import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { JUnitParseError, type ApiError, type CreatedProject, type IngestResponse } from '@flakeradar/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { HttpError } from './errors.js';
import { ingestRun, ingestSchema } from './ingest.js';
import {
  authenticateProject,
  createProject,
  getProjectBySlug,
  requireAdmin,
  rotateToken,
} from './projects.js';
import { listProjects, listRuns, listTests, projectOverview, setQuarantine, testDetail, toProjectInfo } from './queries.js';

export interface AppOptions {
  db: DB;
  config: Pick<Config, 'publicUrl' | 'adminToken' | 'webDistPath' | 'uploaderPath' | 'logLevel'>;
  /** Disable request logging, e.g. in tests. */
  logger?: boolean;
}

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  repository: z
    .string()
    .trim()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'Expected "owner/repo"')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  defaultBranch: z.string().trim().min(1).max(255).optional(),
});

const testListQuery = z.object({
  status: z.enum(['new', 'stable', 'suspect', 'flaky', 'broken', 'quarantined']).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(['attention', 'score', 'failures', 'recent', 'name']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const idParam = z.coerce.number().int().positive();

export async function buildApp({ db, config, logger = true }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ? { level: config.logLevel } : false,
    // JUnit reports for big suites are large; 25 MB covers tens of thousands of tests.
    bodyLimit: 25 * 1024 * 1024,
  });

  app.setErrorHandler((error, request, reply) => {
    let status = 500;
    let body: ApiError = { error: 'internal_error', message: 'Something went wrong' };

    if (error instanceof HttpError) {
      status = error.statusCode;
      body = { error: error.code, message: error.message };
    } else if (error instanceof ZodError) {
      status = 400;
      body = { error: 'validation_error', message: 'The request is invalid', details: error.issues };
    } else if (error instanceof JUnitParseError) {
      status = 400;
      body = { error: 'invalid_report', message: error.message };
    } else if (typeof (error as { statusCode?: unknown }).statusCode === 'number') {
      // Errors raised by Fastify itself (body too large, bad JSON...).
      const e = error as { statusCode: number; code?: string; message: string };
      status = e.statusCode;
      body = { error: e.code ?? 'bad_request', message: e.message };
    }

    if (status >= 500) request.log.error(error);
    void reply.status(status).send(body);
  });

  // ---- API ---------------------------------------------------------------

  app.get('/api/health', async () => ({ ok: true }));

  // CI jobs download the uploader from the server they report to, so there
  // is nothing to install and the script always matches the server's API.
  const uploader = fs.existsSync(config.uploaderPath) ? fs.readFileSync(config.uploaderPath, 'utf8') : null;
  app.get('/api/uploader.mjs', async (_request, reply) => {
    if (!uploader) throw new HttpError(404, 'Uploader script not found on this server', 'not_found');
    return reply.type('text/javascript; charset=utf-8').header('cache-control', 'public, max-age=300').send(uploader);
  });

  app.get('/api/projects', async () => listProjects(db));

  app.post('/api/projects', async (request, reply): Promise<CreatedProject> => {
    requireAdmin(config.adminToken, request.headers.authorization);
    const input = createProjectSchema.parse(request.body);
    const { project, token } = createProject(db, input);
    void reply.status(201);
    return { project: toProjectInfo(project), token };
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/token', async (request): Promise<CreatedProject> => {
    requireAdmin(config.adminToken, request.headers.authorization);
    const project = getProjectBySlug(db, request.params.slug);
    return { project: toProjectInfo(project), token: rotateToken(db, project.id) };
  });

  app.get<{ Params: { slug: string } }>('/api/projects/:slug', async (request) => {
    const project = getProjectBySlug(db, request.params.slug);
    return projectOverview(db, project);
  });

  app.get<{ Params: { slug: string } }>('/api/projects/:slug/tests', async (request) => {
    const project = getProjectBySlug(db, request.params.slug);
    return listTests(db, project.id, testListQuery.parse(request.query));
  });

  app.get<{ Params: { slug: string; id: string } }>('/api/projects/:slug/tests/:id', async (request) => {
    const project = getProjectBySlug(db, request.params.slug);
    return testDetail(db, project.id, idParam.parse(request.params.id));
  });

  app.patch<{ Params: { slug: string; id: string } }>('/api/projects/:slug/tests/:id', async (request) => {
    requireAdmin(config.adminToken, request.headers.authorization);
    const project = getProjectBySlug(db, request.params.slug);
    const { quarantined } = z.object({ quarantined: z.boolean() }).parse(request.body);
    return setQuarantine(db, project.id, idParam.parse(request.params.id), quarantined);
  });

  app.get<{ Params: { slug: string } }>('/api/projects/:slug/runs', async (request) => {
    const project = getProjectBySlug(db, request.params.slug);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }).parse(request.query);
    return listRuns(db, project.id, limit);
  });

  /** Called from CI. Authenticated with the project's upload token. */
  app.post('/api/runs', async (request, reply): Promise<IngestResponse> => {
    const project = authenticateProject(db, request.headers.authorization);
    const input = ingestSchema.parse(request.body);
    const result = ingestRun(db, project, input, config.publicUrl);
    request.log.info(
      { project: project.slug, runId: result.runId, tests: result.summary.total, failures: result.failures.length },
      'run ingested',
    );
    void reply.status(201);
    return result;
  });

  app.all('/api/*', async () => {
    throw new HttpError(404, 'No such API route', 'not_found');
  });

  // ---- Dashboard -----------------------------------------------------------

  const indexHtml = path.join(config.webDistPath, 'index.html');
  if (fs.existsSync(indexHtml)) {
    await app.register(fastifyStatic, { root: config.webDistPath, wildcard: false });
    // Client-side routing: unknown non-API paths render the SPA.
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET' || request.url.startsWith('/api/')) {
        void reply.status(404).send({ error: 'not_found', message: 'Not found' } satisfies ApiError);
        return;
      }
      void reply.type('text/html').sendFile('index.html');
    });
  } else {
    app.get('/', async () => ({
      name: 'FlakeRadar API',
      message: 'Dashboard not built. Run "npm run build" or use the Vite dev server on port 5173.',
    }));
  }

  return app;
}

import { fileURLToPath } from 'node:url';
import { COMMENT_MARKER } from '@flakeradar/core';
import type { CreatedProject, IngestResponse, ProjectOverview, TestDetail, TestListItem } from '@flakeradar/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { openDatabase, type DB } from './db.js';

const ADMIN = 'admin-secret';

let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDatabase(':memory:');
  app = await buildApp({
    db,
    logger: false,
    config: {
      publicUrl: 'https://flakes.example.com',
      adminToken: ADMIN,
      webDistPath: '/nonexistent',
      uploaderPath: fileURLToPath(new URL('../uploader/flakeradar-upload.mjs', import.meta.url)),
      logLevel: 'silent',
    },
  });
});

afterEach(async () => {
  await app.close();
  db.close();
});

function junit(cases: Record<string, 'pass' | 'fail' | 'skip'>): string {
  const body = Object.entries(cases)
    .map(([name, outcome]) => {
      const inner = outcome === 'fail' ? '<failure message="boom"/>' : outcome === 'skip' ? '<skipped/>' : '';
      return `<testcase classname="Suite" name="${name}" time="0.1">${inner}</testcase>`;
    })
    .join('');
  return `<testsuites><testsuite name="suite">${body}</testsuite></testsuites>`;
}

async function createProject(name = 'Web Shop'): Promise<CreatedProject> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { authorization: `Bearer ${ADMIN}` },
    payload: { name, repository: 'acme/web-shop' },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

let commitCounter = 0;
async function upload(
  token: string,
  reports: string[],
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: IngestResponse }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/runs',
    headers: { authorization: `Bearer ${token}` },
    payload: { commitSha: `commit${++commitCounter}`, branch: 'main', reports, ...extra },
  });
  return { status: res.statusCode, body: res.json() };
}

describe('uploader script', () => {
  it('is served as JavaScript and uses the same comment marker as the server', async () => {
    const res = await app.inject('/api/uploader.mjs');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    // If these drift apart, the uploader would post a new comment on every push.
    expect(res.body).toContain(COMMENT_MARKER);
  });
});

describe('projects', () => {
  it('creates a project with a one-time upload token and a unique slug', async () => {
    const first = await createProject('Web Shop');
    const second = await createProject('Web Shop');
    expect(first.token).toMatch(/^frp_/);
    expect(first.project.slug).toBe('web-shop');
    expect(second.project.slug).toBe('web-shop-2');

    const stored = db.prepare('SELECT token_hash FROM projects WHERE slug = ?').get('web-shop') as { token_hash: string };
    expect(stored.token_hash).not.toContain(first.token);
  });

  it('requires the admin token to create projects when one is configured', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'x' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('admin_required');
  });

  it('validates input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name: '', repository: 'not a repo' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('rotates the upload token, invalidating the old one', async () => {
    const { project, token } = await createProject();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.slug}/token`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const rotated = res.json() as CreatedProject;
    expect(rotated.token).not.toBe(token);
    expect((await upload(token, [junit({ a: 'pass' })])).status).toBe(401);
    expect((await upload(rotated.token, [junit({ a: 'pass' })])).status).toBe(201);
  });
});

describe('POST /api/runs', () => {
  it('rejects missing or unknown tokens', async () => {
    expect((await upload('frp_nope', [junit({ a: 'pass' })])).status).toBe(401);
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('rejects invalid XML with a 400', async () => {
    const { token } = await createProject();
    const { status, body } = await upload(token, ['<testsuite><testcase>']);
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid_report' });
  });

  it('summarises the run and renders a PR comment', async () => {
    const { token } = await createProject();
    const { status, body } = await upload(token, [junit({ a: 'pass', b: 'fail', c: 'skip' })], { prNumber: 12 });
    expect(status).toBe(201);
    expect(body.summary).toMatchObject({ total: 3, passed: 1, failed: 1, skipped: 1 });
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0]).toMatchObject({ name: 'b', verdict: 'likely-regression' });
    expect(body.failures[0]!.url).toMatch(/^https:\/\/flakes\.example\.com\/projects\/web-shop\/tests\/\d+$/);
    expect(body.comment).toContain('1 failure needs attention');
  });

  it('rejects the same CI run attempt twice', async () => {
    const { token } = await createProject();
    const payload = { ciRunId: '123', ciRunAttempt: 1 };
    expect((await upload(token, [junit({ a: 'pass' })], payload)).status).toBe(201);
    expect((await upload(token, [junit({ a: 'pass' })], payload)).status).toBe(409);
    expect((await upload(token, [junit({ a: 'pass' })], { ciRunId: '123', ciRunAttempt: 2 })).status).toBe(201);
  });

  it('labels a failure that passed on retry in the same run as flaky', async () => {
    const { token } = await createProject();
    const { body } = await upload(token, [junit({ login: 'fail' }), junit({ login: 'pass' })]);
    expect(body.summary.failed).toBe(0);
    expect(body.failures[0]!.verdict).toBe('flaky-retry-passed');
    expect(body.comment).toContain('All failures look like known flakiness');
  });

  it('learns from history: known flaky failures stop blocking, new failures are flagged', async () => {
    const { project, token } = await createProject();
    // Flaky test: fails and passes on the same commits.
    for (let i = 0; i < 3; i++) {
      await upload(token, [junit({ flaky: 'fail', steady: 'pass' })], { commitSha: `same${i}` });
      await upload(token, [junit({ flaky: 'pass', steady: 'pass' })], { commitSha: `same${i}` });
    }

    const { body } = await upload(token, [junit({ flaky: 'fail', steady: 'fail' })]);
    const byName = Object.fromEntries(body.failures.map((f) => [f.name, f.verdict]));
    expect(byName).toEqual({ flaky: 'known-flaky', steady: 'likely-regression' });

    const tests = (await app.inject(`/api/projects/${project.slug}/tests?status=flaky`)).json() as TestListItem[];
    expect(tests.map((t) => t.name)).toEqual(['flaky']);
  });

  it('only uses default-branch runs for flip-rate evidence', async () => {
    const { project, token } = await createProject();
    for (let i = 0; i < 10; i++) {
      await upload(token, [junit({ t: i % 2 ? 'fail' : 'pass' })], { branch: 'feature/x' });
    }
    const [test] = (await app.inject(`/api/projects/${project.slug}/tests`)).json() as TestListItem[];
    expect(test!.status).toBe('stable');
  });

  it('updates the default branch when the uploader reports it', async () => {
    const { project, token } = await createProject();
    await upload(token, [junit({ a: 'pass' })], { branch: 'trunk', defaultBranch: 'trunk' });
    const overview = (await app.inject(`/api/projects/${project.slug}`)).json() as ProjectOverview;
    expect(overview.project.defaultBranch).toBe('trunk');
  });
});

describe('reading data', () => {
  it('serves an overview with a 30-day trend', async () => {
    const { project, token } = await createProject();
    await upload(token, [junit({ a: 'pass', b: 'fail' })]);
    const overview = (await app.inject(`/api/projects/${project.slug}`)).json() as ProjectOverview;
    expect(overview.testCount).toBe(2);
    expect(overview.trend).toHaveLength(30);
    expect(overview.trend.at(-1)).toMatchObject({ runs: 1, realFailures: 1 });
    expect(overview.window).toMatchObject({ runs: 1, failedRuns: 1, runsFailedByNoise: 0 });
  });

  it('returns test detail with history and grouped failure messages', async () => {
    const { project, token } = await createProject();
    await upload(token, [junit({ a: 'fail' })]);
    await upload(token, [junit({ a: 'fail' })]);
    await upload(token, [junit({ a: 'pass' })]);
    const [item] = (await app.inject(`/api/projects/${project.slug}/tests`)).json() as TestListItem[];
    const detail = (await app.inject(`/api/projects/${project.slug}/tests/${item!.id}`)).json() as TestDetail;
    expect(detail.history.map((h) => h.status)).toEqual(['passed', 'failed', 'failed']);
    expect(detail.topMessages).toEqual([expect.objectContaining({ message: 'boom', count: 2 })]);
    expect(detail.reasons.length).toBeGreaterThan(0);
  });

  it('searches tests safely, treating LIKE wildcards literally', async () => {
    const { project, token } = await createProject();
    await upload(token, [junit({ '100% coverage': 'pass', 'plain name': 'pass' })]);
    const res = (await app.inject(`/api/projects/${project.slug}/tests?q=${encodeURIComponent('%')}`)).json();
    expect((res as TestListItem[]).map((t) => t.name)).toEqual(['100% coverage']);
  });

  it('quarantines a test so its failures stop counting as real', async () => {
    const { project, token } = await createProject();
    await upload(token, [junit({ a: 'pass' })]);
    const [item] = (await app.inject(`/api/projects/${project.slug}/tests`)).json() as TestListItem[];

    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.slug}/tests/${item!.id}`,
      payload: { quarantined: true },
    });
    expect(denied.statusCode).toBe(401);

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.slug}/tests/${item!.id}`,
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { quarantined: true },
    });
    expect((ok.json() as TestDetail).quarantined).toBe(true);

    const { body } = await upload(token, [junit({ a: 'fail' })]);
    expect(body.failures[0]!.quarantined).toBe(true);
    expect(body.comment).toContain('All failures look like known flakiness');
  });

  it('returns 404s as JSON', async () => {
    const res = await app.inject('/api/projects/missing');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
    expect((await app.inject('/api/nope')).statusCode).toBe(404);
  });
});

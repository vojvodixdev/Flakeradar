import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface Config {
  port: number;
  host: string;
  databasePath: string;
  /** Public base URL of the dashboard, used for links in pull request comments. */
  publicUrl: string | null;
  /**
   * When set, creating projects and quarantining tests require this token.
   * Leave empty for local development.
   */
  adminToken: string | null;
  /** Built dashboard to serve from the same origin, if present. */
  webDistPath: string;
  /** The CI uploader script, served at /api/uploader.mjs. */
  uploaderPath: string;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number.parseInt(env.PORT ?? '3000', 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a valid port number, got "${env.PORT}"`);
  }

  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    databasePath: env.DATABASE_PATH ?? path.resolve(here, '../data/flakeradar.db'),
    publicUrl: env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/+$/, '') : null,
    adminToken: env.ADMIN_TOKEN?.trim() || null,
    webDistPath: env.WEB_DIST_PATH ?? path.resolve(here, '../../web/dist'),
    uploaderPath: path.resolve(here, '../uploader/flakeradar-upload.mjs'),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}

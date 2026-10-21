import crypto from 'node:crypto';
import type { DB } from './db.js';
import { HttpError, notFound, unauthorized } from './errors.js';

export interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  repository: string | null;
  default_branch: string;
  token_hash: string;
  created_at: number;
}

const TOKEN_PREFIX = 'frp_';

/**
 * Upload tokens are shown to the user once and only their SHA-256 hash is
 * stored, so a leaked database does not leak working credentials. Tokens
 * have 256 bits of entropy, so a fast hash is fine (no need for bcrypt).
 */
export function generateToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Constant-time string comparison for the admin token. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'project';
}

export function createProject(
  db: DB,
  input: { name: string; repository?: string | null; defaultBranch?: string | null },
): { project: ProjectRow; token: string } {
  const base = slugify(input.name);
  let slug = base;
  for (let i = 2; db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug); i++) {
    slug = `${base}-${i}`;
  }

  const token = generateToken();
  const info = db
    .prepare(
      `INSERT INTO projects (slug, name, repository, default_branch, token_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(slug, input.name.trim(), input.repository ?? null, input.defaultBranch || 'main', hashToken(token), Date.now());

  return { project: getProjectById(db, Number(info.lastInsertRowid)), token };
}

export function getProjectById(db: DB, id: number): ProjectRow {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  if (!row) throw notFound('Project');
  return row;
}

export function getProjectBySlug(db: DB, slug: string): ProjectRow {
  const row = db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as ProjectRow | undefined;
  if (!row) throw notFound('Project');
  return row;
}

export function authenticateProject(db: DB, authorization: string | undefined): ProjectRow {
  const token = bearer(authorization);
  if (!token) throw unauthorized('Send the project upload token as "Authorization: Bearer <token>"');
  const row = db.prepare('SELECT * FROM projects WHERE token_hash = ?').get(hashToken(token)) as
    | ProjectRow
    | undefined;
  if (!row) throw unauthorized('Unknown upload token');
  return row;
}

export function requireAdmin(adminToken: string | null, authorization: string | undefined): void {
  if (!adminToken) return;
  const token = bearer(authorization);
  if (!token || !safeEqual(token, adminToken)) {
    throw new HttpError(401, 'This action requires the admin token', 'admin_required');
  }
}

export function rotateToken(db: DB, projectId: number): string {
  const token = generateToken();
  db.prepare('UPDATE projects SET token_hash = ? WHERE id = ?').run(hashToken(token), projectId);
  return token;
}

function bearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match ? match[1]!.trim() : null;
}

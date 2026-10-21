/**
 * Backend-free API used by the static demo build (`npm run build:demo`).
 *
 * It serves a snapshot captured from a seeded server and mimics the real
 * API: filtering, search and sorting run here, quarantining works for the
 * current page view, and creating projects is refused politely.
 */
import type {
  CreatedProject,
  DemoSnapshot,
  ProjectListItem,
  ProjectOverview,
  RunListItem,
  TestDetail,
  TestListItem,
  TestStatus,
} from '@flakeradar/core';
import { ApiRequestError } from '../errors';

// The snapshot is generated at build time and is not checked in, so it is
// loaded with a glob: a normal build without it still compiles.
const files = import.meta.glob<DemoSnapshot>('./snapshot.json', { eager: true, import: 'default' });

const DAY_MS = 86_400_000;
const TIME_KEYS = new Set(['createdAt', 'lastRunAt', 'lastSeenAt', 'lastFailedAt', 'firstSeenAt']);

/**
 * Shift every date by whole days so the demo always looks recent, however
 * long ago it was built. Whole days keep the trend chart's dates aligned.
 */
function shift<T>(value: T, offset: number): T {
  if (Array.isArray(value)) return value.map((v) => shift(v, offset)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (TIME_KEYS.has(k) && typeof v === 'number') out[k] = v + offset;
      else if (k === 'date' && typeof v === 'string') {
        out[k] = new Date(Date.parse(`${v}T00:00:00Z`) + offset).toISOString().slice(0, 10);
      } else out[k] = shift(v, offset);
    }
    return out as T;
  }
  return value;
}

// Prepared on first use, so a normal (non-demo) build can drop all of this.
let cache: DemoSnapshot | null = null;
function snapshot(): DemoSnapshot {
  if (!cache) {
    const raw = Object.values(files)[0];
    if (!raw) throw new ApiRequestError(500, 'no_snapshot', 'Demo data is missing. Build with npm run build:demo.');
    const offset = Math.max(0, Math.floor((Date.now() - raw.generatedAt) / DAY_MS)) * DAY_MS;
    cache = shift(raw, offset);
  }
  return cache;
}

const quarantine = new Map<string, boolean>();

const STATUS_RANK: Record<TestStatus, number> = { broken: 0, flaky: 1, suspect: 2, stable: 3, new: 3 };

function project(slug: string) {
  const p = snapshot().byProject[slug];
  if (!p) throw new ApiRequestError(404, 'not_found', 'Project not found');
  return p;
}

function withQuarantine<T extends TestListItem>(slug: string, t: T): T {
  const q = quarantine.get(`${slug}:${t.id}`);
  return q === undefined ? t : { ...t, quarantined: q };
}

function readOnly(): never {
  throw new ApiRequestError(
    403,
    'demo',
    'This is a read-only demo with sample data. Run FlakeRadar yourself to create projects.',
  );
}

/** A short delay, so loading states behave like they do against a real server. */
const later = <T>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 120));

export const demoApi = {
  projects: async (): Promise<ProjectListItem[]> => later(snapshot().projects),

  createProject: async (_input: { name: string; repository?: string; defaultBranch?: string }): Promise<CreatedProject> =>
    readOnly(),

  rotateToken: async (_slug: string): Promise<CreatedProject> => readOnly(),

  overview: async (slug: string): Promise<ProjectOverview> => {
    const p = project(slug);
    const quarantined = p.tests.filter((t) => withQuarantine(slug, t).quarantined).length;
    return later({ ...p.overview, quarantined });
  },

  tests: async (slug: string, params: { status?: string; q?: string; sort?: string }): Promise<TestListItem[]> => {
    let tests = project(slug).tests.map((t) => withQuarantine(slug, t));
    if (params.status === 'quarantined') tests = tests.filter((t) => t.quarantined);
    else if (params.status) tests = tests.filter((t) => t.status === params.status);
    if (params.q) {
      const q = params.q.toLowerCase();
      tests = tests.filter((t) => [t.name, t.classname, t.file ?? ''].some((s) => s.toLowerCase().includes(q)));
    }
    const byName = (a: TestListItem, b: TestListItem) => a.name.localeCompare(b.name);
    const sorters: Record<string, (a: TestListItem, b: TestListItem) => number> = {
      attention: (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.score - a.score || b.failures - a.failures || byName(a, b),
      score: (a, b) => b.score - a.score || b.failures - a.failures || byName(a, b),
      failures: (a, b) => b.failures - a.failures || b.score - a.score || byName(a, b),
      recent: (a, b) => (b.lastFailedAt ?? -1) - (a.lastFailedAt ?? -1) || byName(a, b),
      name: (a, b) => a.classname.localeCompare(b.classname) || byName(a, b),
    };
    return later([...tests].sort(sorters[params.sort ?? 'attention'] ?? sorters.attention));
  },

  test: async (slug: string, id: number): Promise<TestDetail> => {
    const detail = project(slug).details[String(id)];
    if (!detail) throw new ApiRequestError(404, 'not_found', 'Test not found');
    return later(withQuarantine(slug, detail));
  },

  setQuarantine: async (slug: string, id: number, quarantined: boolean): Promise<TestDetail> => {
    quarantine.set(`${slug}:${id}`, quarantined);
    return demoApi.test(slug, id);
  },

  runs: async (slug: string): Promise<RunListItem[]> => later(project(slug).runs),
};

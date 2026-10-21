import type {
  FailureMessage,
  HistoryEntry,
  ProjectInfo,
  ProjectListItem,
  ProjectOverview,
  RunListItem,
  StatusCounts,
  TestDetail,
  TestListItem,
  TestStatus,
} from '@flakeradar/core';
import type { DB } from './db.js';
import { notFound } from './errors.js';
import type { ProjectRow } from './projects.js';

const DAY_MS = 86_400_000;
const STATUSES: TestStatus[] = ['new', 'stable', 'suspect', 'flaky', 'broken'];

export function toProjectInfo(p: ProjectRow): ProjectInfo {
  return {
    slug: p.slug,
    name: p.name,
    repository: p.repository,
    defaultBranch: p.default_branch,
    createdAt: p.created_at,
  };
}

function statusCounts(db: DB, projectId: number): StatusCounts {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as StatusCounts;
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM tests WHERE project_id = ? GROUP BY status')
    .all(projectId) as { status: TestStatus; n: number }[];
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

export function listProjects(db: DB): ProjectListItem[] {
  const projects = db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all() as ProjectRow[];
  const runStats = db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM runs WHERE project_id = ?');

  return projects.map((p) => {
    const counts = statusCounts(db, p.id);
    const runs = runStats.get(p.id) as { n: number; last: number | null };
    return {
      ...toProjectInfo(p),
      counts,
      testCount: Object.values(counts).reduce((s, n) => s + n, 0),
      runCount: runs.n,
      lastRunAt: runs.last,
    };
  });
}

export function projectOverview(db: DB, project: ProjectRow, days = 30, now = Date.now()): ProjectOverview {
  const counts = statusCounts(db, project.id);
  const since = startOfUtcDay(now) - (days - 1) * DAY_MS;

  const window = db
    .prepare(
      `SELECT COUNT(*) AS runs,
              COALESCE(SUM(failed > 0), 0) AS failedRuns,
              COALESCE(SUM(failed > 0 AND real_failures = 0 AND noise_failures > 0), 0) AS runsFailedByNoise,
              COALESCE(SUM(CASE WHEN failed > 0 AND real_failures = 0 AND noise_failures > 0 THEN duration_ms END), 0) AS wastedMs
         FROM runs WHERE project_id = ? AND created_at >= ?`,
    )
    .get(project.id, since) as Omit<ProjectOverview['window'], 'days'>;

  const daily = db
    .prepare(
      `SELECT date(created_at / 1000, 'unixepoch') AS date,
              COUNT(*) AS runs,
              SUM(noise_failures) AS noiseFailures,
              SUM(real_failures) AS realFailures
         FROM runs WHERE project_id = ? AND created_at >= ?
        GROUP BY 1`,
    )
    .all(project.id, since) as ProjectOverview['trend'];
  const byDate = new Map(daily.map((d) => [d.date, d]));

  const trend: ProjectOverview['trend'] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(since + i * DAY_MS).toISOString().slice(0, 10);
    trend.push(byDate.get(date) ?? { date, runs: 0, noiseFailures: 0, realFailures: 0 });
  }

  const quarantined = (
    db.prepare('SELECT COUNT(*) AS n FROM tests WHERE project_id = ? AND quarantined = 1').get(project.id) as {
      n: number;
    }
  ).n;

  return {
    project: toProjectInfo(project),
    testCount: Object.values(counts).reduce((s, n) => s + n, 0),
    counts,
    quarantined,
    window: { days, ...window },
    trend,
  };
}

interface TestRow {
  id: number;
  key: string;
  name: string;
  classname: string;
  suite: string;
  file: string | null;
  status: TestStatus;
  score: number;
  runs: number;
  failures: number;
  failure_rate: number;
  flips: number;
  flip_rate: number;
  conflicting_commits: number;
  fail_streak: number;
  reasons: string;
  quarantined: number;
  avg_duration_ms: number;
  first_seen_at: number;
  last_seen_at: number;
  last_failed_at: number | null;
}

function toTestListItem(r: TestRow, recent = ''): TestListItem {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    classname: r.classname,
    suite: r.suite,
    file: r.file,
    status: r.status,
    score: r.score,
    runs: r.runs,
    failures: r.failures,
    failureRate: r.failure_rate,
    flips: r.flips,
    conflictingCommits: r.conflicting_commits,
    quarantined: r.quarantined === 1,
    avgDurationMs: r.avg_duration_ms,
    lastSeenAt: r.last_seen_at,
    lastFailedAt: r.last_failed_at,
    recent,
  };
}

const RECENT_LENGTH = 40;

/** Last N outcomes per test in one query, using a window function. */
function recentOutcomes(db: DB, testIds: number[]): Map<number, string> {
  const result = new Map<number, string>();
  if (testIds.length === 0) return result;
  const rows = db
    .prepare(
      `SELECT test_id AS testId, status FROM (
         SELECT test_id, status, created_at,
                ROW_NUMBER() OVER (PARTITION BY test_id ORDER BY created_at DESC) AS rn
           FROM executions
          WHERE test_id IN (${testIds.map(() => '?').join(',')})
       )
       WHERE rn <= ${RECENT_LENGTH}
       ORDER BY test_id, created_at`,
    )
    .all(...testIds) as { testId: number; status: string }[];
  for (const r of rows) result.set(r.testId, (result.get(r.testId) ?? '') + r.status[0]);
  return result;
}

export type TestSort = 'attention' | 'score' | 'failures' | 'recent' | 'name';

const ORDER_BY: Record<TestSort, string> = {
  // Broken and flaky first, then whatever looks shakiest.
  attention: `CASE status WHEN 'broken' THEN 0 WHEN 'flaky' THEN 1 WHEN 'suspect' THEN 2 ELSE 3 END,
              score DESC, failures DESC, name`,
  score: 'score DESC, failures DESC, name',
  failures: 'failures DESC, score DESC, name',
  recent: 'last_failed_at IS NULL, last_failed_at DESC, name',
  name: 'classname COLLATE NOCASE, name COLLATE NOCASE',
};

export function listTests(
  db: DB,
  projectId: number,
  opts: { status?: TestStatus | 'quarantined'; q?: string; sort?: TestSort; limit?: number },
): TestListItem[] {
  const where = ['project_id = ?'];
  const params: unknown[] = [projectId];

  if (opts.status === 'quarantined') {
    where.push('quarantined = 1');
  } else if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  if (opts.q) {
    where.push("(name LIKE ? ESCAPE '\\' OR classname LIKE ? ESCAPE '\\' OR file LIKE ? ESCAPE '\\')");
    const like = `%${opts.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like, like);
  }

  // ORDER_BY values are constants, never user input, so interpolation is safe.
  const sql = `SELECT * FROM tests WHERE ${where.join(' AND ')} ORDER BY ${ORDER_BY[opts.sort ?? 'attention']} LIMIT ?`;
  params.push(Math.min(opts.limit ?? 200, 1000));
  const rows = db.prepare(sql).all(...params) as TestRow[];
  const recent = recentOutcomes(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toTestListItem(r, recent.get(r.id)));
}

export function testDetail(db: DB, projectId: number, testId: number, historyLimit = 120): TestDetail {
  const row = db.prepare('SELECT * FROM tests WHERE id = ? AND project_id = ?').get(testId, projectId) as
    | TestRow
    | undefined;
  if (!row) throw notFound('Test');

  const history = (
    db
      .prepare(
        `SELECT e.run_id AS runId, r.commit_sha AS commitSha, r.branch, r.trusted, r.pr_number AS prNumber,
                e.status, e.attempt, e.duration_ms AS durationMs, e.message, e.verdict, e.created_at AS createdAt
           FROM executions e JOIN runs r ON r.id = e.run_id
          WHERE e.test_id = ?
          ORDER BY e.created_at DESC
          LIMIT ?`,
      )
      .all(testId, historyLimit) as Array<Omit<HistoryEntry, 'trusted'> & { trusted: number }>
  ).map((h) => ({ ...h, trusted: h.trusted === 1 }));

  const topMessages = db
    .prepare(
      `SELECT message, COUNT(*) AS count, MAX(created_at) AS lastSeenAt
         FROM executions
        WHERE test_id = ? AND status = 'failed' AND message IS NOT NULL
        GROUP BY message
        ORDER BY count DESC, lastSeenAt DESC
        LIMIT 5`,
    )
    .all(testId) as FailureMessage[];

  return {
    ...toTestListItem(row, recentOutcomes(db, [row.id]).get(row.id)),
    flipRate: row.flip_rate,
    failStreak: row.fail_streak,
    reasons: JSON.parse(row.reasons) as string[],
    firstSeenAt: row.first_seen_at,
    history,
    topMessages,
  };
}

export function setQuarantine(db: DB, projectId: number, testId: number, quarantined: boolean): TestDetail {
  const info = db
    .prepare('UPDATE tests SET quarantined = ? WHERE id = ? AND project_id = ?')
    .run(quarantined ? 1 : 0, testId, projectId);
  if (info.changes === 0) throw notFound('Test');
  return testDetail(db, projectId, testId);
}

export function listRuns(db: DB, projectId: number, limit = 50): RunListItem[] {
  const rows = db
    .prepare(
      `SELECT id, commit_sha AS commitSha, branch, trusted, pr_number AS prNumber, workflow,
              ci_run_id AS ciRunId, ci_run_attempt AS ciRunAttempt, total, passed, failed, skipped,
              duration_ms AS durationMs, noise_failures AS noiseFailures, real_failures AS realFailures,
              created_at AS createdAt
         FROM runs WHERE project_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(projectId, Math.min(limit, 500)) as Array<Omit<RunListItem, 'trusted'> & { trusted: number }>;
  return rows.map((r) => ({ ...r, trusted: r.trusted === 1 }));
}

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

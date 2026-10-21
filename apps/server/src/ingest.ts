import {
  analyzeFlakiness,
  isNoise,
  parseJUnitReports,
  renderPullRequestComment,
  verdictFor,
  type ExecutionSample,
  type ParsedTestCase,
  type RunFailure,
  type RunSummary,
  type TestStatus,
} from '@flakeradar/core';
import { z } from 'zod';
import type { DB } from './db.js';
import { HttpError } from './errors.js';
import type { ProjectRow } from './projects.js';

/** How many recent executions of a test feed its flakiness score. */
export const HISTORY_WINDOW = 300;

export const ingestSchema = z.object({
  commitSha: z.string().trim().min(4).max(64),
  branch: z.string().trim().min(1).max(255),
  /** Lets the uploader keep the project's default branch in sync. */
  defaultBranch: z.string().trim().min(1).max(255).optional(),
  repository: z
    .string()
    .trim()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'Expected "owner/repo"')
    .optional(),
  ciRunId: z.string().trim().max(64).optional(),
  ciRunAttempt: z.number().int().min(1).max(1000).optional(),
  prNumber: z.number().int().positive().optional(),
  workflow: z.string().trim().max(255).optional(),
  /** ISO timestamp of the run. Defaults to now; mainly useful for backfilling history. */
  timestamp: z.iso.datetime({ offset: true }).optional(),
  reports: z.array(z.string().min(1)).min(1).max(500),
});

export type IngestInput = z.infer<typeof ingestSchema>;

export interface IngestResult {
  runId: number;
  summary: RunSummary;
  failures: RunFailure[];
  comment: string;
}

interface TestRow {
  id: number;
  status: TestStatus;
  quarantined: number;
}

/**
 * Stores one CI run and refreshes the flakiness score of every test it touched.
 * Everything happens in a single transaction so a crash can never leave a
 * half-imported run behind.
 */
export function ingestRun(db: DB, project: ProjectRow, input: IngestInput, publicUrl: string | null): IngestResult {
  const cases = parseJUnitReports(input.reports);
  if (cases.length === 0) {
    throw new HttpError(422, 'The reports did not contain any test cases', 'empty_report');
  }

  const createdAt = input.timestamp ? Date.parse(input.timestamp) : Date.now();
  const byKey = groupByKey(cases);
  const summary = summarise(byKey);

  return db.transaction((): IngestResult => {
    if (input.defaultBranch && input.defaultBranch !== project.default_branch) {
      db.prepare('UPDATE projects SET default_branch = ? WHERE id = ?').run(input.defaultBranch, project.id);
      project = { ...project, default_branch: input.defaultBranch };
    }
    if (input.repository && !project.repository) {
      db.prepare('UPDATE projects SET repository = ? WHERE id = ?').run(input.repository, project.id);
    }

    if (input.ciRunId) {
      const duplicate = db
        .prepare('SELECT id FROM runs WHERE project_id = ? AND ci_run_id = ? AND ci_run_attempt = ?')
        .get(project.id, input.ciRunId, input.ciRunAttempt ?? 1);
      if (duplicate) {
        throw new HttpError(409, `Run ${input.ciRunId} attempt ${input.ciRunAttempt ?? 1} was already uploaded`, 'duplicate_run');
      }
    }

    const trusted = input.branch === project.default_branch;
    const runId = Number(
      db
        .prepare(
          `INSERT INTO runs (project_id, commit_sha, branch, trusted, ci_run_id, ci_run_attempt, pr_number, workflow,
                             total, passed, failed, skipped, duration_ms, noise_failures, real_failures, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
        )
        .run(
          project.id,
          input.commitSha,
          input.branch,
          trusted ? 1 : 0,
          input.ciRunId ?? null,
          input.ciRunAttempt ?? 1,
          input.prNumber ?? null,
          input.workflow ?? null,
          summary.total,
          summary.passed,
          summary.failed,
          summary.skipped,
          summary.durationMs,
          createdAt,
        ).lastInsertRowid,
    );

    const findTest = db.prepare('SELECT id, status, quarantined FROM tests WHERE project_id = ? AND key = ?');
    const insertTest = db.prepare(
      `INSERT INTO tests (project_id, key, suite, classname, name, file, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const touchTest = db.prepare(
      'UPDATE tests SET last_seen_at = MAX(last_seen_at, ?), file = COALESCE(?, file) WHERE id = ?',
    );
    const insertExecution = db.prepare(
      `INSERT INTO executions (run_id, test_id, attempt, status, duration_ms, message, verdict, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const failures: RunFailure[] = [];
    const touched: number[] = [];
    const idByKey = new Map<string, number>();
    let noise = 0;
    let real = 0;

    for (const [key, attempts] of byKey) {
      const first = attempts[0]!;
      let test = findTest.get(project.id, key) as TestRow | undefined;
      if (!test) {
        const id = Number(
          insertTest.run(project.id, key, first.suite, first.classname, first.name, first.file, createdAt, createdAt)
            .lastInsertRowid,
        );
        test = { id, status: 'new', quarantined: 0 };
      } else {
        touchTest.run(createdAt, first.file, test.id);
      }
      idByKey.set(key, test.id);

      const failed = attempts.some((a) => a.status === 'failed');
      const passed = attempts.some((a) => a.status === 'passed');
      // The verdict uses the status from *before* this run, see verdictFor().
      const verdict = failed ? verdictFor({ passedInSameRun: passed, priorStatus: test.status }) : null;

      for (const a of attempts) {
        insertExecution.run(
          runId,
          test.id,
          a.attempt,
          a.status,
          a.durationMs,
          a.message,
          a.status === 'failed' ? verdict : null,
          createdAt + a.attempt,
        );
      }
      if (attempts.some((a) => a.status !== 'skipped')) touched.push(test.id);

      if (verdict) {
        const quarantined = test.quarantined === 1;
        if (isNoise(verdict, quarantined)) noise++;
        else real++;
        failures.push({
          testKey: key,
          name: first.name,
          classname: first.classname,
          verdict,
          score: 0, // filled in after rescoring
          quarantined,
          message: attempts.find((a) => a.status === 'failed')?.message ?? null,
          url: publicUrl ? `${publicUrl}/projects/${project.slug}/tests/${test.id}` : null,
        });
      }
    }

    db.prepare('UPDATE runs SET noise_failures = ?, real_failures = ? WHERE id = ?').run(noise, real, runId);

    const scores = rescoreTests(db, touched);
    for (const f of failures) f.score = scores.get(idByKey.get(f.testKey)!) ?? 0;

    const dashboardUrl = publicUrl ? `${publicUrl}/projects/${project.slug}` : null;
    return { runId, summary, failures, comment: renderPullRequestComment({ summary, failures, dashboardUrl }) };
  })();
}

/** Recomputes the stored analysis for the given tests. Returns their new scores. */
export function rescoreTests(db: DB, testIds: number[]): Map<number, number> {
  const history = db.prepare(
    `SELECT e.status, e.duration_ms AS durationMs, e.created_at AS at, r.commit_sha AS commitSha, r.trusted
       FROM executions e JOIN runs r ON r.id = e.run_id
      WHERE e.test_id = ? AND e.status != 'skipped'
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ${HISTORY_WINDOW}`,
  );
  const update = db.prepare(
    `UPDATE tests SET status = ?, score = ?, runs = ?, failures = ?, failure_rate = ?, flips = ?, flip_rate = ?,
                      conflicting_commits = ?, fail_streak = ?, reasons = ?, avg_duration_ms = ?,
                      last_failed_at = ?
      WHERE id = ?`,
  );

  const scores = new Map<number, number>();
  for (const id of testIds) {
    const rows = history.all(id) as Array<{
      status: 'passed' | 'failed';
      durationMs: number;
      at: number;
      commitSha: string;
      trusted: number;
    }>;
    // Rows come newest first. Hand them over oldest first, so executions that
    // share a timestamp keep their insertion order through the stable sort
    // inside analyzeFlakiness.
    const samples: ExecutionSample[] = [...rows].reverse().map((r) => ({
      status: r.status,
      at: r.at,
      commitSha: r.commitSha,
      trusted: r.trusted === 1,
    }));
    const a = analyzeFlakiness(samples);
    const passedDurations = rows.filter((r) => r.status === 'passed' && r.durationMs > 0).map((r) => r.durationMs);
    const avgDuration = passedDurations.length
      ? Math.round(passedDurations.reduce((s, d) => s + d, 0) / passedDurations.length)
      : 0;
    const lastFailedAt = rows.find((r) => r.status === 'failed')?.at ?? null;

    update.run(
      a.status,
      a.score,
      a.runs,
      a.failures,
      a.failureRate,
      a.flips,
      a.flipRate,
      a.conflictingCommits,
      a.failStreak,
      JSON.stringify(a.reasons),
      avgDuration,
      lastFailedAt,
      id,
    );
    scores.set(id, a.score);
  }
  return scores;
}

function groupByKey(cases: ParsedTestCase[]): Map<string, ParsedTestCase[]> {
  const map = new Map<string, ParsedTestCase[]>();
  for (const c of cases) {
    const list = map.get(c.key) ?? [];
    list.push(c);
    map.set(c.key, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.attempt - b.attempt);
  return map;
}

/** Counts tests by their *final* outcome, which is what decides whether CI is green. */
function summarise(byKey: Map<string, ParsedTestCase[]>): RunSummary {
  const summary: RunSummary = { total: byKey.size, passed: 0, failed: 0, skipped: 0, durationMs: 0 };
  for (const attempts of byKey.values()) {
    const last = attempts[attempts.length - 1]!;
    summary[last.status]++;
    summary.durationMs += attempts.reduce((s, a) => s + a.durationMs, 0);
  }
  return summary;
}

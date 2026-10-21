/**
 * Shapes of the HTTP API responses. Shared by the server (which produces
 * them) and the dashboard (which consumes them), so a breaking change is a
 * compile error on both sides.
 */
import type { ExecutionStatus, FailureVerdict, RunFailure, RunSummary, TestStatus } from './types.js';

export type StatusCounts = Record<TestStatus, number>;

export interface ProjectInfo {
  slug: string;
  name: string;
  repository: string | null;
  defaultBranch: string;
  createdAt: number;
}

export interface ProjectListItem extends ProjectInfo {
  testCount: number;
  counts: StatusCounts;
  runCount: number;
  lastRunAt: number | null;
}

export interface CreatedProject {
  project: ProjectInfo;
  /** Shown once. Only a hash is stored on the server. */
  token: string;
}

export interface TrendPoint {
  /** YYYY-MM-DD in UTC. */
  date: string;
  runs: number;
  noiseFailures: number;
  realFailures: number;
}

export interface ProjectOverview {
  project: ProjectInfo;
  testCount: number;
  counts: StatusCounts;
  quarantined: number;
  window: {
    days: number;
    runs: number;
    failedRuns: number;
    /** Runs that went red only because of flaky or quarantined tests. */
    runsFailedByNoise: number;
    /** CI time spent in those runs, i.e. time thrown away by flakiness. */
    wastedMs: number;
  };
  trend: TrendPoint[];
}

export interface TestListItem {
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
  failureRate: number;
  flips: number;
  conflictingCommits: number;
  quarantined: boolean;
  avgDurationMs: number;
  lastSeenAt: number;
  lastFailedAt: number | null;
  /**
   * Outcomes of the most recent executions, oldest first, one character
   * each: "p" passed, "f" failed, "s" skipped. Compact enough to send for
   * every row of the test list.
   */
  recent: string;
}

export interface HistoryEntry {
  runId: number;
  commitSha: string;
  branch: string;
  trusted: boolean;
  prNumber: number | null;
  status: ExecutionStatus;
  attempt: number;
  durationMs: number;
  message: string | null;
  verdict: FailureVerdict | null;
  createdAt: number;
}

export interface FailureMessage {
  message: string;
  count: number;
  lastSeenAt: number;
}

export interface TestDetail extends TestListItem {
  flipRate: number;
  failStreak: number;
  reasons: string[];
  firstSeenAt: number;
  /** Most recent executions, newest first. */
  history: HistoryEntry[];
  topMessages: FailureMessage[];
}

export interface RunListItem {
  id: number;
  commitSha: string;
  branch: string;
  trusted: boolean;
  prNumber: number | null;
  workflow: string | null;
  ciRunId: string | null;
  ciRunAttempt: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  noiseFailures: number;
  realFailures: number;
  createdAt: number;
}

export interface IngestResponse {
  runId: number;
  summary: RunSummary;
  failures: RunFailure[];
  /** Ready-to-post pull request comment (GitHub Markdown). */
  comment: string;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

/**
 * Everything the dashboard needs, captured from a seeded server. Used by the
 * static demo build, which runs without a backend.
 */
export interface DemoSnapshot {
  /** When the data was captured; the demo shifts dates so they stay recent. */
  generatedAt: number;
  projects: ProjectListItem[];
  byProject: Record<
    string,
    {
      overview: ProjectOverview;
      tests: TestListItem[];
      runs: RunListItem[];
      details: Record<string, TestDetail>;
    }
  >;
}

/** Outcome of a single test execution as reported by the test runner. */
export type ExecutionStatus = 'passed' | 'failed' | 'skipped';

/**
 * Classification FlakeRadar assigns to a test after looking at its history.
 *
 * - `new`     not enough data yet to say anything useful
 * - `stable`  behaves deterministically
 * - `suspect` shows some signs of flakiness, worth watching
 * - `flaky`   strong evidence of non-deterministic behaviour
 * - `broken`  fails consistently: a real bug, not flakiness
 */
export type TestStatus = 'new' | 'stable' | 'suspect' | 'flaky' | 'broken';

/** One test case extracted from a JUnit XML report. */
export interface ParsedTestCase {
  /** Stable identifier used to match the same test across runs. */
  key: string;
  suite: string;
  classname: string;
  name: string;
  file: string | null;
  status: ExecutionStatus;
  durationMs: number;
  /** Failure or error message, trimmed. Null when the test passed. */
  message: string | null;
  /**
   * 1-based attempt number inside the same CI run. Runners that retry
   * failed tests (Playwright, Maven Surefire, pytest-rerunfailures...)
   * produce several attempts for the same key.
   */
  attempt: number;
}

/** A historical execution fed into the flakiness analysis. */
export interface ExecutionSample {
  status: 'passed' | 'failed';
  commitSha: string;
  /** Unix epoch milliseconds; used to order the samples. */
  at: number;
  /**
   * Whether this run happened on the default branch. Defaults to true.
   * Untrusted samples (feature branches) only contribute same-commit
   * conflicts, not flip-rate or broken-streak evidence.
   */
  trusted?: boolean;
}

export interface FlakinessAnalysis {
  status: TestStatus;
  /** 0 (perfectly stable) to 1 (certainly flaky). */
  score: number;
  runs: number;
  failures: number;
  failureRate: number;
  /** Pass→fail or fail→pass transitions between consecutive default-branch runs. */
  flips: number;
  flipRate: number;
  /** Commits on which the test both passed and failed. Same code, different outcome. */
  conflictingCommits: number;
  /** Consecutive failures at the end of the default-branch history. */
  failStreak: number;
  /** Human-readable explanation of the score, shown in the dashboard. */
  reasons: string[];
}

/** How a failure in a specific CI run should be interpreted. */
export type FailureVerdict =
  | 'flaky-retry-passed'
  | 'known-flaky'
  | 'possibly-flaky'
  | 'known-broken'
  | 'likely-regression';

export interface RunFailure {
  testKey: string;
  name: string;
  classname: string;
  verdict: FailureVerdict;
  score: number;
  quarantined: boolean;
  message: string | null;
  /** Link to the test's page in the dashboard, when a public URL is configured. */
  url: string | null;
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

import type { ExecutionSample, FlakinessAnalysis, TestStatus } from './types.js';

/**
 * Tunable thresholds. They are exported so the server (and the tests) can
 * reason about them, and so a team could adjust them per project later.
 */
export const SCORING = {
  /** Below this many runs we label a test `new` unless there is hard evidence. */
  minRuns: 5,
  /** Trailing consecutive failures needed to call a test `broken`. */
  brokenStreak: 3,
  /**
   * A flip rate (lower confidence bound) at or above this value counts as
   * full evidence of flakiness. A test that fails at random 10% of the time
   * flips roughly 2 * 0.1 * 0.9 = 18% of the time, so 0.15 saturates for
   * anything noticeably unreliable.
   */
  flipSaturation: 0.15,
  /** z-score for a one-sided 95% Wilson interval. */
  z: 1.645,
  flakyAt: 0.6,
  suspectAt: 0.25,
} as const;

/**
 * Decides how flaky a test is from its execution history.
 *
 * The core insight is that "fails sometimes" is not the same as "flaky".
 * A test that started failing at commit X and kept failing is a real bug.
 * A test that fails and passes **on the same commit** is non-deterministic
 * by definition, because the code under test did not change.
 *
 * Two independent pieces of evidence are combined:
 *
 * 1. Conflicting commits: commits on which the test both passed and failed
 *    (e.g. a CI retry went green). Each one halves the remaining doubt.
 * 2. Flip rate: how often consecutive runs disagree. We use the lower bound
 *    of a Wilson confidence interval so that 2 flips out of 3 runs does not
 *    outrank 20 flips out of 100.
 *
 * Skipped executions carry no signal and must be filtered out by the caller.
 */
export function analyzeFlakiness(samples: ExecutionSample[]): FlakinessAnalysis {
  const history = [...samples].sort((a, b) => a.at - b.at);
  const runs = history.length;

  if (runs === 0) {
    return {
      status: 'new',
      score: 0,
      runs: 0,
      failures: 0,
      failureRate: 0,
      flips: 0,
      flipRate: 0,
      conflictingCommits: 0,
      failStreak: 0,
      reasons: ['No executions recorded yet.'],
    };
  }

  const failures = history.filter((s) => s.status === 'failed').length;

  // Flip rate and broken streaks only make sense where the code is expected
  // to be correct between runs: the default branch. On a feature branch a
  // test failing on one push and passing on the next usually means the
  // author fixed their code, not that the test is flaky.
  const trusted = history.filter((s) => s.trusted !== false);
  const trustedRuns = trusted.length;

  // Only compare consecutive runs of *different* commits. A pass and a fail
  // on the same commit is already counted as a conflict below; counting it
  // again as a flip would double the evidence.
  let flips = 0;
  let comparisons = 0;
  for (let i = 1; i < trustedRuns; i++) {
    const prev = trusted[i - 1]!;
    const curr = trusted[i]!;
    if (prev.commitSha === curr.commitSha) continue;
    comparisons++;
    if (curr.status !== prev.status) flips++;
  }

  const outcomesByCommit = new Map<string, Set<ExecutionSample['status']>>();
  for (const s of history) {
    const set = outcomesByCommit.get(s.commitSha) ?? new Set();
    set.add(s.status);
    outcomesByCommit.set(s.commitSha, set);
  }
  const conflicted = new Set(
    [...outcomesByCommit.entries()].filter(([, set]) => set.size > 1).map(([sha]) => sha),
  );
  const conflictingCommits = conflicted.size;

  let failStreak = 0;
  for (let i = trustedRuns - 1; i >= 0 && trusted[i]!.status === 'failed'; i--) failStreak++;
  const streakCommits = new Set(trusted.slice(trustedRuns - failStreak).map((s) => s.commitSha));
  const streakIsDeterministic = [...streakCommits].every((sha) => !conflicted.has(sha));

  const flipRate = comparisons > 0 ? flips / comparisons : 0;
  const conflictEvidence = 1 - 0.5 ** conflictingCommits;
  const flipEvidence =
    comparisons > 0 ? clamp01(wilsonLowerBound(flips, comparisons, SCORING.z) / SCORING.flipSaturation) : 0;
  // Treat both signals as independent evidence: the test is "not flaky" only
  // if neither signal says it is.
  const score = round3(1 - (1 - conflictEvidence) * (1 - flipEvidence));

  const status = classify({ runs, score, conflictingCommits, failStreak, streakIsDeterministic });
  const failureRate = failures / runs;

  return {
    status,
    score,
    runs,
    failures,
    failureRate: round3(failureRate),
    flips,
    flipRate: round3(flipRate),
    conflictingCommits,
    failStreak,
    reasons: explain({ status, runs, trustedRuns, failures, flips, flipRate, conflictingCommits, failStreak }),
  };
}

function classify(input: {
  runs: number;
  score: number;
  conflictingCommits: number;
  failStreak: number;
  streakIsDeterministic: boolean;
}): TestStatus {
  const { runs, score, conflictingCommits, failStreak, streakIsDeterministic } = input;

  // A deterministic run of failures is the most actionable thing to report,
  // even for a test that used to be flaky: right now it is simply broken.
  if (failStreak >= SCORING.brokenStreak && streakIsDeterministic) return 'broken';
  if (runs < SCORING.minRuns && conflictingCommits === 0) return 'new';
  if (score >= SCORING.flakyAt) return 'flaky';
  if (score >= SCORING.suspectAt) return 'suspect';
  return 'stable';
}

function explain(input: {
  status: TestStatus;
  runs: number;
  trustedRuns: number;
  failures: number;
  flips: number;
  flipRate: number;
  conflictingCommits: number;
  failStreak: number;
}): string[] {
  const { status, runs, trustedRuns, failures, flips, flipRate, conflictingCommits, failStreak } = input;
  const reasons: string[] = [];

  if (conflictingCommits > 0) {
    reasons.push(
      `Passed and failed on the same code in ${plural(conflictingCommits, 'commit')}. Nothing changed, so the outcome is non-deterministic.`,
    );
  }
  if (flips > 0) {
    reasons.push(
      `Changed outcome ${plural(flips, 'time')} across ${plural(trustedRuns, 'run')} on the default branch (${pct(flipRate)} of consecutive runs disagree).`,
    );
  }
  if (status === 'broken') {
    reasons.push(
      `Failed the last ${plural(failStreak, 'run')} on the default branch in a row, never passing on any of those commits. This looks like a real bug, not flakiness.`,
    );
  }
  if (status === 'new') {
    reasons.push(`Only ${plural(runs, 'run')} recorded. At least ${SCORING.minRuns} are needed for a reliable verdict.`);
  }
  if (status === 'stable' && failures === 0) {
    reasons.push(`Passed all ${plural(runs, 'run')}.`);
  } else if (status === 'stable') {
    reasons.push(`${plural(failures, 'failure')} in ${plural(runs, 'run')}, but they look deterministic.`);
  }
  return reasons;
}

/**
 * Lower bound of the Wilson score interval for a binomial proportion.
 * Much better than the raw ratio for small samples.
 */
export function wilsonLowerBound(successes: number, trials: number, z: number): number {
  if (trials <= 0) return 0;
  const p = successes / trials;
  const z2 = z * z;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return Math.max(0, (centre - margin) / (1 + z2 / trials));
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

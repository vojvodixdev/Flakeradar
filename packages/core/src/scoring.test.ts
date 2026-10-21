import { describe, expect, it } from 'vitest';
import { analyzeFlakiness, wilsonLowerBound } from './scoring.js';
import type { ExecutionSample } from './types.js';

/** Deterministic PRNG so the statistical tests never flake themselves. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One run per commit on the default branch, from a string like "PPPFFP". */
function history(pattern: string): ExecutionSample[] {
  return [...pattern].map((ch, i) => ({
    status: ch === 'F' ? 'failed' : 'passed',
    commitSha: `c${i}`,
    at: i,
  }));
}

describe('analyzeFlakiness', () => {
  it('labels an empty history as new', () => {
    expect(analyzeFlakiness([])).toMatchObject({ status: 'new', score: 0, runs: 0 });
  });

  it('labels a test with too few runs as new', () => {
    expect(analyzeFlakiness(history('PPF')).status).toBe('new');
  });

  it('scores an always-passing test as stable with zero flakiness', () => {
    const result = analyzeFlakiness(history('P'.repeat(50)));
    expect(result).toMatchObject({ status: 'stable', score: 0, flips: 0, failures: 0 });
  });

  it('recognises a deterministic breakage as broken, not flaky', () => {
    const result = analyzeFlakiness(history('P'.repeat(40) + 'FFFFF'));
    expect(result.status).toBe('broken');
    expect(result.failStreak).toBe(5);
    expect(result.score).toBeLessThan(0.25);
  });

  it('treats a bug that was introduced and then fixed as stable', () => {
    const result = analyzeFlakiness(history('P'.repeat(30) + 'FFF' + 'P'.repeat(30)));
    expect(result.status).toBe('stable');
    expect(result.flips).toBe(2);
  });

  it('flags passing and failing on the same commit, even with little history', () => {
    const sameCommit: ExecutionSample[] = [
      { status: 'failed', commitSha: 'abc', at: 1 },
      { status: 'passed', commitSha: 'abc', at: 2 },
    ];
    expect(analyzeFlakiness(sameCommit)).toMatchObject({ conflictingCommits: 1, score: 0.5, status: 'suspect' });

    const twoCommits: ExecutionSample[] = [
      ...sameCommit,
      { status: 'failed', commitSha: 'def', at: 3 },
      { status: 'passed', commitSha: 'def', at: 4 },
    ];
    expect(analyzeFlakiness(twoCommits).status).toBe('flaky');
  });

  it('detects a test that fails at random 15% of the time', () => {
    const rand = mulberry32(42);
    const pattern = Array.from({ length: 120 }, () => (rand() < 0.15 ? 'F' : 'P')).join('');
    const result = analyzeFlakiness(history(pattern));
    expect(result.status).toBe('flaky');
    expect(result.score).toBeGreaterThan(0.6);
  });

  it('does not count flips on feature branches as flakiness', () => {
    // A PR that breaks and fixes things on every push, each push a new commit.
    const prPushes: ExecutionSample[] = history('PFPFPFPFPF').map((s) => ({ ...s, trusted: false }));
    const result = analyzeFlakiness(prPushes);
    expect(result.flips).toBe(0);
    expect(result.status).toBe('stable');
  });

  it('still counts same-commit conflicts on feature branches', () => {
    const samples: ExecutionSample[] = [
      { status: 'failed', commitSha: 'pr1', at: 1, trusted: false },
      { status: 'passed', commitSha: 'pr1', at: 2, trusted: false },
      { status: 'failed', commitSha: 'pr2', at: 3, trusted: false },
      { status: 'passed', commitSha: 'pr2', at: 4, trusted: false },
    ];
    expect(analyzeFlakiness(samples).status).toBe('flaky');
  });

  it('does not call a failing streak broken when the same commits also passed', () => {
    const samples: ExecutionSample[] = [
      ...history('PPPPPP'),
      { status: 'passed', commitSha: 'x', at: 10 },
      { status: 'failed', commitSha: 'x', at: 11 },
      { status: 'failed', commitSha: 'x', at: 12 },
      { status: 'failed', commitSha: 'x', at: 13 },
    ];
    const result = analyzeFlakiness(samples);
    expect(result.failStreak).toBe(3);
    expect(result.status).not.toBe('broken');
  });

  it('ignores input order', () => {
    const ordered = history('PPPPPFFFF');
    const shuffled = [...ordered].reverse();
    expect(analyzeFlakiness(shuffled)).toEqual(analyzeFlakiness(ordered));
  });

  it('always explains its verdict', () => {
    for (const pattern of ['', 'PP', 'PPPPPPPP', 'PPPPPFFF', 'PFPFPFPFPFPF']) {
      expect(analyzeFlakiness(history(pattern)).reasons.length).toBeGreaterThan(0);
    }
  });
});

describe('wilsonLowerBound', () => {
  it('is more conservative for small samples', () => {
    expect(wilsonLowerBound(2, 3, 1.645)).toBeLessThan(wilsonLowerBound(40, 60, 1.645));
  });

  it('returns 0 for no trials or no successes', () => {
    expect(wilsonLowerBound(0, 0, 1.645)).toBe(0);
    expect(wilsonLowerBound(0, 50, 1.645)).toBe(0);
  });
});

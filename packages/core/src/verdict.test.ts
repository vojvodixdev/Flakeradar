import { describe, expect, it } from 'vitest';
import { COMMENT_MARKER, formatDuration, renderPullRequestComment, verdictFor } from './verdict.js';
import type { RunFailure } from './types.js';

const summary = { total: 120, passed: 117, failed: 3, skipped: 0, durationMs: 83_000 };

function failure(partial: Partial<RunFailure>): RunFailure {
  return {
    testKey: 'A::b',
    name: 'b',
    classname: 'A',
    verdict: 'likely-regression',
    score: 0,
    quarantined: false,
    message: null,
    url: null,
    ...partial,
  };
}

describe('verdictFor', () => {
  it('prefers same-run retry evidence over history', () => {
    expect(verdictFor({ passedInSameRun: true, priorStatus: 'stable' })).toBe('flaky-retry-passed');
  });

  it('maps prior status to a verdict', () => {
    expect(verdictFor({ passedInSameRun: false, priorStatus: 'flaky' })).toBe('known-flaky');
    expect(verdictFor({ passedInSameRun: false, priorStatus: 'suspect' })).toBe('possibly-flaky');
    expect(verdictFor({ passedInSameRun: false, priorStatus: 'broken' })).toBe('known-broken');
    expect(verdictFor({ passedInSameRun: false, priorStatus: 'stable' })).toBe('likely-regression');
    expect(verdictFor({ passedInSameRun: false, priorStatus: 'new' })).toBe('likely-regression');
  });
});

describe('renderPullRequestComment', () => {
  it('includes the marker so the uploader can update its own comment', () => {
    const md = renderPullRequestComment({ summary, failures: [], dashboardUrl: null });
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toContain('all 117 tests passed');
  });

  it('lists regressions before known flakiness and summarises what needs attention', () => {
    const md = renderPullRequestComment({
      summary,
      dashboardUrl: 'https://flakes.example.com/projects/1',
      failures: [
        failure({ name: 'flaky one', verdict: 'known-flaky', score: 0.9 }),
        failure({ name: 'real bug', verdict: 'likely-regression', score: 0.01 }),
        failure({ name: 'retried', verdict: 'flaky-retry-passed', score: 0.5 }),
      ],
    });
    expect(md.indexOf('real bug')).toBeLessThan(md.indexOf('flaky one'));
    expect(md).toContain('1 failure needs attention');
    expect(md).toContain('The other 2 are known flakiness');
    expect(md).toContain('[Open dashboard](https://flakes.example.com/projects/1)');
  });

  it('tells the author a re-run is safe when everything is known flakiness', () => {
    const md = renderPullRequestComment({
      summary,
      dashboardUrl: null,
      failures: [failure({ verdict: 'likely-regression', quarantined: true }), failure({ verdict: 'known-flaky' })],
    });
    expect(md).toContain('All failures look like known flakiness');
    expect(md).toContain('_quarantined_');
  });

  it('escapes characters that would break the Markdown table', () => {
    const md = renderPullRequestComment({
      summary,
      dashboardUrl: null,
      failures: [failure({ name: 'a | b\nc', classname: 'X`Y' })],
    });
    expect(md).toContain('a \\| b c');
    expect(md).toContain("`X'Y`");
  });
});

describe('formatDuration', () => {
  it('formats milliseconds, seconds and minutes', () => {
    expect(formatDuration(250)).toBe('250 ms');
    expect(formatDuration(4_200)).toBe('4.2 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });
});

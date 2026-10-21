import type { FailureVerdict, RunFailure, RunSummary, TestStatus } from './types.js';

/**
 * Decides how to present a failure in a CI run.
 *
 * `priorStatus` must describe the test as it was **before** this run was
 * ingested; otherwise a PR that breaks a test three pushes in a row would
 * make its own failure look like an old, known problem.
 */
export function verdictFor(input: { passedInSameRun: boolean; priorStatus: TestStatus }): FailureVerdict {
  if (input.passedInSameRun) return 'flaky-retry-passed';
  switch (input.priorStatus) {
    case 'broken':
      return 'known-broken';
    case 'flaky':
      return 'known-flaky';
    case 'suspect':
      return 'possibly-flaky';
    default:
      return 'likely-regression';
  }
}

/** True when a failure with this verdict should not block a merge on its own. */
export function isNoise(verdict: FailureVerdict, quarantined: boolean): boolean {
  return quarantined || verdict === 'flaky-retry-passed' || verdict === 'known-flaky';
}

const VERDICT_ORDER: FailureVerdict[] = [
  'likely-regression',
  'possibly-flaky',
  'known-broken',
  'known-flaky',
  'flaky-retry-passed',
];

const VERDICT_LABEL: Record<FailureVerdict, { icon: string; label: string }> = {
  'likely-regression': { icon: '🔴', label: 'Likely regression' },
  'possibly-flaky': { icon: '🟠', label: 'Possibly flaky' },
  'known-broken': { icon: '⚫', label: 'Already broken on the default branch' },
  'known-flaky': { icon: '🟡', label: 'Known flaky' },
  'flaky-retry-passed': { icon: '🟡', label: 'Flaky: passed on retry' },
};

/** Hidden marker so the uploader can update its previous comment instead of adding a new one. */
export const COMMENT_MARKER = '<!-- flakeradar-comment -->';

const MAX_ROWS = 25;

/** Renders the pull request comment for one CI run as GitHub-flavoured Markdown. */
export function renderPullRequestComment(input: {
  summary: RunSummary;
  failures: RunFailure[];
  dashboardUrl: string | null;
}): string {
  const { summary, failures, dashboardUrl } = input;
  const lines: string[] = [COMMENT_MARKER];

  if (failures.length === 0) {
    lines.push(`### ✅ FlakeRadar: all ${summary.passed} tests passed`);
    if (summary.skipped > 0) lines.push('', `${summary.skipped} skipped.`);
  } else {
    const real = failures.filter((f) => !isNoise(f.verdict, f.quarantined));
    const noise = failures.length - real.length;
    lines.push(`### FlakeRadar: ${failures.length} of ${summary.total} tests failed`, '');
    lines.push(headline(real.length, noise), '');

    const sorted = [...failures].sort(
      (a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict) || b.score - a.score,
    );
    lines.push('| | Test | Verdict | Flakiness |', '|---|---|---|---|');
    for (const f of sorted.slice(0, MAX_ROWS)) {
      const { icon, label } = VERDICT_LABEL[f.verdict];
      const name = `\`${escapeCell(f.classname)}\` › ${escapeCell(f.name)}`;
      const linked = f.url ? `[${name}](${f.url})` : name;
      const tag = f.quarantined ? ' · _quarantined_' : '';
      lines.push(`| ${icon} | ${linked} | ${label}${tag} | ${f.score.toFixed(2)} |`);
    }
    if (sorted.length > MAX_ROWS) {
      lines.push('', `…and ${sorted.length - MAX_ROWS} more.`);
    }
  }

  lines.push('');
  const footer = [`${summary.total} tests`, `${summary.skipped} skipped`, formatDuration(summary.durationMs)];
  if (dashboardUrl) footer.push(`[Open dashboard](${dashboardUrl})`);
  lines.push(`<sub>${footer.join(' · ')}</sub>`);

  return lines.join('\n');
}

function headline(real: number, noise: number): string {
  if (real === 0) {
    return `**All failures look like known flakiness.** Re-running the job should be safe, and none of them are likely caused by this change.`;
  }
  if (noise === 0) {
    return `**${real} ${real === 1 ? 'failure needs' : 'failures need'} attention.** None of them have a history of flakiness.`;
  }
  const rest = noise === 1 ? 'The other failure is' : `The other ${noise} are`;
  return `**${real} ${real === 1 ? 'failure needs' : 'failures need'} attention.** ${rest} known flakiness and can be ignored.`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/`/g, "'").replace(/\r?\n/g, ' ');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds % 60)} s`;
}

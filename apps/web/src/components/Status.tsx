import type { StatusCounts, TestStatus } from '@flakeradar/core';

export const STATUS_LABEL: Record<TestStatus, string> = {
  flaky: 'Flaky',
  suspect: 'Suspect',
  broken: 'Broken',
  stable: 'Stable',
  new: 'New',
};

export const STATUS_HELP: Record<TestStatus, string> = {
  flaky: 'Passes and fails on the same code',
  suspect: 'Some signs of flakiness, worth watching',
  broken: 'Fails every time: a real bug',
  stable: 'Behaves the same way every run',
  new: 'Not enough runs for a verdict yet',
};

/** Display order, most urgent first. */
export const STATUS_ORDER: TestStatus[] = ['flaky', 'broken', 'suspect', 'stable', 'new'];

export function StatusPill({ status }: { status: TestStatus }) {
  return (
    <span className={`pill pill-${status}`} title={STATUS_HELP[status]}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Proportional bar of how the suite splits across statuses. Each segment is
 * also a filter button, so the chart doubles as navigation.
 */
export function StatusDistribution({
  counts,
  active,
  onSelect,
}: {
  counts: StatusCounts;
  active?: TestStatus | null;
  onSelect?: (status: TestStatus | null) => void;
}) {
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  if (total === 0) return null;
  const present = STATUS_ORDER.filter((s) => counts[s] > 0);

  return (
    <div className="distribution">
      <div className="distribution-bar" aria-hidden="true">
        {present.map((s) => (
          <span
            key={s}
            className={`seg seg-${s}${active && active !== s ? ' is-dimmed' : ''}`}
            style={{ flexGrow: counts[s] }}
          />
        ))}
      </div>
      <div className="distribution-legend" role="group" aria-label="Filter tests by status">
        {present.map((s) => {
          const label = (
            <>
              <span className={`swatch swatch-${s}`} aria-hidden="true" />
              <span className="legend-count">{counts[s]}</span> {STATUS_LABEL[s].toLowerCase()}
            </>
          );
          return onSelect ? (
            <button
              key={s}
              type="button"
              className={`legend-item${active === s ? ' is-active' : ''}`}
              aria-pressed={active === s}
              onClick={() => onSelect(active === s ? null : s)}
              title={STATUS_HELP[s]}
            >
              {label}
            </button>
          ) : (
            <span key={s} className="legend-item">
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function ScoreMeter({ score }: { score: number }) {
  const level = score >= 0.6 ? 'high' : score >= 0.25 ? 'mid' : 'low';
  return (
    <span className="score" title={`Flakiness score ${score.toFixed(2)} of 1`}>
      <span className="score-value">{score.toFixed(2)}</span>
      <span className="score-track" aria-hidden="true">
        <span className={`score-fill score-${level}`} style={{ width: `${Math.max(score * 100, 2)}%` }} />
      </span>
    </span>
  );
}

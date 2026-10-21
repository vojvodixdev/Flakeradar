import type { TrendPoint } from '@flakeradar/core';
import { useState } from 'react';
import { plural } from '../format';

const HEIGHT = 140;
const BAR_GAP = 3;

/**
 * Daily failures over the window, stacked: real failures at the base (the
 * ones that matter), flakiness on top (the noise you want to drive to zero).
 */
export function TrendChart({ points }: { points: TrendPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...points.map((p) => p.noiseFailures + p.realFailures));
  const totalNoise = points.reduce((s, p) => s + p.noiseFailures, 0);
  const totalReal = points.reduce((s, p) => s + p.realFailures, 0);
  const width = 100 / points.length;
  const focused = hover !== null ? points[hover] : null;

  const tickEvery = points.length > 14 ? 7 : 1;
  const yTicks = niceTicks(max);

  return (
    <figure className="trend">
      <figcaption className="trend-head">
        <span className="trend-title">Failing tests per day</span>
        <span className="trend-legend">
          <span>
            <span className="swatch swatch-real" aria-hidden="true" /> real failures ({totalReal})
          </span>
          <span>
            <span className="swatch swatch-noise" aria-hidden="true" /> flakiness ({totalNoise})
          </span>
        </span>
      </figcaption>

      <div className="trend-plot" onMouseLeave={() => setHover(null)}>
        <div className="trend-y" aria-hidden="true">
          {yTicks.map((t) => (
            <span key={t} style={{ bottom: `${(t / yTicks[yTicks.length - 1]!) * 100}%` }}>
              {t}
            </span>
          ))}
        </div>
        <svg
          className="trend-svg"
          viewBox={`0 0 100 ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Over ${points.length} days: ${plural(totalReal, 'real failure')} and ${plural(totalNoise, 'flaky failure')}.`}
        >
          {yTicks.map((t) => {
            const y = HEIGHT - (t / yTicks[yTicks.length - 1]!) * HEIGHT;
            return <line key={t} x1="0" x2="100" y1={y} y2={y} className="trend-grid" vectorEffect="non-scaling-stroke" />;
          })}
          {points.map((p, i) => {
            const scale = HEIGHT / yTicks[yTicks.length - 1]!;
            const realH = p.realFailures * scale;
            const noiseH = p.noiseFailures * scale;
            const x = i * width;
            const w = Math.max(width - (BAR_GAP * width) / 10, width * 0.5);
            return (
              <g key={p.date} className={hover === i ? 'is-hover' : undefined}>
                <rect
                  x={x}
                  y={0}
                  width={width}
                  height={HEIGHT}
                  className="trend-hit"
                  onMouseEnter={() => setHover(i)}
                />
                {realH > 0 && <rect x={x} y={HEIGHT - realH} width={w} height={realH} className="bar-real" />}
                {noiseH > 0 && (
                  <rect x={x} y={HEIGHT - realH - noiseH} width={w} height={noiseH} className="bar-noise" />
                )}
              </g>
            );
          })}
        </svg>
        {focused && hover !== null && (
          <div
            className="trend-tip"
            style={{ left: `${Math.min(Math.max((hover + 0.5) * width, 12), 88)}%` }}
            role="status"
          >
            <strong>{formatDay(focused.date)}</strong>
            <span>{plural(focused.runs, 'run')}</span>
            <span>{plural(focused.realFailures, 'real failure')}</span>
            <span>{plural(focused.noiseFailures, 'flaky failure')}</span>
          </div>
        )}
      </div>

      <div className="trend-x" aria-hidden="true">
        {points.map((p, i) =>
          i % tickEvery === 0 ? (
            <span key={p.date} style={{ left: `${(i + 0.5) * width}%` }}>
              {formatDay(p.date)}
            </span>
          ) : null,
        )}
      </div>
    </figure>
  );
}

function formatDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** 0 plus up to four round steps covering `max`. */
function niceTicks(max: number): number[] {
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? rough;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) ticks.push(Math.round(v));
  return ticks;
}

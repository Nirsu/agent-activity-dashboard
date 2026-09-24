import { useEffect, useRef, useState } from 'react';
import { tokens, usd } from '../../format';
import type { TrendsReport } from './useTrends';
import {
  bucketHasHistory,
  bucketLabel,
  exactCost,
  metricValue,
  trendDateAt,
  trendTimestamp,
  type TrendMetric,
} from './format';

const HEIGHT = 260;
const PAD = { left: 68, right: 14, top: 24, bottom: 34 };
const METRICS: Array<{ key: TrendMetric; label: string }> = [
  { key: 'cost', label: 'Cost' },
  { key: 'tokens', label: 'Tokens' },
  { key: 'prompts', label: 'Prompts' },
];

export function UsageChart({ data }: { data: TrendsReport }) {
  const [metric, setMetric] = useState<TrendMetric>('cost');
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    if (!container.current || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setWidth(Math.max(260, Math.round(entry.contentRect.width)));
      }
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  const unit = data.period.granularity;
  const title = `${metric === 'cost' ? 'Known cost' : metric === 'tokens' ? 'Known tokens' : 'Prompts'} per ${unit}`;
  const values = data.buckets.map((bucket) =>
    bucketHasHistory(bucket, data) ? metricValue(bucket, metric) : null,
  );
  const maximum = Math.max(metric === 'cost' ? 0.01 : 1, ...values.map((value) => value ?? 0));
  const barWidth = (width - PAD.left - PAD.right) / Math.max(1, data.buckets.length);
  const labelStep = Math.max(1, Math.ceil(70 / barWidth));
  const chartHeight = HEIGHT - PAD.top - PAD.bottom;
  const hasUnknown = values.some((value) => value === null);

  return (
    <section className="trends-chart-card">
      <div className="trends-card-heading">
        <div>
          <h2 className="trends-chart-title">Activity over time</h2>
          <p className="trends-chart-caption">
            {title} · {data.period.timeZone}
          </p>
        </div>
        <div className="trends-segmented" role="group" aria-label="Chart metric">
          {METRICS.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={metric === item.key}
              onClick={() => setMetric(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="trends-chart-legend">
        <span>
          <i className="trends-legend-known" />
          {metric === 'prompts' ? 'Recorded prompts' : `Known ${metric}`}
        </span>
        {hasUnknown && (
          <span>
            <i className="trends-legend-unknown" />
            Unavailable
          </span>
        )}
        <span className="trends-granularity">Grouped by {unit}</span>
      </div>
      <div ref={container} className="trends-chart">
        <svg
          className="trends-svg"
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-label={`${title}. Exact values are available under View detailed figures.`}
        >
          {[0, 0.5, 1].map((fraction) => {
            const y = PAD.top + chartHeight * (1 - fraction);
            return (
              <g key={fraction}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={y}
                  y2={y}
                  className="trends-gridline"
                />
                <text x={PAD.left - 10} y={y + 4} textAnchor="end" className="trends-axis">
                  {metric === 'cost'
                    ? usd(maximum * fraction)
                    : tokens(Math.round(maximum * fraction))}
                </text>
              </g>
            );
          })}
          {data.buckets.map((bucket, index) => {
            const value = values[index];
            const height = value === null ? 0 : (value / maximum) * chartHeight;
            const x = PAD.left + index * barWidth;
            const showLabel =
              (index % labelStep === 0 && index < data.buckets.length - labelStep / 2) ||
              index === data.buckets.length - 1;
            const label = bucketLabel(bucket, data.period);
            const detail =
              value === null
                ? 'Unavailable'
                : metric === 'cost'
                  ? exactCost(value)
                  : value.toLocaleString();
            return (
              <g key={bucket.start}>
                <rect
                  x={x + 3}
                  y={PAD.top + chartHeight - (value === null ? 5 : Math.max(2, height))}
                  width={Math.max(1, barWidth - 6)}
                  height={value === null ? 5 : Math.max(2, height)}
                  rx={3}
                  className={
                    value === null
                      ? 'trends-bar-unavailable'
                      : value === 0
                        ? 'trends-bar-zero'
                        : 'trends-bar'
                  }
                >
                  <title>{`${trendTimestamp(bucket.start, data.period.timeZone)}: ${detail} ${metric === 'cost' ? 'USD' : metric}${bucket.unknownUsageCount > 0 ? ` · ${bucket.unknownUsageCount} unknown costs` : ''}`}</title>
                </rect>
                {showLabel && (
                  <text
                    x={x + barWidth / 2}
                    y={HEIGHT - 8}
                    textAnchor="middle"
                    className="trends-axis"
                  >
                    {label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      {values.every((value) => value === null) && (
        <p className="trends-empty-inline">
          No known {metric} for this period. Unavailable usage is not treated as zero.
        </p>
      )}
      <p className="trends-chart-footnote">
        {metric === 'prompts'
          ? 'Each recorded user prompt is counted once.'
          : 'Missing observations are excluded from the known totals.'}{' '}
        {data.period.endDate === trendDateAt(Date.now(), data.period.timeZone) &&
          `The last ${unit} may still be in progress.`}
      </p>
      <DetailedFigures data={data} />
    </section>
  );
}

function DetailedFigures({ data }: { data: TrendsReport }) {
  return (
    <details className="trends-daily">
      <summary>View detailed figures</summary>
      <div
        className="trends-table-scroll"
        tabIndex={0}
        role="region"
        aria-label="Detailed usage figures"
      >
        <table>
          <caption>
            Figures by {data.period.granularity} · {data.period.timeZone} · sessions are unique
            within each row; the headline counts each session once across the entire period.
          </caption>
          <thead>
            <tr>
              <th scope="col">Period starting</th>
              <th scope="col">Known cost</th>
              <th scope="col">Input tokens</th>
              <th scope="col">Output tokens</th>
              <th scope="col">Prompts</th>
              <th scope="col">Sessions</th>
              <th scope="col">Unknown costs</th>
              <th scope="col">Unknown tokens</th>
            </tr>
          </thead>
          <tbody>
            {data.buckets.map((bucket) => {
              const available = bucketHasHistory(bucket, data);
              return (
                <tr key={bucket.start}>
                  <th scope="row">
                    <time dateTime={new Date(bucket.start).toISOString()}>
                      {trendTimestamp(bucket.start, data.period.timeZone)}
                    </time>
                  </th>
                  <td>
                    {available && bucket.costKnown ? exactCost(bucket.costUsd) : 'Unavailable'}
                  </td>
                  <td>
                    {available && bucket.tokensInKnown
                      ? bucket.tokensIn.toLocaleString()
                      : 'Unavailable'}
                  </td>
                  <td>
                    {available && bucket.tokensOutKnown
                      ? bucket.tokensOut.toLocaleString()
                      : 'Unavailable'}
                  </td>
                  <td>{available ? bucket.prompts.toLocaleString() : 'Unavailable'}</td>
                  <td>{available ? bucket.sessions.toLocaleString() : 'Unavailable'}</td>
                  <td>{available ? bucket.unknownUsageCount.toLocaleString() : 'Unavailable'}</td>
                  <td>{available ? bucket.unknownTokenCount.toLocaleString() : 'Unavailable'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

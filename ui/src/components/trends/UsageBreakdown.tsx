import { useState } from 'react';
import { tokens, usd } from '../../format';
import type { TrendsBreakdown, TrendsReport } from './useTrends';

type Dimension = 'provider' | 'model' | 'team';

export function UsageBreakdown({ data }: { data: TrendsReport }) {
  const [dimension, setDimension] = useState<Dimension>('provider');
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost');
  const rows: Array<TrendsBreakdown & { id: string; name: string; detail: string }> =
    dimension === 'provider'
      ? data.byProvider.map((row) => ({
          ...row,
          id: row.provider,
          name: row.provider,
          detail: `${row.usageCount.toLocaleString()} observations`,
        }))
      : dimension === 'model'
        ? data.byModel.map((row) => ({
            ...row,
            id: `${row.provider}/${row.model}`,
            name: row.model,
            detail: row.provider,
          }))
        : data.byStream.map((row) => ({
            ...row,
            id: row.teamId,
            name: row.teamName || row.teamId,
            detail: `${row.usageCount.toLocaleString()} observations`,
          }));
  const value = (row: TrendsBreakdown) => (metric === 'cost' ? row.costUsd : row.tokens);
  const isKnown = (row: TrendsBreakdown) => (metric === 'cost' ? row.costKnown : row.tokensKnown);
  const maximum = Math.max(0.0001, ...rows.filter(isKnown).map(value));
  const sortedRows = [...rows].sort(
    (left, right) => Number(isKnown(right)) - Number(isKnown(left)) || value(right) - value(left),
  );

  return (
    <section className="trends-chart-card trends-breakdown-card">
      <div className="trends-card-heading">
        <div>
          <h2 className="trends-chart-title">Where usage comes from</h2>
          <p className="trends-chart-caption">
            Explore the providers, models and teams behind your activity.
          </p>
        </div>
        <div className="trends-segmented" role="group" aria-label="Breakdown metric">
          <button type="button" aria-pressed={metric === 'cost'} onClick={() => setMetric('cost')}>
            Cost
          </button>
          <button
            type="button"
            aria-pressed={metric === 'tokens'}
            onClick={() => setMetric('tokens')}
          >
            Tokens
          </button>
        </div>
      </div>
      <div className="trends-breakdown-tabs" role="group" aria-label="Breakdown dimension">
        {(['provider', 'model', 'team'] as const).map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={dimension === item}
            onClick={() => setDimension(item)}
          >
            {item === 'provider' ? 'Providers' : item === 'model' ? 'Models' : 'Teams'}
          </button>
        ))}
      </div>
      <div className="trends-breakdown-labels" aria-hidden="true">
        <span>
          {dimension === 'provider' ? 'Provider' : dimension === 'model' ? 'Model' : 'Team'}
        </span>
        <span>{metric === 'cost' ? 'Known cost' : 'Known tokens'}</span>
      </div>
      {sortedRows.length === 0 && (
        <p className="trends-empty-inline">No {dimension} activity recorded for this period.</p>
      )}
      <ul
        className="trends-breakdown-list"
        tabIndex={0}
        aria-label={`${dimension} usage breakdown`}
      >
        {sortedRows.map((row, index) => (
          <li key={row.id} className="trends-breakdown-row">
            <span className="trends-breakdown-rank" aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </span>
            <div className="trends-breakdown-identity">
              <span className="trends-breakdown-name" title={row.name}>
                {row.name}
              </span>
              <span className="trends-breakdown-detail">{row.detail}</span>
            </div>
            <div className="trends-stream-bar" aria-hidden="true">
              <div
                className="trends-stream-fill"
                style={{ width: `${isKnown(row) ? (value(row) / maximum) * 100 : 0}%` }}
              />
            </div>
            <div className="trends-breakdown-value">
              <span>
                {isKnown(row)
                  ? metric === 'cost'
                    ? usd(row.costUsd)
                    : tokens(row.tokens)
                  : 'Unavailable'}
              </span>
              {(metric === 'cost' ? row.unknownUsageCount : row.unknownTokenCount) > 0 && (
                <small>Partial usage</small>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="trends-chart-footnote">
        {dimension === 'team'
          ? 'Shared activity appears in each team. Overall totals count it once.'
          : 'Known usage only. Unidentified activity appears under unknown.'}
      </p>
    </section>
  );
}

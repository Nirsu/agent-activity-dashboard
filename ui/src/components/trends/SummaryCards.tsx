import { tokens, usd } from '../../format';
import type { TrendsReport } from './useTrends';

type SummaryMetric = 'cost' | 'tokens' | 'prompts' | 'sessions';

export function comparisonLabel(data: TrendsReport, metric: SummaryMetric) {
  if (!data.coverage.currentComplete || !data.coverage.previousComplete) {
    return 'No comparable period yet';
  }
  if (
    metric === 'cost' &&
    (!data.summary.costKnown ||
      !data.previous.costKnown ||
      data.summary.unknownUsageCount > 0 ||
      data.previous.unknownUsageCount > 0)
  ) {
    return 'Cost comparison unavailable';
  }
  if (
    metric === 'tokens' &&
    (!data.summary.tokensKnown ||
      !data.previous.tokensKnown ||
      data.summary.unknownTokenCount > 0 ||
      data.previous.unknownTokenCount > 0)
  ) {
    return 'Token comparison unavailable';
  }
  const current = metric === 'cost' ? data.summary.costUsd : data.summary[metric];
  const previous = metric === 'cost' ? data.previous.costUsd : data.previous[metric];
  if (previous === 0) {
    return current === 0 ? 'No change' : 'Previous value was zero';
  }
  const change = ((current - previous) / previous) * 100;
  if (change === 0) {
    return 'No change';
  }
  const magnitude =
    Math.abs(change) < 0.1
      ? '<0.1'
      : Math.abs(change).toLocaleString('en-US', { maximumFractionDigits: 1 });
  return `${change > 0 ? '↑' : '↓'} ${magnitude}% vs previous period`;
}

export function SummaryCards({ data }: { data: TrendsReport }) {
  const totals = data.summary;
  const cards: Array<{ metric: SummaryMetric; label: string; value: string; hint: string }> = [
    {
      metric: 'cost',
      label: 'Known cost',
      value: totals.costKnown ? usd(totals.costUsd) : 'Unavailable',
      hint:
        totals.unknownUsageCount > 0
          ? `${totals.unknownUsageCount.toLocaleString()} unpriced observations`
          : 'USD · recorded usage',
    },
    {
      metric: 'tokens',
      label: 'Known tokens',
      value: totals.tokensKnown ? tokens(totals.tokens) : 'Unavailable',
      hint: totals.tokensKnown
        ? `${totals.tokensInKnown ? tokens(totals.tokensIn) : 'Unknown'} input · ${totals.tokensOutKnown ? tokens(totals.tokensOut) : 'Unknown'} output`
        : 'No token observations',
    },
    {
      metric: 'prompts',
      label: 'Prompts',
      value: totals.prompts.toLocaleString(),
      hint: 'Recorded user prompts',
    },
    {
      metric: 'sessions',
      label: 'Unique sessions',
      value: totals.sessions.toLocaleString(),
      hint: 'Counted once across the period',
    },
  ];
  return (
    <div className="trends-tiles">
      {cards.map((card) => (
        <article key={card.metric} className={`trends-tile trends-tile-${card.metric}`}>
          <h2 className="trends-tile-label">{card.label}</h2>
          <div className={`trends-tile-value ${card.metric === 'cost' ? 'accent' : ''}`}>
            {card.value}
          </div>
          <p className="trends-tile-hint">{card.hint}</p>
          <p className="trends-tile-comparison">{comparisonLabel(data, card.metric)}</p>
        </article>
      ))}
    </div>
  );
}

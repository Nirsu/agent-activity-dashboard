import type { TrendsBucket, TrendsReport } from './useTrends';

export type TrendMetric = 'cost' | 'tokens' | 'prompts';

export function trendDateAt(timestamp: number, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp));
}

export function trendDayLabel(day: string, includeYear = false) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(includeYear ? { year: 'numeric' as const } : {}),
    timeZone: 'UTC',
  });
}

export function trendTimestamp(timestamp: number, timeZone: string) {
  return new Date(timestamp).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'shortOffset',
    timeZone,
  });
}

export function bucketLabel(bucket: TrendsBucket, period: TrendsReport['period']) {
  if (period.granularity === 'hour') {
    return new Date(bucket.start).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: period.timeZone,
    });
  }
  return trendDayLabel(bucket.day);
}

export function exactCost(value: number) {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`;
}

export function metricValue(bucket: TrendsBucket, metric: TrendMetric) {
  if (metric === 'cost') {
    return bucket.costKnown ? bucket.costUsd : null;
  }
  if (metric === 'tokens') {
    return bucket.tokensKnown ? bucket.tokens : null;
  }
  return bucket.prompts;
}

export function bucketHasHistory(bucket: TrendsBucket, data: TrendsReport) {
  const earliest = data.coverage.earliestAvailableAt;
  return data.coverage.currentComplete || earliest === null || bucket.end > earliest;
}

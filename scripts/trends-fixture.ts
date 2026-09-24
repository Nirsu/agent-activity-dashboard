import type { TrendsBucket, TrendsReport, TrendsTotals } from '../server/src/trends/types';

export function trendTotals(overrides: Partial<TrendsTotals> = {}): TrendsTotals {
  return {
    costUsd: 1.73456,
    tokensIn: 250,
    tokensOut: 70,
    tokens: 320,
    cachedTokens: 100,
    cacheKnown: true,
    prompts: 3,
    sessions: 2,
    costKnown: true,
    knownCostCount: 2,
    tokensKnown: true,
    tokensInKnown: true,
    tokensOutKnown: true,
    unknownUsageCount: 0,
    unknownTokenCount: 0,
    usageCount: 2,
    unattributedUsageCount: 0,
    unattributedCostUsd: 0,
    ...overrides,
  };
}

export function trendsFixture(overrides: Partial<TrendsReport> = {}): TrendsReport {
  const start = Date.parse('2026-09-22T00:00:00Z');
  const end = Date.parse('2026-09-24T00:00:00Z');
  const days: TrendsBucket[] = [
    {
      ...trendTotals({ costUsd: 0.5, tokensIn: 150, tokensOut: 50, tokens: 200, prompts: 2 }),
      start,
      end: start + 86_400_000,
      day: '2026-09-22',
    },
    {
      ...trendTotals({
        costUsd: 1.23456,
        tokensIn: 100,
        tokensOut: 20,
        tokens: 120,
        prompts: 1,
        sessions: 1,
      }),
      start: start + 86_400_000,
      end,
      day: '2026-09-23',
    },
  ];
  return {
    enabled: true,
    backend: 'sqlite',
    period: {
      key: '14d',
      start,
      end,
      startDate: '2026-09-22',
      endDate: '2026-09-23',
      previousStart: start - 2 * 86_400_000,
      previousEnd: start,
      timeZone: 'UTC',
      granularity: 'day',
      dayCount: 2,
    },
    summary: trendTotals(),
    previous: trendTotals({
      costUsd: 1,
      tokensIn: 200,
      tokensOut: 0,
      tokens: 200,
      prompts: 6,
      sessions: 1,
    }),
    buckets: days,
    days,
    byProvider: [
      { ...trendTotals(), provider: 'openai' },
      {
        ...trendTotals({ costKnown: false, costUsd: 0, unknownUsageCount: 1 }),
        provider: 'anthropic',
      },
    ],
    byModel: [{ ...trendTotals(), provider: 'openai', model: 'gpt-test-model' }],
    byStream: [{ ...trendTotals(), teamId: 'test-team', teamName: 'Test team' }],
    byTeam: [
      {
        id: 'test-team',
        name: 'Test team',
        current: trendTotals(),
        previous: trendTotals({ costUsd: 1 }),
      },
    ],
    byPerson: [
      {
        id: 'person-a',
        name: 'calm-otter-01',
        current: trendTotals(),
        previous: trendTotals({ costUsd: 1 }),
      },
    ],
    audience: {
      teams: [{ id: 'test-team', name: 'Test team' }],
      people: [{ id: 'person-a', name: 'calm-otter-01', teamIds: ['test-team'] }],
    },
    filters: {},
    coverage: {
      retentionDays: 180,
      earliestAvailableAt: start - 90 * 86_400_000,
      currentComplete: true,
      previousComplete: true,
    },
    insights: {
      averageDailyCostUsd: 0.86728,
      peakDay: { day: '2026-09-23', costUsd: 1.23456 },
    },
    ...overrides,
  };
}

export type TrendsPeriod = 'today' | '7d' | '14d' | 'month' | '30d' | '90d' | 'custom';
export type TrendsGranularity = 'hour' | 'day' | 'week';

export interface TrendsQuery {
  period?: string;
  start?: string;
  end?: string;
  team?: string;
  person?: string;
}

export interface TrendsUsageTotals {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  costKnown: boolean;
  knownCostCount: number;
  tokensKnown: boolean;
  unknownUsageCount: number;
  usageCount: number;
  unattributedUsageCount: number;
  unattributedCostUsd: number;
}

export interface TrendsTotals extends TrendsBreakdown {
  prompts: number;
  sessions: number;
}

export interface TrendsBucket extends TrendsTotals {
  start: number;
  end: number;
  day: string;
}

export interface TrendsBreakdown extends TrendsUsageTotals {
  cachedTokens: number;
  cacheKnown: boolean;
  tokens: number;
  tokensInKnown: boolean;
  tokensOutKnown: boolean;
  unknownTokenCount: number;
}

export interface TrendsAudienceRow {
  id: string;
  name: string;
  current: TrendsTotals;
  previous: TrendsTotals;
}

export interface TrendsAudienceOptions {
  teams: Array<{ id: string; name: string }>;
  people: Array<{ id: string; name: string; teamIds: string[] }>;
}

export interface TrendsReport {
  enabled: boolean;
  backend: 'postgres' | 'sqlite' | 'disabled';
  period: {
    key: TrendsPeriod;
    start: number;
    end: number;
    startDate: string;
    endDate: string;
    // Previous calendar window of the same selected day count and local clock
    // position. Millisecond duration can differ at daylight-saving transitions.
    previousStart: number;
    previousEnd: number;
    timeZone: string;
    granularity: TrendsGranularity;
    dayCount: number;
  };
  summary: TrendsTotals;
  previous: TrendsTotals;
  buckets: TrendsBucket[];
  days: TrendsBucket[];
  byProvider: Array<TrendsBreakdown & { provider: string }>;
  byModel: Array<TrendsBreakdown & { provider: string; model: string }>;
  byStream: Array<TrendsBreakdown & { teamId: string; teamName: string }>;
  byTeam: TrendsAudienceRow[];
  byPerson: TrendsAudienceRow[];
  audience: TrendsAudienceOptions;
  filters: { team?: string; person?: string };
  coverage: {
    ignoredCostCount?: number;
    retentionDays: number;
    earliestAvailableAt: number | null;
    currentComplete: boolean;
    previousComplete: boolean;
  };
  insights: {
    averageDailyCostUsd: number;
    peakDay: { day: string; costUsd: number } | null;
  };
}

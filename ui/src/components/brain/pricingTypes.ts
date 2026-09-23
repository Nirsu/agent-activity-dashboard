export type Rates = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedInputPerMillionUsd?: number;
};
export type PriceVersion = {
  at: number;
  rates: Rates | null;
  sourceUrl: string;
  origin: 'environment' | 'manual' | 'agent';
  checkedAt?: string;
  evidence?: string;
  notes?: string;
};
export type PricingVerification = {
  model: string;
  sourceUrl: string;
  checkedAt?: string;
  rates?: Rates | null;
  evidence?: string;
  notes?: string;
  proposed?: boolean;
};
export type PricingModel = {
  model: string;
  provider: 'openai' | 'anthropic';
  sourceUrl: string;
  revision: number;
  versions: PriceVersion[];
  ignored?: boolean;
  detectedAt?: string;
  automatic?: {
    status: 'queued' | 'checking' | 'failed' | 'applied';
    attempts: number;
    retryAt?: number;
    error?: string;
  };
};
export type PricingProposal = {
  model: string;
  revision: number;
  sourceUrl: string;
  checkedAt: string;
  rates?: Rates;
  evidence?: string;
  notes?: string;
  error?: string;
  appliedAt?: string;
  usage?: { inputTokens: number; outputTokens: number; usageKnown?: boolean };
};
export type PricingState = {
  models: PricingModel[];
  agent: { configured: boolean; model: string };
  automation?: { enabled: boolean; checking: boolean; error?: string };
  job?: {
    id: string;
    status: 'running' | 'completed' | 'interrupted' | 'failed';
    startedAt: string;
    models: string[];
    proposals: PricingProposal[];
    error?: string;
  };
};

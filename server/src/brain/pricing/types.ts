import type { ModelPrice } from '../../model-cost.js';
import type { ModelResult } from '../analysis/types.js';

export type PricingProvider = 'openai' | 'anthropic';
export type PriceVersion = {
  at: number;
  rates: ModelPrice | null;
  sourceUrl: string;
  origin: 'environment' | 'manual' | 'agent';
  checkedAt?: string;
  evidence?: string;
  notes?: string;
};
export type PricingModel = {
  model: string;
  provider: PricingProvider;
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
  rates?: ModelPrice;
  evidence?: string;
  notes?: string;
  error?: string;
  retryable?: boolean;
  appliedAt?: string;
  usage?: Omit<ModelResult, 'value'>;
};
export type PricingJob = {
  id: string;
  status: 'running' | 'completed' | 'interrupted' | 'failed';
  startedAt: string;
  models: string[];
  proposals: PricingProposal[];
  error?: string;
};
export type PricingCatalogue = { models: PricingModel[]; job?: PricingJob };

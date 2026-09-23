import type { PricingModel, PricingProposal, PricingState, Rates } from './pricingTypes';

export function pricingAttentionModels(state: PricingState) {
  return state.models
    .filter((entry) => {
      if (entry.ignored) {
        return false;
      }
      const proposal = state.job?.proposals.find((item) => item.model === entry.model);
      if (proposal && proposalReady(proposal, state.models)) {
        return true;
      }
      if (
        proposal &&
        !proposal.appliedAt &&
        (proposal.error || proposal.revision !== entry.revision)
      ) {
        return true;
      }
      if (
        state.job &&
        ['interrupted', 'failed'].includes(state.job.status) &&
        state.job.models.includes(entry.model) &&
        !proposal
      ) {
        return true;
      }
      if (!entry.sourceUrl) {
        return true;
      }
      const version = entry.versions.at(-1);
      if (!version?.rates) {
        const waiting = entry.automatic && ['queued', 'checking'].includes(entry.automatic.status);
        return !(waiting && state.automation?.enabled && state.agent.configured);
      }
      return Boolean(version.checkedAt && version.sourceUrl !== entry.sourceUrl);
    })
    .map((entry) => entry.model);
}

export const pricingColumns: { key: keyof Rates; label: string }[] = [
  { key: 'inputPerMillionUsd', label: 'Input' },
  { key: 'cachedInputPerMillionUsd', label: 'Cached input' },
  { key: 'outputPerMillionUsd', label: 'Output' },
];

export function formatPrice(value?: number) {
  return value == null
    ? 'Not set'
    : `$${value.toLocaleString('en-US', { maximumFractionDigits: 8 })}`;
}

export function priceChange(previous: number | undefined, next: number | undefined) {
  if (previous === next) {
    return 'No change';
  }
  if (next === undefined) {
    return 'Now unknown';
  }
  if (previous === undefined) {
    return 'New price';
  }
  const difference = next - previous;
  return `${difference > 0 ? '+' : '−'}${formatPrice(Math.abs(difference))}`;
}

export function proposalReady(proposal: PricingProposal, models: PricingModel[]) {
  return Boolean(
    proposal.rates &&
    !proposal.error &&
    !proposal.appliedAt &&
    models.some(
      (entry) =>
        !entry.ignored && entry.model === proposal.model && entry.revision === proposal.revision,
    ),
  );
}

export function modelPricingStatus(entry: PricingModel) {
  if (entry.ignored) {
    return { label: 'Ignored', tone: 'neutral' };
  }
  const version = entry.versions.at(-1);
  if (!entry.sourceUrl) {
    return { label: 'Source needed', tone: 'attention' };
  }
  if (!version?.rates) {
    if (entry.automatic?.status === 'checking') {
      return { label: 'Checking…', tone: 'review' };
    }
    if (entry.automatic?.status === 'queued') {
      return { label: entry.automatic.retryAt ? 'Retry scheduled' : 'Queued', tone: 'neutral' };
    }
    if (entry.automatic?.status === 'failed') {
      return { label: 'Needs attention', tone: 'attention' };
    }
    return { label: 'Ready to check', tone: 'neutral' };
  }
  if (version.checkedAt && version.sourceUrl === entry.sourceUrl) {
    return { label: 'Agent checked', tone: 'checked' };
  }
  return { label: version.checkedAt ? 'Source changed' : 'Not checked', tone: 'neutral' };
}

export function comparisonRates(proposal: PricingProposal, entry?: PricingModel) {
  if (!proposal.appliedAt) {
    return entry?.versions.at(-1)?.rates;
  }
  const appliedIndex =
    entry?.versions.findIndex(
      (version) => version.origin === 'agent' && version.checkedAt === proposal.checkedAt,
    ) ?? -1;
  return appliedIndex > 0 ? entry?.versions[appliedIndex - 1].rates : undefined;
}

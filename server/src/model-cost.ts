type ModelPrice = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedInputPerMillionUsd?: number;
};

/** A user-configured valuation, never a billing amount. Missing rates remain unknown. */
export function estimateModelCost(usage: {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}): number | null {
  if (!usage.model || usage.inputTokens === undefined || usage.outputTokens === undefined) {
    return null;
  }
  const cached = usage.cachedInputTokens ?? 0;
  if (![usage.inputTokens, usage.outputTokens, cached].every((value) => Number.isSafeInteger(value) && value >= 0) || cached > usage.inputTokens) {
    return null;
  }
  let prices: Record<string, ModelPrice>;
  try {
    prices = JSON.parse(process.env.MODEL_PRICING_JSON ?? '{}');
  } catch {
    return null;
  }
  const price = prices?.[usage.model];
  if (!price || ![price.inputPerMillionUsd, price.outputPerMillionUsd].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
    return null;
  }
  if (cached > 0 && (typeof price.cachedInputPerMillionUsd !== 'number' || !Number.isFinite(price.cachedInputPerMillionUsd) || price.cachedInputPerMillionUsd < 0)) {
    return null;
  }
  const amount = ((usage.inputTokens - cached) * price.inputPerMillionUsd + usage.outputTokens * price.outputPerMillionUsd + cached * (price.cachedInputPerMillionUsd ?? 0)) / 1_000_000;
  return Number.isFinite(amount) ? Number(amount.toFixed(9)) : null;
}

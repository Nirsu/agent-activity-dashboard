import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateModelCost } from './model-cost.js';

test('valuation distinguishes missing usage, uncached input and cached input', () => {
  const previous = process.env.MODEL_PRICING_JSON;
  process.env.MODEL_PRICING_JSON = JSON.stringify({ test: { inputPerMillionUsd: 2, outputPerMillionUsd: 8, cachedInputPerMillionUsd: 0.5 } });
  try {
    assert.equal(estimateModelCost({ model: 'test', inputTokens: 1000, outputTokens: 500, cachedInputTokens: 400 }), 0.0054);
    assert.equal(estimateModelCost({ model: 'test', inputTokens: 0, outputTokens: 0 }), 0);
    assert.equal(estimateModelCost({ model: 'test', inputTokens: 1000 }), null);
    assert.equal(estimateModelCost({ model: 'missing', inputTokens: 1000, outputTokens: 500 }), null);
    assert.equal(estimateModelCost({ model: 'test', inputTokens: 100, outputTokens: 500, cachedInputTokens: 200 }), null);
  } finally {
    if (previous === undefined) delete process.env.MODEL_PRICING_JSON;
    else process.env.MODEL_PRICING_JSON = previous;
  }
});

test('a missing cached-input rate does not silently charge the uncached price', () => {
  const previous = process.env.MODEL_PRICING_JSON;
  process.env.MODEL_PRICING_JSON = JSON.stringify({ test: { inputPerMillionUsd: 2, outputPerMillionUsd: 8 } });
  try {
    assert.equal(estimateModelCost({ model: 'test', inputTokens: 1000, outputTokens: 500, cachedInputTokens: 10 }), null);
  } finally {
    if (previous === undefined) delete process.env.MODEL_PRICING_JSON;
    else process.env.MODEL_PRICING_JSON = previous;
  }
});

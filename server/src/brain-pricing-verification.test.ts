import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProposal } from './brain/pricing/agent.js';
import { brainConfig } from './brain/config.js';
import { PricingDiscovery } from './brain/pricing/discovery.js';
import type { PricingCatalogue } from './brain/pricing/types.js';

const rates = { inputPerMillionUsd: 2, outputPerMillionUsd: 8, cachedInputPerMillionUsd: 0.5 };
const heading = 'Standard pricing · USD per 1M tokens';
const columns = '| Model | Input | Cached input | Output |';
const row = '| test-model | $2 | $0.5 | $8 |';
const source = [heading, columns, row].join('\n');
const value = { found: true, ...rates, evidence: [heading, columns, row], notes: '' };
const validate = (proposal: unknown, page = source, model = 'test-model') =>
  validateProposal(proposal, page, model, 'openai');

test('source verification binds the exact model and each price to its column', () => {
  assert.deepEqual(validate(value).rates, rates);
  for (const model of ['other-model', 'test-model-2026-09-23', 'test']) {
    assert.throws(() => validate(value, source, model), /does not verify/);
  }
  for (const changes of [
    { inputPerMillionUsd: 99 },
    { outputPerMillionUsd: 199 },
    { cachedInputPerMillionUsd: 9 },
    { inputPerMillionUsd: 8, outputPerMillionUsd: 2 },
    { cachedInputPerMillionUsd: null },
  ]) {
    assert.throws(() => validate({ ...value, ...changes }), /does not verify/);
  }
  assert.throws(() => validate({ ...value, evidence: [heading, columns] }), /does not verify/);
});

test('a standard quote cannot authorize a batch row, another currency, or per-thousand rates', () => {
  for (const wrongHeading of [
    'Batch pricing · USD per 1M tokens',
    'Standard pricing · EUR per 1M tokens',
    'Standard pricing · USD per 1K tokens',
    'Priority pricing',
    'Non standard pricing',
    '### Long-context pricing',
  ]) {
    const wrongSource = `${heading}\n${wrongHeading}\n${columns}\n${row}`;
    assert.throws(
      () => validate({ ...value, evidence: [heading, wrongHeading, columns, row] }, wrongSource),
      /does not verify/,
    );
  }
  const page = `${source}\n## Batch pricing\n${columns}\n| test-model | $1 | $0.25 | $4 |`;
  assert.throws(
    () =>
      validate(
        {
          ...value,
          inputPerMillionUsd: 1,
          outputPerMillionUsd: 4,
          cachedInputPerMillionUsd: 0.25,
          evidence: [heading, columns, '| test-model | $1 | $0.25 | $4 |'],
        },
        page,
      ),
    /does not verify/,
  );
});

test('OpenAI short-context columns exclude long context and cache writes', () => {
  const header =
    '| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |';
  const modelRow = '| test-model | $2 | $0.5 | $3 | $8 | $4 | $1 | $6 | $12 |';
  const page = `Prices per 1M tokens.\nStandard\n### Standard pricing data\n${header}\n${modelRow}`;
  const proposal = {
    ...value,
    evidence: ['Prices per 1M tokens.', '### Standard pricing data', header, modelRow],
  };
  assert.deepEqual(validate(proposal, page).rates, rates);
  assert.throws(
    () => validate({ ...proposal, cachedInputPerMillionUsd: 3 }, page),
    /does not verify/,
  );
  assert.throws(
    () =>
      validate(
        {
          ...proposal,
          inputPerMillionUsd: 4,
          outputPerMillionUsd: 12,
          cachedInputPerMillionUsd: 1,
        },
        page,
      ),
    /does not verify/,
  );
});

test('Claude display names and MTok columns verify without treating cache writes as reads', () => {
  const header =
    '| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |';
  const modelRow =
    '| Claude Test 4.6 | $2 / MTok | $3 / MTok | $4 / MTok | $0.5 / MTok | $8 / MTok |';
  const page = `All prices are in USD.\n## Model pricing\n${header}\n${modelRow}`;
  const proposal = {
    ...value,
    evidence: ['All prices are in USD.', '## Model pricing', header, modelRow],
  };
  assert.deepEqual(validateProposal(proposal, page, 'claude-test-4-6', 'anthropic').rates, rates);
  assert.throws(
    () => validateProposal(proposal, page, 'claude-test-4-6-20260923', 'anthropic'),
    /does not verify/,
  );
  assert.throws(
    () =>
      validateProposal(
        { ...proposal, cachedInputPerMillionUsd: 3 },
        page,
        'claude-test-4-6',
        'anthropic',
      ),
    /does not verify/,
  );
});

test('missing cache prices remain unknown and conflicting standard rows fail closed', () => {
  const page = source.replace('$0.5', '—');
  const proposal = {
    ...value,
    cachedInputPerMillionUsd: null,
    evidence: [heading, columns, row.replace('$0.5', '—')],
  };
  assert.equal(validate(proposal, page).rates.cachedInputPerMillionUsd, undefined);
  assert.throws(
    () => validate({ ...proposal, cachedInputPerMillionUsd: 0 }, page),
    /does not verify/,
  );
  assert.throws(() => validate(value, `${source}\n${row.replace('$2', '$3')}`), /does not verify/);
});

test('empty notes are valid, but missing, non-string and oversized notes are rejected', () => {
  for (const notes of ['', '   \n\t']) {
    assert.equal(validate({ ...value, notes }).notes, '');
  }
  for (const notes of [
    undefined,
    null,
    12,
    'a'.repeat(brainConfig.analysis.maxTextCharacters + 1),
  ]) {
    assert.throws(() => validate({ ...value, notes }), /Response notes/);
  }
});

async function eventually(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate());
}

test('discovery clears a recovered observation write error without requiring an agent call', async (t) => {
  let catalogue: PricingCatalogue = { models: [] };
  let offline = true;
  const discovery = new PricingDiscovery(
    {
      catalogue: () => catalogue,
      change: async (work) => {
        if (offline) throw new Error('Storage offline');
        const next = structuredClone(catalogue);
        work(next);
        catalogue = next;
      },
      lookup: async () => {
        throw new Error('The unavailable agent must not run');
      },
      available: () => false,
    },
    true,
    5,
  );
  t.after(() => discovery.close());
  discovery.observe([{ model: 'gpt-test', provider: 'codex' }]);
  discovery.start();
  await eventually(() => Boolean(discovery.state().error));
  assert.equal(catalogue.models.length, 0);
  offline = false;
  await eventually(() => catalogue.models.length === 1);
  assert.equal(discovery.state().error, undefined);
});

test('storage recovery preserves a catalogue-capacity warning', async (t) => {
  const catalogue: PricingCatalogue = {
    models: Array.from({ length: brainConfig.pricing.maxModels }, (_, i) => ({
      model: `gpt-existing-${i}`,
      provider: 'openai',
      sourceUrl: brainConfig.pricing.officialSources.openai,
      revision: 1,
      versions: [],
    })),
  };
  let offline = true;
  const discovery = new PricingDiscovery(
    {
      catalogue: () => catalogue,
      change: async (work) => {
        if (offline) throw new Error('Storage offline');
        work(catalogue);
      },
      lookup: async () => {
        throw new Error('Agent must not run');
      },
      available: () => false,
    },
    true,
    5,
  );
  t.after(() => discovery.close());
  discovery.observe([{ model: 'gpt-extra', provider: 'codex' }]);
  discovery.start();
  await eventually(() => /storage connection/.test(discovery.state().error ?? ''));
  offline = false;
  await eventually(() => /catalogue is full/.test(discovery.state().error ?? ''));
});

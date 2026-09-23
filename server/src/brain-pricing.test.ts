import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { BrainStorage } from './brain/persistence.js';
import { PricingService } from './brain/pricing/service.js';
import { registerPricingRoutes } from './brain/pricing/routes.js';
import { requireBrainAccess } from './brain/access.js';
import { fetchPricingSource, pricingUrl, sourceText } from './brain/pricing/source.js';
import { validateProposal } from './brain/pricing/agent.js';
import { estimateModelCost } from './model-cost.js';
import { config } from './config.js';
import { UsageAccounting } from './store/accounting.js';
import { brainConfig } from './brain/config.js';
import type { AgentEvent } from './types.js';
const sourceUrl = 'https://developers.openai.com/api/docs/pricing';
const rates = { inputPerMillionUsd: 2, outputPerMillionUsd: 8, cachedInputPerMillionUsd: 0.5 };
const evidence =
  'test-model: input $2, output $8, cached input $0.5 per million tokens, USD standard.';
const evidenceFor = (model: string) => evidence.replace('test-model', model);
const fixtureSource = ['test-model', 'gpt-6-astra', 'claude-sonnet-4-6', 'codex-auto-review']
  .map(evidenceFor)
  .join('\n');
const response = {
  value: {
    found: true,
    ...rates,
    evidence: [evidence],
    notes: 'Standard short-context text pricing.',
  },
  inputTokens: 40,
  outputTokens: 20,
  usageKnown: true,
  model: 'agent-model',
};
function responseFor(input: unknown) {
  const { model } = input as { model: string };
  return { ...response, value: { ...response.value, evidence: [evidenceFor(model)] } };
}
async function eventually(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), 'The pricing queue did not reach the expected state');
}

test('discovery deduplicates activity, saves first prices from provider pages and preserves pending reviews', async (t) => {
  let calls = 0;
  const sources: Array<[string, string]> = [];
  const { service } = await fixture(t, {
    automatic: true,
    automaticIntervalMs: 5,
    fetchSource: async (url, provider) => {
      sources.push([url, provider]);
      return { url, text: fixtureSource, hash: 'test' };
    },
    call: async (input) => {
      calls++;
      return responseFor(input);
    },
  });
  await service.save({ model: 'test-model', provider: 'openai', sourceUrl, revision: 1 });
  await service.start(['test-model']);
  const manualJob = structuredClone(await finish(service));
  calls = 0;
  sources.length = 0;
  const before = Date.now() - 1000;
  for (let i = 0; i < 50; i++) {
    service.observeModels([
      { model: 'gpt-6-astra', provider: 'codex' },
      { model: 'claude-sonnet-4-6', provider: 'claude' },
      { model: 'test-model', provider: 'codex' },
    ]);
  }
  service.startAutomatic();
  await eventually(
    () =>
      service.state().models.filter((entry) => entry.automatic?.status === 'applied').length === 2,
  );
  assert.equal(calls, 2);
  assert.deepEqual(sources, [
    [sourceUrl, 'openai'],
    [brainConfig.pricing.officialSources.anthropic, 'anthropic'],
  ]);
  assert.deepEqual(service.state().job, manualJob);
  assert.deepEqual(service.price('gpt-6-astra', Date.now()), rates);
  assert.equal(service.price('gpt-6-astra', before), undefined);
  assert.equal(
    service.state().models.find((entry) => entry.model === 'test-model')!.versions.length,
    1,
  );
  assert.equal(
    service.state().models.find((entry) => entry.model === 'gpt-6-astra')!.versions[0].evidence,
    evidenceFor('gpt-6-astra'),
  );
});

test('discovery persists queued observations at shutdown and resumes only missing rates after restart', async (t) => {
  const { service, storage } = await fixture(t, { automatic: true });
  service.observeModels([{ model: 'gpt-6-astra', provider: 'codex' }]);
  await service.close();
  let calls = 0;
  const restarted = new PricingService(storage, {
    automatic: true,
    automaticIntervalMs: 5,
    fetchSource: async () => ({ url: sourceUrl, text: fixtureSource, hash: 'test' }),
    call: async (input) => {
      calls++;
      return responseFor(input);
    },
  });
  t.after(() => restarted.close());
  await restarted.init();
  restarted.startAutomatic();
  await eventually(() => Boolean(restarted.price('gpt-6-astra', Date.now())));
  restarted.observeModels([{ model: 'gpt-6-astra', provider: 'codex' }]);
  await restarted.close();
  assert.equal(calls, 1);
  assert.equal(
    restarted.state().models.find((entry) => entry.model === 'gpt-6-astra')!.automatic?.status,
    'applied',
  );
});

test('ambiguous automatic prices remain unknown without repeated paid attempts', async (t) => {
  let calls = 0;
  const { service } = await fixture(t, {
    automatic: true,
    automaticIntervalMs: 5,
    call: async () => {
      calls++;
      return { ...response, value: { ...response.value, found: false } };
    },
  });
  service.observeModels([{ model: 'codex-auto-review', provider: 'codex' }]);
  service.startAutomatic();
  await eventually(() =>
    service.state().models.some((entry) => entry.automatic?.status === 'failed'),
  );
  service.observeModels([{ model: 'codex-auto-review', provider: 'codex' }]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  assert.equal(service.price('codex-auto-review', Date.now()), undefined);
  assert.match(service.state().models.at(-1)!.automatic!.error!, /exact model/);
});

test('automatic discovery rejects genuine quotes for the wrong model or invented rates', async (t) => {
  let badRates = false;
  const { service } = await fixture(t, {
    automatic: true,
    automaticIntervalMs: 5,
    call: async (input) =>
      badRates
        ? { ...responseFor(input), value: { ...responseFor(input).value, inputPerMillionUsd: 99 } }
        : response,
  });
  service.observeModels([{ model: 'gpt-6-astra', provider: 'codex' }]);
  service.startAutomatic();
  await eventually(() => service.state().models.at(-1)?.automatic?.status === 'failed');
  assert.equal(service.price('gpt-6-astra', Date.now()), undefined);
  assert.match(service.state().models.at(-1)!.automatic!.error!, /does not verify/);
  badRates = true;
  service.observeModels([{ model: 'claude-sonnet-4-6', provider: 'claude' }]);
  await eventually(
    () =>
      service.state().models.at(-1)?.model === 'claude-sonnet-4-6' &&
      service.state().models.at(-1)?.automatic?.status === 'failed',
  );
  assert.equal(service.price('claude-sonnet-4-6', Date.now()), undefined);
});

test('automatic discovery applies verified prices with empty notes', async (t) => {
  const { service } = await fixture(t, {
    automatic: true,
    automaticIntervalMs: 5,
    call: async (input) => ({
      ...responseFor(input),
      value: { ...responseFor(input).value, notes: '' },
    }),
  });
  service.observeModels([{ model: 'gpt-6-astra', provider: 'codex' }]);
  service.startAutomatic();
  await eventually(() => service.state().models.at(-1)?.automatic?.status === 'applied');
  assert.deepEqual(service.price('gpt-6-astra', Date.now()), rates);
});

test('transient automatic errors retry with a persisted bounded attempt count', async (t) => {
  const delay = brainConfig.pricing.automaticRetryDelayMs;
  brainConfig.pricing.automaticRetryDelayMs = 1;
  t.after(() => {
    brainConfig.pricing.automaticRetryDelayMs = delay;
  });
  let calls = 0;
  const { service } = await fixture(t, {
    automatic: true,
    automaticIntervalMs: 5,
    call: async () => {
      calls++;
      throw new Error('offline');
    },
  });
  service.observeModels([{ model: 'gpt-6-astra', provider: 'codex' }]);
  service.startAutomatic();
  await eventually(() => service.state().models.at(-1)?.automatic?.status === 'failed');
  assert.equal(calls, brainConfig.pricing.automaticMaxAttempts);
  assert.equal(service.state().models.at(-1)!.automatic!.attempts, calls);
  assert.equal(service.price('gpt-6-astra', Date.now()), undefined);
});

test('a manual edit during automatic lookup wins over the late result', async (t) => {
  let release!: (result: typeof response) => void;
  const { service } = await fixture(t, {
    automatic: true,
    automaticIntervalMs: 5,
    call: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  service.observeModels([{ model: 'gpt-6-astra', provider: 'codex' }]);
  service.startAutomatic();
  await eventually(() => Boolean(release));
  await assert.rejects(service.start(['gpt-6-astra']), /already running/);
  const manualRates = { inputPerMillionUsd: 123, outputPerMillionUsd: 456 };
  await service.save({
    model: 'gpt-6-astra',
    provider: 'openai',
    sourceUrl,
    revision: 1,
    rates: manualRates,
  });
  release(response);
  await eventually(() => !service.state().automation.checking);
  assert.deepEqual(service.price('gpt-6-astra', Date.now()), manualRates);
  assert.equal(service.state().models.at(-1)!.versions.length, 1);
});

test('ignored models survive rediscovery and restart, and restore resumes missing prices', async (t) => {
  const { service, storage } = await fixture(t, { automatic: true });
  await service.save({ model: 'codex-auto-review', provider: 'openai', sourceUrl, revision: 0 });
  await service.setIgnored({ model: 'codex-auto-review', revision: 1, ignored: true });
  service.observeModels([{ model: 'codex-auto-review', provider: 'codex' }]);
  await service.close();
  let calls = 0;
  const restarted = new PricingService(storage, {
    automatic: true,
    automaticIntervalMs: 5,
    fetchSource: async () => ({ url: sourceUrl, text: fixtureSource, hash: 'test' }),
    call: async (input) => {
      calls++;
      return responseFor(input);
    },
  });
  t.after(() => restarted.close());
  await restarted.init();
  restarted.observeModels([{ model: 'codex-auto-review', provider: 'codex' }]);
  restarted.startAutomatic();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 0);
  const ignored = restarted.state().models.at(-1)!;
  assert.equal(ignored.ignored, true);
  assert.equal(ignored.automatic, undefined);
  assert.equal(restarted.price(ignored.model, Date.now()), undefined);
  await assert.rejects(restarted.start([ignored.model]), /Restore ignored models/);
  await restarted.setIgnored({ model: ignored.model, revision: ignored.revision, ignored: false });
  await eventually(() => Boolean(restarted.price(ignored.model, Date.now())));
  assert.equal(calls, 1);
  assert.equal(restarted.state().models.at(-1)!.ignored, false);
});

test('ignoring invalidates pending reviews without changing saved price history', async (t) => {
  const { service } = await fixture(t);
  await service.save({ model: 'test-model', provider: 'openai', sourceUrl, revision: 1 });
  await service.start(['test-model']);
  const job = await finish(service);
  const before = structuredClone(service.state().models[0]);
  await service.setIgnored({ model: before.model, revision: before.revision, ignored: true });
  assert.deepEqual(service.state().models[0].versions, before.versions);
  assert.deepEqual(service.price(before.model, Date.now()), before.versions[0].rates);
  assert.deepEqual(service.state().job!.models, []);
  assert.deepEqual(service.state().job!.proposals, []);
  await assert.rejects(service.apply(job.id, before.model), /Restore this model/);
  await assert.rejects(
    service.setIgnored({ model: before.model, revision: before.revision, ignored: false }),
    /changed/,
  );
  await assert.rejects(
    service.save({
      model: before.model,
      provider: 'openai',
      sourceUrl,
      revision: before.revision + 1,
    }),
    /Restore this model/,
  );
  await service.setIgnored({ model: before.model, revision: before.revision + 1, ignored: false });
  await assert.rejects(service.apply(job.id, before.model), /No valid proposal/);
  assert.equal(service.state().models[0].automatic, undefined);
});

test('ignoring models skips queued manual checks and discards a late in-flight proposal', async (t) => {
  let release!: (result: typeof response) => void;
  let calls = 0;
  const { service } = await fixture(t, {
    call: () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  await service.save({ model: 'test-model', provider: 'openai', sourceUrl, revision: 1 });
  await service.save({ model: 'queued-model', provider: 'openai', sourceUrl, revision: 0 });
  await service.start(['test-model', 'queued-model']);
  await eventually(() => Boolean(release));
  await service.setIgnored({ model: 'test-model', revision: 2, ignored: true });
  await service.setIgnored({ model: 'queued-model', revision: 1, ignored: true });
  await service.setIgnored({ model: 'test-model', revision: 3, ignored: false });
  release(response);
  const job = await finish(service);
  assert.equal(calls, 1);
  assert.deepEqual(job.proposals, []);
  assert.deepEqual(job.models, []);
  assert.equal(service.state().models[0].versions.length, 1);
});

test('a late automatic result cannot reactivate an ignored model or overwrite its restored queue', async (t) => {
  let release!: (result: typeof response) => void;
  let calls = 0;
  const { service } = await fixture(t, {
    automatic: true,
    automaticIntervalMs: 5,
    call: () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  service.observeModels([{ model: 'gpt-6-astra', provider: 'codex' }]);
  service.startAutomatic();
  await eventually(() => calls === 1);
  await service.setIgnored({ model: 'gpt-6-astra', revision: 1, ignored: true });
  release(responseFor({ model: 'gpt-6-astra' }));
  await eventually(() => !service.state().automation.checking);
  assert.equal(service.price('gpt-6-astra', Date.now()), undefined);
  assert.equal(service.state().models.at(-1)!.automatic, undefined);
  await service.setIgnored({ model: 'gpt-6-astra', revision: 2, ignored: false });
  await eventually(() => calls === 2);
  await service.setIgnored({ model: 'gpt-6-astra', revision: 3, ignored: true });
  await service.setIgnored({ model: 'gpt-6-astra', revision: 4, ignored: false });
  release(responseFor({ model: 'gpt-6-astra' }));
  await eventually(() => calls === 3);
  assert.equal(service.state().models.at(-1)!.versions.length, 0);
  release(responseFor({ model: 'gpt-6-astra' }));
  await eventually(() => Boolean(service.price('gpt-6-astra', Date.now())));
  assert.equal(service.state().models.at(-1)!.versions.length, 1);
});

test('an unconfigured agent still registers observed models without guessing prices', async (t) => {
  const { service } = await fixture(t, {
    automatic: true,
    automaticIntervalMs: 5,
    call: undefined,
    model: '',
    apiKey: '',
  });
  service.observeModels([
    { model: 'gpt-6-astra', provider: 'codex' },
    { model: '' },
    { model: 'invalid model' },
  ]);
  service.startAutomatic();
  await eventually(() => service.state().models.length === 2);
  assert.equal(service.state().models.at(-1)!.automatic?.attempts, 0);
  assert.equal(service.price('gpt-6-astra', Date.now()), undefined);
});
async function fixture(
  t: TestContext,
  options: ConstructorParameters<typeof PricingService>[1] = {},
) {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-pricing-'));
  const storage = new BrainStorage(resolve(root, 'pricing.db'), ['access_settings'], 33);
  const previousDatabaseUrl = process.env.DATABASE_URL;
  // These fixtures own a temporary SQLite database, including when run directly from .env.
  process.env.DATABASE_URL = '';
  const previous = process.env.MODEL_PRICING_JSON;
  process.env.MODEL_PRICING_JSON = JSON.stringify({
    'test-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 4, cachedInputPerMillionUsd: 0.1 },
  });
  await storage.init();
  const service = new PricingService(storage, {
    call: async (input) => responseFor(input),
    fetchSource: async () => ({ url: sourceUrl, text: fixtureSource, hash: 'test' }),
    ...options,
  });
  await service.init();
  t.after(async () => {
    await service.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    if (previous === undefined) {
      delete process.env.MODEL_PRICING_JSON;
    } else {
      process.env.MODEL_PRICING_JSON = previous;
    }
  });
  return { storage, service };
}
async function finish(service: PricingService) {
  for (let attempt = 0; attempt < 100 && service.state().job?.status === 'running'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(service.state().job?.status, 'completed');
  return service.state().job!;
}
test('agent proposals require approval, persist across service restarts, and preserve replayed historical prices', async (t) => {
  let usageWrites = 0;
  const { service, storage } = await fixture(t, {
    onUsage: async () => {
      usageWrites++;
    },
  });
  await service.save({ model: 'test-model', provider: 'openai', sourceUrl, revision: 1 });
  const oldAt = Date.now() - 1000;
  const input = {
    model: 'test-model',
    inputTokens: 1000,
    outputTokens: 500,
    cachedInputTokens: 400,
  };
  const oldCost = estimateModelCost({ ...input, ts: oldAt });
  const accounting = new UsageAccounting();
  const event = {
    ...input,
    id: 'event',
    ts: oldAt,
    provider: 'codex',
    kind: 'api_request',
    sessionId: 'session',
    requestId: 'response',
  } as AgentEvent;
  const first = accounting.consume(event).usage!;
  const started = await service.start(['test-model']);
  const job = await finish(service);
  assert.equal(usageWrites, 1);
  assert.equal(estimateModelCost(input), oldCost, 'A proposal must not change active prices');
  await service.apply(started.job!.id, 'test-model');
  assert.equal(estimateModelCost(input), 0.0054);
  assert.equal(estimateModelCost({ ...input, ts: oldAt }), oldCost);
  assert.equal(
    accounting.consume({ ...event, ts: Date.now() }).completion,
    undefined,
    'Replaying a completed response must not reprice historical usage',
  );
  assert.equal(first.dUsd, oldCost);
  assert.equal(job.proposals[0].evidence, evidence);
  await service.apply(started.job!.id, 'test-model');
  assert.equal(service.state().models[0].versions.length, 2, 'Approval is idempotent');
  await service.close();
  const restarted = new PricingService(storage, { call: async () => response });
  await restarted.init();
  assert.equal(estimateModelCost(input), 0.0054);
  assert.ok(restarted.state().job?.proposals[0].appliedAt);
  await restarted.close();
});
test('invalid evidence and unknown prices leave saved rates intact; stale proposals cannot overwrite edits', async (t) => {
  const { service } = await fixture(t);
  await service.save({ model: 'test-model', provider: 'openai', sourceUrl, revision: 1 });
  await service.start(['test-model']);
  const job = await finish(service);
  await service.save({
    model: 'test-model',
    provider: 'openai',
    sourceUrl,
    revision: 2,
    rates: { ...rates, inputPerMillionUsd: 3 },
  });
  await assert.rejects(service.apply(job.id, 'test-model'), /changed after the lookup/);
  assert.equal(service.price('test-model', Date.now())?.inputPerMillionUsd, 3);
  assert.throws(
    () =>
      validateProposal(
        { ...response.value, evidence: ['invented quote'] },
        evidence,
        'test-model',
        'openai',
      ),
    /does not match/,
  );
  assert.throws(
    () => validateProposal({ ...response.value, found: false }, evidence, 'test-model', 'openai'),
    /could not establish/,
  );
  await assert.rejects(
    service.save({
      model: 'bad-model',
      provider: 'openai',
      sourceUrl,
      revision: 0,
      rates: { ...rates, inputPerMillionUsd: -1 },
    }),
    /non-negative/,
  );
});
test('failed lookups record consumption and never erase existing prices', async (t) => {
  let recorded = 0;
  const { service } = await fixture(t, {
    call: async () => ({ ...response, value: { ...response.value, found: false } }),
    onUsage: async () => {
      recorded++;
    },
  });
  await service.save({ model: 'test-model', provider: 'openai', sourceUrl, revision: 1 });
  await service.start(['test-model']);
  const job = await finish(service);
  assert.match(job.proposals[0].error!, /could not establish/);
  assert.equal(job.proposals[0].rates, undefined);
  assert.equal(recorded, 1);
  assert.equal(service.price('test-model', Date.now())?.inputPerMillionUsd, 1);
});

test('table headings and model rows are verified separately without accepting stitched or altered quotes', () => {
  const heading = 'Standard pricing · USD per 1M tokens';
  const columns = '| Model | Input | Cached input | Output |';
  const row = '| test-model | $2 | $0.5 | $8 |';
  const source = `${heading}\n\n${columns}\n| other-model | $10 | $1 | $50 |\n${row}`;
  const proposal = { ...response.value, evidence: [heading, columns, row] };
  const result = validateProposal(proposal, source, 'test-model', 'openai');
  assert.deepEqual(result.rates, rates);
  assert.equal(result.evidence, [heading, columns, row].join('\n\n[…]\n\n'));
  assert.deepEqual(
    validateProposal(
      { ...proposal, evidence: [heading, columns, row.replaceAll(' ', '\n\t')] },
      source,
      'test-model',
      'openai',
    ).rates,
    rates,
  );
  for (const evidence of [[`${columns} ${row}`], [row.replace('$2', '$20')], ['invented quote']]) {
    assert.throws(
      () => validateProposal({ ...proposal, evidence }, source, 'test-model', 'openai'),
      /does not match/,
    );
  }
  assert.throws(
    () => validateProposal({ ...proposal, evidence: [] }, source, 'test-model', 'openai'),
    /evidence is missing/,
  );
  assert.throws(
    () =>
      validateProposal(
        { ...proposal, evidence: [row.repeat(200)] },
        source,
        'test-model',
        'openai',
      ),
    /too long/,
  );
});

test('a rejected quote cannot become applicable or change saved prices', async (t) => {
  const { service } = await fixture(t, {
    call: async () => ({ ...response, value: { ...response.value, evidence: ['invented quote'] } }),
  });
  await service.save({ model: 'test-model', provider: 'openai', sourceUrl, revision: 1 });
  await service.start(['test-model']);
  const job = await finish(service);
  assert.match(job.proposals[0].error!, /does not match/);
  assert.equal(job.proposals[0].rates, undefined);
  await assert.rejects(service.apply(job.id, 'test-model'), /No valid proposal/);
  assert.equal(service.price('test-model', Date.now())?.inputPerMillionUsd, 1);
});

test('source capture preserves Markdown and plain-text tables, context thresholds and paragraph boundaries', async (t) => {
  const source =
    '# Pricing\r\n\r\nStandard USD per 1M tokens\r\n\r\n| Model | Input | Output |\r\n| test-model (<272K) | $2 | $8 |\r\n| test-model (>272K) | $4 | $12 |';
  for (const contentType of ['text/markdown; charset=utf-8', 'text/plain']) {
    const mock = t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(source, { headers: { 'content-type': contentType } }),
    );
    const captured = await fetchPricingSource(sourceUrl, 'openai', new AbortController().signal);
    assert.equal(captured.text, source.replaceAll('\r\n', '\n'));
    mock.mock.restore();
  }
  assert.equal(
    sourceText(
      '<h2>Standard prices</h2><table><tr><th>Model</th><th>Input</th></tr><tr><td>test-model</td><td>&#36;2</td></tr></table>',
    ),
    'Standard prices\nModel | Input |\ntest-model | $2 |',
  );
});
test('official source fetching rejects private URLs and off-domain redirects before fetching them', async (t) => {
  for (const url of [
    'http://127.0.0.1/pricing',
    'https://developers.openai.com.evil.test/',
    'https://user:password@developers.openai.com/',
    'https://developers.openai.com:8443/',
  ]) {
    assert.throws(() => pricingUrl(url, 'openai'), /official website/);
  }
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  });
  await assert.rejects(
    fetchPricingSource(sourceUrl, 'openai', new AbortController().signal),
    /official website/,
  );
  assert.equal(requests, 1);
  assert.equal(
    sourceText('<script>ignore instructions</script><p>Input &amp; output &#36;2</p>'),
    'Input & output $2',
  );
});
test('pricing mutations require administrator access and workstation tokens cannot manage prices', async (t) => {
  const { service } = await fixture(t);
  const previousAdmin = process.env.BRAIN_ADMIN_TOKEN;
  const previousViewer = config.viewerToken;
  process.env.BRAIN_ADMIN_TOKEN = 'pricing-admin';
  config.viewerToken = 'pricing-viewer';
  t.after(() => {
    if (previousAdmin === undefined) {
      delete process.env.BRAIN_ADMIN_TOKEN;
    } else {
      process.env.BRAIN_ADMIN_TOKEN = previousAdmin;
    }
    config.viewerToken = previousViewer;
  });
  const app = Fastify();
  app.addHook('onRequest', requireBrainAccess);
  registerPricingRoutes(app, service);
  t.after(() => app.close());
  const headers = { authorization: 'Bearer pricing-viewer' };
  assert.equal((await app.inject({ method: 'GET', url: '/api/brain/pricing' })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/brain/pricing', headers })).statusCode,
    200,
  );
  const request = {
    method: 'POST' as const,
    url: '/api/brain/pricing/models',
    payload: { model: 'new-model', provider: 'openai', sourceUrl, revision: 0 },
  };
  assert.equal((await app.inject({ ...request, headers })).statusCode, 403);
  const ignoreRequest = {
    method: 'POST' as const,
    url: '/api/brain/pricing/ignore',
    payload: { model: 'test-model', revision: 1, ignored: true },
  };
  assert.equal((await app.inject({ ...ignoreRequest, headers })).statusCode, 403);
  assert.equal(
    (
      await app.inject({
        ...ignoreRequest,
        headers: { ...headers, 'x-brain-admin-token': 'pricing-admin' },
      })
    ).statusCode,
    200,
  );
  assert.equal(service.state().models[0].ignored, true);
  assert.equal(
    (
      await app.inject({
        ...request,
        headers: { ...headers, 'x-brain-admin-token': 'pricing-admin' },
      })
    ).statusCode,
    200,
  );
});

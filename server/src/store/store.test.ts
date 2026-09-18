import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from './store.js';
import { config } from '../config.js';
import type { AgentEvent, CumulativeSnapshot, UsageAliasUpdate, UsageDelta } from '../types.js';

function event(overrides: Partial<AgentEvent>): AgentEvent {
  return {
    id: Math.random().toString(36),
    ts: Date.now(),
    kind: 'activity',
    subtype: 'session_start',
    provider: 'codex',
    sessionId: 'session-1',
    ...overrides,
  };
}

test('keeps provider and client visible across hook state transitions', () => {
  const store = new Store();
  store.ingest(event({ client: 'vscode' }));
  store.ingest(event({ subtype: 'prompt_submit', client: 'vscode' }));
  store.ingest(event({ subtype: 'pre_tool', toolName: 'File edit', client: 'vscode' }));

  const [session] = store.getSessions();
  assert.equal(session.provider, 'codex');
  assert.equal(session.client, 'vscode');
  assert.equal(session.status, 'tool');
  assert.equal(session.currentTool, 'File edit');

  store.ingest(event({ subtype: 'post_tool', client: 'vscode' }));
  assert.equal(store.getSessions()[0].status, 'thinking');
});

test('qualifies identical raw session IDs by provider throughout events and state', () => {
  const store = new Store();
  store.ingest(event({ sessionId: 'shared', provider: 'codex' }));
  store.ingest(event({ sessionId: 'shared', provider: 'claude', client: 'cli' }));

  const sessions = store.getSessions();
  assert.equal(sessions.find((session) => session.sessionId === 'codex:shared')?.provider, 'codex');
  assert.equal(
    sessions.find((session) => session.sessionId === 'claude:shared')?.provider,
    'claude',
  );
  assert.deepEqual(
    store.getRecentEvents().map((entry) => entry.sessionId),
    ['codex:shared', 'claude:shared'],
  );
  assert.equal(sessions[0].rawSessionId, 'shared');
});

function collectUsage(store: Store): UsageDelta[] {
  const usage: UsageDelta[] = [];
  store.on('usage', (entry: UsageDelta) => usage.push(entry));
  return usage;
}

function metric(value: number, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return event({
    provider: 'claude',
    kind: 'metric',
    subtype: undefined,
    metricName: 'claude_code.cost.usage',
    metricValue: value,
    metricTemporality: 'cumulative',
    model: 'claude-test',
    ...overrides,
  });
}

test('pairs hook and native prompts in either arrival order without resetting work or merging distinct turns', (t) => {
  for (const provider of ['claude', 'codex'] as const) {
    for (const nativeFirst of [false, true]) {
      const store = new Store();
      t.after(() => store.close());
      const ts = Date.now() - 2_000;
      const hook = event({ provider, ts, subtype: 'prompt_submit' });
      const native = event({ provider, ts: ts + 1, kind: 'user_prompt', promptId: 'one' });
      store.ingest(nativeFirst ? native : hook);
      store.ingest(event({ provider, ts: ts + 100, subtype: 'pre_tool', toolName: 'Read' }));
      store.ingest(nativeFirst ? hook : native);
      assert.equal(store.getSessions()[0].status, 'tool');
      assert.equal(store.getSessions()[0].promptCount, 1);
      assert.equal(store.getAggregate(provider).promptsLastHour, 1);
      store.ingest(event({ provider, ts: ts + 200, subtype: 'prompt_submit' }));
      store.ingest(event({ provider, ts: ts + 201, kind: 'user_prompt', promptId: 'two' }));
      assert.equal(store.getSessions()[0].promptCount, 2);
      assert.equal(store.getAggregate().promptsLastHour, 2);
      assert.equal(store.getSessions()[0].currentPromptId, 'two');
      store.ingest(event({ provider, ts: ts + 300, subtype: 'stop' }));
      store.ingest({ ...native, id: 'native-retry' });
      assert.equal(store.getSessions()[0].status, 'idle');
      assert.equal(store.getSessions()[0].turnStartedAt, undefined);
      store.ingest(event({ provider, ts: ts + 400, subtype: 'session_end' }));
      store.ingest({ ...native, id: 'native-after-close' });
      assert.equal(store.getSessions().length, 0);
    }
  }
});

test('counts hook-only and native-only prompts, with provider isolation and no pairing of different prompt IDs', (t) => {
  const store = new Store();
  t.after(() => store.close());
  store.ingest(event({ provider: 'claude', subtype: 'prompt_submit' }));
  store.ingest(event({ provider: 'claude', subtype: 'prompt_submit' }));
  store.ingest(event({ kind: 'user_prompt', promptId: 'native-one' }));
  store.ingest(event({ kind: 'user_prompt', promptId: 'native-two' }));
  store.ingest(event({ subtype: 'prompt_submit', promptId: 'different-turn' }));
  assert.equal(store.getAggregate('claude').promptsLastHour, 2);
  assert.equal(store.getAggregate('codex').promptsLastHour, 3);
});

test('the rolling prompt hour survives metric traffic and expires by event time', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-18T12:00:00Z') });
  const store = new Store();
  t.after(() => store.close());
  store.ingest(event({ subtype: 'prompt_submit' }));
  for (let index = 0; index <= config.ringSize; index++) store.ingest(metric(index));
  assert.equal(store.getAggregate().promptsLastHour, 1);
  t.mock.timers.tick(3_600_001);
  assert.equal(store.getAggregate().promptsLastHour, 0);
});

test('corrects provisional costs when cache usage arrives and preserves reported zero', (t) => {
  const prices = process.env.MODEL_PRICING_JSON;
  process.env.MODEL_PRICING_JSON = JSON.stringify({
    'cache-test': { inputPerMillionUsd: 10, outputPerMillionUsd: 20, cachedInputPerMillionUsd: 1 },
    'missing-cache-rate': { inputPerMillionUsd: 10, outputPerMillionUsd: 20 },
  });
  t.after(() => {
    if (prices === undefined) delete process.env.MODEL_PRICING_JSON;
    else process.env.MODEL_PRICING_JSON = prices;
  });
  for (const model of ['cache-test', 'missing-cache-rate']) {
    const store = new Store();
    t.after(() => store.close());
    const base = event({
      kind: 'api_request',
      model,
      requestId: 'request',
      inputTokens: 1000,
      outputTokens: 100,
    });
    store.ingest(event({ subtype: 'prompt_submit' }));
    store.ingest(base);
    assert.equal(store.getAggregate().costTodayUsd, 0.012);
    store.ingest({ ...base, id: 'cached', responseId: 'response', cachedInputTokens: 900 });
    const expected = model === 'cache-test' ? 0.0039 : 0;
    assert.ok(Math.abs(store.getAggregate().costTodayUsd - expected) < 1e-12);
    assert.ok(Math.abs(store.getAggregate('codex').costTodayUsd - expected) < 1e-12);
    assert.ok(Math.abs(store.getSessions()[0].sessionCostUsd - expected) < 1e-12);
    assert.ok(Math.abs(store.getSessions()[0].turnCostUsd - expected) < 1e-12);
    assert.equal(store.getAggregate().costKnown, model === 'cache-test');
    assert.equal(store.getSessions()[0].costKnown, model === 'cache-test');
    assert.equal(store.getAggregate().unknownUsageCount, model === 'cache-test' ? 0 : 1);
    store.ingest({ ...base, id: 'reported-zero', costUsd: 0 });
    store.ingest({ ...base, id: 'conflicting-retry', costUsd: 99 });
    assert.ok(Math.abs(store.getAggregate().costTodayUsd) < 1e-12);
    assert.equal(store.getAggregate().costKnown, true);
    assert.equal(store.getAggregate().unknownUsageCount, 0);
    assert.equal(store.getSessions()[0].sessionTokens, 1100);
  }
});

test('expires inactive accounting and attribution with retention while refusing old replay', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-18T12:00:00Z') });
  const store = new Store();
  t.after(() => store.close());
  const usage = collectUsage(store);
  const request = event({
    kind: 'api_request',
    requestId: 'old-request',
    inputTokens: 5,
    costUsd: 1,
  });
  store.ingest(event({ subtype: 'prompt_submit', userEmail: 'developer@example.test' }));
  store.ingest(request);
  store.ingest(event({ subtype: 'stop' }));
  store.ingest(event({ subtype: 'session_end' }));
  t.mock.timers.tick(86_400_000);
  store['sweep']();
  store.ingest({ ...request, id: 'late-retry' });
  assert.equal(usage.length, 1, 'late exports inside retention remain deduplicated');
  t.mock.timers.tick(config.retentionDays * 86_400_000);
  store['sweep']();
  for (const field of [
    'sessionContext',
    'usageContexts',
    'sessionTotals',
    'endedSessions',
    'stoppedTurns',
    'agentBySession',
  ] as const) {
    assert.equal(store[field].size, 0, field);
  }
  for (const field of ['cumulative', 'seen', 'usageIdentity', 'requests'] as const) {
    assert.equal(store['accounting'][field].size, 0, field);
  }
  store.ingest({ ...request, id: 'expired-retry' });
  assert.equal(usage.length, 1);
  assert.equal(store.getSessions().length, 0);
});

test('an expired cumulative baseline does not charge a long-lived counter again', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-18T12:00:00Z') });
  const store = new Store();
  t.after(() => store.close());
  const start = (BigInt(Date.now() - 1000) * 1_000_000n).toString();
  store.ingest(metric(10, { metricStartTimeUnixNano: start }));
  t.mock.timers.tick((config.retentionDays + 1) * 86_400_000);
  store['sweep']();
  store.ingest(metric(12, { metricStartTimeUnixNano: start }));
  assert.equal(store.getAggregate().costTodayUsd, 0);
  assert.equal(store.getAggregate().costKnown, false);
  t.mock.timers.tick(1000);
  store.ingest(metric(13, { metricStartTimeUnixNano: start }));
  assert.equal(store.getAggregate().costTodayUsd, 1);
});

test('completes a partial Codex observation without duplicate usage or unknown-cost counts', (t) => {
  const store = new Store();
  t.after(() => store.close());
  const usage = collectUsage(store);
  const updates: UsageAliasUpdate[] = [];
  store.on('usage_aliases', (update) => updates.push(update));
  store.ingest(event({ kind: 'api_request', requestId: 'partial', inputTokens: 100 }));
  assert.equal(store.getAggregate().unknownUsageCount, 1);
  store.ingest(
    event({
      kind: 'api_request',
      requestId: 'partial',
      responseId: 'complete',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.5,
    }),
  );
  store.ingest(
    event({
      kind: 'api_request',
      responseId: 'complete',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.5,
    }),
  );
  assert.equal(usage.length, 1);
  assert.equal(updates.length, 1);
  assert.equal(store.getSessions()[0].sessionTokens, 120);
  assert.equal(store.getAggregate().costTodayUsd, 0.5);
  assert.equal(store.getAggregate('codex').unknownUsageCount, 0);
  assert.equal(store.getAggregate().unknownUsageCount, 0);
  store.ingest(event({ kind: 'api_request', requestId: 'zero', inputTokens: 0, costUsd: 0 }));
  store.ingest(
    event({
      kind: 'api_request',
      requestId: 'zero',
      inputTokens: 999,
      outputTokens: 3,
      costUsd: 999,
    }),
  );
  assert.equal(store.getSessions()[0].sessionTokens, 123, 'reported zero is not missing data');
  assert.equal(store.getAggregate().costTodayUsd, 0.5);
});

test('a late completion retains the original usage day and does not charge a later turn', (t) => {
  const store = new Store();
  t.after(() => store.close());
  store.ingest(
    event({
      kind: 'api_request',
      requestId: 'yesterday',
      ts: Date.now() - 86400000,
      inputTokens: 10,
    }),
  );
  store.ingest(event({ subtype: 'prompt_submit', promptId: 'today' }));
  store.ingest(
    event({
      kind: 'api_request',
      requestId: 'yesterday',
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.1,
    }),
  );
  assert.equal(store.getSessions()[0].sessionTokens, 12);
  assert.equal(store.getSessions()[0].turnTokens, 0);
  assert.equal(store.getAggregate().costTodayUsd, 0);
  assert.equal(store.getAggregate().unknownUsageCount, 0);
});

test('estimates a completed request using input and cache measurements from its earlier observation', (t) => {
  const previousPrices = process.env.MODEL_PRICING_JSON;
  process.env.MODEL_PRICING_JSON = JSON.stringify({
    'partial-test-model': {
      inputPerMillionUsd: 2,
      outputPerMillionUsd: 8,
      cachedInputPerMillionUsd: 1,
    },
  });
  const store = new Store();
  t.after(() => {
    store.close();
    if (previousPrices === undefined) {
      delete process.env.MODEL_PRICING_JSON;
    } else {
      process.env.MODEL_PRICING_JSON = previousPrices;
    }
  });
  const usage = collectUsage(store);
  store.ingest(
    event({
      kind: 'api_request',
      requestId: 'priced-partial',
      model: 'partial-test-model',
      inputTokens: 100,
      cachedInputTokens: 20,
    }),
  );
  assert.equal(store.getAggregate().unknownUsageCount, 1);
  store.ingest(event({ kind: 'api_request', requestId: 'priced-partial', outputTokens: 10 }));
  assert.equal(usage.length, 1);
  assert.equal(store.getSessions()[0].sessionTokens, 110);
  assert.equal(store.getAggregate().costTodayUsd, 0.00026);
  assert.equal(store.getAggregate().unknownUsageCount, 0);
  store.ingest(event({ kind: 'api_request', requestId: 'priced-partial', outputTokens: 10 }));
  assert.equal(store.getAggregate().costTodayUsd, 0.00026);
});

test('persists Codex response usage with unknown cost and preserves explicit zero', () => {
  const store = new Store();
  const usage = collectUsage(store);
  store.ingest(event({ ticket: 'HM-42', projectId: 'portal', runId: 'coding-run' }));
  store.ingest(
    event({
      kind: 'api_request',
      inputTokens: 100,
      outputTokens: 20,
      model: 'model-without-configured-pricing',
      requestId: 'req-1',
    }),
  );
  assert.equal(usage.length, 1);
  assert.equal(usage[0].dUsd, null);
  assert.equal(usage[0].dTokensIn, 100);
  assert.equal(usage[0].ticket, 'HM-42');
  assert.equal(usage[0].workItemId, 'HM-42');
  assert.equal(usage[0].projectId, 'portal');
  assert.equal(usage[0].runId, 'coding-run');
  assert.equal(store.getSessions()[0].costKnown, false);
  assert.equal(store.getSessions()[0].tokensKnown, true);
  assert.equal(store.getAggregate().unknownUsageCount, 1);

  store.ingest(
    event({
      kind: 'api_request',
      requestId: 'free-response',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    }),
  );
  assert.equal(usage[1].dUsd, 0);
  assert.equal(store.getSessions()[0].costKnown, true);
  assert.equal(store.getAggregate().costKnown, true);
});

test('does not fabricate consumption for transport-only events or count a response twice', () => {
  const store = new Store();
  const usage = collectUsage(store);
  store.ingest(event({ kind: 'api_request', requestId: 'request-a', durationMs: 40 }));
  assert.equal(usage.length, 0);
  const response = event({
    kind: 'api_request',
    usageOrigin: 'response',
    requestId: 'request-a',
    responseId: 'response-a',
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.25,
  });
  store.ingest(response);
  store.ingest(response);
  store.ingest(event({ ...response, id: 'another-export', usageOrigin: 'request' }));
  store.ingest(event({ ...response, id: 'response-only-alias', requestId: undefined }));
  assert.equal(usage.length, 1);
  assert.equal(store.getAggregate().costTodayUsd, 0.25);
  assert.equal(store.getSessions()[0].sessionTokens, 15);
});

test('persists aliases revealed after the first usage so a response-only replay survives restart', () => {
  const store = new Store();
  const usage = collectUsage(store);
  const aliases: UsageAliasUpdate[] = [];
  store.on('usage_aliases', (update: UsageAliasUpdate) => aliases.push(update));
  store.ingest(
    event({ kind: 'api_request', requestId: 'request-alias', inputTokens: 5, outputTokens: 2 }),
  );
  store.ingest(
    event({
      kind: 'api_request',
      requestId: 'request-alias',
      responseId: 'response-alias',
      inputTokens: 5,
      outputTokens: 2,
    }),
  );
  assert.equal(usage.length, 1);
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].usageId, usage[0].usageId);

  const restoredIdentity = new Map(aliases[0].dedupeKeys.map((key) => [key, usage[0].usageId]));
  const restarted = new Store();
  const replayUsage = collectUsage(restarted);
  restarted.restoreUsageIdentityMap(restoredIdentity);
  restarted.ingest(
    event({ kind: 'api_request', responseId: 'response-alias', inputTokens: 5, outputTokens: 2 }),
  );
  assert.equal(replayUsage.length, 0);
});

test('uses Claude metrics as the sole accounting source regardless of export order', () => {
  const store = new Store();
  const usage = collectUsage(store);
  store.ingest(event({ provider: 'claude' }));
  store.ingest(
    event({
      provider: 'claude',
      kind: 'api_request',
      costUsd: 2,
      inputTokens: 100,
      outputTokens: 50,
    }),
  );
  assert.equal(store.getSessions()[0].costKnown, false);
  assert.equal(store.getAggregate().costTodayUsd, 0);
  store.ingest(metric(2));
  store.ingest(metric(100, { metricName: 'claude_code.token.usage', tokenType: 'input' }));
  store.ingest(metric(50, { metricName: 'claude_code.token.usage', tokenType: 'output' }));
  store.ingest(
    event({
      provider: 'claude',
      kind: 'api_request',
      costUsd: 2,
      inputTokens: 100,
      outputTokens: 50,
    }),
  );
  assert.equal(usage.length, 3);
  assert.equal(store.getAggregate().costTodayUsd, 2);
  assert.equal(store.getAggregate().tokensTodayInput, 100);
  assert.equal(store.getAggregate().tokensTodayOutput, 50);
  assert.equal(store.getAggregate().unknownUsageCount, 0);
  assert.equal(store.getSessions()[0].sessionTokens, 150);
});

test('isolates model counters and handles cumulative reset epochs without stale regression', () => {
  const store = new Store();
  const usage = collectUsage(store);
  const ts = Date.now();
  const start = String(BigInt(ts - 1_000) * 1_000_000n);
  const restart = String(BigInt(ts + 3) * 1_000_000n);
  store.ingest(metric(2, { model: 'model-a', ts, metricStartTimeUnixNano: start }));
  store.ingest(metric(3, { model: 'model-b', ts, metricStartTimeUnixNano: start }));
  store.ingest(metric(2.5, { model: 'model-a', ts: ts + 1, metricStartTimeUnixNano: start }));
  store.ingest(metric(1, { model: 'model-a', ts: ts + 2, metricStartTimeUnixNano: start }));
  store.ingest(metric(1, { model: 'model-a', ts: ts + 4, metricStartTimeUnixNano: restart }));
  store.ingest(metric(9, { model: 'model-a', ts: ts + 5, metricStartTimeUnixNano: start }));
  store.ingest(metric(1.5, { model: 'model-a', ts: ts + 6, metricStartTimeUnixNano: restart }));
  assert.deepEqual(
    usage.map((entry) => entry.dUsd),
    [2, 3, 0.5, 1, 0.5],
  );
  assert.equal(store.getAggregate().costTodayUsd, 7);
});

test('adds distinct delta samples, deduplicates replay, and accepts late disjoint samples', () => {
  const store = new Store();
  const usage = collectUsage(store);
  const ts = Date.now();
  const first = metric(4, { metricTemporality: 'delta', ts });
  const second = metric(3, { metricTemporality: 'delta', ts: ts + 2 });
  store.ingest(first);
  store.ingest(second);
  store.ingest({ ...first, id: 'replayed-in-new-envelope' });
  store.ingest(metric(2, { metricTemporality: 'delta', ts: ts + 1 }));
  assert.deepEqual(
    usage.map((entry) => entry.dUsd),
    [4, 3, 2],
  );
  assert.equal(store.getAggregate().costTodayUsd, 9);
});

test('restores counter baselines, session totals and usage identities across a restart', () => {
  const original = new Store();
  const usage = collectUsage(original);
  const ts = Date.now();
  const initial = metric(4, { ts });
  const codex = event({
    kind: 'api_request',
    requestId: 'req-before-restart',
    costUsd: 2,
    inputTokens: 8,
    outputTokens: 3,
  });
  original.ingest(initial);
  original.ingest(codex);
  const snapshots = new Map<string, CumulativeSnapshot>();
  for (const entry of usage) {
    if (entry.cumulative) snapshots.set(entry.cumulative.seriesKey, entry.cumulative);
  }
  const restarted = new Store();
  const newUsage = collectUsage(restarted);
  restarted.restoreCumulative(snapshots);
  restarted.restoreUsageIds(usage.flatMap((entry) => [entry.usageId, ...(entry.dedupeKeys ?? [])]));
  restarted.restoreSessionTotals(
    new Map([
      [
        'claude:session-1',
        { costUsd: 4, tokensIn: 0, tokensOut: 0, costKnown: true, tokensKnown: false },
      ],
      [
        'codex:session-1',
        { costUsd: 2, tokensIn: 8, tokensOut: 3, costKnown: true, tokensKnown: true },
      ],
    ]),
  );
  restarted.hydrateToday({
    costUsd: 6,
    tokensIn: 8,
    tokensOut: 3,
    costKnown: true,
    tokensKnown: true,
  });
  restarted.hydrateToday({ costUsd: 4, tokensIn: 0, tokensOut: 0 }, 'claude');
  restarted.hydrateToday({ costUsd: 2, tokensIn: 8, tokensOut: 3 }, 'codex');
  restarted.ingest(event({ provider: 'claude' }));
  restarted.ingest(initial);
  restarted.ingest(codex);
  restarted.ingest(metric(5, { ts: ts + 1 }));
  assert.equal(newUsage.length, 1);
  assert.equal(newUsage[0].dUsd, 1);
  assert.equal(restarted.getAggregate().costTodayUsd, 7);
  assert.equal(restarted.getAggregate('claude').costTodayUsd, 5);
  assert.equal(restarted.getAggregate('codex').costTodayUsd, 2);
  assert.equal(
    restarted.getSessions().find((session) => session.provider === 'claude')?.sessionCostUsd,
    5,
  );
  assert.equal(
    restarted.getSessions().find((session) => session.provider === 'codex')?.sessionTokens,
    11,
  );
});

test('late prior-day usage is persisted without resetting today or reviving a stopped turn', () => {
  const store = new Store();
  const usage = collectUsage(store);
  store.ingest(event({ subtype: 'prompt_submit' }));
  store.ingest(event({ kind: 'api_request', costUsd: 1, inputTokens: 5, outputTokens: 2 }));
  store.ingest(event({ subtype: 'stop' }));
  const yesterday = Date.now() - 86_400_000;
  store.ingest(
    event({ kind: 'api_request', ts: yesterday, costUsd: 9, inputTokens: 30, outputTokens: 10 }),
  );
  assert.equal(usage.length, 2);
  assert.equal(usage[1].ts, yesterday);
  assert.equal(store.getAggregate().costTodayUsd, 1);
  assert.equal(store.getSessions()[0].status, 'idle');
});

test('keeps late metric attribution after session end and clears ticket on branch change', () => {
  const store = new Store();
  const usage = collectUsage(store);
  store.ingest(event({ provider: 'claude', branch: 'HM-1', ticket: 'HM-1' }));
  store.ingest(metric(1));
  store.ingest(event({ provider: 'claude', subtype: 'session_end' }));
  store.ingest(metric(2, { ts: Date.now() + 1 }));
  assert.equal(store.getSessions().length, 0);
  assert.equal(usage[1].ticket, 'HM-1');

  store.ingest(event({ branch: 'HM-2', ticket: 'HM-2' }));
  store.ingest(event({ subtype: 'context_update', branch: 'main' }));
  store.ingest(event({ kind: 'api_request', costUsd: 1 }));
  assert.equal(usage.at(-1)?.ticket, undefined);
});

test('external Brain usage updates aggregates once without manufacturing an agent session', () => {
  const store = new Store();
  const emittedUsage = collectUsage(store);
  const usage: UsageDelta = {
    usageId: 'brain:run:reader',
    source: 'brain',
    provider: 'brain',
    runId: 'run',
    ts: Date.now(),
    dUsd: null,
    dTokensIn: 15,
    dTokensOut: 8,
    costStatus: 'unknown',
  };
  store.ingestExternalUsage(usage);
  store.ingestExternalUsage(usage);
  assert.equal(store.getSessions().length, 0);
  assert.equal(emittedUsage.length, 0);
  assert.equal(store.getAggregate().tokensTodayInput, 15);
  assert.equal(store.getAggregate().unknownUsageCount, 1);
});

test('attributes a delayed response to the scope at its event time, not the current branch', () => {
  const store = new Store();
  const usage = collectUsage(store);
  const ts = Date.now();
  store.ingest(event({ ts, branch: 'HM-1', ticket: 'HM-1', runId: 'run-a' }));
  store.ingest(
    event({
      ts: ts + 20,
      subtype: 'context_update',
      branch: 'HM-2',
      ticket: 'HM-2',
      runId: 'run-b',
    }),
  );
  store.ingest(
    event({ ts: ts + 10, kind: 'api_request', costUsd: 2, inputTokens: 10, outputTokens: 3 }),
  );
  assert.equal(usage[0].ticket, 'HM-1');
  assert.equal(usage[0].runId, 'run-a');
  assert.equal(store.getSessions()[0].ticket, 'HM-2');
});

test('estimates Codex cost from explicit configured rates and the model context', () => {
  const prior = process.env.MODEL_PRICING_JSON;
  process.env.MODEL_PRICING_JSON = JSON.stringify({
    'priced-test-model': {
      inputPerMillionUsd: 2,
      outputPerMillionUsd: 8,
      cachedInputPerMillionUsd: 1,
    },
  });
  try {
    const store = new Store();
    const usage = collectUsage(store);
    store.ingest(event({ model: 'priced-test-model' }));
    store.ingest(
      event({ kind: 'api_request', inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 }),
    );
    assert.equal(usage[0].dUsd, 0.00026);
    assert.equal(usage[0].costStatus, 'estimated');
    assert.equal(usage[0].model, 'priced-test-model');
  } finally {
    if (prior === undefined) {
      delete process.env.MODEL_PRICING_JSON;
    } else {
      process.env.MODEL_PRICING_JSON = prior;
    }
  }
});

test('context enrichment does not reset live tool state', () => {
  const store = new Store();
  store.ingest(event({ subtype: 'session_start' }));
  store.ingest(event({ subtype: 'prompt_submit' }));
  store.ingest(event({ subtype: 'pre_tool', toolName: 'File edit' }));
  store.ingest(event({ subtype: 'context_update', ticketTitle: 'Login validation' }));

  const [session] = store.getSessions();
  assert.equal(session.status, 'tool');
  assert.equal(session.currentTool, 'File edit');
  assert.equal(session.ticketTitle, 'Login validation');
});

test('provider aggregates isolate live activity and durable daily usage, including day rollover', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-18T12:00:00Z') });
  const store = new Store();
  t.after(() => store.close());
  store.ingest(event({ provider: 'claude', subtype: 'prompt_submit' }));
  store.ingest(event({ subtype: 'prompt_submit' }));
  store.ingest(metric(3));
  const request = event({ kind: 'api_request', costUsd: 2, inputTokens: 12, outputTokens: 4 });
  store.ingest(request);
  store.ingest(request);
  store.ingest(event({ kind: 'api_request', inputTokens: 1, model: 'unpriced-filter-test' }));
  store.ingest(
    event({ provider: 'claude', kind: 'tool_decision', toolName: 'Edit', decision: 'accept' }),
  );
  store.ingest(event({ kind: 'tool_decision', toolName: 'File edit', decision: 'reject' }));
  store.ingest(event({ provider: 'claude', kind: 'api_error', statusCode: 429 }));
  store.ingest(event({ kind: 'api_error', statusCode: 500 }));
  store.ingestExternalUsage({
    usageId: 'brain:provider-filter',
    source: 'brain',
    provider: 'brain',
    ts: Date.now(),
    dUsd: 5,
    dTokensIn: 100,
    dTokensOut: 30,
    costStatus: 'estimated',
  });

  const { claude, codex } = store.getProviderAggregates();
  assert.equal(store.getAggregate().costTodayUsd, 10);
  assert.equal(claude.costTodayUsd, 3);
  assert.equal(codex.costTodayUsd, 2);
  assert.equal(claude.activeSessions, 1);
  assert.equal(codex.activeSessions, 1);
  assert.equal(claude.promptsLastHour, 1);
  assert.equal(codex.promptsLastHour, 1);
  assert.equal(claude.editWriteAccepts, 1);
  assert.equal(claude.editWriteRejects, 0);
  assert.equal(codex.editWriteRejects, 1);
  assert.equal(codex.editWriteAccepts, 0);
  assert.deepEqual(
    claude.recentErrors.map((entry) => entry.statusCode),
    [429],
  );
  assert.deepEqual(
    codex.recentErrors.map((entry) => entry.statusCode),
    [500],
  );
  assert.equal(codex.tokensTodayInput, 13);
  assert.equal(codex.unknownUsageCount, 1);
  assert.equal(claude.unknownUsageCount, 0);

  store.ingest(event({ subtype: 'session_end' }));
  assert.equal(store.getAggregate('codex').activeSessions, 0);
  assert.equal(
    store.getAggregate('codex').costTodayUsd,
    2,
    'ended sessions still count toward today',
  );

  t.mock.timers.tick(86_400_000);
  for (const aggregate of Object.values(store.getProviderAggregates())) {
    assert.equal(aggregate.costTodayUsd, 0);
    assert.equal(aggregate.costKnown, false);
    assert.equal(aggregate.tokensTodayInput, 0);
    assert.equal(aggregate.unknownUsageCount, 0);
    assert.equal(aggregate.editWriteAccepts + aggregate.editWriteRejects, 0);
  }
  store.ingest(metric(7));
  assert.equal(
    store.getAggregate('claude').costTodayUsd,
    4,
    'only the new cumulative delta is counted',
  );
  assert.equal(store.getAggregate('codex').costTodayUsd, 0);
});

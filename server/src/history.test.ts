import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import SQLite from 'better-sqlite3';
import { History, type StoredUsage } from './db.js';
import type { AgentEvent, CumulativeSnapshot } from './types.js';
import { migrateSqliteHistory } from './persistence/migrate-history.js';
import { Store } from './store/store.js';
import { PersistenceQueue } from './persistence/queue.js';

function usage(overrides: Partial<StoredUsage> = {}): StoredUsage {
  return {
    source: 'codex_logs',
    usageId: `codex:test:${randomUUID()}`,
    ts: Date.now(),
    provider: 'codex',
    sessionId: 'session-one',
    agent: 'agent-one',
    dUsd: 0.25,
    dTokensIn: 20,
    dTokensOut: 5,
    costStatus: 'measured',
    ...overrides,
  };
}

function checkpoint(ts: number): CumulativeSnapshot {
  return {
    seriesKey: 'claude:session-one:model-one:cost',
    provider: 'claude',
    sessionId: 'session-one',
    metricName: 'claude_code.cost.usage',
    model: 'model-one',
    value: 0.25,
    ts,
  };
}

async function verifyRequestCompletion(target: History): Promise<void> {
  const baseline = await target.todayTotals();
  let store = new Store();
  const writes = new PersistenceQueue(() => {});
  const connect = () => {
    store.on('usage', (observation) => writes.enqueue(() => target.recordUsage(observation)));
    store.on('usage_aliases', (update) => writes.enqueue(() => target.recordUsageAliases(update)));
  };
  connect();
  const ts = Date.now();
  try {
    store.ingest({
      id: 'completion-first',
      ts,
      kind: 'api_request',
      provider: 'codex',
      sessionId: 'completion',
      requestId: 'partial-request',
      inputTokens: 100,
      cachedInputTokens: 20,
      ticket: 'HM-42',
    });
    await writes.flush();
    store.close();
    await target.close();
    await target.init();
    store = new Store();
    store.restoreUsageIdentityMap(await target.loadUsageIdentityMap());
    store.restoreRequestUsage(await target.loadRequestUsage());
    store.restoreSessionTotals(await target.loadSessionTotals());
    store.hydrateToday(await target.todayTotals());
    store.hydrateToday(await target.todayTotals('codex'), 'codex');
    connect();
    store.ingest({
      id: 'completion-final',
      ts: ts + 10,
      kind: 'api_request',
      provider: 'codex',
      sessionId: 'completion',
      requestId: 'partial-request',
      responseId: 'final-response',
      outputTokens: 20,
      costUsd: 0.5,
      ticket: 'HM-99',
    });
    await writes.flush();
    const current = await target.todayTotals();
    assert.equal(current.tokensIn, baseline.tokensIn + 100);
    assert.equal(current.tokensOut, baseline.tokensOut + 20);
    assert.equal(current.costUsd, baseline.costUsd + 0.5);
    assert.equal(current.unknownUsageCount, baseline.unknownUsageCount);
    assert.equal(current.usageCount, baseline.usageCount + 1);
    assert.equal(store.getAggregate().costTodayUsd, current.costUsd);
    assert.equal(store.getAggregate().unknownUsageCount, current.unknownUsageCount);
    const observation = (await target.exportUsage()).find(
      (row) => row.sessionId === 'codex:completion',
    )!;
    assert.equal(observation.ts, ts);
    assert.equal(observation.ticket, 'HM-42');
    assert.equal(observation.cachedInputTokens, 20);
    assert.equal(observation.dTokensOut, 20);
    await target.close();
    await target.init();
    store.close();
    store = new Store();
    store.restoreUsageIdentityMap(await target.loadUsageIdentityMap());
    store.restoreRequestUsage(await target.loadRequestUsage());
    store.restoreSessionTotals(await target.loadSessionTotals());
    connect();
    store.ingest({
      id: 'completion-replay',
      ts: ts + 20,
      kind: 'api_request',
      provider: 'codex',
      sessionId: 'completion',
      responseId: 'final-response',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.5,
    });
    await writes.flush();
    assert.deepEqual(await target.todayTotals(), current);
    assert.equal(store.getSessions()[0].sessionTokens, 120);
  } finally {
    store.close();
  }
}

async function verifyTelemetryCorrections(target: History): Promise<void> {
  const priorPrices = process.env.MODEL_PRICING_JSON;
  process.env.MODEL_PRICING_JSON = JSON.stringify({
    'late-cache-history': {
      inputPerMillionUsd: 10,
      outputPerMillionUsd: 20,
      cachedInputPerMillionUsd: 1,
    },
  });
  const baseline = await target.todayTotals();
  const priorPrompts = ((await target.trends(1)) as { days: Array<{ prompts: number }> }).days[0]
    .prompts;
  let store = new Store();
  store.restorePrompts(await target.loadPromptEvents(Date.now() - 3_600_000));
  const priorClaudePrompts = store.getAggregate('claude').promptsLastHour;
  const writes = new PersistenceQueue(() => {});
  const connect = () => {
    store.on('event', (event) => writes.enqueue(() => target.recordEvent(event)));
    store.on('usage', (usage) => writes.enqueue(() => target.recordUsage(usage)));
    store.on('usage_aliases', (update) => writes.enqueue(() => target.recordUsageAliases(update)));
  };
  const ts = Date.now() - 10_000;
  const prompt: AgentEvent = {
    id: 'prompt-native',
    ts: ts + 1,
    provider: 'claude',
    kind: 'user_prompt',
    sessionId: 'prompt-history',
    promptId: 'prompt-id',
  };
  const request: AgentEvent = {
    id: 'cache-first',
    ts,
    provider: 'codex',
    kind: 'api_request',
    sessionId: 'cache-history',
    requestId: 'cache-request',
    model: 'late-cache-history',
    inputTokens: 1000,
    outputTokens: 100,
  };
  try {
    connect();
    // Native first, then the earlier hook: both must produce one prompt in history.
    store.ingest(prompt);
    store.ingest({
      ...prompt,
      id: 'prompt-hook',
      ts,
      kind: 'activity',
      subtype: 'prompt_submit',
      promptId: undefined,
    });
    store.ingest(request);
    await writes.flush();
    store.close();
    await target.close();
    await target.init();
    store = new Store();
    store.restorePrompts(await target.loadPromptEvents(Date.now() - 3_600_000));
    store.restoreUsageIdentityMap(await target.loadUsageIdentityMap());
    store.restoreRequestUsage(await target.loadRequestUsage());
    store.restoreSessionTotals(await target.loadSessionTotals());
    store.hydrateToday(await target.todayTotals());
    store.hydrateToday(await target.todayTotals('codex'), 'codex');
    connect();
    assert.equal(store.getAggregate('claude').promptsLastHour, priorClaudePrompts + 1);
    store.ingest({ ...prompt, id: 'prompt-replay' });
    assert.equal(store.getAggregate('claude').promptsLastHour, priorClaudePrompts + 1);
    store.ingest({
      ...request,
      id: 'cache-complete',
      ts: ts + 20,
      responseId: 'cache-response',
      cachedInputTokens: 900,
    });
    await writes.flush();
    let totals = await target.todayTotals();
    assert.ok(Math.abs(totals.costUsd - baseline.costUsd - 0.0039) < 1e-12);
    assert.ok(Math.abs(store.getAggregate().costTodayUsd - totals.costUsd) < 1e-12);
    assert.equal(totals.usageCount, baseline.usageCount + 1);
    assert.equal(
      ((await target.trends(1)) as { days: Array<{ prompts: number }> }).days[0].prompts,
      priorPrompts + 1,
    );
    const stored = (await target.exportUsage()).find(
      (row) => row.sessionId === 'codex:cache-history',
    )!;
    assert.equal(stored.dUsd, 0.0039);
    assert.equal(stored.cachedInputTokens, 900);
    assert.equal(stored.costOrigin, 'model');
    store.ingest({ ...request, id: 'cache-explicit-zero', costUsd: 0 });
    store.ingest({ ...request, id: 'cache-conflicting-cost', costUsd: 100 });
    await writes.flush();
    totals = await target.todayTotals();
    assert.equal(totals.costUsd, baseline.costUsd);
    assert.equal(totals.unknownUsageCount, baseline.unknownUsageCount);
    assert.equal(
      (await target.exportUsage()).find((row) => row.sessionId === 'codex:cache-history')!
        .costOrigin,
      'reported',
    );
  } finally {
    store.close();
    if (priorPrices === undefined) delete process.env.MODEL_PRICING_JSON;
    else process.env.MODEL_PRICING_JSON = priorPrices;
  }
}

test('SQLite restores prompt windows and corrects a persisted estimate after late cache usage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aad-telemetry-fixes-'));
  const target = new History({
    backend: 'sqlite',
    databasePath: join(directory, 'history.db'),
    pruneOnInit: false,
  });
  try {
    await target.init();
    await verifyTelemetryCorrections(target);
  } finally {
    await target.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite request completion survives restart and response-only replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aad-complete-'));
  const target = new History({
    backend: 'sqlite',
    databasePath: join(directory, 'history.db'),
    pruneOnInit: false,
  });
  try {
    await target.init();
    await verifyRequestCompletion(target);
  } finally {
    await target.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function verifyHistory(target: History): Promise<void> {
  const ts = Date.now();
  const first = usage({
    ts,
    ticket: 'HARM-1',
    cumulative: checkpoint(ts),
    dedupeKeys: ['codex:test:request-alias'],
  });
  assert.equal(await target.recordUsage(first), true);
  assert.equal(await target.recordUsage(first), false);
  await target.recordUsage(
    usage({
      ts: ts + 1,
      usageId: 'brain:unknown',
      source: 'brain',
      provider: 'openai',
      dUsd: null,
      dTokensIn: 10,
      dTokensOut: null,
      costStatus: 'unknown',
    }),
  );
  await target.recordUsage(
    usage({
      ts: ts + 2,
      usageId: 'claude:tokens',
      source: 'claude_metrics',
      provider: 'claude',
      metricName: 'claude_code.token.usage',
      dUsd: null,
      dTokensIn: 30,
      dTokensOut: null,
      costStatus: 'unknown',
    }),
  );
  await target.recordUsage(
    usage({ ts: ts + 3, usageId: 'codex:free', dUsd: 0, dTokensIn: null, dTokensOut: null }),
  );
  const current = await target.todayTotals();
  assert.equal(current.costUsd, 0.25);
  assert.equal(current.tokensIn, 60);
  assert.equal(current.tokensOut, 5);
  assert.equal(current.usageCount, 4);
  assert.equal(
    current.unknownUsageCount,
    1,
    'a separate token metric is not a missing cost observation',
  );
  assert.equal(current.unattributedUsageCount, 3);
  assert.equal(current.unattributedCostUsd, 0);
  assert.equal(current.costKnown, true);
  assert.equal(current.tokensKnown, true);
  const codex = await target.todayTotals('codex');
  assert.equal(codex.costUsd, 0.25);
  assert.equal(codex.tokensIn, 20);
  assert.equal(codex.usageCount, 2);
  assert.equal(codex.unknownUsageCount, 0);
  const claude = await target.todayTotals('claude');
  assert.equal(claude.costKnown, false);
  assert.equal(claude.tokensIn, 30);
  assert.equal(claude.usageCount, 1);
  const unknown = (await target.exportUsage()).find((row) => row.usageId === 'brain:unknown');
  assert.equal(unknown?.dUsd, null, 'unknown cost remains null, not zero');
  assert.equal(unknown?.dTokensOut, null);
  assert.equal((await target.exportUsage({ since: ts + 1, until: ts + 2 })).length, 1);
  assert.ok((await target.loadUsageIds()).includes('codex:test:request-alias'));
  await target.recordUsageAliases({
    usageId: first.usageId,
    dedupeKeys: ['codex:test:late-response-alias'],
  });
  assert.equal(
    (await target.loadUsageIdentityMap()).get('codex:test:late-response-alias'),
    first.usageId,
  );
  assert.equal(
    (await target.todayTotals()).costUsd,
    0.25,
    'learning an alias does not add another charge',
  );
  assert.equal((await target.loadSessionTotals()).get('session-one')?.costUsd, 0.25);
  await target.recordCumulative({ ...checkpoint(ts - 1), value: 99 });
  assert.equal((await target.loadCumulative()).get(first.cumulative!.seriesKey)?.value, 0.25);
  const event = {
    id: 'event-one',
    ts,
    kind: 'activity' as const,
    subtype: 'prompt_submit' as const,
    provider: 'codex' as const,
    sessionId: 'session-one',
    agent: 'agent-one',
  };
  assert.equal(await target.recordEvent(event), true);
  assert.equal(await target.recordEvent(event), false);
  const trend = (await target.trends(1)) as {
    days: Array<{ costUsd: number; prompts: number; sessions: number; unknownUsageCount: number }>;
  };
  assert.equal(trend.days[0].costUsd, current.costUsd);
  assert.equal(trend.days[0].unknownUsageCount, 1);
  assert.equal(trend.days[0].prompts, 1);
  assert.equal(trend.days[0].sessions, 1);
  const timeline = (await target.agentHistory('agent-one')) as {
    totals: { costUsd: number; sessions: number };
    events: unknown[];
  };
  assert.equal(timeline.totals.costUsd, 0.25);
  assert.equal(timeline.totals.sessions, 1);
  assert.equal(timeline.events.length, 1);
}

test('SQLite history preserves unknown and unattributed usage, aliases and checkpoints across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aad-history-'));
  const databasePath = join(directory, 'history.db');
  const first = new History({ backend: 'sqlite', databasePath, pruneOnInit: false });
  const reopened = new History({ backend: 'sqlite', databasePath, pruneOnInit: false });
  try {
    await first.init();
    assert.equal(first.enabled, true);
    await verifyHistory(first);
    await first.close();
    await reopened.init();
    assert.equal((await reopened.todayTotals()).costUsd, 0.25);
    assert.equal((await reopened.loadCumulative()).size, 1);
    assert.ok((await reopened.loadUsageIds()).includes('codex:test:request-alias'));
    assert.ok((await reopened.loadUsageIdentityMap()).has('codex:test:late-response-alias'));
  } finally {
    await first.close();
    await reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function createLegacyDatabase(path: string): void {
  const database = new SQLite(path);
  try {
    database.exec(`
      CREATE TABLE events(id INTEGER PRIMARY KEY,ts INTEGER,day TEXT,kind TEXT,session_id TEXT,agent TEXT);
      CREATE TABLE usage(id INTEGER PRIMARY KEY,ts INTEGER,day TEXT,session_id TEXT,agent TEXT,ticket TEXT,d_usd REAL,d_tokens_in INTEGER,d_tokens_out INTEGER);
      CREATE TABLE cumulative(session_id TEXT PRIMARY KEY,cost REAL,tokens_json TEXT,ts INTEGER);
    `);
    database
      .prepare('INSERT INTO events VALUES(?,?,?,?,?,?)')
      .run(7, Date.now(), 'legacy-day', 'user_prompt', 'legacy-session', 'legacy-agent');
    database
      .prepare('INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?)')
      .run(12, Date.now(), 'legacy-day', 'legacy-session', 'legacy-agent', null, 1.5, 100, 20);
    database
      .prepare('INSERT INTO cumulative VALUES(?,?,?,?)')
      .run('legacy-session', 1.5, '{"input":100}', Date.now());
  } finally {
    database.close();
  }
}

test('legacy SQLite upgrades once without discarding original rows or inventing cumulative series', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aad-legacy-history-'));
  const databasePath = join(directory, 'legacy.db');
  createLegacyDatabase(databasePath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const target = new History({ backend: 'sqlite', databasePath, pruneOnInit: false });
    try {
      await target.init();
      assert.equal((await target.todayTotals()).costUsd, 1.5);
      assert.equal((await target.loadCumulative()).size, 0);
      assert.deepEqual(await target.loadUsageIds(), ['legacy-sqlite-local:usage:12']);
    } finally {
      await target.close();
    }
  }
  const original = new SQLite(databasePath, { readonly: true });
  assert.equal((original.prepare('SELECT id FROM usage').get() as { id: number }).id, 12);
  original.close();
  await rm(directory, { recursive: true, force: true });
});

test(
  'PostgreSQL integration: durable writes, atomic usage checkpoints and read-only idempotent migration',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const schema = `aad_history_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString });
    const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
    const target = new History({ backend: 'postgres', pool, pruneOnInit: false });
    const directory = await mkdtemp(join(tmpdir(), 'aad-migrate-history-'));
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await target.init();
      assert.equal(target.storageKind, 'postgresql');
      await verifyHistory(target);
      const originalCount = (await target.exportUsage()).length;
      const broken = usage({ usageId: 'broken:checkpoint', cumulative: checkpoint(Number.NaN) });
      await assert.rejects(target.recordUsage(broken));
      assert.equal(
        (await target.exportUsage()).length,
        originalCount,
        'failed checkpoint rolls back usage insertion',
      );
      await target.close();
      await target.init();
      assert.equal((await target.todayTotals()).costUsd, 0.25);
      assert.equal((await target.todayTotals('codex')).costUsd, 0.25);
      const concurrent = usage({ usageId: 'concurrent:duplicate' });
      assert.deepEqual(
        (
          await Promise.all([target.recordUsage(concurrent), target.recordUsage(concurrent)])
        ).sort(),
        [false, true],
      );

      const sourcePath = join(directory, 'source.db');
      createLegacyDatabase(sourcePath);
      const digest = async () =>
        createHash('sha256')
          .update(await readFile(sourcePath))
          .digest('hex');
      const before = await digest();
      const firstImport = await migrateSqliteHistory(sourcePath, pool, 'stable-source');
      assert.equal(firstImport.events, 1);
      assert.equal(firstImport.usage, 1);
      assert.equal(firstImport.legacyCheckpoints, 1);
      assert.equal(await digest(), before, 'migration must not modify its SQLite source');
      const secondImport = await migrateSqliteHistory(sourcePath, pool, 'stable-source');
      assert.equal(secondImport.events, 0);
      assert.equal(secondImport.usage, 0);
      assert.equal(secondImport.legacyCheckpoints, 0);
      assert.equal(await digest(), before);
      assert.ok((await target.loadUsageIds()).includes('stable-source:usage:12'));
      assert.equal((await target.loadCumulative()).size, 1, 'legacy snapshots stay archived');

      const modernPath = join(directory, 'modern.db');
      const modern = new History({
        backend: 'sqlite',
        databasePath: modernPath,
        pruneOnInit: false,
      });
      await modern.init();
      await modern.recordUsage(
        usage({ usageId: 'preserve-this-id', dedupeKeys: ['preserve-alias'] }),
      );
      await modern.close();
      const modernBefore = createHash('sha256')
        .update(await readFile(modernPath))
        .digest('hex');
      assert.equal((await migrateSqliteHistory(modernPath, pool)).usage, 1);
      assert.equal((await migrateSqliteHistory(modernPath, pool)).usage, 0);
      assert.equal(
        createHash('sha256')
          .update(await readFile(modernPath))
          .digest('hex'),
        modernBefore,
      );
      assert.ok((await target.loadUsageIds()).includes('preserve-alias'));
      await verifyRequestCompletion(target);
      await verifyTelemetryCorrections(target);
    } finally {
      await target.close();
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { History, historyDay } from './db.js';
import { UsageAccounting } from './store/accounting.js';
import { usePricingCatalogue } from './model-cost.js';
import type { AgentEvent, UsageDelta } from './types.js';

const event: AgentEvent = {
  id: 'request-event',
  ts: 1000,
  kind: 'api_request',
  provider: 'codex',
  sessionId: 'session',
  requestId: 'request',
  model: 'test-model',
  inputTokens: 100,
  outputTokens: 20,
};

function historicalUsage(): UsageDelta {
  const original = new UsageAccounting().consume(event).usage!;
  return {
    ...original,
    dUsd: 0.12,
    costStatus: 'estimated',
    costOrigin: 'historical_estimate',
    costEstimate: {
      at: '2026-09-24T00:00:00Z',
      method: 'configured-rate-backfill',
      historicalRateVerified: false,
      missingCacheAssumedZero: true,
      priceVersion: {
        at: 2000,
        rates: {
          inputPerMillionUsd: 1000,
          outputPerMillionUsd: 1000,
          cachedInputPerMillionUsd: 100,
        },
      },
    },
  };
}

test('historical estimates accept reported costs, including zero, without requiring saved rates', () => {
  const release = usePricingCatalogue(() => undefined);
  try {
    for (const reportedCost of [0.03, 0]) {
      const accounting = new UsageAccounting();
      const original = historicalUsage();
      delete original.costEstimate;
      accounting.restoreRequestUsage([original]);
      assert.equal(accounting.consume(event).completion, undefined);
      const corrected = accounting.consume({ ...event, costUsd: reportedCost }).completion!;
      assert.equal(corrected.current.dUsd, reportedCost);
      assert.equal(corrected.current.costOrigin, 'reported');
      assert.equal(accounting.consume({ ...event, costUsd: 999 }).completion, undefined);
    }
  } finally {
    release();
  }
});

test('cache-only events cannot create usage or reserve a request identity', () => {
  const accounting = new UsageAccounting();
  for (const cachedInputTokens of [0, 40]) {
    assert.deepEqual(
      accounting.consume({
        id: 'cache-only',
        ts: event.ts,
        kind: 'api_request',
        provider: 'codex',
        sessionId: event.sessionId,
        requestId: event.requestId,
        cachedInputTokens,
      }),
      {},
    );
  }
  assert.ok(accounting.consume(event).usage);
  assert.equal(accounting.consume(event).usage, undefined);
});

async function verifyPersistedCorrections(history: History, cacheOnly: boolean) {
  const release = usePricingCatalogue(() => undefined);
  try {
    const original = historicalUsage();
    await history.recordUsage(original);
    let accounting = new UsageAccounting();
    accounting.restoreRequestUsage(await history.loadRequestUsage());
    assert.equal(
      accounting.consume(event).completion,
      undefined,
      'an identical replay preserves the estimate',
    );
    const cachedEvent: AgentEvent = cacheOnly
      ? {
          id: 'cache-only',
          ts: event.ts + 1,
          kind: 'api_request',
          provider: 'codex',
          sessionId: event.sessionId,
          requestId: event.requestId,
          cachedInputTokens: 40,
        }
      : { ...event, cachedInputTokens: 40 };
    const corrected = accounting.consume(cachedEvent);
    assert.equal(corrected.usage, undefined, 'a completion must not create another observation');
    assert.equal(corrected.completion!.current.dUsd, 0.084);
    await history.recordUsageAliases(corrected.aliases!);
    const observations = await history.loadRequestUsage();
    assert.equal(observations.length, 1);
    let stored = observations[0];
    assert.equal(stored.dUsd, 0.084);
    assert.equal(stored.costOrigin, 'historical_estimate');
    assert.equal(stored.costEstimate!.missingCacheAssumedZero, false);
    assert.deepEqual(stored.costEstimate!.priceVersion, original.costEstimate!.priceVersion);
    const day = historyDay(event.ts);
    const report = await history.trendsReport({ period: 'custom', start: day, end: day });
    assert.equal(report.summary.costUsd, 0.084);
    // A fresh accounting instance models a restart. A changed catalogue must
    // neither reprice an identical replay nor prevent reported-cost completion.
    const releaseNewPrice = usePricingCatalogue(() => ({
      inputPerMillionUsd: 9999,
      outputPerMillionUsd: 9999,
    }));
    try {
      accounting = new UsageAccounting();
      accounting.restoreRequestUsage(await history.loadRequestUsage());
      assert.equal(accounting.consume(cachedEvent).completion, undefined);
      const measured = accounting.consume({ ...cachedEvent, costUsd: 0 });
      await history.recordUsageAliases(measured.aliases!);
      stored = (await history.loadRequestUsage())[0];
      assert.equal(stored.dUsd, 0);
      assert.equal(stored.costOrigin, 'reported');
      assert.equal(stored.costEstimate, undefined);
      assert.equal(stored.dTokensIn, 100);
      assert.equal(stored.dTokensOut, 20);
      assert.equal(stored.cachedInputTokens, 40);
      // Persistence must also reject stale automatic estimates after a report.
      await history.recordUsageAliases(corrected.aliases!);
      assert.equal((await history.loadRequestUsage())[0].dUsd, 0);
    } finally {
      releaseNewPrice();
    }
  } finally {
    release();
  }
}

for (const { backend, cacheOnly } of (['sqlite', 'postgres'] as const).flatMap((backend) =>
  [false, true].map((cacheOnly) => ({ backend, cacheOnly })),
)) {
  test(
    `${backend} persists historical ${cacheOnly ? 'cache-only' : 'full-usage'} corrections and reported costs across restoration`,
    { skip: backend === 'postgres' && !process.env.TEST_DATABASE_URL },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'usage-backfill-'));
      const schema = `backfill_${randomUUID().replaceAll('-', '')}`;
      let owner: pg.Pool | undefined;
      let pool: pg.Pool | undefined;
      if (backend === 'postgres') {
        owner = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
        await owner.query(`CREATE SCHEMA ${schema}`);
        pool = new pg.Pool({
          connectionString: process.env.TEST_DATABASE_URL,
          options: `-c search_path=${schema}`,
        });
      }
      const history = new History({
        backend,
        databasePath: join(directory, 'history.db'),
        pool,
        pruneOnInit: false,
      });
      t.after(async () => {
        await history.close();
        await pool?.end();
        if (owner) {
          await owner.query(`DROP SCHEMA ${schema} CASCADE`);
          await owner.end();
        }
        await rm(directory, { recursive: true, force: true });
      });
      await history.init();
      await verifyPersistedCorrections(history, cacheOnly);
    },
  );
}

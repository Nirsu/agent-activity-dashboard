import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { History, type StoredUsage } from './db.js';
import { InvalidTrendsQuery, resolveTrendsRange } from './trends/range.js';

const timestamp = (value: string) => new Date(value).getTime();

test('Trends uses calendar presets and compares the same local clock position', () => {
  const now = timestamp('2026-09-24T12:30:00');
  const today = resolveTrendsRange({ period: 'today' }, now);
  assert.equal(today.period.start, timestamp('2026-09-24T00:00:00'));
  assert.equal(today.period.previousStart, timestamp('2026-09-23T00:00:00'));
  assert.equal(today.period.previousEnd, timestamp('2026-09-23T12:30:00'));
  assert.equal(today.buckets.length, 13);
  assert.equal(today.buckets.at(-1)?.end, now);
  const month = resolveTrendsRange({ period: 'month' }, now);
  assert.equal(month.period.startDate, '2026-09-01');
  assert.equal(month.period.dayCount, 24);
  assert.equal(month.period.previousStart, timestamp('2026-08-08T00:00:00'));
  assert.equal(month.period.previousEnd, timestamp('2026-08-31T12:30:00'));
  const thirtyDays = resolveTrendsRange({ period: '30d' }, now);
  assert.equal(thirtyDays.period.startDate, '2026-08-26');
  assert.equal(thirtyDays.period.granularity, 'day');
  const ninetyDays = resolveTrendsRange({ period: '90d' }, now);
  assert.equal(ninetyDays.days.length, 90);
  assert.equal(ninetyDays.buckets.length, 13);
  assert.equal(ninetyDays.period.granularity, 'week');
  const completed = resolveTrendsRange(
    { period: 'custom', start: '2026-08-30', end: '2026-09-02' },
    now,
  );
  assert.equal(completed.period.end, timestamp('2026-09-03T00:00:00'));
  assert.equal(completed.period.previousEnd, completed.period.start);
});

test('Trends handles daylight saving days without overlapping comparison windows', () => {
  const originalZone = process.env.TZ;
  process.env.TZ = 'Europe/Paris';
  try {
    const today = resolveTrendsRange({ period: 'today' }, timestamp('2026-03-29T12:30:00'));
    assert.equal(today.period.timeZone, 'Europe/Paris');
    assert.equal(today.period.previousEnd, timestamp('2026-03-28T12:30:00'));
    assert.equal(today.buckets.length, 12);
    for (const [day, hours] of [
      ['2026-03-29', 23],
      ['2026-10-25', 25],
    ] as const) {
      const report = resolveTrendsRange(
        { period: 'custom', start: day, end: day },
        timestamp('2026-11-01T12:00:00'),
      );
      assert.equal(report.buckets.length, hours);
      assert.equal(report.period.previousEnd, report.period.start);
      assert.equal(report.buckets.at(-1)?.end, report.period.end);
    }
  } finally {
    if (originalZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalZone;
    }
  }
});

test('Trends rejects invalid, future, reversed and oversized custom dates', () => {
  const now = timestamp('2026-09-24T12:30:00');
  for (const query of [
    { period: 'unsupported' },
    { period: 'custom' },
    { period: 'custom', start: '2026-02-30', end: '2026-03-01' },
    { period: 'custom', start: '2026-09-24', end: '2026-09-25' },
    { period: 'custom', start: '2026-09-24', end: '2026-09-23' },
    { period: 'custom', start: '2026-01-01', end: '2026-09-23' },
  ]) {
    assert.throws(() => resolveTrendsRange(query, now), InvalidTrendsQuery);
  }
});

function usage(value: string, overrides: Partial<StoredUsage> = {}): StoredUsage {
  return {
    usageId: randomUUID(),
    source: 'codex_logs',
    ts: timestamp(value),
    provider: 'codex',
    sessionId: 'shared-session',
    model: 'model-a',
    dUsd: 1,
    dTokensIn: 100,
    dTokensOut: 10,
    costStatus: 'measured',
    ...overrides,
  };
}

async function verifyReport(history: History) {
  const now = timestamp('2026-09-24T12:30:00');
  const teams = [
    { id: 'platform', name: 'Platform' },
    { id: 'web', name: 'Web' },
  ];
  await history.recordUsage(usage('2026-09-01T00:00:00'));
  await history.recordUsage(usage('2026-09-11T10:00:00', { dUsd: 4 }));
  await history.recordUsage(usage('2026-09-17T15:00:00', { dUsd: 100 }));
  await history.recordUsage(usage('2026-09-18T10:00:00', { teams }));
  await history.recordUsage(
    usage('2026-09-19T11:00:00', { dUsd: 2, teams: [{ id: 'platform', name: 'Core Platform' }] }),
  );
  await history.recordUsage(
    usage('2026-09-24T12:00:00', {
      provider: 'brain',
      source: 'brain',
      sessionId: 'usage-only',
      model: undefined,
      dUsd: null,
      dTokensIn: null,
      dTokensOut: null,
      costStatus: 'unknown',
    }),
  );
  await history.recordUsage(
    usage('2026-09-24T12:05:00', { model: undefined, dUsd: 0, dTokensIn: 0, dTokensOut: 0 }),
  );
  await history.recordUsage(
    usage('2026-09-24T12:10:00', { model: '', dUsd: 0, dTokensIn: 0, dTokensOut: 0 }),
  );
  await history.recordUsage(usage('2026-09-24T12:30:00', { dUsd: 999 }));
  const event = async (
    value: string,
    provider: 'codex' | 'claude',
    sessionId: string,
    promptId?: string,
  ) => {
    await history.recordEvent({
      id: randomUUID(),
      ts: timestamp(value),
      provider,
      sessionId,
      kind: 'user_prompt',
      promptId,
    });
  };
  await event('2026-09-18T10:00:00', 'codex', 'shared-session', 'current-prompt');
  await event('2026-09-19T11:00:00', 'claude', 'shared-session');
  await event('2026-09-20T10:00:00', 'codex', 'event-only');
  await history.recordEvent({
    id: randomUUID(),
    ts: timestamp('2026-09-18T10:00:01'),
    provider: 'codex',
    sessionId: 'shared-session',
    kind: 'activity',
    subtype: 'prompt_submit',
    promptId: 'current-prompt',
  });
  await event('2026-09-11T10:00:00', 'codex', 'previous-session');
  await event('2026-09-17T15:00:00', 'codex', 'outside-comparison');
  // Paired hook/native observations crossing the selection boundary remain one prior prompt.
  await history.recordEvent({
    id: randomUUID(),
    ts: timestamp('2026-09-17T23:59:58'),
    provider: 'codex',
    sessionId: 'boundary-session',
    kind: 'activity',
    subtype: 'prompt_submit',
  });
  await event('2026-09-18T00:00:01', 'codex', 'boundary-session');
  const report = await history.trendsReport({ period: '7d' }, new Map(), now);
  assert.equal(report.summary.costUsd, 3);
  assert.equal(report.summary.tokens, 220);
  assert.equal(report.summary.usageCount, 5);
  assert.equal(report.summary.unknownUsageCount, 1);
  assert.equal(report.summary.unknownTokenCount, 1);
  assert.equal(
    report.summary.sessions,
    5,
    'counts usage-only, event-only and provider-specific sessions once across days',
  );
  assert.equal(
    report.summary.prompts,
    3,
    'deduplicates hook/native pairs including selection boundary',
  );
  assert.equal(report.previous.costUsd, 4);
  assert.equal(report.previous.prompts, 1);
  assert.equal(report.days.length, 7);
  assert.equal(report.days[3].usageCount, 0);
  assert.equal(
    report.days.reduce((sum, day) => sum + day.costUsd, 0),
    report.summary.costUsd,
  );
  assert.ok(report.days.reduce((sum, day) => sum + day.sessions, 0) > report.summary.sessions);
  assert.equal(
    report.byModel.filter((row) => row.provider === 'codex' && row.model === 'Unknown model')
      .length,
    1,
  );
  assert.equal(report.byProvider.find((row) => row.provider === 'brain')?.costKnown, false);
  assert.equal(report.byStream.find((row) => row.teamId === 'platform')?.teamName, 'Core Platform');
  assert.equal(report.byStream.find((row) => row.teamId === 'platform')?.costUsd, 3);
  assert.equal(report.byStream.find((row) => row.teamId === 'web')?.costUsd, 1);
  assert.equal(report.coverage.currentComplete, true);
  assert.equal(report.coverage.previousComplete, true);
  assert.equal(report.insights.averageDailyCostUsd, 3 / 7);
  assert.deepEqual(report.insights.peakDay, { day: '2026-09-19', costUsd: 2 });
  const longReport = await history.trendsReport({ period: '90d' }, new Map(), now);
  assert.equal(longReport.buckets.length, 13);
  assert.equal(longReport.coverage.currentComplete, false);
  assert.equal(longReport.coverage.previousComplete, false);
  assert.equal(
    longReport.buckets.reduce((sum, bucket) => sum + bucket.prompts, 0),
    longReport.summary.prompts,
  );
  assert.equal(
    longReport.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
    longReport.summary.costUsd,
  );
  const today = await history.trendsReport({ period: 'today' }, new Map(), now);
  assert.equal(today.buckets.at(-1)?.unknownUsageCount, 1);
  assert.equal(
    today.buckets.at(-1)?.costKnown,
    true,
    'measured zero remains known beside unknown observations',
  );
}

async function verifyTokenCoverage(history: History) {
  const time = '2026-09-25T10:00:00';
  const records: Partial<StoredUsage>[] = [
    { model: 'input-only', dTokensIn: 100, dTokensOut: null },
    { model: 'output-only', dTokensIn: null, dTokensOut: 20 },
    { model: 'no-tokens', source: 'brain', provider: 'brain', dTokensIn: null, dTokensOut: null },
    { model: 'zero', dTokensIn: 0, dTokensOut: 0 },
    {
      model: 'claude',
      source: 'claude_metrics',
      provider: 'claude',
      metricName: 'claude_code.token.usage',
      dUsd: null,
      dTokensIn: 50,
      dTokensOut: null,
    },
    {
      model: 'claude',
      source: 'claude_metrics',
      provider: 'claude',
      metricName: 'claude_code.token.usage',
      dUsd: null,
      dTokensIn: null,
      dTokensOut: 5,
    },
    {
      model: 'claude',
      source: 'claude_metrics',
      provider: 'claude',
      metricName: 'claude_code.cost.usage',
      dTokensIn: null,
      dTokensOut: null,
    },
    {
      model: 'unknown-claude-tokens',
      source: 'claude_metrics',
      provider: 'claude',
      metricName: 'claude_code.token.usage',
      dUsd: null,
      dTokensIn: null,
      dTokensOut: null,
    },
  ];
  for (const record of records) {
    await history.recordUsage(
      usage(time, { ...record, teams: [{ id: 'coverage', name: 'Coverage' }] }),
    );
  }
  const report = await history.trendsReport(
    { period: 'today' },
    new Map(),
    timestamp('2026-09-25T12:30:00'),
  );
  assert.equal(report.summary.unknownTokenCount, 4);
  assert.equal(report.summary.tokens, 175);
  assert.equal(report.buckets.find((bucket) => bucket.usageCount > 0)?.unknownTokenCount, 4);
  assert.equal(report.days[0].unknownTokenCount, 4);
  assert.equal(report.byStream.find((team) => team.teamId === 'coverage')?.unknownTokenCount, 4);
  assert.equal(report.byStream.find((team) => team.teamId === 'coverage')?.tokensOutKnown, true);
  assert.equal(
    report.byProvider.find((provider) => provider.provider === 'codex')?.unknownTokenCount,
    2,
  );
  const input = report.byModel.find((model) => model.model === 'input-only')!;
  assert.equal(input.tokensInKnown, true);
  assert.equal(input.tokensOutKnown, false);
  const output = report.byModel.find((model) => model.model === 'output-only')!;
  assert.equal(output.tokensInKnown, false);
  assert.equal(output.tokensOutKnown, true);
  const zero = report.byModel.find((model) => model.model === 'zero')!;
  assert.equal(zero.unknownTokenCount, 0);
  assert.equal(zero.tokensInKnown && zero.tokensOutKnown, true);
  assert.equal(report.byModel.find((model) => model.model === 'claude')?.unknownTokenCount, 0);
  const following = await history.trendsReport(
    { period: 'today' },
    new Map(),
    timestamp('2026-09-26T12:30:00'),
  );
  assert.equal(following.previous.unknownTokenCount, 4);
}

for (const backend of ['sqlite', 'postgres'] as const) {
  test(
    `${backend} Trends reports preserve exact windows, unique sessions and measurement coverage`,
    { skip: backend === 'postgres' && !process.env.TEST_DATABASE_URL },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'trends-report-'));
      const schema = `trends_${randomUUID().replaceAll('-', '')}`;
      let pool: pg.Pool | undefined;
      let owner: pg.Pool | undefined;
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
        retentionDays: 190,
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
      await verifyReport(history);
      await verifyTokenCoverage(history);
    },
  );
}

test('disabled history reports unavailable coverage while retaining the selected range', async () => {
  const report = await new History().trendsReport(
    { period: 'today' },
    new Map(),
    timestamp('2026-09-24T12:30:00'),
  );
  assert.equal(report.enabled, false);
  assert.equal(report.coverage.earliestAvailableAt, null);
  assert.equal(report.coverage.currentComplete, false);
  assert.equal(report.summary.costKnown, false);
  assert.equal(report.period.key, 'today');
});

test('Trends does not label a period complete outside the configured retention window', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trends-retention-'));
  const history = new History({
    backend: 'sqlite',
    databasePath: join(directory, 'history.db'),
    retentionDays: 5,
    pruneOnInit: false,
  });
  t.after(async () => {
    await history.close();
    await rm(directory, { recursive: true, force: true });
  });
  await history.init();
  await history.recordUsage(usage('2026-09-01T00:00:00'));
  const report = await history.trendsReport(
    { period: '7d' },
    new Map(),
    timestamp('2026-09-24T12:30:00'),
  );
  assert.equal(report.coverage.retentionDays, 5);
  assert.equal(report.coverage.earliestAvailableAt, timestamp('2026-09-01T00:00:00'));
  assert.equal(report.coverage.currentComplete, false);
  assert.equal(report.coverage.previousComplete, false);
});

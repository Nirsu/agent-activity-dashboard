import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { Store } from './store/store.js';
import { History, type StoredUsage } from './db.js';
import { attributeEvent } from './access/identity.js';
import type { AccessPrincipal } from './access/store.js';
import type { AgentEvent, ActivityTeam, UsageDelta } from './types.js';

const teams: ActivityTeam[] = [
  { id: randomUUID(), name: 'Platform' },
  { id: randomUUID(), name: 'Mobile' },
];

function event(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: randomUUID(),
    ts: Date.now(),
    provider: 'codex',
    kind: 'activity',
    subtype: 'prompt_submit',
    sessionId: 'task',
    ...overrides,
  };
}

test('authenticated teams override spoofed metadata and remain a single usage observation', () => {
  const store = new Store();
  const usage: UsageDelta[] = [];
  store.on('usage', (entry) => usage.push(entry));
  const principal: AccessPrincipal = {
    account: {
      id: randomUUID(),
      name: 'Developer',
      email: 'dev@example.test',
      enabled: true,
      createdAt: new Date().toISOString(),
      teamIds: teams.map((team) => team.id),
    },
    token: {
      id: randomUUID(),
      accountId: '',
      label: 'Workstation',
      createdAt: new Date().toISOString(),
      expiresAt: null,
    },
    teams,
  };
  try {
    const attributed = attributeEvent(
      event({ teamId: 'spoofed', teams: [{ id: 'fake', name: 'Fake' }] }),
      principal,
    );
    store.ingest(attributed);
    store.ingest(
      attributeEvent(
        event({
          kind: 'api_request',
          subtype: undefined,
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.1,
        }),
        principal,
      ),
    );
    assert.deepEqual(store.getSessions()[0].teams, teams);
    assert.equal(store.getAggregate().activeSessions, 1);
    assert.equal(store.getAggregate().costTodayUsd, 0.1);
    assert.equal(usage.length, 1);
    assert.deepEqual(usage[0].teams, teams);
    store.ingest(
      attributeEvent(
        event({
          ts: Date.now() + 1,
          kind: 'api_request',
          subtype: undefined,
          inputTokens: 2,
          costUsd: 0.02,
        }),
        { ...principal, teams: [] },
      ),
    );
    assert.deepEqual(store.getSessions()[0].teams, []);
    assert.equal(store.getSessions()[0].teamId, undefined);
    assert.deepEqual(usage[1].teams, []);
    assert.equal(usage[1].teamId, undefined);
  } finally {
    store.close();
  }
});

test('membership refresh updates live sessions without creating events or changing totals', () => {
  const store = new Store();
  try {
    store.ingest(event({ teams, teamId: teams[0].name }));
    const before = store.getAggregate();
    const initialEvent = store.getRecentEvents()[0];
    let broadcasts = 0;
    store.on('sessions', () => broadcasts++);
    const renamed = [{ ...teams[1], name: 'Mobile Apps' }];
    store.refreshTeams((id) => (id === 'codex:task' ? renamed : undefined));
    assert.deepEqual(store.getSessions()[0].teams, renamed);
    assert.equal(store.getSessions()[0].status, 'thinking');
    assert.deepEqual(store.getAggregate(), before);
    assert.equal(store.getRecentEvents().length, 1);
    assert.deepEqual(initialEvent.teams, teams);
    store.refreshTeams(() => []);
    assert.deepEqual(store.getSessions()[0].teams, []);
    assert.equal(store.getSessions()[0].teamId, undefined);
    assert.equal(broadcasts, 2);
  } finally {
    store.close();
  }
});

async function verifyTeamHistory(history: History) {
  const now = Date.now();
  const usage = (overrides: Partial<StoredUsage> = {}): StoredUsage => ({
    usageId: randomUUID(),
    source: 'codex_logs',
    ts: now,
    provider: 'codex',
    dUsd: 0.5,
    dTokensIn: 20,
    dTokensOut: 5,
    costStatus: 'measured',
    ...overrides,
  });
  await history.recordUsage(usage({ teams, teamId: 'Platform' }));
  await history.recordUsage(
    usage({ ts: now + 1, teams: [{ ...teams[0], name: 'Core Platform' }] }),
  );
  await history.recordUsage(usage({ teams: [], teamId: 'stale-legacy-value' }));
  await history.recordUsage(usage({ teamId: 'legacy' }));
  await history.recordEvent(event({ agent: 'pseudonym', teams }));
  const trends = (await history.trends(1)) as {
    days: Array<{ costUsd: number; tokensIn: number }>;
    byStream: Array<{ teamId: string; teamName: string; costUsd: number; tokens: number }>;
  };
  assert.equal(trends.days[0].costUsd, 2);
  assert.equal(trends.days[0].tokensIn, 80);
  assert.equal(trends.byStream.length, 4);
  assert.deepEqual(
    trends.byStream.find((team) => team.teamId === teams[0].id)?.teamName,
    'Core Platform',
  );
  assert.equal(trends.byStream.find((team) => team.teamId === teams[0].id)?.costUsd, 1);
  assert.equal(trends.byStream.find((team) => team.teamId === teams[1].id)?.costUsd, 0.5);
  assert.equal(trends.byStream.find((team) => team.teamId === 'unassigned')?.costUsd, 0.5);
  assert.equal(trends.byStream.find((team) => team.teamId === 'legacy')?.costUsd, 0.5);
  assert.equal((await history.exportUsage()).length, 4);
  const detail = (await history.agentHistory('pseudonym')) as { events: AgentEvent[] };
  assert.deepEqual(detail.events[0].teams, teams);
}

test('SQLite history persists all teams, merges renamed IDs and counts global usage once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'team-history-'));
  const history = new History({ backend: 'sqlite', databasePath: join(directory, 'history.db') });
  try {
    await history.init();
    assert.equal(history.enabled, true);
    await verifyTeamHistory(history);
    await history.close();
    await history.init();
    assert.deepEqual(
      (await history.exportUsage()).find((entry) => entry.teams?.length === 2)?.teams,
      teams,
    );
  } finally {
    await history.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'PostgreSQL history expands memberships without duplicating overall usage',
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async () => {
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `team_history_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const history = new History({ backend: 'postgres', pool });
    try {
      await history.init();
      await verifyTeamHistory(history);
    } finally {
      await history.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

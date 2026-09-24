import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { History } from './db.js';
import type { AgentEvent, UsageDelta } from './types.js';
import { config } from './config.js';
import { agentLabel } from './identity.js';
import { historyPerson } from './trends/attribution.js';
import { attributeEvent } from './access/identity.js';

const at = (day: number, hour = 10) => new Date(2026, 5, day, hour).getTime();
const alice = randomUUID();
const bob = randomUUID();
const workstation = randomUUID();
const firstSession = `codex:${alice}/${workstation}/session`;
const red = { id: 'red', name: 'Red' };
const web = { id: 'web', name: 'Web' };
const blue = { id: 'blue', name: 'Blue' };
const aliases = new Map([['old red', red]]);

function usage(overrides: Partial<UsageDelta> = {}): UsageDelta {
  return {
    usageId: randomUUID(),
    source: 'codex_logs',
    provider: 'codex',
    ts: at(18),
    sessionId: firstSession,
    model: 'model-one',
    dUsd: 2,
    dTokensIn: 100,
    dTokensOut: 20,
    cachedInputTokens: 40,
    costStatus: 'estimated',
    teams: [red, web],
    ...overrides,
  };
}

async function verifyAudience(history: History) {
  await history.recordUsage(usage({ ts: at(1) }));
  await history.recordUsage(usage({ ts: at(11), dUsd: 1, teams: undefined, teamId: 'Old Red' }));
  await history.recordUsage(usage()); // Legacy account identity from the authenticated session.
  await history.recordUsage(
    usage({
      accountId: alice,
      provider: 'claude',
      sessionId: `claude:${alice}/${randomUUID()}/session`,
      teams: [red],
      dUsd: 3,
      model: 'model-two',
      cachedInputTokens: 0,
    }),
  );
  await history.recordUsage(
    usage({
      accountId: bob,
      sessionId: `codex:${bob}/${workstation}/session`,
      teams: [web],
      dUsd: 7,
      cachedInputTokens: undefined,
    }),
  );
  await history.recordUsage(usage({ accountId: alice, ts: at(20), teams: [blue], dUsd: 5 }));
  await history.recordUsage(
    usage({
      sessionId: 'raw-session',
      agent: agentLabel(`account:${alice}`),
      teams: [],
      dUsd: 11,
    }),
  );
  await history.recordUsage(
    usage({
      sessionId: undefined,
      source: 'brain',
      provider: 'brain',
      teams: [],
      dUsd: 13,
    }),
  );
  const prompt: AgentEvent = {
    id: 'prompt',
    ts: at(18),
    provider: 'codex',
    kind: 'activity',
    subtype: 'prompt_submit',
    sessionId: firstSession,
    promptId: 'prompt-one',
    teams: [red, web],
  };
  await history.recordEvent(prompt);
  await history.recordEvent({ ...prompt, id: 'native', kind: 'user_prompt', ts: at(18) + 1000 });
  await history.recordEvent({
    ...prompt,
    id: 'boundary-hook',
    promptId: undefined,
    ts: new Date(2026, 5, 17, 23, 59, 58).getTime(),
    teams: [red],
  });
  await history.recordEvent({
    ...prompt,
    id: 'boundary-native',
    promptId: undefined,
    kind: 'user_prompt',
    ts: new Date(2026, 5, 18, 0, 0, 1).getTime(),
    teams: [blue],
  });
  await history.recordEvent({
    ...prompt,
    id: 'blue-prompt',
    promptId: 'prompt-two',
    ts: at(20),
    teams: [blue],
  });
  await history.recordEvent({
    ...prompt,
    id: 'event-only',
    promptId: 'event-only',
    accountId: bob,
    sessionId: 'event-only',
    teams: [web],
  });
  // A team rename must not count the same session twice across event and usage rows.
  await history.recordEvent({
    ...prompt,
    id: 'rename-event',
    kind: 'activity',
    subtype: 'session_start',
    ts: at(21),
    teams: [{ ...red, name: 'Red renamed' }],
  });
  const report = await history.trendsReport({ period: '7d' }, aliases, at(24, 12));
  assert.equal(report.summary.costUsd, 41);
  assert.equal(report.byPerson.find((row) => row.id === alice)?.current.costUsd, 10);
  assert.equal(report.byPerson.find((row) => row.id === alice)?.current.sessions, 2);
  assert.equal(report.byPerson.find((row) => row.id === alice)?.current.prompts, 2);
  assert.equal(report.byPerson.find((row) => row.id === alice)?.previous.costUsd, 1);
  assert.equal(
    report.byPerson.find((row) => row.id === alice)?.name,
    agentLabel(`account:${alice}`),
  );
  assert.equal(report.byPerson.find((row) => row.id === 'unassigned')?.current.costUsd, 24);
  assert.equal(
    report.byPerson.reduce((sum, row) => sum + row.current.costUsd, 0),
    41,
  );
  assert.equal(report.byTeam.find((row) => row.id === red.id)?.current.sessions, 2);
  assert.equal(report.byTeam.find((row) => row.id === red.id)?.previous.costUsd, 1);
  assert.equal(report.byTeam.find((row) => row.id === web.id)?.current.prompts, 2);
  assert.equal(report.byTeam.find((row) => row.id === web.id)?.current.costUsd, 9);
  assert.ok(
    report.byTeam.reduce((sum, row) => sum + row.current.costUsd, 0) > report.summary.costUsd,
  );
  assert.deepEqual(
    new Set(report.audience.people.find((person) => person.id === alice)?.teamIds),
    new Set(['red', 'web', 'blue']),
  );

  const person = await history.trendsReport({ period: '7d', person: alice }, aliases, at(24, 12));
  assert.equal(person.summary.costUsd, 10);
  assert.equal(person.previous.costUsd, 1);
  assert.equal(person.summary.sessions, 2);
  assert.equal(person.summary.prompts, 2);
  assert.equal(person.byProvider.length, 2);
  assert.equal(person.byPerson.length, 1);
  assert.equal(person.summary.cachedTokens, 80);
  assert.equal(person.summary.cacheKnown, true);
  assert.equal(
    (await history.loadRequestUsage()).find((row) => row.accountId === alice)?.accountId,
    alice,
  );
  const filtered = await history.trendsReport(
    { period: '7d', team: web.id, person: alice },
    aliases,
    at(24, 12),
  );
  assert.equal(filtered.summary.costUsd, 2);
  assert.equal(filtered.previous.costUsd, 0);
  assert.equal(filtered.summary.prompts, 1);
  assert.equal(filtered.summary.sessions, 1);
  assert.equal(
    filtered.days.reduce((sum, day) => sum + day.costUsd, 0),
    2,
  );
  assert.equal(
    filtered.buckets.reduce((sum, bucket) => sum + bucket.prompts, 0),
    1,
  );
  assert.equal(filtered.byModel.length, 1);
  assert.equal(filtered.byModel[0].costUsd, 2);
  assert.equal(filtered.insights.peakDay?.costUsd, 2);
  assert.equal(filtered.insights.averageDailyCostUsd, 2 / 7);
  assert.equal(
    filtered.audience.people.length,
    report.audience.people.length,
    'filter choices remain available',
  );
  assert.equal(filtered.byPerson[0].previous.prompts, 0);

  const moved = await history.trendsReport(
    { period: '7d', team: blue.id, person: alice },
    aliases,
    at(24, 12),
  );
  assert.equal(moved.summary.costUsd, 5, 'new membership cannot move old usage');
  assert.equal(moved.summary.prompts, 1);
  const unknown = await history.trendsReport(
    { period: '7d', person: 'unassigned' },
    aliases,
    at(24, 12),
  );
  assert.equal(unknown.summary.costUsd, 24);
  const empty = await history.trendsReport(
    { period: '7d', person: "' OR 1=1 --" },
    aliases,
    at(24, 12),
  );
  assert.equal(empty.summary.usageCount, 0);
  assert.equal(empty.summary.sessions, 0);
  assert.equal(empty.summary.prompts, 0);
  assert.equal(empty.byModel.length, 0);
  for (const query of [{ person: ['a', 'b'] }, { team: '' }, { team: 'x'.repeat(201) }]) {
    await assert.rejects(
      history.trendsReport({ period: '7d', ...query } as any),
      /valid team or person/,
    );
  }

  const originalMode = config.anonymize;
  try {
    config.anonymize = false;
    const named = await history.trendsReport(
      { period: '7d', person: alice },
      aliases,
      at(24, 12),
      new Map([[alice, 'Alice']]),
    );
    assert.equal(named.byPerson[0].name, 'Alice');
    config.anonymize = true;
    const anonymous = await history.trendsReport(
      { period: '7d', person: alice },
      aliases,
      at(24, 12),
      new Map([[alice, 'Alice']]),
    );
    assert.doesNotMatch(JSON.stringify(anonymous), /Alice/);
  } finally {
    config.anonymize = originalMode;
  }
}

for (const backend of ['sqlite', 'postgres'] as const) {
  test(
    `${backend} filters all Trends metrics by historical teams and stable people`,
    { skip: backend === 'postgres' && !process.env.TEST_DATABASE_URL },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'trends-audience-'));
      const schema = `audience_${randomUUID().replaceAll('-', '')}`;
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
      await verifyAudience(history);
    },
  );
}

test('account attribution is trusted and never inferred from a pseudonym or arbitrary session', () => {
  const account = {
    id: alice,
    name: 'Alice',
    email: 'private@example.test',
    teamIds: [],
    enabled: true,
    createdAt: '',
  };
  const event: AgentEvent = {
    id: 'event',
    ts: Date.now(),
    kind: 'api_request',
    provider: 'codex',
    accountId: bob,
    sessionId: 'raw',
  };
  const attributed = attributeEvent(event, {
    account,
    teams: [],
    token: { id: workstation, accountId: alice, label: 'Laptop', createdAt: '', expiresAt: null },
  });
  assert.equal(attributed.accountId, alice);
  assert.equal(historyPerson(attributed), alice);
  assert.equal(historyPerson({ sessionId: firstSession }), alice);
  assert.equal(historyPerson({ sessionId: `claude:${alice}/${workstation}/session` }), alice);
  assert.equal(historyPerson({ sessionId: 'codex:arbitrary/workstation/session' }), 'unassigned');
  assert.equal(historyPerson({ sessionId: `codex:${alice}/${workstation}/` }), 'unassigned');
});

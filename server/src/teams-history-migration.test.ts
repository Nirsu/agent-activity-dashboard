import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { AccessStore } from './access/store.js';
import { History, type StoredUsage } from './db.js';
import { closePostgresPool, getPostgresPool } from './persistence/postgres.js';

interface Trends {
  days: Array<{ costUsd: number; tokensIn: number; usageCount: number }>;
  byStream: Array<{ teamId: string; teamName: string; costUsd: number; tokens: number }>;
}

async function verifyMigration(
  initialAccess: AccessStore,
  history: History,
  alreadyMigrated: boolean,
) {
  let access = initialAccess;
  try {
    const account = {
      id: randomUUID(),
      name: 'Developer',
      email: 'developer@example.test',
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    if (alreadyMigrated) {
      const team = await access.saveTeam({ name: 'DIPT' }, 'test');
      await access.storage.put('access_accounts', account.id, { ...account, teamIds: [team.id] });
      // Simulate the first managed-team release, which stored no legacy correspondence.
      await access.storage.remove('access_settings', 'legacy-team-aliases');
    } else {
      await access.storage.put('access_accounts', account.id, { ...account, team: 'DIPT' });
    }
    const now = Date.now();
    let sequence = 0;
    const record = (overrides: Partial<StoredUsage>) =>
      history.recordUsage({
        usageId: randomUUID(),
        source: 'codex_logs',
        ts: now + sequence++,
        provider: 'codex',
        dUsd: 1,
        dTokensIn: 10,
        dTokensOut: 5,
        costStatus: 'measured',
        ...overrides,
      });
    const trends = async () => (await history.trends(1, access.legacyTeamAliases())) as Trends;
    const restart = async () => {
      await access.close();
      access = new AccessStore(access.storage.path);
      await access.init();
    };
    await record({ teamId: ' dipt ' });
    await restart();
    const team = access.teams()[0];
    await record({ teamId: 'DIPT', teams: [{ id: team.id, name: team.name }] });
    let result = await trends();
    assert.equal(result.days[0].costUsd, 2);
    assert.equal(result.days[0].tokensIn, 20);
    assert.deepEqual(
      result.byStream.map(({ teamId, costUsd, tokens }) => ({ teamId, costUsd, tokens })),
      [{ teamId: team.id, costUsd: 2, tokens: 30 }],
    );
    await restart();
    assert.deepEqual(await trends(), result);

    const renamed = await access.saveTeam({ name: 'Platform' }, 'test', team.id);
    await record({ teams: [{ id: renamed.id, name: renamed.name }], dUsd: 0.5 });
    const replacement = await access.saveTeam({ name: 'DIPT' }, 'test');
    await record({ teams: [{ id: replacement.id, name: replacement.name }], dUsd: 3 });
    await record({ teams: [], teamId: 'DIPT', dUsd: 4 });
    await record({ teamId: 'Unrelated legacy team', dUsd: 5 });
    // A modern ID that happens to match an alias is not a legacy name.
    await record({ teams: [{ id: 'dipt', name: 'Explicit ID' }], dUsd: 6 });
    await restart();
    result = await trends();
    assert.equal(result.days[0].costUsd, 20.5);
    assert.equal(result.days[0].usageCount, 7);
    assert.equal(result.byStream.length, 5);
    const original = result.byStream.find((entry) => entry.teamId === team.id)!;
    assert.equal(original.costUsd, 2.5);
    assert.equal(original.teamName, 'Platform');
    assert.equal(result.byStream.find((entry) => entry.teamId === replacement.id)?.costUsd, 3);
    assert.equal(result.byStream.find((entry) => entry.teamId === 'unassigned')?.costUsd, 4);
    assert.equal(
      result.byStream.find((entry) => entry.teamId === 'Unrelated legacy team')?.costUsd,
      5,
    );
    assert.equal(result.byStream.find((entry) => entry.teamId === 'dipt')?.costUsd, 6);

    await access.saveAccount({ ...account, teamIds: [] }, 'test', account.id);
    await access.removeTeam(team.id, 'test');
    await restart();
    assert.equal(access.legacyTeamAliases().get('dipt')?.id, team.id);
    assert.deepEqual(await trends(), result, 'deleting a team must preserve historical ownership');
    assert.equal((await history.exportUsage()).length, 7, 'history is not rewritten or duplicated');
  } finally {
    await access.close();
  }
}

for (const backend of ['sqlite', 'postgres'] as const) {
  for (const alreadyMigrated of [false, true]) {
    test(
      `${backend} merges legacy and managed history ${alreadyMigrated ? 'after an earlier upgrade' : 'during account migration'}`,
      { skip: backend === 'postgres' && !process.env.TEST_DATABASE_URL },
      async () => {
        const directory = await mkdtemp(join(tmpdir(), 'team-history-migration-'));
        const originalUrl = process.env.DATABASE_URL;
        const schema = `team_migration_${randomUUID().replaceAll('-', '')}`;
        const admin =
          backend === 'postgres'
            ? new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
            : undefined;
        let access: AccessStore | undefined;
        let history: History | undefined;
        try {
          if (admin) {
            await admin.query(`CREATE SCHEMA ${schema}`);
            const url = new URL(process.env.TEST_DATABASE_URL!);
            url.searchParams.set('options', `-c search_path=${schema}`);
            process.env.DATABASE_URL = url.toString();
          } else {
            process.env.DATABASE_URL = '';
          }
          access = new AccessStore(join(directory, 'access.db'));
          history = new History({
            backend,
            databasePath: join(directory, 'history.db'),
            pool: getPostgresPool() ?? undefined,
          });
          await access.init();
          await history.init();
          assert.equal(history.enabled, true);
          await verifyMigration(access, history, alreadyMigrated);
        } finally {
          await access?.close();
          await history?.close();
          await closePostgresPool();
          if (originalUrl === undefined) {
            delete process.env.DATABASE_URL;
          } else {
            process.env.DATABASE_URL = originalUrl;
          }
          if (admin) {
            await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
            await admin.end();
          }
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
  }
}

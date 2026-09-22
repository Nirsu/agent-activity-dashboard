import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { after } from 'node:test';
import Fastify from 'fastify';
import Sqlite from 'better-sqlite3';
import type { DeveloperAccount, DeviceToken } from './access/store.js';

const directory = await mkdtemp(resolve(tmpdir(), 'harmonie-managed-teams-'));
Object.assign(process.env, {
  DATABASE_URL: '',
  BRAIN_ADMIN_TOKEN: 'managed-team-administrator',
  BRAIN_PROJECTS_PATH: resolve(directory, 'projects.json'),
});
await writeFile(process.env.BRAIN_PROJECTS_PATH!, '[]');
const { AccessStore } = await import('./access/store.js');
const { registerAccessRoutes } = await import('./access/routes.js');
const { ProjectRegistry } = await import('./brain/project-registry.js');
const admin = { 'x-brain-admin-token': 'managed-team-administrator' };
after(async () => rm(directory, { recursive: true, force: true }));

test('legacy team strings become shared IDs once, preserving account and workstation credentials', async () => {
  const path = resolve(directory, 'migration.db');
  let store = new AccessStore(path);
  await store.init();
  try {
    const account = await store.saveAccount(
      {
        name: 'Existing developer',
        email: 'existing@example.test',
        teamIds: [],
        enabled: true,
      },
      'test',
    );
    const issued = await store.issue(account.id, 'Existing workstation', null, 'test');
    const tokenBefore = store.storage.get<DeviceToken>('access_tokens', issued.token.id);
    const { teamIds: _teamIds, ...legacy } = account;
    for (const [id, team] of [
      [account.id, ' Platform '],
      ['same-team', 'platform'],
      ['other-team', 'Operations'],
      ['no-team', '  '],
    ]) {
      await store.storage.put('access_accounts', id, {
        ...legacy,
        id,
        email: `${id}@example.test`,
        team,
      });
    }
    await store.close();
    store = new AccessStore(path);
    await store.init();
    const snapshot = store.snapshot();
    assert.equal(snapshot.teams.length, 2);
    const platform = snapshot.teams.find((team) => team.name.toLowerCase() === 'platform')!;
    assert.match(platform.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(snapshot.accounts.find((item) => item.id === account.id)!.teamIds, [
      platform.id,
    ]);
    assert.deepEqual(snapshot.accounts.find((item) => item.id === 'same-team')!.teamIds, [
      platform.id,
    ]);
    assert.deepEqual(snapshot.accounts.find((item) => item.id === 'no-team')!.teamIds, []);
    assert.ok(snapshot.accounts.every((item) => !('team' in item)));
    assert.deepEqual(store.storage.get('access_tokens', issued.token.id), tokenBefore);
    const principal = await store.authenticate(issued.secret);
    assert.equal(principal!.account.id, account.id);
    assert.equal(principal!.token.id, issued.token.id);
    assert.deepEqual(principal!.teams, [{ id: platform.id, name: platform.name }]);
    await store.close();
    store = new AccessStore(path);
    await store.init();
    assert.deepEqual(store.snapshot().teams, snapshot.teams);
    assert.deepEqual(store.snapshot().accounts, snapshot.accounts);
    assert.ok(await store.authenticate(issued.secret));
  } finally {
    await store.close();
  }
});

test('SQLite migration rolls back newly created teams when any legacy account update fails', async () => {
  const path = resolve(directory, 'migration-rollback.db');
  const seed = new AccessStore(path);
  await seed.init();
  await seed.storage.put('access_accounts', 'legacy', {
    id: 'legacy',
    name: 'Legacy',
    email: 'legacy@example.test',
    team: 'Platform',
    enabled: true,
    createdAt: '',
  });
  await seed.close();
  let database = new Sqlite(path);
  database.prepare("DELETE FROM access_settings WHERE id='legacy-team-aliases'").run();
  database.exec(
    "CREATE TRIGGER reject_migration BEFORE UPDATE ON access_accounts BEGIN SELECT RAISE(ABORT, 'migration failure'); END",
  );
  database.close();
  await assert.rejects(new AccessStore(path).init(), /migration failure/);
  database = new Sqlite(path);
  assert.equal(
    database.prepare("SELECT data FROM access_settings WHERE id='legacy-team-aliases'").get(),
    undefined,
    'failed migration must not retain an alias registry',
  );
  assert.equal(
    (database.prepare('SELECT count(*) AS count FROM access_teams').get() as { count: number })
      .count,
    0,
  );
  assert.equal(
    JSON.parse(
      (database.prepare('SELECT data FROM access_accounts').get() as { data: string }).data,
    ).team,
    'Platform',
  );
  database.exec('DROP TRIGGER reject_migration');
  database.close();
  const retry = new AccessStore(path);
  await retry.init();
  try {
    assert.equal(retry.snapshot().teams.length, 1);
    assert.equal(retry.snapshot().accounts[0].teamIds.length, 1);
  } finally {
    await retry.close();
  }
});

test('team and membership administration validates IDs, preserves credentials and publishes only committed changes', async () => {
  const path = resolve(directory, 'api.db');
  let store = new AccessStore(path);
  await store.init();
  const registry = new ProjectRegistry(
    store,
    process.env.BRAIN_PROJECTS_PATH!,
    resolve(directory, 'cache'),
  );
  await registry.init();
  const app = Fastify();
  let changed = 0;
  registerAccessRoutes(app, store, registry, () => {
    changed++;
  });
  const createTeam = (name: string) =>
    app.inject({
      method: 'POST',
      url: '/api/brain/access/teams',
      headers: admin,
      payload: { name },
    });
  try {
    for (const [method, url] of [
      ['POST', '/api/brain/access/teams'],
      ['PUT', '/api/brain/access/teams/missing'],
      ['DELETE', '/api/brain/access/teams/missing'],
    ] as const) {
      const response = await app.inject({ method, url, payload: { name: 'Unauthorized' } });
      assert.equal(response.statusCode, 403);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    const created = await createTeam(' Platform Engineering ');
    assert.equal(created.statusCode, 200, created.body);
    const platform = created.json();
    assert.equal(platform.name, 'Platform Engineering');
    assert.equal((await createTeam('platform engineering')).statusCode, 409);
    for (const name of ['', '  ', 'a'.repeat(81)]) {
      assert.equal((await createTeam(name)).statusCode, 400);
    }
    const operations = (await createTeam('Operations')).json();
    const input = {
      name: 'Member',
      email: 'member@example.test',
      teamIds: [platform.id, operations.id, platform.id],
      enabled: true,
    };
    const createAccount = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/brain/access/accounts', headers: admin, payload });
    for (const teamIds of [[randomUUID()], ['Operations'], null, 'Operations']) {
      assert.equal((await createAccount({ ...input, teamIds })).statusCode, 400);
    }
    assert.equal((await createAccount({ ...input, team: 'Typo' })).statusCode, 400);
    const accountResult = await createAccount(input);
    assert.equal(accountResult.statusCode, 200, accountResult.body);
    const account = accountResult.json() as DeveloperAccount;
    assert.deepEqual(account.teamIds, [platform.id, operations.id]);
    assert.equal(changed, 3, 'validation failures must not notify live sessions');
    const issued = await store.issue(account.id, 'Workstation', null, 'test');
    assert.deepEqual((await store.authenticate(issued.secret))!.teams, [
      { id: platform.id, name: platform.name },
      { id: operations.id, name: operations.name },
    ]);
    const rename = (name: string) =>
      app.inject({
        method: 'PUT',
        url: `/api/brain/access/teams/${platform.id}`,
        headers: admin,
        payload: { name },
      });
    assert.equal((await rename(' operations ')).statusCode, 409);
    const renamed = await rename('Engineering');
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().id, platform.id);
    assert.equal(renamed.json().createdAt, platform.createdAt);
    assert.equal((await store.authenticate(issued.secret))!.teams[0].name, 'Engineering');
    const remove = (id: string) =>
      app.inject({ method: 'DELETE', url: `/api/brain/access/teams/${id}`, headers: admin });
    assert.equal((await remove(platform.id)).statusCode, 409);
    assert.equal((await remove(randomUUID())).statusCode, 404);
    const unknownUpdate = await app.inject({
      method: 'PUT',
      url: `/api/brain/access/accounts/${account.id}`,
      headers: admin,
      payload: { ...input, teamIds: [randomUUID()] },
    });
    assert.equal(unknownUpdate.statusCode, 400);
    assert.deepEqual((await store.authenticate(issued.secret))!.account.teamIds, account.teamIds);
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/brain/access/accounts/${account.id}`,
      headers: admin,
      payload: { ...input, teamIds: [operations.id] },
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual((await store.authenticate(issued.secret))!.teams, [
      { id: operations.id, name: operations.name },
    ]);
    assert.equal((await remove(platform.id)).statusCode, 200);
    assert.equal((await remove(platform.id)).statusCode, 404);
    assert.equal(changed, 6);
    const snapshot = (await app.inject({ url: '/api/brain/access', headers: admin })).json();
    assert.deepEqual(snapshot.teams, [operations]);
    assert.doesNotMatch(JSON.stringify(snapshot), /digest|hb_/);
    await app.close();
    await store.close();
    store = new AccessStore(path);
    await store.init();
    assert.deepEqual((await store.authenticate(issued.secret))!.teams, [
      { id: operations.id, name: operations.name },
    ]);
    await store.saveAccount({ ...input, teamIds: [] }, 'test', account.id);
    assert.deepEqual((await store.authenticate(issued.secret))!.teams, []);
    await store.removeTeam(operations.id, 'test');
    assert.equal(store.snapshot().teams.length, 0);
  } finally {
    await app.close();
    await store.close();
  }
});

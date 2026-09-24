import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { after } from 'node:test';
import Fastify from 'fastify';
import type { DeviceToken } from './access/store.js';

const directory = await mkdtemp(resolve(tmpdir(), 'harmonie-access-'));
Object.assign(process.env, {
  DATA_DIR: directory,
  DB_PATH: resolve(directory, 'history.db'),
  HISTORY_BACKEND: 'sqlite',
  DATABASE_URL: '',
  BRAIN_DB_PATH: resolve(directory, 'brain.db'),
  BRAIN_PROJECTS_PATH: resolve(directory, 'projects.json'),
  BRAIN_SYNC_ENABLED: '0',
  // Stale deployment settings must not restore shared agent access.
  INGEST_TOKEN: 'legacy-ingest',
  VIEWER_TOKEN: 'dashboard-viewer',
  BRAIN_ADMIN_TOKEN: 'administrator-test-key',
  COST_LEDGER: '0',
  LOG_LEVEL: 'silent',
});
await writeFile(
  process.env.BRAIN_PROJECTS_PATH!,
  JSON.stringify(
    ['allowed', 'other'].map((id) => ({
      id,
      name: id,
      scope: 'Test access boundaries',
      repoPath: '.',
      codePaths: ['src/'],
      specs: [],
    })),
  ),
);
const { buildApp } = await import('./index.js');
const { AccessStore } = await import('./access/store.js');
const { scopedBrainService } = await import('./brain/mcp.js');
const { agentLabel } = await import('./identity.js');
const { deviceOriginSession } = await import('./access/identity.js');
const { normalizeRepositoryRemote } = await import('./access/repositories.js');
const viewer = { 'x-aad-token': 'dashboard-viewer' };
const admin = { ...viewer, 'x-brain-admin-token': 'administrator-test-key' };
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

test('Git URL identity matches HTTPS and SSH without credentials or ambiguous paths', () => {
  for (const remote of [
    'https://github.com/Org/Repo.git',
    'git@github.com:org/repo.git',
    'ssh://git@github.com:22/org/repo',
    'github.com/org/repo',
  ]) {
    assert.equal(normalizeRepositoryRemote(remote), 'github.com/org/repo');
  }
  for (const remote of [
    'https://token@github.com/org/repo',
    'https://user:secret@github.com/org/repo',
    'https://github.com/org/../repo',
    'https://github.com/org/%2e%2e/repo',
    'https://github.com/org/repo?token=secret',
    'file:///repo',
    'C:\\repo',
  ]) {
    assert.equal(normalizeRepositoryRemote(remote), undefined, remote);
  }
  const custom = normalizeRepositoryRemote('ssh://git@git.example.test:2222/Org/Repo.git');
  assert.equal(custom, 'git.example.test:2222/Org/Repo');
  assert.equal(normalizeRepositoryRemote(custom), custom);
  assert.notEqual(
    normalizeRepositoryRemote('https://github.com/one/repo'),
    normalizeRepositoryRemote('https://github.com/two/repo'),
  );
});

test('every agent endpoint requires an active workstation token, including loopback requests', async () => {
  const app = await buildApp();
  const routes = [
    ['/activity', 'POST'],
    ['/v1/logs', 'POST'],
    ['/v1/metrics', 'POST'],
    ['/v1/traces', 'POST'],
    ['/api/agent-policy', 'GET'],
    ['/api/agent-policy', 'HEAD'],
    ['/api/brain/mcp', 'POST'],
  ] as const;
  const request = (url: string, method: 'POST' | 'GET' | 'HEAD', headers = {}) =>
    app.inject({
      url,
      method,
      headers: { accept: 'application/json, text/event-stream', ...headers },
      ...(method === 'POST'
        ? {
            payload:
              url === '/api/brain/mcp'
                ? {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'brain_list_projects', arguments: {} },
                  }
                : url === '/activity'
                  ? { event: 'stop', session_id: 'auth-fixture', provider: 'codex' }
                  : {},
          }
        : {}),
    });
  try {
    for (const headers of [
      {},
      { authorization: 'Bearer legacy-ingest' },
      viewer,
      admin,
      { authorization: 'Bearer administrator-test-key' },
      { authorization: 'Bearer hb_invalid.invalid' },
    ]) {
      for (const [url, method] of routes) {
        const response = await request(url, method, headers);
        assert.equal(response.statusCode, 401, `${method} ${url}: ${response.body}`);
      }
    }
    const account = (
      await app.inject({
        method: 'POST',
        url: '/api/brain/access/accounts',
        headers: admin,
        payload: { name: 'Auth fixture', email: 'auth@example.test', teamIds: [], enabled: true },
      })
    ).json();
    const issued = (
      await app.inject({
        method: 'POST',
        url: '/api/brain/access/tokens',
        headers: admin,
        payload: { accountId: account.id, label: 'Auth fixture workstation' },
      })
    ).json();
    const headers = { authorization: `Bearer ${issued.secret}` };
    for (const [url, method] of routes) {
      const response = await request(url, method, headers);
      assert.equal(response.statusCode, 200, `${method} ${url}: ${response.body}`);
    }
    const snapshot = (await app.inject({ url: '/api/brain/access', headers: admin })).json();
    assert.equal('requireDeviceTokens' in snapshot, false);
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/brain/access/policy',
          headers: admin,
          payload: { required: false },
        })
      ).statusCode,
      404,
      'the removed policy cannot re-enable shared credentials',
    );
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/brain/access/tokens/${issued.token.id}`,
          headers: admin,
        })
      ).statusCode,
      200,
    );
    for (const [url, method] of routes) {
      assert.equal((await request(url, method, headers)).statusCode, 401, url);
    }
    const second = (
      await app.inject({
        method: 'POST',
        url: '/api/brain/access/tokens',
        headers: admin,
        payload: { accountId: account.id, label: 'Disabled account workstation' },
      })
    ).json();
    const disabled = await app.inject({
      method: 'PUT',
      url: `/api/brain/access/accounts/${account.id}`,
      headers: admin,
      payload: { name: 'Auth fixture', email: 'auth@example.test', teamIds: [], enabled: false },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    for (const [url, method] of routes) {
      assert.equal(
        (await request(url, method, { authorization: `Bearer ${second.secret}` })).statusCode,
        401,
        url,
      );
    }
    assert.equal((await app.inject({ url: '/api/state', headers: viewer })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('SQLite startup deletes the obsolete device policy while preserving accounts and repository policy', async () => {
  const path = resolve(directory, 'policy-cleanup.db');
  let store = new AccessStore(path);
  await store.init();
  try {
    const account = await store.saveAccount(
      { name: 'Existing', email: 'existing@example.test', teamIds: [], enabled: true },
      'test',
    );
    const issued = await store.issue(account.id, 'Existing workstation', null, 'test');
    await store.setRepositoryFiltering(true, 'test');
    await store.storage.put('access_settings', 'device-tokens', { required: false });
    const auditBefore = store.snapshot().audit;
    await store.close();
    store = new AccessStore(path);
    await store.init();
    assert.equal(store.storage.get('access_settings', 'device-tokens'), undefined);
    assert.equal(store.filterRepositories, true);
    assert.deepEqual(store.snapshot().audit, auditBefore);
    assert.ok(await store.authenticate(issued.secret));
    await store.close();
    store = new AccessStore(path);
    await store.init();
    assert.equal(store.storage.get('access_settings', 'device-tokens'), undefined);
    assert.equal(store.snapshot().accounts[0].id, account.id);
    assert.ok(await store.authenticate(issued.secret));
  } finally {
    await store.close();
  }
});

test('local dashboard bootstrap does not make agent authentication optional', async () => {
  const { config } = await import('./config.js');
  const previousViewerToken = config.viewerToken;
  config.viewerToken = '';
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    app = await buildApp();
    assert.equal((await app.inject({ url: '/api/state' })).statusCode, 200);
    for (const url of ['/activity', '/v1/logs', '/v1/metrics', '/v1/traces', '/api/brain/mcp']) {
      assert.equal((await app.inject({ method: 'POST', url, payload: {} })).statusCode, 401, url);
    }
    assert.equal((await app.inject({ url: '/api/agent-policy' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'HEAD', url: '/api/agent-policy' })).statusCode, 401);
  } finally {
    await app?.close();
    config.viewerToken = previousViewerToken;
  }
});

test('central repository policy rejects missing and disabled origins on every ingestion route and survives restart', async () => {
  let app = await buildApp();
  const repository = {
    name: 'Shared project',
    remote: 'git@github.com:org/project.git',
    enabled: true,
    brainProjectId: 'allowed',
  };
  const setFilter = (enabled: boolean) =>
    app.inject({
      method: 'PUT',
      url: '/api/brain/access/repository-policy',
      headers: admin,
      payload: { enabled },
    });
  try {
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/brain/access/repositories',
          headers: viewer,
          payload: repository,
        })
      ).statusCode,
      403,
    );
    const created = await app.inject({
      method: 'POST',
      url: '/api/brain/access/repositories',
      headers: admin,
      payload: repository,
    });
    assert.equal(created.statusCode, 200, created.body);
    const id = created.json().id;
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/brain/access/repositories',
          headers: admin,
          payload: { ...repository, remote: 'https://github.com/org/project' },
        })
      ).statusCode,
      409,
    );
    assert.equal((await setFilter(true)).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/agent-policy', headers: viewer })).statusCode, 401);
    const account = (
      await app.inject({
        method: 'POST',
        url: '/api/brain/access/accounts',
        headers: admin,
        payload: { name: 'Repo dev', email: 'repo@example.test', teamIds: [], enabled: true },
      })
    ).json();
    const issued = (
      await app.inject({
        method: 'POST',
        url: '/api/brain/access/tokens',
        headers: admin,
        payload: { accountId: account.id, label: 'Repo laptop', expiresInDays: 1 },
      })
    ).json();
    const device = { authorization: `Bearer ${issued.secret}` };
    const policy = await app.inject({ url: '/api/agent-policy', headers: device });
    assert.deepEqual(policy.json(), { enabled: true, repositories: ['github.com/org/project'] });
    assert.equal(policy.headers['cache-control'], 'no-store');
    for (const url of ['/activity', '/v1/logs', '/v1/metrics', '/v1/traces']) {
      for (const remote of [undefined, 'github.com/other/project']) {
        const result = await app.inject({
          method: 'POST',
          url,
          headers: { ...device, ...(remote ? { 'x-harmonie-repository': remote } : {}) },
          payload: {},
        });
        assert.equal(result.statusCode, 403, url);
        assert.equal(result.headers['x-harmonie-policy-rejected'], 'repository');
      }
      const result = await app.inject({
        method: 'POST',
        url,
        headers: { ...device, 'x-harmonie-repository': 'https://github.com/org/project.git' },
        payload: {
          event: 'session_start',
          session_id: 'repository-session',
          provider: 'codex',
          repo: 'forged',
          project_id: 'forged',
        },
      });
      assert.equal(result.statusCode, 200, result.body);
    }
    const board = (await app.inject({ url: '/api/state', headers: viewer })).json();
    const session = board.sessions.find((item: any) =>
      item.sessionId.endsWith('/repository-session'),
    );
    assert.equal(session.repo, 'Shared project');
    assert.equal(session.projectId, 'allowed');
    await app.close();
    app = await buildApp();
    assert.deepEqual(
      (await app.inject({ url: '/api/agent-policy', headers: device })).json(),
      policy.json(),
    );
    const registry = await readFile(process.env.BRAIN_PROJECTS_PATH!, 'utf8');
    await writeFile(process.env.BRAIN_PROJECTS_PATH!, '[]');
    try {
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/brain/access/repositories/${id}`,
            headers: admin,
            payload: { ...repository, enabled: false },
          })
        ).statusCode,
        200,
      );
    } finally {
      await writeFile(process.env.BRAIN_PROJECTS_PATH!, registry);
    }
    assert.deepEqual((await app.inject({ url: '/api/agent-policy', headers: device })).json(), {
      enabled: true,
      repositories: [],
    });
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/activity',
          headers: { ...device, 'x-harmonie-repository': 'github.com/org/project' },
          payload: {},
        })
      ).statusCode,
      403,
    );
  } finally {
    await setFilter(false);
    await app.close();
  }
});

test('administrator controls accounts and secrets; shared projects, revocation and disabling apply immediately', async () => {
  let app = await buildApp();
  try {
    assert.equal((await app.inject({ url: '/api/brain/access', headers: viewer })).statusCode, 403);
    assert.equal(
      (await app.inject({ url: '/api/brain/%61ccess', headers: viewer })).statusCode,
      403,
    );
    const team = (
      await app.inject({
        method: 'POST',
        url: '/api/brain/access/teams',
        headers: admin,
        payload: { name: 'mobile' },
      })
    ).json();
    const payload = {
      name: 'Developer',
      email: 'dev@example.test',
      teamIds: [team.id],
      enabled: true,
    };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/brain/access/accounts',
          headers: admin,
          payload: { ...payload, projectIds: ['missing'] },
        })
      ).statusCode,
      400,
    );
    const created = await app.inject({
      method: 'POST',
      url: '/api/brain/access/accounts',
      headers: admin,
      payload,
    });
    assert.equal(created.statusCode, 200, created.body);
    const account = created.json();
    const issue = async (label: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/brain/access/tokens',
        headers: admin,
        payload: { accountId: account.id, label, expiresInDays: 90 },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'no-store');
      return response.json();
    };
    const first = await issue('Laptop');
    const second = await issue('Desktop');
    const headers = { authorization: `Bearer ${first.secret}` };
    for (const url of [
      '/api/state',
      '/live',
      '/api/brain/access',
      '/api/brain/agents',
      '/api/trends?period=7d',
    ]) {
      assert.equal(
        (
          await app.inject({
            url,
            headers: { ...headers, 'x-brain-admin-token': 'administrator-test-key' },
          })
        ).statusCode,
        403,
        url,
      );
    }
    const activity = {
      event: 'session_start',
      session_id: 'same-session',
      event_id: 'same-event',
      user: 'forged@example.test',
      team_id: 'forged-team',
      provider: 'codex',
    };
    assert.equal(
      (await app.inject({ method: 'POST', url: '/activity', headers, payload: activity }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/activity',
          headers: { authorization: `Bearer ${second.secret}` },
          payload: activity,
        })
      ).statusCode,
      200,
    );
    const board = (await app.inject({ url: '/api/state', headers: viewer })).json();
    assert.equal(board.sessions.length, 2, 'workstations cannot merge spoofed session IDs');
    for (const session of board.sessions) {
      assert.equal(session.agent, agentLabel(`account:${account.id}`));
      assert.equal(session.teamId, 'mobile');
      assert.deepEqual(session.teams, [{ id: team.id, name: 'mobile' }]);
    }
    assert.doesNotMatch(JSON.stringify(board), /forged/);
    const personReport = await app.inject({
      url: `/api/trends?period=7d&person=${account.id}`,
      headers: viewer,
    });
    assert.equal(personReport.statusCode, 200, personReport.body);
    assert.equal(personReport.json().summary.sessions, 2);
    assert.equal(personReport.json().byPerson.length, 1);
    assert.equal(personReport.json().byPerson[0].name, agentLabel(`account:${account.id}`));
    assert.doesNotMatch(personReport.body, /dev@example.test|Developer|forged/);
    const call = (name: string, args = {}, token = first.secret) =>
      app.inject({
        method: 'POST',
        url: '/api/brain/mcp',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json, text/event-stream',
        },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      });
    const listing = await call('brain_list_projects');
    assert.equal(listing.statusCode, 200, listing.body);
    assert.deepEqual(
      listing.json().result.structuredContent.projects.map((project: { id: string }) => project.id),
      ['allowed', 'other'],
    );
    const denied = await call('brain_get_project_context', {
      projectId: 'missing',
      feature: 'Unauthorized',
    });
    assert.equal(denied.json().result.isError, true);
    assert.match(denied.body, /Project is not registered/);
    const accountUpdate = (input = payload) =>
      app.inject({
        method: 'PUT',
        url: `/api/brain/access/accounts/${account.id}`,
        headers: admin,
        payload: input,
      });
    const secondTeam = (
      await app.inject({
        method: 'POST',
        url: '/api/brain/access/teams',
        headers: admin,
        payload: { name: 'Platform' },
      })
    ).json();
    assert.equal(
      (await accountUpdate({ ...payload, teamIds: [team.id, secondTeam.id] })).statusCode,
      200,
    );
    const multipleTeamsBoard = (await app.inject({ url: '/api/state', headers: viewer })).json();
    assert.equal(multipleTeamsBoard.sessions.length, 2);
    for (const session of multipleTeamsBoard.sessions) {
      assert.deepEqual(session.teams, [
        { id: team.id, name: 'mobile' },
        { id: secondTeam.id, name: 'Platform' },
      ]);
      assert.equal(
        session.lastSeen,
        board.sessions.find((previous: any) => previous.sessionId === session.sessionId).lastSeen,
      );
    }
    const renamedTeam = await app.inject({
      method: 'PUT',
      url: `/api/brain/access/teams/${team.id}`,
      headers: admin,
      payload: { name: 'Mobile Engineering' },
    });
    assert.equal(renamedTeam.statusCode, 200);
    const renamedBoard = (await app.inject({ url: '/api/state', headers: viewer })).json();
    assert.ok(
      renamedBoard.sessions.every((session: any) => session.teams[0].name === 'Mobile Engineering'),
    );
    assert.equal((await accountUpdate({ ...payload, teamIds: [] })).statusCode, 200);
    const unassignedBoard = (await app.inject({ url: '/api/state', headers: viewer })).json();
    const historicalTeam = await app.inject({
      url: `/api/trends?period=7d&person=${account.id}&team=${team.id}`,
      headers: viewer,
    });
    assert.equal(
      historicalTeam.json().summary.sessions,
      2,
      'editing membership preserves prior attribution',
    );
    for (const session of unassignedBoard.sessions) {
      assert.deepEqual(session.teams, []);
      assert.equal(session.teamId, undefined);
    }
    await accountUpdate();
    const snapshot = (await app.inject({ url: '/api/brain/access', headers: admin })).json();
    assert.ok(
      snapshot.tokens.find((token: { id: string }) => token.id === first.token.id).lastUsedAt,
    );
    assert.doesNotMatch(JSON.stringify(snapshot), /digest|hb_/);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/activity',
          headers: { 'x-aad-token': 'legacy-ingest' },
          payload: activity,
        })
      ).statusCode,
      401,
    );
    assert.equal((await app.inject({ url: '/api/state', headers: viewer })).statusCode, 200);
    await app.close();
    app = await buildApp();
    assert.equal((await call('brain_list_projects')).statusCode, 200, 'tokens survive restart');
    await app.inject({
      method: 'DELETE',
      url: `/api/brain/access/tokens/${first.token.id}`,
      headers: admin,
    });
    assert.equal((await call('brain_list_projects')).statusCode, 401);
    assert.equal((await call('brain_list_projects', {}, second.secret)).statusCode, 200);
    const savedProjects = await readFile(process.env.BRAIN_PROJECTS_PATH!, 'utf8');
    await writeFile(process.env.BRAIN_PROJECTS_PATH!, '[]');
    assert.equal(
      (await accountUpdate({ ...payload, enabled: false })).statusCode,
      200,
      'a removed registry project must not prevent offboarding',
    );
    assert.equal((await call('brain_list_projects', {}, second.secret)).statusCode, 401);
    await writeFile(process.env.BRAIN_PROJECTS_PATH!, savedProjects);
    await accountUpdate();
    assert.equal(
      (await call('brain_list_projects', {}, second.secret)).statusCode,
      401,
      'reenabling cannot resurrect revoked tokens',
    );
    const secretBytes = await readFile(resolve(directory, 'access.db'));
    assert.equal(secretBytes.includes(Buffer.from(first.secret)), false);
  } finally {
    await app.close();
  }
});

test('token expiration and forged secrets fail closed; audit contains no credentials', async (t) => {
  const store = new AccessStore(resolve(directory, 'expiration.db'));
  await store.init();
  try {
    const account = await store.saveAccount(
      { name: 'Other', email: 'other@example.test', teamIds: [], projectIds: [], enabled: true },
      'test',
    );
    const issued = await store.issue(account.id, 'Old laptop', 1, 'test');
    const future = Date.now() + 2 * 86400000;
    t.mock.method(Date, 'now', () => future);
    assert.equal(await store.authenticate(issued.secret), null);
    const valid = await store.issue(account.id, 'Current laptop', 1, 'test');
    assert.equal(
      await store.authenticate(
        valid.secret.slice(0, -1) + (valid.secret.endsWith('a') ? 'b' : 'a'),
      ),
      null,
    );
    assert.ok(await store.authenticate(valid.secret));
    assert.doesNotMatch(JSON.stringify(store.snapshot()), /digest|hb_/);
  } finally {
    await store.close();
  }
});

test('non-expiring tokens survive future authentication and restart but still honor revocation and account disabling', async (t) => {
  const path = resolve(directory, 'non-expiring.db');
  let store = new AccessStore(path);
  await store.init();
  try {
    const input = {
      name: 'Long-lived account',
      email: 'long-lived@example.test',
      teamIds: [],
      enabled: true,
    };
    const account = await store.saveAccount(input, 'test');
    const omitted = await store.issue(account.id, 'No expiration omitted', undefined, 'test');
    const explicit = await store.issue(account.id, 'No expiration explicit', null, 'test');
    const dated = await store.issue(account.id, 'Dated workstation', 1, 'test');
    assert.equal(omitted.token.expiresAt, null);
    assert.equal(explicit.token.expiresAt, null);
    assert.equal(typeof dated.token.expiresAt, 'string');
    const future = Date.now() + 730 * 86400000;
    t.mock.method(Date, 'now', () => future);
    assert.ok(await store.authenticate(omitted.secret));
    assert.ok(await store.authenticate(explicit.secret));
    assert.equal(await store.authenticate(dated.secret), null);
    await store.close();
    store = new AccessStore(path);
    await store.init();
    assert.ok(await store.authenticate(omitted.secret));
    assert.ok(await store.authenticate(explicit.secret));
    assert.equal(await store.authenticate(dated.secret), null);
    assert.equal(
      store.snapshot().tokens.find((token) => token.id === omitted.token.id)!.expiresAt,
      null,
    );
    assert.doesNotMatch(JSON.stringify(store.snapshot()), /digest|hb_/);
    await store.revoke(omitted.token.id, 'test');
    assert.equal(await store.authenticate(omitted.secret), null);
    assert.ok(await store.authenticate(explicit.secret));
    await store.saveAccount({ ...input, enabled: false }, 'test', account.id);
    assert.equal(await store.authenticate(explicit.secret), null);
    await store.saveAccount(input, 'test', account.id);
    assert.equal(
      await store.authenticate(explicit.secret),
      null,
      'reenabling must not restore a revoked permanent token',
    );
  } finally {
    await store.close();
  }
});

test('direct token issuance rejects invalid durations and malformed stored expiration fails closed', async () => {
  const store = new AccessStore(resolve(directory, 'expiration-validation.db'));
  await store.init();
  try {
    const account = await store.saveAccount(
      { name: 'Validation', email: 'validation@example.test', teamIds: [], enabled: true },
      'test',
    );
    for (const days of [0, -1, 366, 1.5, NaN, Infinity, '90']) {
      await assert.rejects(
        store.issue(account.id, 'Invalid lifetime', days as number, 'test'),
        /Token expiration must be/,
      );
    }
    assert.equal(store.snapshot().tokens.length, 0);
    const issued = await store.issue(account.id, 'Validation workstation', 365, 'test');
    const original = store.storage.get<DeviceToken>('access_tokens', issued.token.id)!;
    for (const expiresAt of [
      '',
      'not-a-date',
      '2099',
      '2099-02-30T00:00:00.000Z',
      9999999999999,
      {},
      false,
      undefined,
    ]) {
      await store.storage.put('access_tokens', original.id, { ...original, expiresAt });
      assert.equal(
        await store.authenticate(issued.secret),
        null,
        `invalid expiry ${JSON.stringify(expiresAt)}`,
      );
    }
    await store.storage.put('access_tokens', original.id, original);
    assert.ok(await store.authenticate(issued.secret));
  } finally {
    await store.close();
  }
});

test('token creation API accepts omitted or null expiration and preserves numeric validation', async () => {
  const { registerAccessRoutes } = await import('./access/routes.js');
  const { ProjectRegistry } = await import('./brain/project-registry.js');
  const store = new AccessStore(resolve(directory, 'token-api.db'));
  await store.init();
  const registry = new ProjectRegistry(
    store,
    resolve(directory, 'token-api-projects.json'),
    resolve(directory, 'token-api-cache'),
  );
  await registry.init();
  const app = Fastify();
  registerAccessRoutes(app, store, registry);
  try {
    const account = await store.saveAccount(
      { name: 'API account', email: 'token-api@example.test', teamIds: [], enabled: true },
      'test',
    );
    const issue = (expiration: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/brain/access/tokens',
        headers: admin,
        payload: { accountId: account.id, label: 'API workstation', ...expiration },
      });
    for (const expiration of [{}, { expiresInDays: null }]) {
      const result = await issue(expiration);
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().token.expiresAt, null);
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.ok(await store.authenticate(result.json().secret));
    }
    for (const expiresInDays of [1, 365]) {
      const before = Date.now();
      const result = await issue({ expiresInDays });
      assert.equal(result.statusCode, 200, result.body);
      const expiration = Date.parse(result.json().token.expiresAt);
      assert.ok(expiration >= before + expiresInDays * 86400000);
      assert.ok(expiration <= Date.now() + expiresInDays * 86400000);
    }
    for (const expiresInDays of [0, -1, 366, 1.5, '90', false, {}]) {
      const result = await issue({ expiresInDays });
      assert.equal(result.statusCode, 400, JSON.stringify(expiresInDays));
    }
    assert.equal(store.snapshot().tokens.length, 4, 'invalid requests must not create tokens');
  } finally {
    await app.close();
    await store.close();
  }
});

test('Trends API combines migrated legacy names with managed team usage', async () => {
  const { History } = await import('./db.js');
  let access = new AccessStore(resolve(directory, 'access.db'));
  const history = new History({ backend: 'sqlite', databasePath: process.env.DB_PATH });
  let teamId: string;
  try {
    await access.init();
    await access.storage.put('access_accounts', 'historical-team-account', {
      id: 'historical-team-account',
      name: 'Historical developer',
      email: 'historical@example.test',
      team: 'Historical team',
      enabled: true,
      createdAt: '',
    });
    await access.close();
    access = new AccessStore(resolve(directory, 'access.db'));
    await access.init();
    const team = access.teams().find((item) => item.name === 'Historical team')!;
    teamId = team.id;
    await history.init();
    for (const managed of [false, true]) {
      await history.recordUsage({
        usageId: `historical-team-${managed}`,
        source: 'codex_logs',
        ts: Date.now(),
        provider: 'codex',
        teamId: 'Historical team',
        ...(managed ? { teams: [{ id: team.id, name: team.name }] } : {}),
        dUsd: 1,
        dTokensIn: 10,
        dTokensOut: 5,
        costStatus: 'measured',
      });
    }
  } finally {
    await access.close();
    await history.close();
  }
  const app = await buildApp();
  try {
    const response = await app.inject({ url: '/api/trends?days=1', headers: viewer });
    assert.equal(response.statusCode, 200, response.body);
    const teams = response.json().byStream as Array<{ teamId: string; costUsd: number }>;
    assert.equal(teams.find((item) => item.teamId === teamId)?.costUsd, 2);
    assert.equal(
      teams.some((item) => item.teamId === 'Historical team'),
      false,
    );
  } finally {
    await app.close();
  }
});

test('MCP shares registered projects, rejects removed ones and overwrites attribution', async () => {
  const account = {
    id: 'dev',
    name: 'Dev',
    email: 'dev@example.test',
    teamIds: [],
    projectIds: [], // Legacy restrictions no longer constrain shared projects.
    enabled: true,
    createdAt: '',
  };
  const principal = {
    account,
    teams: [],
    token: { id: 'machine', accountId: 'dev', label: 'Machine', createdAt: '', expiresAt: '' },
  };
  let started: unknown[] | undefined;
  const service = {
    state: async () => ({ projects: [{ id: 'allowed' }, { id: 'other' }] }),
    detail: async (id: string) => ({ id, projectId: id === 'removed-run' ? 'removed' : 'other' }),
    start: async (...args: unknown[]) => {
      started = args;
      return {};
    },
  } as unknown as Parameters<typeof scopedBrainService>[0];
  const scoped = scopedBrainService(service, principal);
  assert.equal(deviceOriginSession(principal, 'codex:session'), 'codex:dev/machine/session');
  assert.equal((await scoped.detail('shared-run')).projectId, 'other');
  await assert.rejects(scoped.detail('removed-run'), /Project is not registered/);
  await assert.rejects(scoped.start('removed', 'a'.repeat(40)), /Project is not registered/);
  await assert.rejects(
    scoped.start('allowed', 'a'.repeat(40), undefined, 'Test', undefined, {
      parentRunId: 'removed-run',
    }),
    /Project is not registered/,
  );
  assert.equal(started, undefined);
  await scoped.start('allowed', 'a'.repeat(40), undefined, 'Test', undefined, {
    originSessionId: 'session',
    developerId: 'forged',
  });
  assert.deepEqual(started![5], {
    originSessionId: 'dev/machine/session',
    developerId: 'dev',
    workstationId: 'machine',
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { after } from 'node:test';

const directory = await mkdtemp(resolve(tmpdir(), 'harmonie-access-'));
Object.assign(process.env, {
  DATA_DIR: directory,
  DB_PATH: resolve(directory, 'history.db'),
  HISTORY_BACKEND: 'sqlite',
  DATABASE_URL: '',
  BRAIN_DB_PATH: resolve(directory, 'brain.db'),
  BRAIN_PROJECTS_PATH: resolve(directory, 'projects.json'),
  BRAIN_SYNC_ENABLED: '0',
  INGEST_TOKEN: 'legacy-ingest',
  VIEWER_TOKEN: 'legacy-viewer',
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
const viewer = { 'x-aad-token': 'legacy-viewer' };
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

test('central repository policy rejects missing and disabled origins on every ingestion route and survives restart', async () => {
  let app = await buildApp();
  const legacy = { authorization: 'Bearer legacy-ingest' };
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
    await app.inject({
      method: 'PUT',
      url: '/api/brain/access/policy',
      headers: admin,
      payload: { required: false },
    });
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
    const policy = await app.inject({ url: '/api/agent-policy', headers: legacy });
    assert.deepEqual(policy.json(), { enabled: true, repositories: ['github.com/org/project'] });
    assert.equal(policy.headers['cache-control'], 'no-store');
    const account = (
      await app.inject({
        method: 'POST',
        url: '/api/brain/access/accounts',
        headers: admin,
        payload: { name: 'Repo dev', email: 'repo@example.test', team: 'mobile', enabled: true },
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
    assert.deepEqual(
      (await app.inject({ url: '/api/agent-policy', headers: device })).json(),
      policy.json(),
    );
    for (const auth of [legacy, device]) {
      for (const url of ['/activity', '/v1/logs', '/v1/metrics', '/v1/traces']) {
        for (const remote of [undefined, 'github.com/other/project']) {
          const result = await app.inject({
            method: 'POST',
            url,
            headers: { ...auth, ...(remote ? { 'x-harmonie-repository': remote } : {}) },
            payload: {},
          });
          assert.equal(result.statusCode, 403, url);
          assert.equal(result.headers['x-harmonie-policy-rejected'], 'repository');
        }
        const result = await app.inject({
          method: 'POST',
          url,
          headers: { ...auth, 'x-harmonie-repository': 'https://github.com/org/project.git' },
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
    const payload = {
      name: 'Developer',
      email: 'dev@example.test',
      team: 'mobile',
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
    for (const url of ['/api/state', '/live', '/api/brain/access', '/api/brain/agents']) {
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
    }
    assert.doesNotMatch(JSON.stringify(board), /forged/);
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
    await accountUpdate();
    const snapshot = (await app.inject({ url: '/api/brain/access', headers: admin })).json();
    assert.ok(
      snapshot.tokens.find((token: { id: string }) => token.id === first.token.id).lastUsedAt,
    );
    assert.doesNotMatch(JSON.stringify(snapshot), /digest|hb_/);
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/brain/access/policy',
          headers: admin,
          payload: { required: true },
        })
      ).statusCode,
      200,
    );
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

test('token expiration and forged secrets fail closed; audit contains no credentials', async () => {
  const store = new AccessStore(resolve(directory, 'expiration.db'));
  await store.init();
  try {
    const account = await store.saveAccount(
      { name: 'Other', email: 'other@example.test', team: '', projectIds: [], enabled: true },
      'test',
    );
    const issued = await store.issue(account.id, 'Old laptop', -1, 'test');
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

test('MCP shares registered projects, rejects removed ones and overwrites attribution', async () => {
  const account = {
    id: 'dev',
    name: 'Dev',
    email: 'dev@example.test',
    team: '',
    projectIds: [], // Legacy restrictions no longer constrain shared projects.
    enabled: true,
    createdAt: '',
  };
  const principal = {
    account,
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

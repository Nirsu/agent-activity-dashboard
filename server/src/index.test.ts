import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { after } from 'node:test';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import type { LightMyRequestResponse } from 'fastify';
import { brainConfig } from './brain/config.js';

const directory = await mkdtemp(resolve(tmpdir(), 'aad-agent-routes-'));
Object.assign(process.env, {
  DATA_DIR: directory,
  DB_PATH: resolve(directory, 'history.db'),
  HISTORY_BACKEND: 'sqlite',
  DATABASE_URL: '',
  BRAIN_DB_PATH: resolve(directory, 'brain.db'),
  BRAIN_PROJECTS_PATH: resolve(directory, 'projects.json'),
  BRAIN_SYNC_ENABLED: '0',
  VIEWER_TOKEN: '',
  COST_LEDGER: '0',
});

const { buildApp } = await import('./index.js');
const { AccessStore } = await import('./access/store.js');
const access = new AccessStore(resolve(directory, 'access.db'));
await access.init();
const account = await access.saveAccount(
  { name: 'Route fixture', email: 'routes@example.test', teamIds: [], enabled: true },
  'test',
);
const issued = await access.issue(account.id, 'Route workstation', null, 'test');
const agentHeaders = { authorization: `Bearer ${issued.secret}` };
const devicePrefix = `${account.id}/${issued.token.id}/`;
await access.close();

test('replayed hook events keep their original time and stable ID', async () => {
  const app = await buildApp();
  try {
    const timestamp = Date.now() - 60000;
    const payload = {
      event: 'stop',
      provider: 'codex',
      session_id: 'offline-task',
      event_id: 'offline-event',
      timestamp,
    };
    await app.inject({ method: 'POST', url: '/activity', headers: agentHeaders, payload });
    await app.inject({ method: 'POST', url: '/activity', headers: agentHeaders, payload });
    const events = (await app.inject('/api/state'))
      .json()
      .recentEvents.filter((event: { id: string }) => event.id === `${devicePrefix}offline-event`);
    assert.equal(events.length, 1);
    assert.equal(events[0].ts, timestamp);
  } finally {
    await app.close();
  }
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

test('agent APIs remain available without human delivery endpoints', async () => {
  const app = await buildApp();
  try {
    for (const url of ['/api/state', '/api/trends']) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200, response.body);
    }

    const removedRoutes = [
      ['GET', '/api/dora'],
      ['GET', '/api/delivery'],
      ['GET', '/api/delivery/imports'],
      ['PUT', '/api/delivery/settings'],
      ['DELETE', '/api/delivery/settings'],
      ['POST', '/api/delivery/test'],
      ['POST', '/api/delivery/imports'],
    ] as const;
    for (const [method, url] of removedRoutes) {
      const response = await app.inject({ method, url });
      assert.equal(response.statusCode, 404, `${method} ${url}: ${response.body}`);
    }
  } finally {
    await app.close();
  }
});

test('Trends validates report periods at the HTTP boundary and retains the legacy days API', async () => {
  const app = await buildApp();
  try {
    for (const period of ['today', '7d', '14d', 'month', '30d', '90d']) {
      const response = await app.inject(`/api/trends?period=${period}`);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().period.key, period);
      assert.equal(typeof response.json().summary.sessions, 'number');
    }
    const custom = await app.inject('/api/trends?period=custom&start=2026-01-01&end=2026-01-02');
    assert.equal(custom.statusCode, 200, custom.body);
    assert.equal(custom.json().period.dayCount, 2);
    for (const query of [
      'period=invalid',
      'period=custom',
      'period=custom&start=2026-02-30&end=2026-03-02',
      'period=custom&start=2026-01-03&end=2026-01-01',
      'period=custom&start=2026-01-01&end=2026-05-01',
    ]) {
      const response = await app.inject(`/api/trends?${query}`);
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(typeof response.json().error, 'string');
    }
    const legacy = await app.inject('/api/trends?days=7');
    assert.equal(legacy.statusCode, 200);
    assert.equal(legacy.json().days.length, 7);
    assert.equal(legacy.json().period, undefined);
  } finally {
    await app.close();
  }
});

test('hook ingestion exposes child lifecycle and hierarchy over the public state API', async () => {
  const app = await buildApp();
  try {
    const send = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/activity',
        headers: agentHeaders,
        payload: { provider: 'claude', ...payload },
      });
    await send({ event: 'session_start', session_id: 'hierarchy-root', session_role: 'main' });
    await send({
      event: 'subagent_start',
      session_id: 'hierarchy-root/agent:child',
      parent_session_id: 'hierarchy-root',
      session_role: 'subagent',
      agent_type: 'Explore',
      prompt: 'DO-NOT-STORE',
      tool_input: 'DO-NOT-STORE',
    });
    const state = (await app.inject('/api/state')).json();
    assert.equal(state.aggregate.activeSessions, 1);
    const child = state.sessions.find(
      (item: { sessionId: string }) =>
        item.sessionId === `claude:${devicePrefix}hierarchy-root/agent:child`,
    );
    assert.equal(child.parentSessionId, `claude:${devicePrefix}hierarchy-root`);
    assert.equal(child.agentType, 'Explore');
    assert.equal(child.status, 'thinking');
    assert.doesNotMatch(JSON.stringify(state), /DO-NOT-STORE/);
    await send({
      event: 'subagent_stop',
      session_id: 'hierarchy-root/agent:child',
      parent_session_id: 'hierarchy-root',
    });
    const stopped = (await app.inject('/api/state')).json();
    assert.equal(stopped.aggregate.activeSessions, 0);
    assert.ok(stopped.sessions.find((item: { endedAt?: number }) => item.endedAt));
  } finally {
    await app.close();
  }
});

test('authenticated local Codex logs gain structural metadata before account attribution while remote requests cannot read it', async () => {
  const { config } = await import('./config.js');
  const { agentLabel } = await import('./identity.js');
  const previousMetadataPath = config.codexMetadataDb;
  const path = resolve(directory, 'local-codex-metadata.sqlite');
  const db = new Database(path);
  db.exec(
    'CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, cwd TEXT, git_branch TEXT, preview TEXT)',
  );
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)');
  for (const id of ['local-metadata', 'remote-ip-metadata', 'remote-host-metadata']) {
    insert.run(
      id,
      JSON.stringify({
        subagent: { thread_spawn: { parent_thread_id: 'local-parent', agent_role: 'explorer' } },
      }),
      '/private/local-project',
      'local-branch',
      'PRIVATE PROMPT MUST NOT APPEAR',
    );
  }
  db.close();
  config.codexMetadataDb = path;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    app = await buildApp();
    for (const [id, remoteAddress, host] of [
      ['local-metadata', '127.0.0.1', 'localhost:4318'],
      ['remote-ip-metadata', '192.0.2.10', 'localhost:4318'],
      ['remote-host-metadata', '127.0.0.1', 'dashboard.example.test'],
    ]) {
      const response: LightMyRequestResponse = await app.inject({
        method: 'POST',
        url: '/v1/logs',
        remoteAddress,
        headers: { ...agentHeaders, host },
        payload: {
          resourceLogs: [
            {
              scopeLogs: [
                {
                  logRecords: [
                    {
                      attributes: [
                        { key: 'event.name', value: { stringValue: 'codex.api_request' } },
                        { key: 'conversation.id', value: { stringValue: id } },
                        { key: 'user.email', value: { stringValue: 'forged@example.test' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
      assert.equal(response.statusCode, 200, `${id}: ${response.body}`);
    }
    const state = (await app.inject('/api/state')).json();
    const local = state.sessions.find(
      (session: { sessionId: string }) =>
        session.sessionId === `codex:${devicePrefix}local-metadata`,
    );
    assert.ok(local);
    assert.equal(local.parentSessionId, `codex:${devicePrefix}local-parent`);
    assert.equal(local.sessionRole, 'subagent');
    assert.equal(local.agentType, 'explorer');
    assert.equal(local.repo, 'local-project');
    assert.equal(local.branch, 'local-branch');
    assert.equal(local.agent, agentLabel(`account:${account.id}`));
    for (const id of ['remote-ip-metadata', 'remote-host-metadata']) {
      const remote = state.sessions.find(
        (session: { sessionId: string }) => session.sessionId === `codex:${devicePrefix}${id}`,
      );
      assert.ok(remote);
      assert.equal(remote.parentSessionId, undefined, id);
      assert.equal(remote.agentType, undefined, id);
      assert.equal(remote.repo, undefined, id);
      assert.equal(remote.branch, undefined, id);
      assert.equal(remote.agent, agentLabel(`account:${account.id}`));
    }
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE PROMPT|forged@example/);
  } finally {
    await app?.close();
    config.codexMetadataDb = previousMetadataPath;
  }
});

test('agent API preflight permits local browsers and rejects untrusted origins', async () => {
  const app = await buildApp();
  try {
    const local = await app.inject({
      method: 'OPTIONS',
      url: '/api/state',
      headers: { origin: 'http://127.0.0.1:5173' },
    });
    assert.equal(local.statusCode, 204);
    assert.equal(local.headers['access-control-allow-origin'], 'http://127.0.0.1:5173');

    const untrusted = await app.inject({
      method: 'OPTIONS',
      url: '/api/state',
      headers: { origin: 'https://attacker.example' },
    });
    assert.equal(untrusted.statusCode, 403);
    assert.equal(untrusted.headers['access-control-allow-origin'], undefined);
  } finally {
    await app.close();
  }
});

test('untrusted browser requests cannot read state or inject activity without a preflight', async () => {
  const app = await buildApp();
  try {
    for (const origin of ['https://attacker.example', 'null']) {
      const response = await app.inject({
        method: 'POST',
        url: '/activity',
        headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        payload: JSON.stringify({
          event: 'session_start',
          provider: 'codex',
          session_id: 'cross-origin',
        }),
      });
      assert.equal(response.statusCode, 403);
      assert.equal((await app.inject({ url: '/api/state', headers: { origin } })).statusCode, 403);
    }
    const state = (await app.inject('/api/state')).json();
    assert.ok(
      !state.sessions.some((session: { sessionId: string }) =>
        session.sessionId.includes('cross-origin'),
      ),
    );
    assert.equal(
      (await app.inject({ url: '/api/state', headers: { origin: 'http://127.0.0.1:5173' } }))
        .statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});

test('gzip parsing enforces the decompressed route limit and rejects malformed bodies', async () => {
  const app = await buildApp();
  try {
    for (const url of ['/v1/logs', '/api/brain/mcp']) {
      const limit =
        url === '/api/brain/mcp' ? brainConfig.mcp.maxRequestBytes : app.initialConfig.bodyLimit!;
      const payload = gzipSync(Buffer.from(JSON.stringify({ padding: 'x'.repeat(limit) })));
      assert.ok(payload.length < limit);
      const response = await app.inject({
        method: 'POST',
        url,
        headers: {
          ...agentHeaders,
          'content-type': 'application/json',
          'content-encoding': 'gzip',
        },
        payload,
      });
      assert.equal(response.statusCode, 413, response.body);
    }
    for (const payload of [Buffer.from('invalid gzip'), gzipSync(Buffer.from('invalid json'))]) {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/logs',
            headers: {
              ...agentHeaders,
              'content-type': 'application/json',
              'content-encoding': 'gzip',
            },
            payload,
          })
        ).statusCode,
        400,
      );
    }
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/logs',
          headers: {
            ...agentHeaders,
            'content-type': 'application/json',
            'content-encoding': 'gzip',
          },
          payload: gzipSync(Buffer.from('{}')),
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});

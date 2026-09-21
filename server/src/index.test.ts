import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { after } from 'node:test';
import { gzipSync } from 'node:zlib';
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
  INGEST_TOKEN: '',
  VIEWER_TOKEN: '',
  COST_LEDGER: '0',
});

const { buildApp } = await import('./index.js');

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
    await app.inject({ method: 'POST', url: '/activity', payload });
    await app.inject({ method: 'POST', url: '/activity', payload });
    const events = (await app.inject('/api/state'))
      .json()
      .recentEvents.filter((event: { id: string }) => event.id === 'offline-event');
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

test('hook ingestion exposes child lifecycle and hierarchy over the public state API', async () => {
  const app = await buildApp();
  try {
    const send = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/activity', payload: { provider: 'claude', ...payload } });
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
      (item: { sessionId: string }) => item.sessionId === 'claude:hierarchy-root/agent:child',
    );
    assert.equal(child.parentSessionId, 'claude:hierarchy-root');
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
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
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
            headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
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
          headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
          payload: gzipSync(Buffer.from('{}')),
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});

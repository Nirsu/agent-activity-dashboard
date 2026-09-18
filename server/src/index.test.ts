import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { after } from 'node:test';

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

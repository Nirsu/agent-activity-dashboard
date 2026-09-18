import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { after } from 'node:test';

const directory = await mkdtemp(resolve(tmpdir(), 'aad-app-lifecycle-'));
process.env.DATA_DIR = directory;
process.env.DB_PATH = resolve(directory, 'history.db');
process.env.HISTORY_BACKEND = 'sqlite';
process.env.DATABASE_URL = '';
process.env.BRAIN_DB_PATH = resolve(directory, 'brain.db');
process.env.BRAIN_PROJECTS_PATH = resolve(directory, 'projects.json');
process.env.COST_LEDGER = '0';

const { buildApp } = await import('./index.js');
const { history } = await import('./db.js');

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

test('failed history initialization releases the application and allows a fresh startup', async (context) => {
  let closes = 0;
  const originalClose = history.close.bind(history);
  context.mock.method(history, 'close', async () => {
    closes++;
    await originalClose();
  });
  const failedInit = context.mock.method(history, 'init', async () => {
    throw new Error('Injected history initialization failure');
  });
  await assert.rejects(buildApp(), /Injected history initialization failure/);
  assert.equal(closes, 1);
  assert.equal(history.enabled, false);
  failedInit.mock.restore();

  const app = await buildApp();
  try {
    assert.equal((await app.inject('/healthz')).statusCode, 200);
    assert.equal(history.enabled, true);
  } finally {
    await app.close();
  }
  assert.equal(closes, 2);
  assert.equal(history.enabled, false);
});

test('health checks return HTTP 503 after an ingestion persistence failure', async (context) => {
  const app = await buildApp();
  context.mock.method(history, 'recordEvent', async () => {
    throw new Error('Injected write failure');
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/activity',
      payload: { event: 'session_start', session_id: 'write-failure', provider: 'codex' },
    });
    assert.equal(response.statusCode, 503);
    const health = await app.inject('/healthz');
    assert.equal(health.json().persistence.healthy, false);
    assert.equal(health.statusCode, 503, 'HTTP-only Docker probes must detect the failure');
  } finally {
    await app.close();
  }
});

test('a failed second build does not close the history shared by a running application', async (context) => {
  const app = await buildApp();
  context.mock.method(history, 'loadCumulative', async () => {
    throw new Error('Injected history hydration failure');
  });
  try {
    await assert.rejects(buildApp(), /Injected history hydration failure/);
    assert.equal(history.enabled, true);
    const response = await app.inject({
      method: 'POST',
      url: '/activity',
      payload: { event: 'session_start', session_id: 'still-alive', provider: 'codex' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await app.inject('/healthz')).json().persistence.healthy, true);
  } finally {
    await app.close();
  }
  assert.equal(history.enabled, false);
});

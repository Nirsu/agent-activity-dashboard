import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { RelayOutbox } from './relay-outbox.mjs';
import { ensureRelay } from './ensure-relay.mjs';
import { safeTelemetry } from './safe-telemetry.mjs';

const limits = createRequire(import.meta.url)('./relay-config.json');
process.env.HARMONIE_TOKEN = 'fixture-workstation-token';

test('on-demand relay rejects a missing token before launching or reusing a process', async (t) => {
  const f = await fixture(t);
  const token = process.env.HARMONIE_TOKEN;
  delete process.env.HARMONIE_TOKEN;
  try {
    await assert.rejects(
      ensureRelay({
        configPath: f.configPath,
        launch: () => assert.fail('Must not launch without credentials'),
      }),
      /Set HARMONIE_TOKEN/,
    );
  } finally {
    process.env.HARMONIE_TOKEN = token;
  }
});

test('central filtering uses the captured Git origin, discards revoked repositories and retains events on policy outages', async (t) => {
  const f = await fixture(t);
  execFileSync('git', ['init', '--quiet'], { cwd: f.directory });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:org/project.git'], {
    cwd: f.directory,
  });
  let remotePolicy = { enabled: true, repositories: ['github.com/org/project'] };
  let offline = false;
  let revoked = false;
  const delivered = [];
  const queue = new RelayOutbox(
    f.configPath,
    async (_url, init) => {
      if (init.method === 'GET') {
        assert.equal(init.headers.authorization, 'Bearer secret');
        if (offline) throw new Error('offline');
        return Response.json(remotePolicy);
      }
      delivered.push(init);
      return revoked
        ? new Response('{}', {
            status: 403,
            headers: { 'x-harmonie-policy-rejected': 'repository' },
          })
        : new Response('{}');
    },
    'secret',
  );
  await queue.init();
  const add = () =>
    queue.enqueue(
      '/activity',
      { event: 'stop', session_id: 'task', provider: 'codex', repo: 'forged' },
      f.directory,
      f.policy.dashboardUrl,
    );
  await add();
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/private/project.git'], {
    cwd: f.directory,
  });
  await queue.flush();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].headers['x-harmonie-repository'], 'github.com/org/project');
  await add();
  await queue.flush();
  assert.equal(delivered.length, 1, 'a different origin is rejected before posting');
  assert.equal(queue.status().discarded, 1);
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/org/project.git'], {
    cwd: f.directory,
  });
  revoked = true;
  await add();
  await queue.flush();
  assert.equal(queue.status().pending, 0);
  assert.equal(queue.status().discarded, 2, 'the server rejects a stale cached authorization');
  offline = true;
  await add();
  await queue.flush();
  assert.equal(queue.status().pending, 1);
  assert.equal(delivered.length, 2, 'no payload is sent when policy cannot be fetched');
  offline = false;
  remotePolicy = { enabled: true, repositories: [] };
  await queue.flush();
  assert.equal(queue.status().pending, 0);
  assert.equal(queue.status().discarded, 3);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'harmonie delivery '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'telemetry.json');
  const policy = {
    version: 1,
    relayPort: 14318,
    dashboardUrl: 'https://dashboard.example.test',
    projects: [directory],
  };
  await writeFile(configPath, JSON.stringify(policy));
  return { directory, configPath, policy };
}

test('offline events survive restart, preserve identity/time and are removed only after acknowledgement', async (t) => {
  const f = await fixture(t);
  const offline = new RelayOutbox(
    f.configPath,
    async () => {
      throw new Error('offline');
    },
    'PRIVATE_TOKEN',
  );
  await offline.init();
  const timestamp = Date.now() - 60000;
  await offline.enqueue(
    '/activity',
    {
      provider: 'codex',
      event: 'stop',
      session_id: 'task',
      timestamp,
      event_id: 'stable-id',
      prompt: 'PRIVATE_PROMPT',
      tool_input: { command: 'PRIVATE_COMMAND' },
    },
    f.directory,
    f.policy.dashboardUrl,
  );
  await offline.flush();
  assert.equal(offline.status().pending, 1);
  assert.match(offline.status().lastError, /retried/);
  const saved = await readFile(
    join(f.directory, 'outbox', (await readdir(join(f.directory, 'outbox')))[0]),
    'utf8',
  );
  assert.doesNotMatch(saved, /PRIVATE_/);
  const delivered = [];
  const resumed = new RelayOutbox(
    f.configPath,
    async (url, init) => {
      if (init.method === 'GET') return Response.json({ enabled: false, repositories: [] });
      delivered.push({ url, ...init });
      return new Response('{}');
    },
    'PRIVATE_TOKEN',
  );
  await resumed.init();
  await resumed.flush();
  assert.equal(resumed.status().pending, 0);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].headers.authorization, 'Bearer PRIVATE_TOKEN');
  const body = JSON.parse(delivered[0].body);
  assert.equal(body.timestamp, timestamp);
  assert.equal(body.event_id, 'stable-id');
  assert.deepEqual(await readdir(join(f.directory, 'outbox')), []);
});

test('queued activity is never attributed to a replacement token and does not block its new events', async (t) => {
  const f = await fixture(t);
  const delivered = [];
  const forward = async (_url, init) => {
    if (init.method === 'GET') return Response.json({ enabled: false, repositories: [] });
    delivered.push(JSON.parse(init.body).session_id);
    return new Response('{}');
  };
  const previous = new RelayOutbox(f.configPath, forward, 'previous-developer');
  await previous.init();
  await previous.enqueue(
    '/activity',
    { provider: 'codex', event: 'stop', session_id: 'previous-session' },
    f.directory,
    f.policy.dashboardUrl,
  );
  const current = new RelayOutbox(f.configPath, forward, 'current-developer');
  await current.init();
  await current.enqueue(
    '/activity',
    { provider: 'codex', event: 'stop', session_id: 'current-session' },
    f.directory,
    f.policy.dashboardUrl,
  );
  await current.flush();
  assert.deepEqual(delivered, ['current-session']);
  assert.equal(current.status().pending, 1);
  assert.match(current.status().lastError, /different credential/);
  const restored = new RelayOutbox(f.configPath, forward, 'previous-developer');
  await restored.init();
  await restored.flush();
  assert.deepEqual(delivered, ['current-session', 'previous-session']);
  assert.equal(restored.status().pending, 0);
});

test('queue respects removal, destination changes, expiry and reports capacity errors', async (t) => {
  const f = await fixture(t);
  let delivered = 0;
  const queue = new RelayOutbox(
    f.configPath,
    async () => {
      delivered++;
      return new Response('{}');
    },
    'fixture-workstation-token',
    { ...limits, maxQueueEntries: 1 },
  );
  await queue.init();
  const add = () =>
    queue.enqueue(
      '/activity',
      { event: 'stop', session_id: 'task', provider: 'codex' },
      f.directory,
      f.policy.dashboardUrl,
    );
  await add();
  await assert.rejects(add(), /full/);
  await writeFile(f.configPath, JSON.stringify({ ...f.policy, projects: [] }));
  await queue.flush();
  assert.equal(delivered, 0);
  assert.equal(queue.status().discarded, 1);
  await writeFile(f.configPath, JSON.stringify(f.policy));
  await add();
  await writeFile(
    f.configPath,
    JSON.stringify({ ...f.policy, dashboardUrl: 'https://other.example.test' }),
  );
  await queue.flush();
  assert.equal(delivered, 0);
  await writeFile(f.configPath, JSON.stringify(f.policy));
  await add();
  queue.entries[0].entry.createdAt = Date.now() - limits.maxQueueAgeMs - 1;
  await queue.flush();
  assert.equal(delivered, 0);
  assert.equal(queue.status().discarded, 3);
});

test('HTTP auth errors retain events without persisting or logging access tokens', async (t) => {
  const f = await fixture(t);
  const queue = new RelayOutbox(
    f.configPath,
    async () => new Response('PRIVATE_RESPONSE', { status: 401 }),
    'PRIVATE_TOKEN',
  );
  await queue.init();
  await queue.enqueue(
    '/activity',
    { event: 'stop', session_id: 'task', provider: 'codex' },
    f.directory,
    f.policy.dashboardUrl,
  );
  await queue.flush();
  assert.equal(queue.status().pending, 1);
  assert.match(queue.status().lastError, /401/);
  assert.doesNotMatch(JSON.stringify(queue.status()), /PRIVATE_/);
});

test('durable OTLP payloads retain usage and hierarchy but discard content and arbitrary nested fields', () => {
  const attribute = (key, value) => ({ key, value: { stringValue: value } });
  const body = {
    resourceLogs: [
      {
        resource: {
          attributes: [attribute('user.email', 'dev'), attribute('prompt', 'PRIVATE_PROMPT')],
        },
        scopeLogs: [
          {
            scope: { name: 'codex', ignored: 'PRIVATE_SCOPE' },
            logRecords: [
              {
                timeUnixNano: '1000000000',
                body: { stringValue: 'PRIVATE_BODY' },
                attributes: [
                  attribute('event.name', 'codex.api_request'),
                  attribute('session.id', 'task'),
                  attribute('input_tokens', '42'),
                  attribute('command', 'PRIVATE_COMMAND'),
                  attribute(
                    'session_source',
                    JSON.stringify({
                      subagent: {
                        thread_spawn: {
                          parent_thread_id: 'root',
                          agent_role: 'explorer',
                          prompt: 'PRIVATE_NESTED',
                        },
                      },
                    }),
                  ),
                ],
                arbitrary: 'PRIVATE_EXTRA',
              },
            ],
          },
        ],
      },
    ],
  };
  const safe = safeTelemetry('/v1/logs', body);
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_/);
  const attrs = safe.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
  assert.equal(attrs.find((a) => a.key === 'input_tokens').value.stringValue, '42');
  assert.match(attrs.find((a) => a.key === 'session_source').value.stringValue, /root/);
  const metric = safeTelemetry('/v1/metrics', {
    resourceMetrics: [
      {
        resource: { attributes: [] },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.token.usage',
                description: 'PRIVATE_DESCRIPTION',
                sum: {
                  aggregationTemporality: 2,
                  dataPoints: [
                    {
                      asInt: '42',
                      timeUnixNano: '1000000000',
                      attributes: [attribute('session.id', 'task')],
                      exemplars: ['PRIVATE_EXEMPLAR'],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(metric), /PRIVATE_/);
  assert.equal(metric.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asInt, '42');
});

test('relay starts on demand with paths containing spaces and is reused by subsequent hooks', async (t) => {
  const f = await fixture(t);
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await writeFile(f.configPath, JSON.stringify({ ...f.policy, relayPort: port }));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.ref();
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  assert.equal(
    await ensureRelay({
      configPath: f.configPath,
      launch: (...args) => {
        child = spawn(...args);
        return child;
      },
    }),
    true,
  );
  assert.equal(
    await ensureRelay({
      configPath: f.configPath,
      launch: () => {
        throw new Error('Must reuse relay');
      },
    }),
    true,
  );
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(health.service, 'harmonie-project-relay');
  assert.equal(health.delivery.pending, 0);
  const originalToken = process.env.HARMONIE_TOKEN;
  try {
    process.env.HARMONIE_TOKEN = 'replacement-test-credential';
    await assert.rejects(ensureRelay({ configPath: f.configPath }), /different credential/);
  } finally {
    if (originalToken === undefined) delete process.env.HARMONIE_TOKEN;
    else process.env.HARMONIE_TOKEN = originalToken;
  }
});

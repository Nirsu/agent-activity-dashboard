import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { repositoryAt } from './project-policy.mjs';
import { startRelay } from './relay.mjs';
import { ensureRelay } from './ensure-relay.mjs';
import { relayCredentialId } from './relay-outbox.mjs';

const branch = 'feature/AAD-321-workspaces';
const hookPath = fileURLToPath(new URL('../hooks/hook.js', import.meta.url));
const attribute = (key, value) => ({ key, value: { stringValue: value } });
const attributeValue = (values, key) =>
  values.find((value) => value.key === key)?.value.stringValue;

function logs(...ids) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [] },
        scopeLogs: [
          {
            scope: { name: 'fixture' },
            logRecords: ids.map((id) => ({
              attributes: [
                attribute('event.name', 'codex.api_request'),
                attribute('conversation.id', id),
              ],
            })),
          },
        ],
      },
    ],
  };
}

function metrics(...ids) {
  return {
    resourceMetrics: [
      {
        resource: { attributes: [] },
        scopeMetrics: [
          {
            scope: { name: 'fixture' },
            metrics: [
              {
                name: 'codex.token.usage',
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: ids.map((id) => ({
                    attributes: [attribute('conversation.id', id)],
                    asInt: '42',
                    timeUnixNano: '1750000000000000000',
                  })),
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function deliveredIds(delivered, path) {
  return delivered
    .filter((entry) => entry.path === path)
    .flatMap(({ body }) => {
      if (path === '/activity') {
        return [body.session_id];
      }
      const records =
        path === '/v1/logs'
          ? body.resourceLogs.flatMap((resource) =>
              resource.scopeLogs.flatMap((scope) => scope.logRecords),
            )
          : body.resourceMetrics.flatMap((resource) =>
              resource.scopeMetrics.flatMap((scope) =>
                scope.metrics.flatMap((metric) => metric.sum.dataPoints),
              ),
            );
      return records.map((record) => attributeValue(record.attributes, 'conversation.id'));
    })
    .sort();
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'harmonie-workspace-relay-'));
  const workspace = join(directory, 'workspace');
  const repository = join(workspace, 'selected-repository');
  const other = join(directory, 'other-repository');
  const servers = [];
  t.after(async () => {
    for (const server of servers) {
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  for (const path of [repository, other]) {
    await mkdir(path, { recursive: true });
    execFileSync('git', ['init', '--quiet', `--initial-branch=${branch}`], { cwd: path });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=',
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        'fixture',
      ],
      { cwd: path },
    );
  }
  const configPath = join(directory, 'telemetry.json');
  const policy = {
    version: 1,
    dashboardUrl: 'https://dashboard.example.test',
    relayPort: 14318,
    projects: [repositoryAt(repository).path, repositoryAt(other).path],
    workspaceBindings: [{ workspace, repository: repositoryAt(repository).path }],
  };
  const writePolicy = (value) => writeFile(configPath, JSON.stringify(value));
  await writePolicy(policy);
  const delivered = [];
  let offline = false;
  async function start({ onPolicyRequest } = {}) {
    const server = await startRelay({
      configPath,
      port: 0,
      token: 'fixture-token',
      forward: async (url, init) => {
        if (offline) {
          throw new Error('offline');
        }
        if (init.method === 'GET') {
          await onPolicyRequest?.();
          return Response.json({ enabled: false, repositories: [] });
        }
        delivered.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
        return new Response('{}');
      },
    });
    servers.push(server);
    return server;
  }
  return {
    directory,
    configPath,
    workspace,
    repository,
    other,
    policy,
    writePolicy,
    delivered,
    start,
    setOffline(value) {
      offline = value;
    },
  };
}

async function post(server, path, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.text());
  await server.flushTelemetry();
}

function identify(server, id, cwd) {
  return post(server, '/activity', {
    provider: 'codex',
    event: 'session_start',
    session_id: id,
    cwd,
  });
}

async function runHook(server, input) {
  await new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookPath],
      {
        env: {
          ...process.env,
          AAD_URL: `http://127.0.0.1:${server.address().port}`,
          AAD_PROVIDER: 'codex',
          AAD_DRY_RUN: '0',
        },
        windowsHide: true,
      },
      (error, _stdout, stderr) => {
        if (error) {
          reject(error);
        } else if (stderr) {
          reject(new Error(stderr));
        } else {
          resolve();
        }
      },
    );
    child.stdin.end(JSON.stringify(input));
  });
  await server.flushTelemetry();
}

test('Codex workspace hooks retain their cwd and identify the selected repository for parent and child usage', async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  await runHook(server, {
    hook_event_name: 'SessionStart',
    session_id: 'parent',
    cwd: f.workspace,
  });
  await runHook(server, {
    hook_event_name: 'SubagentStart',
    session_id: 'parent',
    agent_id: 'child',
    agent_type: 'explorer',
    cwd: f.workspace,
  });
  await runHook(server, {
    hook_event_name: 'Stop',
    session_id: 'parent',
    cwd: f.workspace,
  });
  const activity = f.delivered.filter((entry) => entry.path === '/activity');
  assert.equal(activity.length, 3);
  for (const { body } of activity) {
    assert.equal(body.cwd, f.workspace);
    assert.equal(body.repo, basename(f.repository));
    assert.equal(body.branch, branch);
  }
  assert.equal(activity[1].body.parent_session_id, 'parent');
  assert.equal(activity[1].body.session_role, 'subagent');
  await post(server, '/v1/logs', logs('parent', 'child', 'unidentified'));
  await post(server, '/v1/metrics', metrics('parent', 'child', 'unidentified'));
  for (const path of ['/v1/logs', '/v1/metrics']) {
    assert.deepEqual(deliveredIds(f.delivered, path), ['child', 'parent']);
  }
});

test('changing a workspace binding revokes mapped sessions without revoking direct sessions in the same repository', async (t) => {
  for (const change of ['remove', 'reassign']) {
    await t.test(change, async (t) => {
      const f = await fixture(t);
      const server = await f.start();
      await identify(server, 'mapped', f.workspace);
      await identify(server, 'direct', f.repository);
      const workspaceBindings =
        change === 'remove' ? [] : [{ workspace: f.workspace, repository: f.policy.projects[1] }];
      await f.writePolicy({ ...f.policy, workspaceBindings });
      await post(server, '/v1/logs', logs('mapped', 'direct'));
      await post(server, '/v1/metrics', metrics('mapped', 'direct'));
      for (const path of ['/v1/logs', '/v1/metrics']) {
        assert.deepEqual(deliveredIds(f.delivered, path), ['direct']);
      }
    });
  }
});

test('persisted workspace sessions require their original binding after relay restart', async (t) => {
  const f = await fixture(t);
  let server = await f.start();
  await identify(server, 'mapped', f.workspace);
  await identify(server, 'direct', f.repository);
  await new Promise((resolve) => server.close(resolve));
  server = await f.start();
  await post(server, '/v1/logs', logs('mapped', 'direct'));
  await post(server, '/v1/metrics', metrics('mapped', 'direct'));
  for (const path of ['/v1/logs', '/v1/metrics']) {
    assert.deepEqual(deliveredIds(f.delivered, path), ['direct', 'mapped']);
  }
  await new Promise((resolve) => server.close(resolve));
  await f.writePolicy({ ...f.policy, workspaceBindings: [] });
  f.delivered.length = 0;
  server = await f.start();
  await post(server, '/v1/logs', logs('mapped', 'direct'));
  await post(server, '/v1/metrics', metrics('mapped', 'direct'));
  for (const path of ['/v1/logs', '/v1/metrics']) {
    assert.deepEqual(deliveredIds(f.delivered, path), ['direct']);
  }
});

test('on-demand relay starts within its hook deadline with 40 persisted workspace sessions', async (t) => {
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.ref();
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  const f = await fixture(t);
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await f.writePolicy({ ...f.policy, relayPort: port });
  await writeFile(
    join(f.directory, 'relay-sessions.json'),
    JSON.stringify({
      dashboardUrl: f.policy.dashboardUrl,
      credentialId: relayCredentialId(process.env.HARMONIE_TOKEN || process.env.AAD_TOKEN),
      sessions: Array.from({ length: 40 }, (_, index) => [
        `codex:restored-${index}`,
        { project: f.policy.projects[0], workspace: f.workspace, at: Date.now() },
      ]),
    }),
  );
  const startedAt = Date.now();
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
  t.diagnostic(`Relay ready with 40 saved sessions in ${Date.now() - startedAt} ms.`);
});

test('queued mixed usage survives restart only for sessions whose workspace authorization remains selected', async (t) => {
  const f = await fixture(t);
  f.setOffline(true);
  let server = await f.start();
  await identify(server, 'mapped', f.workspace);
  await identify(server, 'direct', f.repository);
  await post(server, '/v1/logs', logs('mapped', 'direct'));
  await post(server, '/v1/metrics', metrics('mapped', 'direct'));
  assert.ok(server.telemetryStatus().pending > 0);
  assert.equal(f.delivered.length, 0);
  await new Promise((resolve) => server.close(resolve));
  await f.writePolicy({ ...f.policy, workspaceBindings: [] });
  f.setOffline(false);
  server = await f.start();
  await server.flushTelemetry();
  assert.equal(server.telemetryStatus().pending, 0);
  for (const path of ['/activity', '/v1/logs', '/v1/metrics']) {
    assert.deepEqual(deliveredIds(f.delivered, path), ['direct']);
  }
});

test('removing a workspace binding while fetching central policy prevents the pending activity from being sent', async (t) => {
  const f = await fixture(t);
  const server = await f.start({
    onPolicyRequest: () => f.writePolicy({ ...f.policy, workspaceBindings: [] }),
  });
  await identify(server, 'mapped', f.workspace);
  assert.deepEqual(f.delivered, []);
  assert.equal(server.telemetryStatus().pending, 0);
  assert.equal(server.telemetryStatus().discarded, 1);
});

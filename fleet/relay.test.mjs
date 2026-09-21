import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { repositoryAt, selectedRepository } from './project-policy.mjs';
import { configureProjects } from './projects.mjs';
import { startRelay, ProjectFilter } from './relay.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'harmonie-relay-'));
  const allowed = join(directory, 'selected', 'project');
  const excluded = join(directory, 'private', 'project');
  for (const path of [allowed, excluded]) {
    await mkdir(path, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: path });
  }
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'telemetry.json');
  const policy = {
    version: 1,
    dashboardUrl: 'https://dashboard.example.test',
    relayPort: 14318,
    projects: [repositoryAt(allowed).path],
  };
  await writeFile(configPath, JSON.stringify(policy));
  return { directory, allowed, excluded, configPath, policy };
}

const attribute = (key, value) => ({ key, value: { stringValue: value } });
const record = (id, provider = 'codex') => ({
  attributes: [
    attribute('event.name', provider === 'codex' ? 'codex.api_request' : 'claude_code.api_request'),
    attribute('conversation.id', id),
  ],
});
const logs = (...records) => ({
  resourceLogs: [
    {
      resource: { attributes: [] },
      scopeLogs: [{ scope: { name: 'fixture' }, logRecords: records }],
    },
  ],
});

test('repository selection respects nested repositories and recognizes linked worktrees', async (t) => {
  const f = await fixture(t);
  const subdirectory = join(f.allowed, 'src');
  const nested = join(f.allowed, 'vendor', 'other');
  await mkdir(subdirectory);
  await mkdir(nested, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: nested });
  assert.equal(selectedRepository(subdirectory, f.policy.projects), f.policy.projects[0]);
  assert.equal(selectedRepository(f.excluded, f.policy.projects), undefined);
  assert.equal(selectedRepository(nested, f.policy.projects), undefined);
  assert.equal(selectedRepository(undefined, f.policy.projects), undefined);
  assert.equal(selectedRepository(f.allowed, []), undefined);
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
    { cwd: f.allowed },
  );
  const worktree = join(f.directory, 'worktree');
  execFileSync('git', ['worktree', 'add', '--quiet', '--detach', worktree], { cwd: f.allowed });
  assert.equal(selectedRepository(worktree, f.policy.projects), f.policy.projects[0]);
});

test('selection CLI is repeatable, preserves the destination and accepts removal of missing paths', async (t) => {
  const f = await fixture(t);
  const initial = await readFile(f.configPath, 'utf8');
  await configureProjects({ configPath: f.configPath, allow: [f.allowed] });
  assert.equal(await readFile(f.configPath, 'utf8'), initial);
  let result = await configureProjects({ configPath: f.configPath, allow: [f.excluded] });
  assert.equal(result.projects.length, 2);
  assert.equal(result.dashboardUrl, f.policy.dashboardUrl);
  result = await configureProjects({ configPath: f.configPath, remove: [f.allowed] });
  assert.deepEqual(result.projects, [repositoryAt(f.excluded).path]);
  const beforeInvalid = await readFile(f.configPath, 'utf8');
  await assert.rejects(
    configureProjects({ configPath: f.configPath, allow: [f.directory] }),
    /Git repository/,
  );
  assert.equal(await readFile(f.configPath, 'utf8'), beforeInvalid);
});

test('HTTP relay forwards only approved sessions across hooks, mixed logs and mixed metrics', async (t) => {
  const f = await fixture(t);
  const forwarded = [];
  const server = await startRelay({
    configPath: f.configPath,
    port: 0,
    token: 'fixture-token',
    forward: async (url, init) => {
      if (init.method === 'GET') return Response.json({ enabled: false, repositories: [] });
      forwarded.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response('{}');
    },
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  async function post(path, body, gzip = false) {
    const data = JSON.stringify(body);
    const response = await fetch(url + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(gzip ? { 'content-encoding': 'gzip' } : {}),
      },
      body: gzip ? gzipSync(data) : data,
    });
    await response.json();
    await server.flushTelemetry();
    return response.status;
  }
  const hook = (id, cwd, provider = 'codex') => ({
    event: 'session_start',
    session_id: id,
    cwd,
    provider,
  });
  assert.equal(await post('/v1/logs', logs(record('same'))), 200);
  assert.equal(await post('/activity', hook('private', f.excluded)), 200);
  assert.equal(
    await post('/activity', { ...hook('fake', f.excluded), project_id: 'approved' }),
    200,
  );
  assert.equal(forwarded.length, 0);
  assert.equal(await post('/activity', hook('same', f.allowed)), 200);
  assert.equal(await post('/activity', hook('claude-session', f.allowed, 'claude')), 200);
  assert.equal(forwarded.length, 2);
  assert.equal(
    await post('/v1/logs', logs(record('same'), record('private'), record('same', 'claude')), true),
    200,
  );
  assert.deepEqual(forwarded.at(-1).body, logs(record('same')));
  const points = ['claude-session', 'private'].map((id) => ({
    attributes: [attribute('session.id', id)],
    asInt: '10',
    timeUnixNano: '1750000000000000000',
  }));
  const metrics = {
    resourceMetrics: [
      {
        resource: { attributes: [] },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.token.usage',
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [...points, { asInt: '99' }],
                },
              },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(await post('/v1/metrics', metrics), 200);
  const metric = forwarded.at(-1).body.resourceMetrics[0].scopeMetrics[0].metrics[0];
  assert.deepEqual(metric.sum.dataPoints, [points[0]]);
  assert.equal(metric.sum.aggregationTemporality, 2);
  assert.equal(forwarded.at(-1).headers.authorization, 'Bearer fixture-token');
  const beforeTrace = forwarded.length;
  await post('/v1/traces', { resourceSpans: ['private'] });
  await post('/activity', hook('same', f.excluded));
  await post('/v1/logs', logs(record('same')));
  assert.equal(
    forwarded.length,
    beforeTrace,
    'an excluded cwd revokes earlier session authorization',
  );
  const origin = await fetch(url + '/healthz', {
    headers: { origin: 'https://external.example.test' },
  });
  assert.equal(origin.status, 403);
  await origin.json();
});

test('a concurrent hook cannot change an accepted event repository or discard its binding', async (t) => {
  const f = await fixture(t);
  for (const [path, name] of [
    [f.allowed, 'one'],
    [f.excluded, 'two'],
  ]) {
    execFileSync('git', ['remote', 'add', 'origin', `https://github.com/org/${name}.git`], {
      cwd: path,
    });
  }
  await writeFile(f.configPath, JSON.stringify({ ...f.policy, projects: [f.allowed, f.excluded] }));
  const activity = ProjectFilter.prototype.activity;
  t.mock.method(ProjectFilter.prototype, 'activity', function (payload, policy) {
    const result = activity.call(this, payload, policy);
    // Deterministically interleave another lifecycle hook during the disk write.
    queueMicrotask(() =>
      activity.call(
        this,
        {
          ...payload,
          cwd: payload.session_id === 'switch' ? f.excluded : f.directory,
        },
        policy,
      ),
    );
    return result;
  });
  const forwarded = [];
  const server = await startRelay({
    configPath: f.configPath,
    port: 0,
    forward: async (_url, init) => {
      if (init.method === 'GET')
        return Response.json({ enabled: true, repositories: ['github.com/org/two'] });
      forwarded.push({
        remote: init.headers['x-harmonie-repository'],
        body: JSON.parse(init.body),
      });
      return new Response('{}');
    },
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const [id, cwd] of [
    ['switch', f.allowed],
    ['remove', f.excluded],
  ]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/activity`, {
      method: 'POST',
      body: JSON.stringify({ event: 'session_start', provider: 'codex', session_id: id, cwd }),
    });
    assert.equal(response.status, 200, await response.text());
    await server.flushTelemetry();
  }
  assert.equal(forwarded.length, 1, 'the first repository remains centrally denied');
  assert.equal(forwarded[0].body.session_id, 'remove');
  assert.equal(forwarded[0].remote, 'github.com/org/two');
});

test('saved sessions survive restart only under the original credential', async (t) => {
  const f = await fixture(t);
  const forwarded = [];
  const forward = async (_url, init) => {
    if (init.method === 'GET') return Response.json({ enabled: false, repositories: [] });
    forwarded.push(JSON.parse(init.body));
    return new Response('{}');
  };
  let server = await startRelay({ configPath: f.configPath, port: 0, token: 'original', forward });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const post = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    await response.json();
    await server.flushTelemetry();
  };
  await post('/activity', {
    event: 'session_start',
    provider: 'codex',
    session_id: 'bound',
    cwd: f.allowed,
  });
  await new Promise((resolve) => server.close(resolve));
  server = await startRelay({ configPath: f.configPath, port: 0, token: 'original', forward });
  await post('/v1/logs', logs(record('bound')));
  assert.equal(forwarded.length, 2, 'the original credential restores its session');
  await new Promise((resolve) => server.close(resolve));
  server = await startRelay({ configPath: f.configPath, port: 0, token: 'replacement', forward });
  await post('/v1/logs', logs(record('bound')));
  assert.equal(forwarded.length, 2, 'replacement credentials need a fresh identifying hook');
});

test('empty, removed, invalid and missing configuration fail closed without an upstream request', async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const server = await startRelay({
    configPath: f.configPath,
    port: 0,
    forward: async (_url, init) => {
      if (init.method === 'GET') return Response.json({ enabled: false, repositories: [] });
      requests++;
      return new Response('{}');
    },
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  async function post(path, body) {
    const response = await fetch(url + path, { method: 'POST', body: JSON.stringify(body) });
    await response.json();
    await server.flushTelemetry();
    return response.status;
  }
  const hook = {
    provider: 'codex',
    session_id: 'selected',
    event: 'session_start',
    cwd: f.allowed,
  };
  await post('/activity', hook);
  assert.equal(requests, 1);
  await writeFile(f.configPath, JSON.stringify({ ...f.policy, projects: [] }));
  await post('/v1/logs', logs(record('selected')));
  await post('/activity', hook);
  assert.equal(requests, 1);
  await writeFile(f.configPath, '{invalid');
  assert.equal(await post('/activity', hook), 503);
  await rm(f.configPath);
  assert.equal(await post('/activity', hook), 503);
  assert.equal(requests, 1);
});

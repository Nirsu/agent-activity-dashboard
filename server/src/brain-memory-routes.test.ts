import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import { MemoryService } from './brain/memory/service.js';
import { registerMemoryRoutes } from './brain/memory/routes.js';
import { registerMemoryWebhooks, verifyWebhookSignature } from './brain/memory/webhooks.js';
import { brainConfig } from './brain/config.js';

const pageId = '3dddeff1b90780b7baedffb10c08a0d3';
const otherPageId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const webhookSecret = 'test-webhook-signing-secret';
const policy = {
  projectIds: ['dashboard'],
  shared: false,
  mandatory: true,
  approval: 'draft' as const,
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-memory-routes-'));
  const projectsPath = resolve(root, 'projects.json');
  await writeFile(
    projectsPath,
    JSON.stringify(
      ['dashboard', 'other'].map((id) => ({
        id,
        name: id,
        scope: 'Test sources',
        repoPath: '.',
        codePaths: ['code.ts'],
        specs: [{ kind: 'git', path: 'README.md' }],
      })),
    ),
  );
  let pageReads = 0;
  const indexed: Array<{ sourceId: string; content: string; datasetId: string }> = [];
  const createService = () =>
    new MemoryService({
      dbPath: resolve(root, 'brain.sqlite'),
      projectsPath,
      schedule: false,
      notion: {
        state: () => ({ configured: true, connected: true, status: 'connected' }),
        fetchPage: async (id) => {
          pageReads += 1;
          return {
            pageId: id,
            title: 'Live document',
            content: 'Exact preserved evidence.',
            properties: {},
            url: `https://www.notion.so/${id}`,
            raw: 'Raw page content',
          };
        },
      },
      cognee: {
        status: async () => ({ configured: true, available: true }),
        index: async (source, name) => {
          indexed.push({ sourceId: source.id, content: source.content, datasetId: name });
          return { datasetId: name };
        },
        search: async () => [],
        graph: async () => ({ nodes: [], edges: [], truncated: false }),
      },
    });
  let service = createService();
  await service.init();
  const createApp = async () => {
    const app = Fastify();
    registerMemoryRoutes(app, service, async (request, reply) => {
      if (request.headers.authorization !== 'Bearer admin') {
        return reply.code(403).send({ error: 'Administrator access is required.' });
      }
    });
    await registerMemoryWebhooks(app, service, {
      notionVerificationToken: webhookSecret,
      githubSecret: webhookSecret,
      githubProjects: { 'company/dashboard': ['dashboard'] },
    });
    return app;
  };
  let app = await createApp();
  t.after(async () => {
    await app.close();
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const restart = async () => {
    await app.close();
    await service.close();
    service = createService();
    await service.init();
    app = await createApp();
  };
  return { root, indexed, app: () => app, service: () => service, restart, reads: () => pageReads };
}

function sign(body: string) {
  return `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`;
}

function notionEvent(id = 'event-1', sourcePageId = pageId) {
  return JSON.stringify(
    {
      id,
      type: 'page.content_updated',
      entity: { type: 'page', id: sourcePageId },
      timestamp: '2026-09-16T10:00:00Z',
    },
    null,
    2,
  );
}

test('memory routes require admin mutations and preserve immutable captured source access', async (t) => {
  const setup = await fixture(t);
  const payload = { ...policy, pageId: `https://app.notion.com/p/Test-${pageId}?source=copy_link` };
  const blocked = await setup
    .app()
    .inject({ method: 'POST', url: '/api/brain/memory/sources', payload });
  assert.equal(blocked.statusCode, 403);
  assert.ok(!setup.service().store.source(`notion:${pageId}`));
  const added = await setup.app().inject({
    method: 'POST',
    url: '/api/brain/memory/sources',
    payload,
    headers: { authorization: 'Bearer admin' },
  });
  assert.equal(added.statusCode, 201);
  await setup.service().wait();
  const source = setup.service().store.source(`notion:${pageId}`)!;
  const capture = await setup.app().inject({ url: `/api/brain/sources/${source.currentSourceId}` });
  assert.equal(capture.statusCode, 200);
  assert.equal(capture.json().content, 'Exact preserved evidence.');
  const withdrawn = await setup.app().inject({
    method: 'PUT',
    url: `/api/brain/memory/sources/${source.id}`,
    headers: { authorization: 'Bearer admin' },
    payload: { ...policy, approval: 'withdrawn' },
  });
  assert.equal(withdrawn.statusCode, 200);
  assert.equal(
    (await setup.app().inject({ url: `/api/brain/sources/${source.currentSourceId}` })).statusCode,
    200,
  );
  const missing = await setup.app().inject({ url: '/api/brain/sources/missing' });
  assert.equal(missing.statusCode, 404);
  const invalidScope = await setup.app().inject({
    method: 'PUT',
    url: `/api/brain/memory/sources/${source.id}`,
    headers: { authorization: 'Bearer admin' },
    payload: { ...policy, projectIds: ['unregistered'] },
  });
  assert.equal(invalidScope.statusCode, 400);
  assert.equal(
    (await setup.app().inject({ method: 'POST', url: '/api/brain/memory/connection-test' }))
      .statusCode,
    403,
  );
  const connection = await setup.app().inject({
    method: 'POST',
    url: '/api/brain/memory/connection-test',
    headers: { authorization: 'Bearer admin' },
  });
  assert.equal(connection.json().available, true);
});

test('webhook signatures cover exact raw bytes and never trust a submitted verification token', async (t) => {
  const setup = await fixture(t);
  await setup.service().register({ ...policy, pageId });
  await setup.service().wait();
  const initialJobs = setup.service().store.jobs().length;
  const body = notionEvent();
  const wrongBytes = sign(JSON.stringify(JSON.parse(body)));
  const rejected = await setup.app().inject({
    method: 'POST',
    url: '/api/brain/webhooks/notion',
    payload: body,
    headers: { 'content-type': 'application/json', 'x-notion-signature': wrongBytes },
  });
  assert.equal(rejected.statusCode, 401);
  const handshake = JSON.stringify({ verification_token: 'attacker-controlled-secret' });
  const unsigned = await setup.app().inject({
    method: 'POST',
    url: '/api/brain/webhooks/notion',
    payload: handshake,
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(unsigned.statusCode, 401);
  const signed = await setup.app().inject({
    method: 'POST',
    url: '/api/brain/webhooks/notion',
    payload: handshake,
    headers: { 'content-type': 'application/json', 'x-notion-signature': sign(handshake) },
  });
  assert.equal(signed.statusCode, 400);
  assert.equal(setup.service().store.jobs().length, initialJobs);
  assert.equal(
    verifyWebhookSignature(
      Buffer.from('Hello, World!'),
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
      "It's a Secret to Everybody",
    ),
    true,
  );
});

test('Notion webhook enqueues only registered pages and deduplicates durably across restart', async (t) => {
  const setup = await fixture(t);
  await setup.service().register({ ...policy, pageId, shared: true, projectIds: [] });
  await setup.service().register({ ...policy, pageId: otherPageId });
  await setup.service().wait();
  const body = notionEvent();
  const send = (payload = body) =>
    setup.app().inject({
      method: 'POST',
      url: '/api/brain/webhooks/notion',
      payload,
      headers: { 'content-type': 'application/json', 'x-notion-signature': sign(payload) },
    });
  const initialJobs = setup.service().store.jobs().length;
  const response = await send();
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { accepted: true, duplicate: false, queued: 1 });
  await setup.service().wait();
  assert.equal(setup.service().store.jobs().length, initialJobs + 1);
  await setup.restart();
  assert.deepEqual((await send()).json(), { accepted: true, duplicate: true, queued: 0 });
  const unrelated = await send(notionEvent('event-unrelated', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'));
  assert.equal(unrelated.json().ignored, true);
  assert.equal(setup.service().store.jobs().length, initialJobs + 1);
  const older = JSON.parse(notionEvent('event-older'));
  older.timestamp = '2020-01-01T00:00:00Z';
  assert.equal((await send(JSON.stringify(older))).json().queued, 1);
  await setup.service().wait();
  assert.equal(
    setup
      .service()
      .store.capture(setup.service().store.source(`notion:${pageId}`)!.currentSourceId!)!.content,
    'Exact preserved evidence.',
  );
});

test('GitHub webhook synchronizes only explicitly mapped registered project sources', async (t) => {
  const setup = await fixture(t);
  const git = async (...args: string[]) => {
    const result = await promisify(execFile)('git', ['-C', setup.root, ...args], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: brainConfig.git.timeoutMs,
      maxBuffer: brainConfig.git.maxBufferBytes,
    });
    return result.stdout.trim();
  };
  const specification = 'Keep hook summaries free of raw command arguments.\n';
  await writeFile(resolve(setup.root, 'README.md'), specification);
  await git('init');
  await git('add', 'README.md');
  await git(
    '-c',
    'user.name=Brain test',
    '-c',
    'user.email=brain@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'Add webhook specification',
  );
  const commit = await git('rev-parse', 'HEAD');
  const send = (repository: string, delivery = 'delivery-1') => {
    const body = JSON.stringify({
      repository: { full_name: repository },
      ref: 'refs/heads/main',
      after: commit,
    });
    return setup.app().inject({
      method: 'POST',
      url: '/api/brain/webhooks/github',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(body),
        'x-github-delivery': delivery,
        'x-github-event': 'push',
      },
    });
  };
  assert.equal((await send('unrelated/repository')).json().ignored, true);
  const accepted = await send('company/dashboard');
  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.json().queued, 1);
  await setup.service().wait();
  const jobs = setup.service().store.jobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'succeeded', jobs[0].error);
  const source = setup.service().store.source(jobs[0].sourceId)!;
  assert.equal(source.git!.projectId, 'dashboard');
  assert.equal(source.status, 'ready');
  const capture = setup.service().store.capture(source.currentSourceId!)!;
  assert.equal(capture.origin!.revision, commit);
  assert.equal(capture.content, specification);
  assert.deepEqual(setup.indexed, [
    { sourceId: capture.id, content: specification, datasetId: source.datasetId },
  ]);
  assert.equal(
    setup
      .service()
      .store.sources()
      .find((entry) => entry.git?.projectId === 'other')!.status,
    'pending',
  );
  assert.equal((await send('company/dashboard')).json().duplicate, true);
});

test('webhooks reject oversized bodies and unconfigured secrets without queueing work', async (t) => {
  const setup = await fixture(t);
  const oversized = 'x'.repeat(brainConfig.synchronization.webhookMaxBodyBytes + 1);
  const result = await setup.app().inject({
    method: 'POST',
    url: '/api/brain/webhooks/notion',
    payload: oversized,
    headers: { 'content-type': 'application/json', 'x-notion-signature': sign(oversized) },
  });
  assert.equal(result.statusCode, 413);
  const app = Fastify();
  t.after(() => app.close());
  await registerMemoryWebhooks(app, setup.service(), {
    githubSecret: '',
    notionVerificationToken: '',
    githubProjects: {},
  });
  const body = notionEvent();
  const unconfigured = await app.inject({
    method: 'POST',
    url: '/api/brain/webhooks/notion',
    payload: body,
    headers: { 'content-type': 'application/json', 'x-notion-signature': sign(body) },
  });
  assert.equal(unconfigured.statusCode, 503);
  assert.equal(setup.service().store.jobs().length, 0);
});

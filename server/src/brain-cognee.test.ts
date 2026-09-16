import assert from 'node:assert/strict';
import test from 'node:test';
import { CogneeClient } from './brain/cognee/client.js';
import { brainConfig } from './brain/config.js';

const firstDataset = '11111111-1111-4111-8111-111111111111';
const secondDataset = '22222222-2222-4222-8222-222222222222';
const chunkId = '33333333-3333-4333-8333-333333333333';
const entityId = '44444444-4444-4444-8444-444444444444';
const source = {
  id: 'notion-page',
  title: 'Specification',
  revision: 'revision-1',
  content: 'Do not send private shell arguments.',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function client(fetcher: typeof fetch) {
  return new CogneeClient({
    url: 'http://127.0.0.1:8000',
    token: 'test-service-token',
    fetch: fetcher,
  });
}

test('Cognee waits for indexing completion and preserves the exact uploaded text', async () => {
  const originalInterval = brainConfig.cognee.pollIntervalMs;
  brainConfig.cognee.pollIntervalMs = 1;
  let polls = 0;
  let adds = 0;
  const service = client(async (input, options) => {
    const url = new URL(String(input));
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer test-service-token');
    if (url.pathname === '/api/v1/datasets') {
      return json({ id: firstDataset, name: 'brain_revision_1' });
    }
    if (url.pathname === '/api/v1/datasets/status') {
      assert.equal(url.searchParams.get('dataset'), firstDataset);
      assert.equal(url.searchParams.get('pipeline'), 'cognify_pipeline');
      polls += 1;
      return json(
        polls === 1
          ? {}
          : {
              [firstDataset]:
                polls === 2 ? 'DATASET_PROCESSING_STARTED' : 'DATASET_PROCESSING_COMPLETED',
            },
      );
    }
    if (url.pathname === '/api/v1/add') {
      adds += 1;
      const body = options?.body as FormData;
      assert.equal(body.get('datasetId'), firstDataset);
      assert.equal(await (body.get('data') as Blob).text(), source.content);
      return json({ dataset_id: firstDataset, status: 'PipelineRunCompleted' });
    }
    assert.equal(url.pathname, '/api/v1/cognify');
    assert.deepEqual(JSON.parse(String(options?.body)).dataset_ids, [firstDataset]);
    return json({ [firstDataset]: { dataset_id: firstDataset, status: 'PipelineRunStarted' } });
  });
  try {
    assert.deepEqual(await service.index(source, 'brain_revision_1'), { datasetId: firstDataset });
    assert.equal(polls, 3);
    await service.index(source, 'brain_revision_1');
    assert.equal(adds, 1, 'an already indexed immutable capture must not be added again');
  } finally {
    brainConfig.cognee.pollIntervalMs = originalInterval;
  }
});

test('Cognee does not mark an errored or malformed pipeline as ready', async () => {
  let polls = 0;
  const service = client(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/v1/datasets') {
      return json({ id: firstDataset });
    }
    if (path === '/api/v1/datasets/status') {
      polls += 1;
      return json(polls === 1 ? {} : { [firstDataset]: 'DATASET_PROCESSING_ERRORED' });
    }
    if (path === '/api/v1/add') {
      return json({ dataset_id: firstDataset, status: 'PipelineRunCompleted' });
    }
    return json({ [firstDataset]: { dataset_id: firstDataset, status: 'PipelineRunStarted' } });
  });
  await assert.rejects(service.index(source, 'brain_revision_1'), /indexing failed/);
});

test('Cognee retrieves exact chunks only from explicit datasets and refuses unscoped results', async () => {
  let leak = false;
  let requests = 0;
  const service = client(async (_input, options) => {
    requests += 1;
    const body = JSON.parse(String(options?.body));
    assert.deepEqual(body.dataset_ids, [firstDataset]);
    assert.equal(body.search_type, 'CHUNKS');
    assert.equal(body.only_context, true);
    assert.equal(body.verbose, true);
    return json([
      {
        dataset_id: leak ? secondDataset : firstDataset,
        objects_result: [{ id: chunkId, payload: { text: source.content } }],
      },
    ]);
  });
  assert.deepEqual(await service.search('shell privacy', []), []);
  assert.equal(requests, 0, 'empty scope must never become an unfiltered Cognee search');
  assert.deepEqual(await service.search('shell privacy', [firstDataset]), [
    { datasetId: firstDataset, chunkId, text: source.content },
  ]);
  leak = true;
  await assert.rejects(service.search('shell privacy', [firstDataset]), /unscoped search/);
  const unscoped = client(async () => json([{ id: chunkId, text: source.content }]));
  await assert.rejects(unscoped.search('shell privacy', [firstDataset]), /invalid identifier/);
});

test('Cognee serializes service login and refreshes an expired bearer once', async () => {
  let logins = 0;
  let expired = false;
  const service = new CogneeClient({
    url: 'http://127.0.0.1:8000',
    token: '',
    username: 'brain@example.test',
    password: 'test-password',
    fetch: async (input, options) => {
      if (String(input).endsWith('/api/v1/auth/login')) {
        logins += 1;
        const form = options?.body as URLSearchParams;
        assert.equal(form.get('password'), 'test-password');
        return json({ access_token: `test-token-${logins}` });
      }
      const token = new Headers(options?.headers).get('Authorization');
      if (expired && token === 'Bearer test-token-1') {
        return json({ detail: 'provider detail must not escape' }, 401);
      }
      return json({ status: 'healthy' });
    },
  });
  const initial = await Promise.all([service.status(), service.status()]);
  assert.ok(initial.every((status) => status.available));
  assert.equal(logins, 1);
  expired = true;
  const refreshed = await Promise.all([service.status(), service.status()]);
  assert.ok(refreshed.every((status) => status.available));
  assert.equal(logins, 2);
});

test('Cognee graph retains dataset provenance and keeps repeated entity IDs separate', async () => {
  const service = client(async () =>
    json({
      nodes: [
        {
          id: chunkId,
          label: 'Chunk',
          type: 'DocumentChunk',
          properties: { text: source.content },
        },
        { id: entityId, label: 'Private arguments', type: 'Entity', properties: {} },
      ],
      edges: [{ source: chunkId, target: entityId, label: 'contains' }],
    }),
  );
  const graph = await service.graph([firstDataset, secondDataset]);
  assert.equal(graph.nodes.length, 4);
  assert.equal(new Set(graph.nodes.map((node) => node.id)).size, 4);
  assert.equal(graph.edges.length, 2);
  for (const edge of graph.edges) {
    assert.ok(edge.source.startsWith(edge.datasetId));
    assert.ok(edge.target.startsWith(edge.datasetId));
  }
});

test('Cognee surfaces authentication failures without leaking response details', async () => {
  const service = client(async () => json({ detail: 'secret-in-provider-output' }, 403));
  const status = await service.status();
  assert.equal(status.available, false);
  assert.match(status.reason ?? '', /authentication failed/);
  assert.ok(!status.reason?.includes('secret-in-provider-output'));
});

test('Cognee shutdown cancels unlimited indexing waits without marking the job ready', async () => {
  const service = client(async (input) => {
    if (new URL(String(input)).pathname === '/api/v1/datasets') {
      return json({ id: firstDataset });
    }
    return json({ [firstDataset]: 'DATASET_PROCESSING_STARTED' });
  });
  const indexing = service.index(source, 'brain_pending_revision');
  const rejection = assert.rejects(indexing, { name: 'AbortError' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  service.close();
  await rejection;
});

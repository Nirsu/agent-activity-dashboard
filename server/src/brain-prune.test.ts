import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MemoryStore } from './brain/memory/store.js';
import { pruneUnusedIndexes } from './brain/memory/prune.js';

const current = '11111111-1111-4111-8111-111111111111';
const obsolete = '22222222-2222-4222-8222-222222222222';
const foreign = '33333333-3333-4333-8333-333333333333';

test('pruning removes only obsolete bound indexes and preserves source captures and current datasets', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-prune-'));
  const store = new MemoryStore(resolve(root, 'brain.db'));
  await store.init();
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.saveSource({
    id: 'notion:page',
    kind: 'notion',
    title: 'Approved specification',
    approval: 'approved',
    status: 'ready',
    shared: true,
    mandatory: true,
    projectIds: [],
    datasetId: current,
  });
  await store.saveDataset('current', current);
  await store.saveDataset('old', obsolete);
  await store.saveDataset('old-alias', obsolete);
  const calls: string[] = [];
  const datasets = [current, obsolete, foreign].map((id) => ({
    id,
    name: `brain_${'a'.repeat(64)}`,
  }));
  const http = {
    request: async (path: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') {
        calls.push(path);
        return null;
      }
      return datasets;
    },
  };
  const before = store.sources();
  const plan = await pruneUnusedIndexes(store, http);
  assert.deepEqual(
    plan.obsolete.map((dataset) => dataset.id),
    [obsolete],
  );
  assert.equal(calls.length, 0);
  assert.equal(store.datasets().length, 3);
  await pruneUnusedIndexes(store, http, true);
  assert.deepEqual(calls, [`/api/v1/datasets/${obsolete}`]);
  assert.deepEqual(store.datasets(), [{ id: 'current', datasetId: current }]);
  assert.deepEqual(store.sources(), before);
});

test('pruning rejects pending sync and retains bindings when deletion fails', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-prune-failure-'));
  const store = new MemoryStore(resolve(root, 'brain.db'));
  await store.init();
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.saveDataset('old', obsolete);
  await assert.rejects(
    pruneUnusedIndexes(
      store,
      {
        request: async (_path, options) => {
          if (options?.method === 'DELETE') throw new Error('upstream failure');
          return [{ id: obsolete, name: `brain_${'a'.repeat(64)}` }];
        },
      },
      true,
    ),
    /upstream failure/,
  );
  assert.equal(store.dataset('old'), obsolete);
  await store.saveJob({
    id: 'queued',
    sourceId: 'page',
    status: 'queued',
    requestedAt: new Date().toISOString(),
    attempts: 0,
  });
  await assert.rejects(
    pruneUnusedIndexes(
      store,
      {
        request: async () => {
          throw new Error('must not query');
        },
      },
      true,
    ),
    /pending synchronization/,
  );
});

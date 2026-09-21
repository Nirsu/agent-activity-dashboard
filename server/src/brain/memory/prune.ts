import type { MemoryStore } from './store.js';
import type { CogneeHttp } from '../cognee/http.js';
import { identifier, record } from '../cognee/http.js';

/** Run with Brain stopped and its storage lock held. Current source bindings are protected. */
export async function pruneUnusedIndexes(
  store: Pick<MemoryStore, 'sources' | 'jobs' | 'datasets' | 'removeDataset'>,
  http: Pick<CogneeHttp, 'request'>,
  apply = false,
) {
  if (store.jobs().some((job) => job.status === 'queued' || job.status === 'running')) {
    throw new Error('Finish pending synchronization before pruning indexes.');
  }
  const current = new Set(
    store
      .sources()
      .map((source) => source.datasetId)
      .filter(Boolean),
  );
  const bindings = store.datasets();
  const remote = await http.request('/api/v1/datasets');
  if (!Array.isArray(remote)) {
    throw new Error('Cognee returned an invalid dataset inventory.');
  }
  const datasets = remote.map((value) => {
    const item = record(value);
    return { id: identifier(item.id), name: String(item.name) };
  });
  // Never touch unknown datasets, even if their names resemble Brain's datasets.
  const obsolete = datasets.filter(
    (dataset) =>
      /^brain_[a-f0-9]{64}$/.test(dataset.name) &&
      bindings.some((binding) => binding.datasetId === dataset.id) &&
      !current.has(dataset.id),
  );
  const missing = bindings.filter(
    (binding) =>
      !current.has(binding.datasetId) &&
      !datasets.some((dataset) => dataset.id === binding.datasetId),
  );
  if (apply) {
    for (const dataset of obsolete) {
      await http.request(`/api/v1/datasets/${dataset.id}`, { method: 'DELETE' });
      for (const binding of bindings.filter((binding) => binding.datasetId === dataset.id)) {
        await store.removeDataset(binding.id);
      }
    }
    for (const binding of missing) {
      await store.removeDataset(binding.id);
    }
  }
  return {
    applied: apply,
    retainedCurrent: current.size,
    obsolete,
    missingBindings: missing.length,
  };
}

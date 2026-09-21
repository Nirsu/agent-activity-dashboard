import { resolve } from 'node:path';
import { config } from '../server/dist/config.js';
import { BrainStorage } from '../server/dist/brain/persistence.js';
import { MemoryStore } from '../server/dist/brain/memory/store.js';
import { CogneeHttp } from '../server/dist/brain/cognee/http.js';
import { pruneUnusedIndexes } from '../server/dist/brain/memory/prune.js';
import { closePostgresPool } from '../server/dist/persistence/postgres.js';

const dbPath = process.env.BRAIN_DB_PATH ?? resolve(config.dataDir, 'brain.db');
const analyses = new BrainStorage(dbPath, ['brain_agent_runs'], 1);
const store = new MemoryStore(dbPath);
const http = new CogneeHttp();
try {
  if (process.argv.slice(2).some((arg) => arg !== '--apply')) {
    throw new Error('Usage: npm run brain:prune-index -- [--apply]');
  }
  // Maintenance is restricted to PostgreSQL, whose worker locks exclude live analyses/sync.
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'Index pruning requires PostgreSQL worker locks. Configure DATABASE_URL and stop Brain.',
    );
  }
  await analyses.init();
  await store.init();
  const result = await pruneUnusedIndexes(store, http, process.argv.includes('--apply'));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Index pruning failed.');
  process.exitCode = 1;
} finally {
  http.close();
  await store.close();
  await analyses.close();
  await closePostgresPool();
}

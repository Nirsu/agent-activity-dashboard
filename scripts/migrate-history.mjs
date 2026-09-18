#!/usr/bin/env node
// Run after building the server. Credentials are read from the environment.
import { resolve } from 'node:path';
import '../server/dist/config.js';
import { getPostgresPool, closePostgresPool } from '../server/dist/persistence/postgres.js';
import { migrateSqliteHistory } from '../server/dist/persistence/migrate-history.js';

const source = process.argv[2];
const sourceId = process.argv[3];
if (!source) {
  console.error('Usage: node scripts/migrate-history.mjs <history.db> [stable-source-id]');
  process.exitCode = 1;
} else {
  try {
    const pool = getPostgresPool();
    if (!pool) {
      throw new Error('DATABASE_URL is required for the PostgreSQL target.');
    }
    const result = await migrateSqliteHistory(resolve(source), pool, sourceId);
    console.log(JSON.stringify(result));
    if (result.legacyCheckpoints > 0) {
      console.log(
        'Legacy cumulative snapshots were archived. They cannot identify model-specific series and are not restored as current checkpoints.',
      );
    }
  } catch {
    // Do not include driver connection information or credentials in CLI output.
    console.error(
      'History migration failed. The SQLite source was left unchanged; the import can be retried with the same source ID.',
    );
    process.exitCode = 1;
  } finally {
    await closePostgresPool();
  }
}

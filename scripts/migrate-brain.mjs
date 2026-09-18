#!/usr/bin/env node
import { resolve } from 'node:path';
import '../server/dist/config.js';
import { migrateSqliteBrain } from '../server/dist/brain/migrate.js';
import { closePostgresPool } from '../server/dist/persistence/postgres.js';

const source = process.argv[2];
try {
  if (!source) {
    throw new Error('Usage: npm run db:migrate:brain -- <brain.db>');
  }
  console.log(JSON.stringify(await migrateSqliteBrain(resolve(source))));
} catch {
  console.error('Brain migration failed. Stop the server, verify the source path and PostgreSQL connection, then retry. The SQLite source remains unchanged.');
  process.exitCode = 1;
} finally {
  await closePostgresPool();
}

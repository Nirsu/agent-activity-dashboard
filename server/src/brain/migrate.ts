import { resolve } from 'node:path';
import Sqlite from 'better-sqlite3';
import { getPostgresPool } from '../persistence/postgres.js';
import type { BrainTable } from './persistence.js';

const tables: BrainTable[] = [
  'brain_agent_runs',
  'brain_activity_events',
  'brain_memory_sources',
  'brain_memory_captures',
  'brain_memory_jobs',
  'brain_memory_datasets',
  'brain_webhook_events',
];

/** Explicit, idempotent import. The original SQLite database is opened read-only. */
export async function migrateSqliteBrain(
  path: string,
): Promise<{ imported: number; skipped: number }> {
  const pool = getPostgresPool();
  if (!pool) {
    throw new Error('DATABASE_URL is required for Brain migration.');
  }
  const source = new Sqlite(resolve(path), { readonly: true, fileMustExist: true });
  const client = await pool.connect().catch((error) => {
    source.close();
    throw error;
  });
  const result = { imported: 0, skipped: 0 };
  try {
    for (const lock of [1, 2]) {
      const locked = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext(current_schema() || ':harmony-brain'), $1) AS locked",
        [lock],
      );
      if (!locked.rows[0].locked) {
        throw new Error('Stop the Brain server before migrating its database.');
      }
    }
    await client.query('BEGIN');
    for (const table of tables) {
      await client.query(`CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY, data JSONB NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        sequence BIGSERIAL UNIQUE NOT NULL
      )`);
      if (
        !source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
      ) {
        continue;
      }
      let rows: { id: string; data: string; revision: number }[];
      if (table === 'brain_memory_datasets') {
        rows = (
          source
            .prepare('SELECT capture_id,dataset_id FROM brain_memory_datasets ORDER BY rowid')
            .all() as { capture_id: string; dataset_id: string }[]
        ).map((row) => ({
          id: row.capture_id,
          data: JSON.stringify({ id: row.capture_id, datasetId: row.dataset_id }),
          revision: 1,
        }));
      } else if (table === 'brain_webhook_events') {
        rows = (
          source
            .prepare('SELECT id,received_at FROM brain_webhook_events ORDER BY rowid')
            .all() as { id: string; received_at: string }[]
        ).map((row) => ({
          id: row.id,
          data: JSON.stringify({ id: row.id, receivedAt: row.received_at }),
          revision: 1,
        }));
      } else {
        const columns = source.pragma(`table_info(${table})`) as { name: string }[];
        const revision = columns.some((column) => column.name === 'revision')
          ? 'revision'
          : '1 AS revision';
        rows = source
          .prepare(`SELECT id,data,${revision} FROM ${table} ORDER BY rowid`)
          .all() as typeof rows;
      }
      for (const row of rows) {
        const inserted = await client.query(
          `INSERT INTO ${table} (id,data,revision) VALUES ($1,$2::jsonb,$3) ON CONFLICT(id) DO NOTHING`,
          [row.id, row.data, row.revision],
        );
        if (inserted.rowCount) {
          result.imported++;
        } else {
          result.skipped++;
        }
      }
    }
    if (
      source
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='brain_records'")
        .get()
    ) {
      const captures = source
        .prepare("SELECT id,data FROM brain_records WHERE kind='source' ORDER BY rowid")
        .all() as { id: string; data: string }[];
      for (const capture of captures) {
        const inserted = await client.query(
          'INSERT INTO brain_memory_captures (id,data) VALUES ($1,$2::jsonb) ON CONFLICT(id) DO NOTHING',
          [capture.id, capture.data],
        );
        if (inserted.rowCount) {
          result.imported++;
        } else {
          result.skipped++;
        }
      }
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    const unlocked = await client
      .query(
        "SELECT pg_advisory_unlock(hashtext(current_schema() || ':harmony-brain'), 1), pg_advisory_unlock(hashtext(current_schema() || ':harmony-brain'), 2)",
      )
      .then(
        () => true,
        () => false,
      );
    client.release(!unlocked);
    source.close();
  }
}

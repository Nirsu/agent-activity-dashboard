import pg from 'pg';
import type { Pool } from 'pg';

let pool: Pool | null = null;
let configuredUrl: string | null = null;

/** The connection is lazy; applications without DATABASE_URL keep their SQLite mode. */
export function getPostgresPool(): Pool | null {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    return null;
  }
  if (pool && configuredUrl !== connectionString) {
    throw new Error('Close the PostgreSQL pool before changing DATABASE_URL.');
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    // An idle-client error must not become an uncaught EventEmitter exception.
    // Avoid logging connection details, which may contain credentials.
    pool.on('error', () => {
      console.error('[postgres] An idle database connection failed.');
    });
    configuredUrl = connectionString;
  }
  return pool;
}

/** Called by the application after all stores and queued writes have closed. */
export async function closePostgresPool(): Promise<void> {
  const previous = pool;
  pool = null;
  configuredUrl = null;
  if (previous) {
    await previous.end();
  }
}

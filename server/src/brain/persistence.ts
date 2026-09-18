import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import type { PoolClient } from 'pg';
import { getPostgresPool } from '../persistence/postgres.js';

export type BrainTable =
  | 'brain_agent_runs'
  | 'brain_activity_events'
  | 'brain_memory_sources'
  | 'brain_memory_captures'
  | 'brain_memory_jobs'
  | 'brain_memory_datasets'
  | 'brain_webhook_events';

type Entry = { id: string; data: string; revision: number };
type TransactionState = {
  records: Map<BrainTable, Map<string, Entry>>;
  afterCommit: (() => void)[];
};

/** PostgreSQL is authoritative. A lifetime lock permits one Brain worker and its read cache. */
export class BrainStorage {
  private sqlite?: Database.Database;
  private client?: PoolClient;
  private connectionFailed = false;
  private readonly connectionError = () => {
    this.connectionFailed = true;
  };
  private records = new Map<BrainTable, Map<string, Entry>>();
  private readonly context = new AsyncLocalStorage<TransactionState>();
  private transactions = Promise.resolve();
  private closing: Promise<void> | null = null;

  constructor(
    readonly path: string,
    private readonly tables: readonly BrainTable[],
    private readonly lock: number,
  ) {}

  async init() {
    const pool = getPostgresPool();
    if (pool) {
      this.client = await pool.connect();
      this.client.on('error', this.connectionError);
      try {
        const locked = await this.client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext(current_schema() || ':harmony-brain'), $1) AS locked",
          [this.lock],
        );
        if (!locked.rows[0].locked) {
          throw new Error(
            'Another Brain worker owns this PostgreSQL database. Run one Brain instance.',
          );
        }
        for (const table of this.tables) {
          await this.client.query(`CREATE TABLE IF NOT EXISTS ${table} (
            id TEXT PRIMARY KEY, data JSONB NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
            sequence BIGSERIAL UNIQUE NOT NULL
          )`);
          const rows = await this.client.query<{ id: string; data: unknown; revision: number }>(
            `SELECT id, data, revision FROM ${table} ORDER BY sequence ASC`,
          );
          this.records.set(
            table,
            new Map(
              rows.rows.map((row) => [
                row.id,
                {
                  id: row.id,
                  data: JSON.stringify(row.data),
                  revision: row.revision,
                },
              ]),
            ),
          );
        }
      } catch (error) {
        await this.client
          .query("SELECT pg_advisory_unlock(hashtext(current_schema() || ':harmony-brain'), $1)", [
            this.lock,
          ])
          .catch(() => {});
        this.client.off('error', this.connectionError);
        this.client.release();
        this.client = undefined;
        throw error;
      }
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const { default: Sqlite } = await import('better-sqlite3');
    this.sqlite = new Sqlite(this.path);
    this.sqlite.pragma('journal_mode = WAL');
    for (const table of this.tables) {
      if (table === 'brain_memory_datasets') {
        this.sqlite.exec(
          'CREATE TABLE IF NOT EXISTS brain_memory_datasets (capture_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL)',
        );
        continue;
      }
      if (table === 'brain_webhook_events') {
        this.sqlite.exec(
          'CREATE TABLE IF NOT EXISTS brain_webhook_events (id TEXT PRIMARY KEY, received_at TEXT NOT NULL)',
        );
        continue;
      }
      this.sqlite.exec(`CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
      )`);
      const columns = this.sqlite.pragma(`table_info(${table})`) as { name: string }[];
      if (!columns.some((column) => column.name === 'revision')) {
        this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`);
      }
    }
  }

  private healthy() {
    if (this.connectionFailed) {
      throw new Error(
        'Brain PostgreSQL worker connection was lost. Restart the server before continuing.',
      );
    }
  }

  entries<T>(table: BrainTable): { data: T; revision: number }[] {
    this.healthy();
    if (this.sqlite && table === 'brain_memory_datasets') {
      return (
        this.sqlite
          .prepare('SELECT capture_id, dataset_id FROM brain_memory_datasets ORDER BY rowid DESC')
          .all() as { capture_id: string; dataset_id: string }[]
      ).map((row) => ({
        data: { id: row.capture_id, datasetId: row.dataset_id } as T,
        revision: 1,
      }));
    }
    if (this.sqlite && table === 'brain_webhook_events') {
      return (
        this.sqlite
          .prepare('SELECT id, received_at FROM brain_webhook_events ORDER BY rowid DESC')
          .all() as { id: string; received_at: string }[]
      ).map((row) => ({ data: { id: row.id, receivedAt: row.received_at } as T, revision: 1 }));
    }
    const entries = this.sqlite
      ? (this.sqlite
          .prepare(`SELECT id, data, revision FROM ${table} ORDER BY rowid DESC`)
          .all() as Entry[])
      : [...(this.context.getStore()?.records ?? this.records).get(table)!.values()].reverse();
    return entries.map((entry) => ({
      data: JSON.parse(entry.data) as T,
      revision: entry.revision,
    }));
  }

  get<T>(table: BrainTable, id: string): T | undefined {
    this.healthy();
    if (this.sqlite && ['brain_memory_datasets', 'brain_webhook_events'].includes(table)) {
      return this.entries<T & { id: string }>(table).find((entry) => entry.data.id === id)?.data;
    }
    const row = this.sqlite
      ? (this.sqlite.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as Entry | undefined)
      : (this.context.getStore()?.records ?? this.records).get(table)!.get(id);
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  put(table: BrainTable, id: string, value: unknown, immutable = false): Promise<void> {
    this.healthy();
    const data = JSON.stringify(value);
    const operation = async () => {
      this.healthy();
      if (this.sqlite) {
        if (table === 'brain_memory_datasets') {
          this.sqlite
            .prepare(
              'INSERT INTO brain_memory_datasets VALUES (?,?) ON CONFLICT(capture_id) DO UPDATE SET dataset_id=excluded.dataset_id',
            )
            .run(id, (value as { datasetId: string }).datasetId);
          return;
        }
        if (table === 'brain_webhook_events') {
          this.sqlite
            .prepare('INSERT OR IGNORE INTO brain_webhook_events VALUES (?,?)')
            .run(id, (value as { receivedAt: string }).receivedAt);
          return;
        }
        this.sqlite
          .prepare(
            `INSERT INTO ${table} (id,data,revision) VALUES (?,?,1)
        ON CONFLICT(id) ${immutable ? 'DO NOTHING' : `DO UPDATE SET data=excluded.data,revision=${table}.revision+1`}`,
          )
          .run(id, data);
        return;
      }
      const result = await this.client!.query<{ revision: number }>(
        `INSERT INTO ${table} (id,data,revision) VALUES ($1,$2::jsonb,1)
         ON CONFLICT(id) ${immutable ? 'DO NOTHING' : `DO UPDATE SET data=excluded.data,revision=${table}.revision+1`}
         RETURNING revision`,
        [id, data],
      );
      if (result.rows.length) {
        (this.context.getStore()?.records ?? this.records)
          .get(table)!
          .set(id, { id, data, revision: result.rows[0].revision });
      }
    };
    return this.context.getStore() ? operation() : this.serialize(operation);
  }

  afterCommit(callback: () => void) {
    const transaction = this.context.getStore();
    if (transaction) {
      transaction.afterCommit.push(callback);
    } else {
      callback();
    }
  }

  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()) {
      return work();
    }
    return this.serialize(async () => {
      this.healthy();
      const state: TransactionState = {
        records: new Map([...this.records].map(([table, entries]) => [table, new Map(entries)])),
        afterCommit: [],
      };
      if (this.sqlite) {
        this.sqlite.exec('BEGIN IMMEDIATE');
      } else {
        await this.client!.query('BEGIN');
      }
      let result: T;
      try {
        result = await this.context.run(state, work);
        if (this.sqlite) {
          this.sqlite.exec('COMMIT');
        } else {
          await this.client!.query('COMMIT');
        }
        this.records = state.records;
      } catch (error) {
        if (this.sqlite) {
          this.sqlite.exec('ROLLBACK');
        } else {
          await this.client!.query('ROLLBACK').catch(() => {});
        }
        throw error;
      }
      for (const callback of state.afterCommit) {
        callback();
      }
      return result;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transactions.then(operation);
    this.transactions = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  legacyCapture<T>(id: string): T | undefined {
    if (
      !this.sqlite
        ?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='brain_records'")
        .get()
    ) {
      return undefined;
    }
    const row = this.sqlite
      .prepare("SELECT data FROM brain_records WHERE kind='source' AND id=?")
      .get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  close() {
    this.closing ??= this.closeStorage();
    return this.closing;
  }

  private async closeStorage() {
    await this.transactions;
    this.sqlite?.close();
    this.sqlite = undefined;
    if (this.client) {
      await this.client
        .query("SELECT pg_advisory_unlock(hashtext(current_schema() || ':harmony-brain'), $1)", [
          this.lock,
        ])
        .catch(() => {
          this.connectionFailed = true;
        });
      this.client.off('error', this.connectionError);
      this.client.release(this.connectionFailed);
      this.client = undefined;
    }
  }
}

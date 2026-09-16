import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import type { Source } from '../sources.js';
import type { SourceRegistration, SyncJob } from './types.js';

export class MemoryStore {
  private db!: Database.Database;

  constructor(readonly path: string) {}

  async init() {
    mkdirSync(dirname(this.path), { recursive: true });
    const { default: Sqlite } = await import('better-sqlite3');
    this.db = new Sqlite(this.path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS brain_memory_sources (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS brain_memory_captures (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS brain_memory_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS brain_webhook_events (id TEXT PRIMARY KEY, received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS brain_memory_datasets (capture_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL);
    `);
    for (const job of this.jobs()) {
      if (job.status === 'running') {
        this.saveJob({
          ...job,
          status: 'queued',
          error: 'Resuming synchronization after restart.',
        });
      }
    }
  }

  private records<T>(table: string): T[] {
    const rows = this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid DESC`).all() as {
      data: string;
    }[];
    return rows.map((row) => JSON.parse(row.data));
  }

  sources() {
    return this.records<SourceRegistration>('brain_memory_sources');
  }
  jobs() {
    return this.records<SyncJob>('brain_memory_jobs');
  }

  source(id: string) {
    const row = this.db.prepare('SELECT data FROM brain_memory_sources WHERE id=?').get(id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as SourceRegistration) : undefined;
  }

  capture(id: string): Source | undefined {
    const row = this.db.prepare('SELECT data FROM brain_memory_captures WHERE id=?').get(id) as
      { data: string } | undefined;
    if (row) {
      return JSON.parse(row.data);
    }
    // Keep exact historical demo captures readable after retiring its workflow.
    const legacy = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='brain_records'")
      .get();
    if (legacy) {
      const old = this.db
        .prepare("SELECT data FROM brain_records WHERE kind='source' AND id=?")
        .get(id) as { data: string } | undefined;
      if (old) {
        return JSON.parse(old.data);
      }
    }
    return undefined;
  }

  saveSource(source: SourceRegistration) {
    this.db
      .prepare(
        'INSERT INTO brain_memory_sources VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(source.id, JSON.stringify(source));
  }

  saveCapture(source: Source) {
    this.db
      .prepare('INSERT OR IGNORE INTO brain_memory_captures VALUES (?,?)')
      .run(source.id, JSON.stringify(source));
  }

  dataset(captureId: string) {
    const row = this.db
      .prepare('SELECT dataset_id FROM brain_memory_datasets WHERE capture_id=?')
      .get(captureId) as { dataset_id: string } | undefined;
    return row?.dataset_id;
  }

  saveDataset(captureId: string, datasetId: string) {
    this.db
      .prepare(
        'INSERT INTO brain_memory_datasets VALUES (?,?) ON CONFLICT(capture_id) DO UPDATE SET dataset_id=excluded.dataset_id',
      )
      .run(captureId, datasetId);
  }

  saveJob(job: SyncJob) {
    this.db
      .prepare(
        'INSERT INTO brain_memory_jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(job.id, JSON.stringify(job));
  }

  recordEvent(id: string, enqueue: () => void) {
    return this.db.transaction(() => {
      const inserted = this.db
        .prepare('INSERT OR IGNORE INTO brain_webhook_events VALUES (?,?)')
        .run(id, new Date().toISOString());
      if (inserted.changes) {
        enqueue();
      }
      return Boolean(inserted.changes);
    })();
  }

  close() {
    this.db.close();
  }
}

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { Pool } from 'pg';
import { History, type StoredUsage } from '../db.js';
import type { AgentEvent, CumulativeSnapshot } from '../types.js';

export interface HistoryMigrationResult {
  events: number;
  usage: number;
  checkpoints: number;
  legacyCheckpoints: number;
  sourceId: string;
}

type LegacyRow = Record<string, string | number | null>;

function tableNames(database: Database.Database): Set<string> {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** Row identifiers are namespaced; original numeric IDs remain in every identifier. */
export async function importLegacyRows(
  database: Database.Database,
  target: History,
  sourceId: string,
): Promise<HistoryMigrationResult> {
  const counts = { events: 0, usage: 0, checkpoints: 0, legacyCheckpoints: 0, sourceId };
  const tables = tableNames(database);
  if (tables.has('events')) {
    const rows = database.prepare('SELECT * FROM events ORDER BY id').all() as LegacyRow[];
    for (const row of rows) {
      const event: AgentEvent = {
        id: `${sourceId}:event:${row.id}`,
        ts: Number(row.ts),
        kind: row.kind as AgentEvent['kind'],
        subtype: (row.subtype ?? undefined) as AgentEvent['subtype'],
        provider: (row.provider ?? 'claude') as AgentEvent['provider'],
        client: (row.client ?? undefined) as AgentEvent['client'],
        sessionId: row.session_id == null ? undefined : String(row.session_id),
        agent: row.agent == null ? undefined : String(row.agent),
        teamId: row.team_id == null ? undefined : String(row.team_id),
        repo: row.repo == null ? undefined : String(row.repo),
        branch: row.branch == null ? undefined : String(row.branch),
        ticket: row.ticket == null ? undefined : String(row.ticket),
        toolName: row.tool_name == null ? undefined : String(row.tool_name),
        success: row.success == null ? undefined : Boolean(row.success),
        decision: (row.decision ?? undefined) as AgentEvent['decision'],
        durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
        statusCode: row.status_code == null ? undefined : Number(row.status_code),
      };
      if (await target.recordEvent(event)) {
        counts.events += 1;
      }
    }
  }
  if (tables.has('usage')) {
    const rows = database.prepare('SELECT * FROM usage ORDER BY id').all() as LegacyRow[];
    for (const row of rows) {
      const usage: StoredUsage = {
        usageId: `${sourceId}:usage:${row.id}`,
        source: 'legacy_sqlite',
        ts: Number(row.ts),
        provider: String(row.provider ?? 'claude'),
        client: (row.client ?? undefined) as StoredUsage['client'],
        sessionId: row.session_id == null ? undefined : String(row.session_id),
        agent: row.agent == null ? undefined : String(row.agent),
        teamId: row.team_id == null ? undefined : String(row.team_id),
        ticket: row.ticket == null ? undefined : String(row.ticket),
        dUsd: row.d_usd == null ? null : Number(row.d_usd),
        dTokensIn: row.d_tokens_in == null ? null : Number(row.d_tokens_in),
        dTokensOut: row.d_tokens_out == null ? null : Number(row.d_tokens_out),
        costStatus: row.d_usd == null ? 'unknown' : 'measured',
      };
      if (await target.recordUsage(usage)) {
        counts.usage += 1;
      }
    }
  }
  if (tables.has('cumulative')) {
    const rows = database
      .prepare('SELECT * FROM cumulative ORDER BY session_id')
      .all() as LegacyRow[];
    for (const row of rows) {
      if (await target.archiveLegacyCumulative(sourceId, String(row.session_id), row)) {
        counts.legacyCheckpoints += 1;
      }
    }
  }
  return counts;
}

/** Explicit, restartable SQLite → PostgreSQL import. The JSONL ledger is never read. */
export async function migrateSqliteHistory(
  sourcePath: string,
  pool: Pool,
  migrationSourceId?: string,
): Promise<HistoryMigrationResult> {
  const { default: SQLite } = await import('better-sqlite3');
  const absolutePath = resolve(sourcePath);
  const sourceId =
    migrationSourceId ??
    `sqlite-${createHash('sha256').update(absolutePath).digest('hex').slice(0, 16)}`;
  const source = new SQLite(absolutePath, { readonly: true, fileMustExist: true });
  const target = new History({ backend: 'postgres', pool, pruneOnInit: false });
  try {
    await target.init();
    // A read transaction gives a consistent source snapshot even in WAL mode.
    source.exec('BEGIN');
    const tables = tableNames(source);
    if (!tables.has('aad_history_usage')) {
      return await importLegacyRows(source, target, sourceId);
    }
    if (tables.has('usage') && tables.has('aad_history_migrations')) {
      const upgraded = source
        .prepare('SELECT source FROM aad_history_migrations WHERE source=?')
        .get('legacy-sqlite-local');
      if (!upgraded) {
        throw new Error(
          'The source SQLite history upgrade is incomplete. Complete its local startup before migration.',
        );
      }
    }
    const counts: HistoryMigrationResult = {
      sourceId,
      events: 0,
      usage: 0,
      checkpoints: 0,
      legacyCheckpoints: 0,
    };
    const events = source
      .prepare('SELECT data FROM aad_history_events ORDER BY ts,id')
      .all() as Array<{ data: string }>;
    for (const row of events) {
      if (await target.recordEvent(JSON.parse(row.data) as AgentEvent)) {
        counts.events += 1;
      }
    }
    const usage = source
      .prepare('SELECT data FROM aad_history_usage ORDER BY ts,source,usage_id')
      .all() as Array<{ data: string }>;
    for (const row of usage) {
      const observation = JSON.parse(row.data) as StoredUsage;
      if (await target.recordUsage(observation)) {
        counts.usage += 1;
      }
      if (observation.source === 'codex_logs' && observation.dedupeKeys?.length) {
        await target.recordUsageAliases({
          usageId: observation.usageId,
          dedupeKeys: observation.dedupeKeys,
          measurements: observation,
        });
      }
    }
    const checkpoints = source.prepare('SELECT data FROM aad_history_checkpoints').all() as Array<{
      data: string;
    }>;
    for (const row of checkpoints) {
      await target.recordCumulative(JSON.parse(row.data) as CumulativeSnapshot);
      counts.checkpoints += 1;
    }
    const legacy = source
      .prepare('SELECT source,session_id,data FROM aad_history_legacy_cumulative')
      .all() as Array<{ source: string; session_id: string; data: string }>;
    for (const row of legacy) {
      if (await target.archiveLegacyCumulative(row.source, row.session_id, JSON.parse(row.data))) {
        counts.legacyCheckpoints += 1;
      }
    }
    return counts;
  } finally {
    if (source.inTransaction) {
      source.exec('ROLLBACK');
    }
    source.close();
    await target.close();
  }
}

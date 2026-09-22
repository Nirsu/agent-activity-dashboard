// Normalized operational history. PostgreSQL is mandatory when configured;
// SQLite remains available for local compatibility and migration.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import type {
  AgentEvent,
  AgentProvider,
  ActivityTeam,
  CumulativeSnapshot,
  UsageAliasUpdate,
  UsageDelta,
} from './types.js';
import { config } from './config.js';
import { getPostgresPool } from './persistence/postgres.js';
import { PromptTracker, PROMPT_PAIR_WINDOW_MS } from './store/prompts.js';

export type { UsageDelta } from './types.js';
const directory = dirname(fileURLToPath(import.meta.url));
const COST_OBSERVATION = "COALESCE(metric_name, '') <> 'claude_code.token.usage'";
const TOKEN_OBSERVATION = "COALESCE(metric_name, '') <> 'claude_code.cost.usage'";

export interface HistoryOptions {
  backend?: 'postgres' | 'sqlite';
  databasePath?: string;
  pool?: Pool;
  retentionDays?: number;
  pruneOnInit?: boolean;
}

export interface HistoryTotals {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  costKnown: boolean;
  knownCostCount: number;
  tokensKnown: boolean;
  unknownUsageCount: number;
  usageCount: number;
  unattributedUsageCount: number;
  unattributedCostUsd: number;
}

interface TotalsRow {
  cost: number | string | null;
  input: number | string | null;
  output: number | string | null;
  known_cost: number | string;
  known_tokens: number | string;
  unknown_cost: number | string;
  usage_count: number | string;
  unattributed_count: number | string;
  unattributed_cost: number | string | null;
}

export type StoredUsage = Omit<UsageDelta, 'source'> & { source: string };

export function historyDay(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function document<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function totals(row?: TotalsRow): HistoryTotals {
  return {
    costUsd: Number(row?.cost ?? 0),
    tokensIn: Number(row?.input ?? 0),
    tokensOut: Number(row?.output ?? 0),
    costKnown: Number(row?.known_cost ?? 0) > 0,
    knownCostCount: Number(row?.known_cost ?? 0),
    tokensKnown: Number(row?.known_tokens ?? 0) > 0,
    unknownUsageCount: Number(row?.unknown_cost ?? 0),
    usageCount: Number(row?.usage_count ?? 0),
    unattributedUsageCount: Number(row?.unattributed_count ?? 0),
    unattributedCostUsd: Number(row?.unattributed_cost ?? 0),
  };
}

const TOTALS_SQL = `
  SUM(d_usd) AS cost, SUM(d_tokens_in) AS input, SUM(d_tokens_out) AS output,
  SUM(CASE WHEN d_usd IS NOT NULL THEN 1 ELSE 0 END) AS known_cost,
  SUM(CASE WHEN ${TOKEN_OBSERVATION} AND (d_tokens_in IS NOT NULL OR d_tokens_out IS NOT NULL) THEN 1 ELSE 0 END) AS known_tokens,
  SUM(CASE WHEN ${COST_OBSERVATION} AND d_usd IS NULL THEN 1 ELSE 0 END) AS unknown_cost,
  COUNT(*) AS usage_count,
  SUM(CASE WHEN ticket IS NULL AND work_item_id IS NULL THEN 1 ELSE 0 END) AS unattributed_count,
  SUM(CASE WHEN ticket IS NULL AND work_item_id IS NULL THEN d_usd ELSE 0 END) AS unattributed_cost`;

export class History {
  private sqlite: import('better-sqlite3').Database | null = null;
  private pool: Pool | null = null;
  private pruneTimer?: ReturnType<typeof setInterval>;
  enabled = false;
  backend: 'postgres' | 'sqlite' | 'disabled' = 'disabled';

  constructor(private readonly options: HistoryOptions = {}) {}

  get storageKind(): 'postgresql' | 'sqlite' | 'disabled' {
    return this.backend === 'postgres' ? 'postgresql' : this.backend;
  }

  async init(): Promise<void> {
    if (this.enabled) {
      return;
    }
    const requested = this.options.backend ?? process.env.HISTORY_BACKEND;
    const usePostgres =
      requested === 'postgres' ||
      (requested !== 'sqlite' && (this.options.pool || process.env.DATABASE_URL?.trim()));
    if (usePostgres) {
      this.pool = this.options.pool ?? getPostgresPool();
      if (!this.pool) {
        throw new Error('PostgreSQL history requires DATABASE_URL.');
      }
      // Never silently discard persistence because a configured database is down.
      await this.pool.query(this.schema('JSONB', 'DOUBLE PRECISION'));
      this.backend = 'postgres';
    } else {
      try {
        const { default: Database } = await import('better-sqlite3');
        const path =
          this.options.databasePath ??
          process.env.DB_PATH ??
          resolve(directory, '../data/history.db');
        mkdirSync(dirname(path), { recursive: true });
        this.sqlite = new Database(path);
        this.sqlite.pragma('journal_mode = WAL');
        this.sqlite.exec(this.schema('TEXT', 'REAL'));
        this.backend = 'sqlite';
      } catch {
        this.sqlite?.close();
        this.sqlite = null;
        console.error('[history] SQLite persistence is unavailable.');
        return;
      }
    }
    this.enabled = true;
    if (this.sqlite) {
      await this.upgradeLegacySqlite();
    }
    if (this.options.pruneOnInit !== false) {
      await this.prune();
      this.pruneTimer = setInterval(() => {
        void this.prune().catch(() => console.error('[history] Retention cleanup failed.'));
      }, 3_600_000);
      this.pruneTimer.unref();
    }
  }

  private schema(jsonType: string, numericType: string): string {
    return `
      CREATE TABLE IF NOT EXISTS aad_history_events (
        id TEXT PRIMARY KEY, ts BIGINT NOT NULL, day TEXT NOT NULL,
        kind TEXT, subtype TEXT, provider TEXT, session_id TEXT, agent TEXT,
        team_id TEXT, data ${jsonType} NOT NULL
      );
      CREATE INDEX IF NOT EXISTS aad_history_events_day ON aad_history_events(day);
      CREATE INDEX IF NOT EXISTS aad_history_events_agent ON aad_history_events(agent, ts);
      CREATE TABLE IF NOT EXISTS aad_history_usage (
        source TEXT NOT NULL, usage_id TEXT NOT NULL, ts BIGINT NOT NULL, day TEXT NOT NULL,
        provider TEXT, session_id TEXT, agent TEXT, team_id TEXT, ticket TEXT,
        work_item_id TEXT, project_id TEXT, run_id TEXT, metric_name TEXT,
        d_usd ${numericType}, d_tokens_in ${numericType}, d_tokens_out ${numericType},
        cost_status TEXT NOT NULL, data ${jsonType} NOT NULL,
        PRIMARY KEY (source, usage_id)
      );
      CREATE INDEX IF NOT EXISTS aad_history_usage_day ON aad_history_usage(day);
      CREATE INDEX IF NOT EXISTS aad_history_usage_agent ON aad_history_usage(agent, ts);
      CREATE INDEX IF NOT EXISTS aad_history_usage_work ON aad_history_usage(work_item_id, ts);
      CREATE TABLE IF NOT EXISTS aad_history_checkpoints (
        series_key TEXT PRIMARY KEY, ts BIGINT NOT NULL, data ${jsonType} NOT NULL
      );
      CREATE TABLE IF NOT EXISTS aad_history_legacy_cumulative (
        source TEXT NOT NULL, session_id TEXT NOT NULL, data ${jsonType} NOT NULL,
        PRIMARY KEY (source, session_id)
      );
      CREATE TABLE IF NOT EXISTS aad_history_migrations (
        source TEXT PRIMARY KEY, completed_at BIGINT NOT NULL
      );`;
  }

  async close(): Promise<void> {
    clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
    this.enabled = false;
    this.sqlite?.close();
    this.sqlite = null;
    // The application owns the shared pool and closes it after all stores.
    this.pool = null;
    this.backend = 'disabled';
  }

  private postgresSql(sql: string): string {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  }

  private async rows<T>(sql: string, values: unknown[] = []): Promise<T[]> {
    if (this.pool) {
      const result = await this.pool.query(this.postgresSql(sql), values);
      return result.rows as T[];
    }
    return this.sqlite!.prepare(sql).all(...values) as T[];
  }

  private async execute(sql: string, values: unknown[], client?: PoolClient): Promise<number> {
    if (client || this.pool) {
      const result = await (client ?? this.pool!).query(this.postgresSql(sql), values);
      return result.rowCount ?? 0;
    }
    return this.sqlite!.prepare(sql).run(...values).changes;
  }

  async recordEvent(event: AgentEvent): Promise<boolean> {
    if (!this.enabled || event.kind === 'metric') {
      return false;
    }
    // Select safe fields explicitly rather than persisting transport envelopes.
    const safeEvent = {
      id: event.id,
      ts: event.ts,
      kind: event.kind,
      subtype: event.subtype,
      provider: event.provider,
      client: event.client,
      sessionId: event.sessionId,
      rawSessionId: event.rawSessionId,
      promptId: event.promptId,
      requestId: event.requestId,
      responseId: event.responseId,
      projectId: event.projectId,
      workItemId: event.workItemId,
      runId: event.runId,
      parentRunId: event.parentRunId,
      model: event.model,
      agent: event.agent,
      teamId: event.teamId,
      teams: event.teams,
      repo: event.repo,
      branch: event.branch,
      ticket: event.ticket,
      toolName: event.toolName,
      success: event.success,
      decision: event.decision,
      durationMs: event.durationMs,
      statusCode: event.statusCode,
    };
    const inserted = await this.execute(
      `INSERT INTO aad_history_events
      (id,ts,day,kind,subtype,provider,session_id,agent,team_id,data)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      [
        `${event.provider}:${event.id}`,
        event.ts,
        historyDay(event.ts),
        event.kind,
        event.subtype ?? null,
        event.provider,
        event.sessionId ?? null,
        event.agent ?? null,
        event.teamId ?? null,
        JSON.stringify(safeEvent),
      ],
    );
    return inserted > 0;
  }

  async recordUsage(usage: StoredUsage): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }
    const write = async (client?: PoolClient): Promise<boolean> => {
      const inserted = await this.execute(
        `INSERT INTO aad_history_usage
        (source,usage_id,ts,day,provider,session_id,agent,team_id,ticket,work_item_id,project_id,run_id,
         metric_name,d_usd,d_tokens_in,d_tokens_out,cost_status,data)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,usage_id) DO NOTHING`,
        [
          usage.source,
          usage.usageId,
          usage.ts,
          historyDay(usage.ts),
          usage.provider,
          usage.sessionId ?? null,
          usage.agent ?? null,
          usage.teamId ?? null,
          usage.ticket ?? null,
          usage.workItemId ?? null,
          usage.projectId ?? null,
          usage.runId ?? null,
          usage.metricName ?? null,
          usage.dUsd,
          usage.dTokensIn,
          usage.dTokensOut,
          usage.costStatus,
          JSON.stringify(usage),
        ],
        client,
      );
      if (inserted && usage.cumulative) {
        await this.writeCheckpoint(usage.cumulative, client);
      }
      return inserted > 0;
    };
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await write(client);
        await client.query('COMMIT');
        return inserted;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    // Application writes are serialized so no other write can interleave here.
    this.sqlite!.exec('BEGIN IMMEDIATE');
    try {
      const inserted = await write();
      this.sqlite!.exec('COMMIT');
      return inserted;
    } catch (error) {
      this.sqlite!.exec('ROLLBACK');
      throw error;
    }
  }

  private async writeCheckpoint(snapshot: CumulativeSnapshot, client?: PoolClient): Promise<void> {
    await this.execute(
      `INSERT INTO aad_history_checkpoints (series_key,ts,data) VALUES (?,?,?)
      ON CONFLICT(series_key) DO UPDATE SET ts=excluded.ts,data=excluded.data
      WHERE excluded.ts >= aad_history_checkpoints.ts`,
      [snapshot.seriesKey, snapshot.ts, JSON.stringify(snapshot)],
      client,
    );
  }

  async recordCumulative(snapshot: CumulativeSnapshot): Promise<void> {
    if (this.enabled) {
      await this.writeCheckpoint(snapshot);
    }
  }

  async loadCumulative(): Promise<Map<string, CumulativeSnapshot>> {
    const snapshots = new Map<string, CumulativeSnapshot>();
    if (this.enabled) {
      const rows = await this.rows<{ series_key: string; data: CumulativeSnapshot | string }>(
        'SELECT series_key,data FROM aad_history_checkpoints',
      );
      for (const row of rows) {
        snapshots.set(row.series_key, document(row.data));
      }
    }
    return snapshots;
  }

  async loadUsageIds(): Promise<string[]> {
    return [...(await this.loadUsageIdentityMap()).keys()];
  }

  async loadUsageIdentityMap(): Promise<Map<string, string>> {
    const identities = new Map<string, string>();
    if (!this.enabled) {
      return identities;
    }
    const rows = await this.rows<{ usage_id: string; data: StoredUsage | string }>(
      'SELECT usage_id,data FROM aad_history_usage',
    );
    for (const row of rows) {
      identities.set(row.usage_id, row.usage_id);
      for (const alias of document(row.data).dedupeKeys ?? []) {
        identities.set(alias, row.usage_id);
      }
    }
    return identities;
  }

  async loadRequestUsage(): Promise<UsageDelta[]> {
    if (!this.enabled) {
      return [];
    }
    const rows = await this.rows<{ data: UsageDelta | string }>(
      "SELECT data FROM aad_history_usage WHERE source='codex_logs'",
    );
    return rows.map((row) => document(row.data));
  }

  /** Complete usage and correct derived costs without adding another row. */
  async recordUsageAliases(update: UsageAliasUpdate): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const merge = (value: StoredUsage | string): StoredUsage => {
      const stored = document(value);
      const reviseCost =
        update.measurements?.costOrigin !== undefined &&
        (stored.dUsd === null || stored.costOrigin === 'model');
      const dUsd = reviseCost
        ? update.measurements!.dUsd
        : (stored.dUsd ?? update.measurements?.dUsd ?? null);
      return {
        ...stored,
        dedupeKeys: [...new Set([...(stored.dedupeKeys ?? []), ...update.dedupeKeys])],
        dUsd,
        dTokensIn: stored.dTokensIn ?? update.measurements?.dTokensIn ?? null,
        dTokensOut: stored.dTokensOut ?? update.measurements?.dTokensOut ?? null,
        cachedInputTokens: stored.cachedInputTokens ?? update.measurements?.cachedInputTokens,
        model: stored.model ?? update.measurements?.model,
        costOrigin: reviseCost ? update.measurements!.costOrigin : stored.costOrigin,
        costStatus:
          dUsd === null ? 'unknown' : stored.costStatus === 'measured' ? 'measured' : 'estimated',
      };
    };
    const sql =
      "UPDATE aad_history_usage SET data=?, d_usd=?, d_tokens_in=?, d_tokens_out=?, cost_status=? WHERE source='codex_logs' AND usage_id=?";
    const values = (stored: StoredUsage) => [
      JSON.stringify(stored),
      stored.dUsd,
      stored.dTokensIn,
      stored.dTokensOut,
      stored.costStatus,
      update.usageId,
    ];
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
          "SELECT data FROM aad_history_usage WHERE source='codex_logs' AND usage_id=$1 FOR UPDATE",
          [update.usageId],
        );
        if (result.rowCount !== 1) {
          throw new Error('The canonical usage must be persisted before its aliases.');
        }
        await this.execute(sql, values(merge(result.rows[0].data)), client);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return;
    }
    this.sqlite!.transaction(() => {
      const row = this.sqlite!.prepare(
        "SELECT data FROM aad_history_usage WHERE source='codex_logs' AND usage_id=?",
      ).get(update.usageId) as { data: string } | undefined;
      if (!row) {
        throw new Error('The canonical usage must be persisted before its aliases.');
      }
      this.sqlite!.prepare(sql).run(...values(merge(row.data)));
    })();
  }

  async exportUsage(window: { since?: number; until?: number } = {}): Promise<StoredUsage[]> {
    if (!this.enabled) {
      return [];
    }
    const rows = await this.rows<{ data: StoredUsage | string }>(
      `SELECT data FROM aad_history_usage
      WHERE ts>=? AND ts<? ORDER BY ts,source,usage_id`,
      [window.since ?? 0, window.until ?? Number.MAX_SAFE_INTEGER],
    );
    return rows.map((row) => document(row.data));
  }

  async loadSessionTotals(): Promise<Map<string, HistoryTotals>> {
    const result = new Map<string, HistoryTotals>();
    if (this.enabled) {
      const rows = await this.rows<
        TotalsRow & { session_id: string }
      >(`SELECT session_id, ${TOTALS_SQL}
        FROM aad_history_usage WHERE session_id IS NOT NULL GROUP BY session_id`);
      for (const row of rows) {
        result.set(row.session_id, totals(row));
      }
    }
    return result;
  }

  async todayTotals(provider?: AgentProvider): Promise<HistoryTotals> {
    if (!this.enabled) {
      return totals();
    }
    const [row] = await this.rows<TotalsRow>(
      `SELECT ${TOTALS_SQL} FROM aad_history_usage WHERE day=?${provider ? ' AND provider=?' : ''}`,
      provider ? [historyDay(Date.now()), provider] : [historyDay(Date.now())],
    );
    return totals(row);
  }

  async loadPromptEvents(since: number, until = Number.MAX_SAFE_INTEGER): Promise<AgentEvent[]> {
    if (!this.enabled) {
      return [];
    }
    const rows = await this.rows<{ data: AgentEvent | string }>(
      `SELECT data FROM aad_history_events WHERE ts>=? AND ts<?
       AND (kind='user_prompt' OR (kind='activity' AND subtype='prompt_submit')) ORDER BY ts,id`,
      [since, until],
    );
    return rows.map((row) => document(row.data));
  }

  private async teamTotals(
    since: string,
    until: string,
    legacyTeamAliases: ReadonlyMap<string, ActivityTeam>,
  ) {
    // Expand memberships only for per-team views. Global totals read the original ledger once.
    const memberships = this.pool
      ? `CASE WHEN jsonb_typeof(data->'teams') = 'array' THEN
          CASE WHEN jsonb_array_length(data->'teams') > 0 THEN data->'teams'
            ELSE jsonb_build_array(jsonb_build_object('id','unassigned','name','No team')) END
          ELSE jsonb_build_array(jsonb_build_object('id',COALESCE(team_id,'unassigned'),
            'name',COALESCE(team_id,'No team'))) END`
      : `CASE WHEN json_type(data,'$.teams') = 'array' THEN
          CASE WHEN json_array_length(data,'$.teams') > 0 THEN json_extract(data,'$.teams')
            ELSE json_array(json_object('id','unassigned','name','No team')) END
          ELSE json_array(json_object('id',COALESCE(team_id,'unassigned'),
            'name',COALESCE(team_id,'No team'))) END`;
    const expanded = this.pool
      ? `jsonb_array_elements(memberships) AS membership(value)`
      : `json_each(memberships) AS membership`;
    const id = this.pool ? `membership.value->>'id'` : `json_extract(membership.value,'$.id')`;
    const name = this.pool
      ? `membership.value->>'name'`
      : `json_extract(membership.value,'$.name')`;
    const hasMemberships = this.pool
      ? `jsonb_typeof(data->'teams') = 'array'`
      : `json_type(data,'$.teams') = 'array'`;
    const rows = await this.rows<
      TotalsRow & { team_id: string; team_name: string; last_seen: number; legacy_team: number }
    >(
      `WITH scoped AS (
        SELECT *, ${memberships} AS memberships,
          CASE WHEN ${hasMemberships} THEN 0 WHEN team_id IS NOT NULL THEN 1 ELSE 0 END AS legacy_team
        FROM aad_history_usage WHERE day>=? AND day<=?
      ) SELECT ${id} AS team_id, ${name} AS team_name, legacy_team, MAX(ts) AS last_seen, ${TOTALS_SQL}
        FROM scoped CROSS JOIN ${expanded} GROUP BY ${id}, ${name}, legacy_team`,
      [since, until],
    );
    // A rename retains its stable ID; use the most recently observed display name.
    const teams = new Map<
      string,
      { teamId: string; teamName: string; lastSeen: number } & HistoryTotals
    >();
    for (const row of rows) {
      const alias = row.legacy_team
        ? legacyTeamAliases.get(row.team_id.trim().toLowerCase())
        : undefined;
      const teamId = alias?.id ?? row.team_id;
      const teamName = alias?.name ?? row.team_name;
      const current = teams.get(teamId);
      const next = totals(row);
      if (!current) {
        teams.set(teamId, {
          teamId,
          teamName,
          lastSeen: Number(row.last_seen),
          ...next,
        });
        continue;
      }
      if (Number(row.last_seen) >= current.lastSeen) {
        current.teamName = teamName;
        current.lastSeen = Number(row.last_seen);
      }
      for (const key of Object.keys(next) as Array<keyof HistoryTotals>) {
        if (key === 'costKnown' || key === 'tokensKnown') {
          current[key] ||= next[key];
        } else {
          current[key] += next[key];
        }
      }
    }
    return [...teams.values()]
      .sort((left, right) => right.costUsd - left.costUsd)
      .map(({ lastSeen: _lastSeen, ...team }) => ({
        ...team,
        tokens: team.tokensIn + team.tokensOut,
      }));
  }

  async trends(
    requestedDays: number,
    legacyTeamAliases: ReadonlyMap<string, ActivityTeam> = new Map(),
  ): Promise<unknown> {
    if (!this.enabled) {
      return { enabled: false, backend: this.backend, days: [], byStream: [] };
    }
    const days = Math.max(1, Math.min(90, Math.trunc(requestedDays) || 14));
    const dates = Array.from({ length: days }, (_, index) => {
      const date = new Date();
      date.setDate(date.getDate() - (days - 1 - index));
      return historyDay(date.getTime());
    });
    const since = dates[0];
    const until = dates[dates.length - 1];
    const [usage, activity, streams, promptEvents] = await Promise.all([
      this.rows<TotalsRow & { day: string }>(
        `SELECT day,${TOTALS_SQL} FROM aad_history_usage WHERE day>=? AND day<=? GROUP BY day`,
        [since, until],
      ),
      this.rows<{ day: string; sessions: string | number }>(
        `SELECT day,
        COUNT(DISTINCT session_id) AS sessions FROM aad_history_events WHERE day>=? AND day<=? GROUP BY day`,
        [since, until],
      ),
      this.teamTotals(since, until, legacyTeamAliases),
      this.loadPromptEvents(new Date(`${since}T00:00:00`).getTime() - PROMPT_PAIR_WINDOW_MS),
    ]);
    const mapped = new Map(
      dates.map((day) => [day, { day, ...totals(), prompts: 0, sessions: 0 }]),
    );
    for (const row of usage) {
      Object.assign(mapped.get(row.day)!, totals(row));
    }
    for (const row of activity) {
      Object.assign(mapped.get(row.day)!, {
        sessions: Number(row.sessions),
      });
    }
    const prompts = new PromptTracker();
    for (const event of promptEvents) {
      prompts.record(event);
    }
    for (const prompt of prompts.values()) {
      const day = mapped.get(historyDay(prompt.ts));
      if (day) {
        day.prompts++;
      }
    }
    return {
      enabled: true,
      backend: this.backend,
      days: [...mapped.values()],
      byStream: streams,
    };
  }

  async agentHistory(agent: string, requestedLimit = 200): Promise<unknown> {
    if (!this.enabled) {
      return { enabled: false };
    }
    const limit = Math.max(1, Math.min(1000, Math.trunc(requestedLimit) || 200));
    const [events, usage] = await Promise.all([
      this.rows<{ data: AgentEvent | string }>(
        'SELECT data FROM aad_history_events WHERE agent=? ORDER BY ts DESC LIMIT ?',
        [agent, limit],
      ),
      this.rows<TotalsRow & { sessions: string | number }>(
        `SELECT ${TOTALS_SQL}, COUNT(DISTINCT session_id) AS sessions FROM aad_history_usage WHERE agent=?`,
        [agent],
      ),
    ]);
    const summary = totals(usage[0]);
    return {
      enabled: true,
      backend: this.backend,
      agent,
      totals: {
        ...summary,
        tokens: summary.tokensIn + summary.tokensOut,
        sessions: Number(usage[0]?.sessions ?? 0),
      },
      events: events.map((row) => document(row.data)),
    };
  }

  /** Preserve legacy baselines without inventing model-specific series. */
  async archiveLegacyCumulative(
    source: string,
    sessionId: string,
    value: unknown,
  ): Promise<boolean> {
    const inserted = await this.execute(
      `INSERT INTO aad_history_legacy_cumulative (source,session_id,data)
      VALUES (?,?,?) ON CONFLICT(source,session_id) DO NOTHING`,
      [source, sessionId, JSON.stringify(value)],
    );
    return inserted > 0;
  }

  private async upgradeLegacySqlite(): Promise<void> {
    const tables = this.sqlite!.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all() as Array<{ name: string }>;
    if (!tables.some((table) => table.name === 'usage')) {
      return;
    }
    const completed = this.sqlite!.prepare(
      'SELECT source FROM aad_history_migrations WHERE source=?',
    ).get('legacy-sqlite-local');
    if (completed) {
      return;
    }
    // Upgrade local SQLite history, retaining original tables. PostgreSQL never
    // imports a different database automatically.
    const { importLegacyRows } = await import('./persistence/migrate-history.js');
    await importLegacyRows(this.sqlite!, this, 'legacy-sqlite-local');
    this.sqlite!.prepare(
      'INSERT INTO aad_history_migrations(source,completed_at) VALUES (?,?)',
    ).run('legacy-sqlite-local', Date.now());
  }

  private async prune(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const cutoff = Date.now() - (this.options.retentionDays ?? config.retentionDays) * 86_400_000;
    for (const table of ['aad_history_events', 'aad_history_usage', 'aad_history_checkpoints']) {
      await this.execute(`DELETE FROM ${table} WHERE ts < ?`, [cutoff]);
    }
  }
}

export const history = new History();

// SQLite-backed history for trends + per-agent timelines that survive restarts.
// Privacy-safe: stores only normalized, pseudonymized events (no email, no
// prompt/tool content). Retention capped at RETENTION_DAYS (default 60).
//
// Degrades gracefully: if better-sqlite3 can't load, everything becomes a no-op
// and the dashboard runs memory-only (endpoints report enabled:false).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import type { AgentClient, AgentEvent, AgentProvider } from './types.js';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? resolve(__dirname, '../data/history.db');

export interface UsageDelta {
  ts: number;
  sessionId?: string;
  agent?: string;
  teamId?: string;
  ticket?: string;
  provider?: AgentProvider;
  client?: AgentClient;
  dUsd: number;
  dTokensIn: number;
  dTokensOut: number;
}

function localDay(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

class History {
  private db: import('better-sqlite3').Database | null = null;
  private pruneTimer?: ReturnType<typeof setInterval>;
  enabled = false;
  private insEvent?: import('better-sqlite3').Statement;
  private insUsage?: import('better-sqlite3').Statement;
  private upsertCum?: import('better-sqlite3').Statement;

  async init(): Promise<void> {
    try {
      const { default: Database } = await import('better-sqlite3');
      mkdirSync(dirname(DB_PATH), { recursive: true });
      const db = new Database(DB_PATH);
      db.pragma('journal_mode = WAL');
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL, day TEXT NOT NULL,
          kind TEXT, subtype TEXT,
          provider TEXT NOT NULL DEFAULT 'claude', client TEXT,
          session_id TEXT, agent TEXT, team_id TEXT,
          repo TEXT, branch TEXT, ticket TEXT,
          tool_name TEXT, success INTEGER, decision TEXT,
          duration_ms INTEGER, status_code INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
        CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent, ts);
        CREATE INDEX IF NOT EXISTS idx_events_day ON events(day);

        CREATE TABLE IF NOT EXISTS usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL, day TEXT NOT NULL,
          provider TEXT NOT NULL DEFAULT 'claude', client TEXT,
          session_id TEXT, agent TEXT, team_id TEXT, ticket TEXT,
          d_usd REAL, d_tokens_in INTEGER, d_tokens_out INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_usage_day ON usage(day);
        CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage(agent, ts);

        -- Per-session cumulative metric snapshot, so cost/token deltas stay
        -- correct across a restart (Claude Code emits cumulative sums).
        CREATE TABLE IF NOT EXISTS cumulative (
          session_id TEXT PRIMARY KEY,
          cost REAL, tokens_json TEXT, ts INTEGER
        );
      `);
      const eventColumns = new Set(
        (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map((column) => column.name),
      );
      if (!eventColumns.has('provider')) {
        db.exec("ALTER TABLE events ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'");
      }
      if (!eventColumns.has('client')) {
        db.exec('ALTER TABLE events ADD COLUMN client TEXT');
      }
      const usageColumns = new Set(
        (db.prepare('PRAGMA table_info(usage)').all() as Array<{ name: string }>).map((column) => column.name),
      );
      if (!usageColumns.has('provider')) {
        db.exec("ALTER TABLE usage ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'");
      }
      if (!usageColumns.has('client')) {
        db.exec('ALTER TABLE usage ADD COLUMN client TEXT');
      }
      this.insEvent = db.prepare(`INSERT INTO events
        (ts,day,kind,subtype,provider,client,session_id,agent,team_id,repo,branch,ticket,tool_name,success,decision,duration_ms,status_code)
        VALUES (@ts,@day,@kind,@subtype,@provider,@client,@session_id,@agent,@team_id,@repo,@branch,@ticket,@tool_name,@success,@decision,@duration_ms,@status_code)`);
      this.insUsage = db.prepare(`INSERT INTO usage
        (ts,day,provider,client,session_id,agent,team_id,ticket,d_usd,d_tokens_in,d_tokens_out)
        VALUES (@ts,@day,@provider,@client,@session_id,@agent,@team_id,@ticket,@d_usd,@d_tokens_in,@d_tokens_out)`);
      this.upsertCum = db.prepare(`INSERT INTO cumulative (session_id,cost,tokens_json,ts)
        VALUES (@session_id,@cost,@tokens_json,@ts)
        ON CONFLICT(session_id) DO UPDATE SET cost=@cost, tokens_json=@tokens_json, ts=@ts`);
      this.db = db;
      this.enabled = true;
      this.prune();
      this.pruneTimer = setInterval(() => this.prune(), 3_600_000);
      this.pruneTimer.unref();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[history] persistence disabled:', (err as Error).message);
      this.enabled = false;
    }
  }

  close(): void {
    clearInterval(this.pruneTimer);
    this.enabled = false;
    this.db?.close();
    this.db = null;
  }

  recordEvent(e: AgentEvent): void {
    if (!this.enabled || e.kind === 'metric') return; // metrics tracked via usage deltas
    this.insEvent!.run({
      ts: e.ts, day: localDay(e.ts),
      kind: e.kind, subtype: e.subtype ?? null,
      provider: e.provider, client: e.client ?? null,
      session_id: e.sessionId ?? null, agent: e.agent ?? null, team_id: e.teamId ?? null,
      repo: e.repo ?? null, branch: e.branch ?? null, ticket: e.ticket ?? null,
      tool_name: e.toolName ?? null, success: e.success == null ? null : e.success ? 1 : 0,
      decision: e.decision ?? null, duration_ms: e.durationMs ?? null, status_code: e.statusCode ?? null,
    });
  }

  recordUsage(u: UsageDelta): void {
    if (!this.enabled) return;
    this.insUsage!.run({
      ts: u.ts, day: localDay(u.ts),
      provider: u.provider ?? 'claude', client: u.client ?? null,
      session_id: u.sessionId ?? null, agent: u.agent ?? null, team_id: u.teamId ?? null,
      ticket: u.ticket ?? null, d_usd: u.dUsd, d_tokens_in: u.dTokensIn, d_tokens_out: u.dTokensOut,
    });
  }

  recordCumulative(sessionId: string, cost: number, tokens: Record<string, number>, ts: number): void {
    if (!this.enabled) return;
    this.upsertCum!.run({ session_id: sessionId, cost, tokens_json: JSON.stringify(tokens), ts });
  }

  /** Restore per-session cumulative snapshots so restart deltas stay correct. */
  loadCumulative(): Map<string, { cost: number; tokens: Record<string, number> }> {
    const map = new Map<string, { cost: number; tokens: Record<string, number> }>();
    if (!this.enabled) return map;
    const rows = this.db!.prepare('SELECT session_id, cost, tokens_json FROM cumulative').all() as Array<{
      session_id: string; cost: number; tokens_json: string;
    }>;
    for (const r of rows) {
      try {
        map.set(r.session_id, { cost: r.cost ?? 0, tokens: JSON.parse(r.tokens_json || '{}') });
      } catch {
        /* skip corrupt row */
      }
    }
    return map;
  }

  /** Today's cost/token totals, to rehydrate the live day counters on boot. */
  todayTotals(): { costUsd: number; tokensIn: number; tokensOut: number } {
    if (!this.enabled) return { costUsd: 0, tokensIn: 0, tokensOut: 0 };
    const day = localDay(Date.now());
    const r = this.db!
      .prepare(`SELECT COALESCE(SUM(d_usd),0) c, COALESCE(SUM(d_tokens_in),0) i, COALESCE(SUM(d_tokens_out),0) o FROM usage WHERE day=?`)
      .get(day) as { c: number; i: number; o: number };
    return { costUsd: r.c, tokensIn: r.i, tokensOut: r.o };
  }

  /** Daily series for the trends view. */
  trends(days: number): unknown {
    if (!this.enabled) return { enabled: false, days: [], byStream: [] };
    const since = localDay(Date.now() - (days - 1) * 86_400_000);
    const cost = this.db!
      .prepare(`SELECT day, SUM(d_usd) costUsd, SUM(d_tokens_in) tokensIn, SUM(d_tokens_out) tokensOut
                FROM usage WHERE day>=? GROUP BY day`)
      .all(since) as Array<{ day: string; costUsd: number; tokensIn: number; tokensOut: number }>;
    const prompts = this.db!
      .prepare(`SELECT day, COUNT(*) prompts FROM events
                WHERE day>=? AND (kind='user_prompt' OR (kind='activity' AND subtype='prompt_submit'))
                GROUP BY day`)
      .all(since) as Array<{ day: string; prompts: number }>;
    const sessions = this.db!
      .prepare(`SELECT day, COUNT(DISTINCT session_id) sessions FROM events WHERE day>=? GROUP BY day`)
      .all(since) as Array<{ day: string; sessions: number }>;

    // Stitch into one row per day across the window.
    const map = new Map<string, { day: string; costUsd: number; tokensIn: number; tokensOut: number; prompts: number; sessions: number }>();
    for (let i = 0; i < days; i++) {
      const day = localDay(Date.now() - (days - 1 - i) * 86_400_000);
      map.set(day, { day, costUsd: 0, tokensIn: 0, tokensOut: 0, prompts: 0, sessions: 0 });
    }
    for (const r of cost) Object.assign(map.get(r.day) ?? {}, { costUsd: +(r.costUsd ?? 0).toFixed(4), tokensIn: r.tokensIn ?? 0, tokensOut: r.tokensOut ?? 0 });
    for (const r of prompts) if (map.get(r.day)) map.get(r.day)!.prompts = r.prompts;
    for (const r of sessions) if (map.get(r.day)) map.get(r.day)!.sessions = r.sessions;

    const byStream = this.db!
      .prepare(`SELECT team_id teamId, SUM(d_usd) costUsd, SUM(d_tokens_in)+SUM(d_tokens_out) tokens
                FROM usage WHERE day>=? GROUP BY team_id ORDER BY costUsd DESC`)
      .all(since) as Array<{ teamId: string; costUsd: number; tokens: number }>;

    return {
      enabled: true,
      days: [...map.values()],
      byStream: byStream.map((s) => ({ teamId: s.teamId ?? 'unassigned', costUsd: +(s.costUsd ?? 0).toFixed(4), tokens: s.tokens ?? 0 })),
    };
  }

  /** Recent event timeline + totals for one agent (across their sessions). */
  agentHistory(agent: string, limit = 200): unknown {
    if (!this.enabled) return { enabled: false };
    const events = this.db!
      .prepare(`SELECT ts,kind,subtype,provider,client,session_id sessionId,repo,branch,ticket,tool_name toolName,success,duration_ms durationMs
                FROM events WHERE agent=? ORDER BY ts DESC LIMIT ?`)
      .all(agent, limit);
    const totals = this.db!
      .prepare(`SELECT COALESCE(SUM(d_usd),0) costUsd, COALESCE(SUM(d_tokens_in+d_tokens_out),0) tokens,
                       COUNT(DISTINCT session_id) sessions FROM usage WHERE agent=?`)
      .get(agent) as { costUsd: number; tokens: number; sessions: number };
    return { enabled: true, agent, totals, events };
  }

  private prune(): void {
    if (!this.enabled) return;
    const cutoff = Date.now() - config.retentionDays * 86_400_000;
    this.db!.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
    this.db!.prepare('DELETE FROM usage WHERE ts < ?').run(cutoff);
    this.db!.prepare('DELETE FROM cumulative WHERE ts < ?').run(cutoff);
  }
}

export const history = new History();

import Database from 'better-sqlite3';
import { basename } from 'node:path';
import type { AgentEvent } from './types.js';
import { sourceMetadata, safeLabel } from './session-metadata.js';

/** Optional adapter for a dashboard on the same machine as Codex.
 * Reads only origin and Git context for IDs already received through telemetry.
 * Never selects titles, previews, prompts, transcripts or client usage counters.
 * Codex's private index is version-dependent: an incompatible schema disables it.
 */
export function openCodexMetadata(path?: string) {
  let db: Database.Database | undefined;
  let query: Database.Statement | undefined;
  const cache = new Map<string, { expires: number; metadata: Partial<AgentEvent> }>();
  let available = false;
  if (path) {
    try {
      db = new Database(path, { readonly: true, fileMustExist: true, timeout: 100 });
      query = db.prepare('SELECT source, cwd, git_branch FROM threads WHERE id = ?');
      available = true;
    } catch {
      db?.close();
      db = undefined;
    }
  }
  return {
    available,
    enrich(event: AgentEvent): AgentEvent {
      if (!query || event.provider !== 'codex' || !event.sessionId) return event;
      const id = event.rawSessionId ?? event.sessionId;
      let entry = cache.get(id);
      if (!entry || entry.expires < Date.now()) {
        try {
          const row = query.get(id) as
            { source: string; cwd: string; git_branch?: string } | undefined;
          const metadata: Partial<AgentEvent> = row
            ? {
                ...sourceMetadata(row.source),
                cwd: row.cwd,
                repo: basename(row.cwd.replaceAll('\\', '/')),
                branch: safeLabel(row.git_branch),
              }
            : {};
          entry = { metadata, expires: Date.now() + 10000 };
          cache.set(id, entry);
          if (cache.size > 512) cache.delete(cache.keys().next().value!);
        } catch {
          return event;
        }
      }
      return {
        ...event,
        sessionRole:
          event.sessionRole && event.sessionRole !== 'unknown'
            ? event.sessionRole
            : (entry.metadata.sessionRole ?? event.sessionRole),
        parentSessionId: event.parentSessionId ?? entry.metadata.parentSessionId,
        agentType: event.agentType ?? entry.metadata.agentType,
        repo: event.repo ?? entry.metadata.repo,
        branch: event.branch ?? entry.metadata.branch,
        cwd: event.cwd ?? entry.metadata.cwd,
      };
    },
    close() {
      db?.close();
    },
  };
}

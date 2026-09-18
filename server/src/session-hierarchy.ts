// Shared projection used by the API, board, directory and detail drawer.
import type { SessionRole, SessionState } from './types.js';

export function sessionRole(session: SessionState): SessionRole {
  if (session.sessionRole && session.sessionRole !== 'unknown') return session.sessionRole;
  if (session.parentSessionId) return 'subagent';
  if (session.sessionRole === 'unknown') return 'unknown';
  // Compatibility with clients that report user prompts but no source metadata.
  return session.promptCount > 0 ? 'main' : 'unknown';
}

export interface SessionGroup {
  root: SessionState;
  children: SessionState[];
  active: boolean;
  lastEventAt: number;
}

export function groupSessions(sessions: SessionState[]) {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const groups = new Map<string, SessionGroup>();
  for (const session of sessions) {
    if (sessionRole(session) === 'main' && !session.parentSessionId) {
      groups.set(session.sessionId, {
        root: session,
        children: [],
        active: session.status !== 'idle',
        lastEventAt: session.lastEventAt,
      });
    }
  }
  const unlinked: SessionState[] = [];
  for (const session of sessions) {
    if (groups.has(session.sessionId)) continue;
    const visited = new Set([session.sessionId]);
    let parentId = session.parentSessionId;
    let group: SessionGroup | undefined;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent || parent.provider !== session.provider) break;
      group = groups.get(parentId);
      if (group) break;
      parentId = parent.parentSessionId;
    }
    if (group) {
      group.children.push(session);
      group.active ||= session.status !== 'idle';
      group.lastEventAt = Math.max(group.lastEventAt, session.lastEventAt);
    } else {
      unlinked.push(session);
    }
  }
  const recentFirst = (a: SessionState, b: SessionState) =>
    Number(b.status !== 'idle') - Number(a.status !== 'idle') || b.lastEventAt - a.lastEventAt;
  for (const group of groups.values()) group.children.sort(recentFirst);
  const ordered = [...groups.values()].sort(
    (a, b) => Number(b.active) - Number(a.active) || b.lastEventAt - a.lastEventAt,
  );
  return { groups: ordered, unlinked: unlinked.sort(recentFirst) };
}

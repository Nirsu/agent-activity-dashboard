import type { ActivityTeam, AgentEvent } from '../types.js';
import type { TrendsQuery } from './types.js';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const accountSession = new RegExp(`^(?:codex:|claude:)?(${uuid})/${uuid}/.+$`);

export function historyPerson(record: { accountId?: string; sessionId?: string }): string {
  return record.accountId || accountSession.exec(record.sessionId ?? '')?.[1] || 'unassigned';
}

export function historyTeams(
  record: { teams?: ActivityTeam[]; teamId?: string },
  aliases: ReadonlyMap<string, ActivityTeam>,
): ActivityTeam[] {
  if (record.teams !== undefined) {
    return record.teams.length ? record.teams : [{ id: 'unassigned', name: 'No team' }];
  }
  return record.teamId
    ? [
        aliases.get(record.teamId.trim().toLowerCase()) ?? {
          id: record.teamId,
          name: record.teamId,
        },
      ]
    : [{ id: 'unassigned', name: 'No team' }];
}

export function matchesAudience(
  event: AgentEvent,
  query: TrendsQuery,
  aliases: ReadonlyMap<string, ActivityTeam>,
): boolean {
  return (
    (!query.person || historyPerson(event) === query.person) &&
    (!query.team || historyTeams(event, aliases).some((team) => team.id === query.team))
  );
}

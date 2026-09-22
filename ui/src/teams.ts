import type { SessionState } from './types';

export const NO_TEAM_ID = 'unassigned';

export interface SessionTeam {
  id: string;
  name: string;
}

/** An explicit empty membership list replaces any legacy team attribution. */
export function sessionTeams(session: SessionState): SessionTeam[] {
  const teams =
    session.teams ?? (session.teamId ? [{ id: session.teamId, name: session.teamId }] : []);
  const unique = [...new Map(teams.map((team) => [team.id, team])).values()];
  return unique.length ? unique : [{ id: NO_TEAM_ID, name: 'No team' }];
}

export function matchesTeam(session: SessionState, teamId: string | null): boolean {
  return !teamId || sessionTeams(session).some((team) => team.id === teamId);
}

export function selectedTeamLabel(teamId: string | null, sessions: SessionState[]): string {
  if (!teamId) {
    return 'All teams';
  }
  if (teamId === NO_TEAM_ID) {
    return 'No team';
  }
  return sessions.flatMap(sessionTeams).find((team) => team.id === teamId)?.name ?? 'Selected team';
}

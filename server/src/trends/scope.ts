import type { ActivityTeam } from '../types.js';
import type { TrendsQuery } from './types.js';
import { InvalidTrendsQuery } from './range.js';

export interface TrendsSql {
  sql: string;
  values: unknown[];
}

export function validateAudience(query: TrendsQuery): void {
  for (const value of [query.team, query.person]) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 200)) {
      throw new InvalidTrendsQuery('Choose a valid team or person.');
    }
  }
}

export function jsonField(postgres: boolean, column: string, field: string): string {
  return postgres ? `${column}->>'${field}'` : `json_extract(${column}, '$.${field}')`;
}

// Older authenticated sessions encoded account/workstation UUIDs in their ID.
// Only that exact namespace is recoverable; agent labels and raw sessions are
// not reliable person identities and must remain unassigned.
function accountIdentity(postgres: boolean): string {
  const raw = `CASE WHEN substr(session_id,1,6)='codex:' THEN substr(session_id,7)
    WHEN substr(session_id,1,7)='claude:' THEN substr(session_id,8) ELSE session_id END`;
  const uuid = postgres
    ? '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    : [8, 4, 4, 4, 12].map((size) => '[0-9a-f]'.repeat(size)).join('-');
  const valid = postgres
    ? `(${raw}) ~ '^${uuid}/${uuid}/.+'`
    : `(${raw}) GLOB '${uuid}/${uuid}/*' AND length(${raw})>74`;
  return `COALESCE(NULLIF(${jsonField(postgres, 'data', 'accountId')},''),
    CASE WHEN ${valid} THEN substr(${raw},1,36) END, 'unassigned')`;
}

export function trendsSource(
  table: 'aad_history_events' | 'aad_history_usage',
  postgres: boolean,
  since: number,
  until: number,
  query: Pick<TrendsQuery, 'team' | 'person'>,
  aliases: ReadonlyMap<string, ActivityTeam>,
): TrendsSql {
  const values: unknown[] = [];
  const legacyValue = (field: 'id' | 'name') => {
    if (!aliases.size) {
      return `COALESCE(NULLIF(team_id,''),'${field === 'id' ? 'unassigned' : 'No team'}')`;
    }
    const cases = [...aliases].map(([name, team]) => {
      values.push(name, team[field]);
      return 'WHEN ? THEN ?';
    });
    return `CASE lower(trim(team_id)) ${cases.join(' ')} ELSE
      COALESCE(NULLIF(team_id,''),'${field === 'id' ? 'unassigned' : 'No team'}') END`;
  };
  const id = legacyValue('id');
  const name = legacyValue('name');
  const fallback = postgres
    ? `jsonb_build_array(jsonb_build_object('id',${id},'name',${name}))`
    : `json_array(json_object('id',${id},'name',${name}))`;
  const empty = postgres
    ? `jsonb_build_array(jsonb_build_object('id','unassigned','name','No team'))`
    : `json_array(json_object('id','unassigned','name','No team'))`;
  const memberships = postgres
    ? `CASE WHEN jsonb_typeof(data->'teams')='array' THEN
        CASE WHEN jsonb_array_length(data->'teams')>0 THEN data->'teams' ELSE ${empty} END
        ELSE ${fallback} END`
    : `CASE WHEN json_type(data,'$.teams')='array' THEN
        CASE WHEN json_array_length(data,'$.teams')>0 THEN json_extract(data,'$.teams') ELSE ${empty} END
        ELSE ${fallback} END`;
  values.push(since, until);
  const filters = ['1=1'];
  if (query.person) {
    filters.push('person_id=?');
    values.push(query.person);
  }
  if (query.team) {
    const expand = postgres ? 'jsonb_array_elements(memberships)' : 'json_each(memberships)';
    filters.push(
      `EXISTS (SELECT 1 FROM ${expand} AS member WHERE ${jsonField(postgres, 'member.value', 'id')}=?)`,
    );
    values.push(query.team);
  }
  return {
    sql: `SELECT * FROM (SELECT *, ${accountIdentity(postgres)} AS person_id,
      ${memberships} AS memberships FROM ${table} WHERE ts>=? AND ts<?) attributed
      WHERE ${filters.join(' AND ')}`,
    values,
  };
}

export function audienceDimension(postgres: boolean, dimension: 'team' | 'person') {
  return dimension === 'person'
    ? { id: 'person_id', name: 'person_id', join: '' }
    : {
        id: jsonField(postgres, 'member.value', 'id'),
        name: jsonField(postgres, 'member.value', 'name'),
        join: `CROSS JOIN ${postgres ? 'jsonb_array_elements(memberships)' : 'json_each(memberships)'} AS member`,
      };
}

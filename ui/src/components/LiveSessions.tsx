import type { SessionState } from '../types';
import type { SessionGroup } from '../../../server/src/session-hierarchy';
import { sessionRole } from '../../../server/src/session-hierarchy';
import { ago, statusLabel, tokens, usd } from '../format';
import { SessionCard } from './SessionCard';
import { sessionTeams } from '../teams';
import './LiveSessions.css';

export function SessionRow({ session, onClick }: { session: SessionState; onClick: () => void }) {
  const role = sessionRole(session);
  return (
    <button type="button" className="session-row" onClick={onClick}>
      <span className={`dir-dot dir-dot-${session.status}`} />
      <span className="session-row-name">
        <strong>
          {session.agentType ??
            session.repo ??
            (role === 'internal' ? 'Internal task' : role === 'subagent' ? 'Subagent' : 'Session')}
        </strong>
        <small>
          {session.provider === 'codex' ? 'Codex' : 'Claude'} ·{' '}
          {session.rawSessionId?.slice(-8) ?? session.sessionId.slice(-8)} ·{' '}
          {role === 'internal'
            ? 'Internal'
            : role === 'subagent'
              ? 'Subagent'
              : role === 'main'
                ? 'Main task'
                : 'Unclassified'}
        </small>
      </span>
      <span className="session-row-status">
        {session.endedAt ? 'Finished' : statusLabel[session.status]}
      </span>
      <span className="session-row-usage">
        {session.tokensKnown ? `${tokens(session.sessionTokens)} tokens` : 'Tokens unavailable'}
        <small>{session.costKnown ? usd(session.sessionCostUsd) : 'Cost unavailable'}</small>
      </span>
      <span className="session-row-time">
        {ago(session.lastEventAt)} <span aria-hidden="true">›</span>
      </span>
    </button>
  );
}

export function LiveSessions({
  groups,
  unlinked,
  hasFilters,
  providerLabel,
  selectedTeam = null,
  onSelect,
  onClear,
}: {
  groups: SessionGroup[];
  unlinked: SessionState[];
  hasFilters: boolean;
  providerLabel: string;
  selectedTeam?: string | null;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  const active = groups.filter((group) => group.active);
  const inactive = groups.filter((group) => !group.active);
  const streams = new Map<string, { name: string; groups: SessionGroup[] }>();
  for (const group of active) {
    for (const team of sessionTeams(group.root)) {
      if (selectedTeam && team.id !== selectedTeam) {
        continue;
      }
      if (!streams.has(team.id)) {
        streams.set(team.id, { name: team.name, groups: [] });
      }
      streams.get(team.id)!.groups.push(group);
    }
  }
  const hasSharedTasks =
    !selectedTeam && active.some((group) => sessionTeams(group.root).length > 1);
  return (
    <section className="live-sessions" aria-label="Live sessions">
      <div className="live-section-heading">
        <div>
          <h2>Live sessions</h2>
          <p>Main tasks in progress. Open a task to see its subagents.</p>
          {hasSharedTasks && (
            <p>Tasks in multiple teams appear in each team. Totals count each task once.</p>
          )}
        </div>
        <span className="active-task-count">
          {active.length} active {active.length === 1 ? 'task' : 'tasks'}
        </span>
      </div>
      {active.length === 0 && (
        <div className="empty" role="status">
          <div className="empty-title">
            {hasFilters && groups.length === 0 && unlinked.length === 0
              ? 'No matching sessions'
              : 'No active tasks'}
          </div>
          <p className="empty-body">
            {inactive.length || unlinked.length
              ? 'No main task is running. Recent and unlinked sessions remain available below.'
              : hasFilters
                ? `No ${providerLabel} sessions match the selected filters.`
                : 'Start a task in Codex or Claude Code with telemetry and hooks enabled to follow its progress here.'}
          </p>
          {hasFilters && (
            <button type="button" className="scope-clear" onClick={onClear}>
              Clear filters
            </button>
          )}
        </div>
      )}
      {[...streams].map(([stream, { name, groups: list }]) => (
        <section key={stream} className="stream">
          <div className="stream-head">
            <h2>{name}</h2>
            <span className="stream-count">
              {list.length} active {list.length === 1 ? 'task' : 'tasks'}
            </span>
          </div>
          <div className="cards">
            {list.map((group) => (
              <SessionCard
                key={group.root.sessionId}
                s={group.root}
                group={group}
                onClick={() => onSelect(group.root.sessionId)}
              />
            ))}
          </div>
        </section>
      ))}
      {inactive.length > 0 && (
        <details className="session-secondary">
          <summary>
            Recent inactive tasks <span>{inactive.length}</span>
          </summary>
          <div className="session-row-list">
            {inactive.map(({ root }) => (
              <SessionRow
                key={root.sessionId}
                session={root}
                onClick={() => onSelect(root.sessionId)}
              />
            ))}
          </div>
        </details>
      )}
      {unlinked.length > 0 && (
        <details className="session-secondary">
          <summary>
            Other sessions <span>{unlinked.length}</span>
          </summary>
          <p>
            Internal activity or sessions without a known main task. These are excluded from the
            active task count. Parent links are shown only when reported by the client.
          </p>
          <div className="session-row-list">
            {unlinked.map((session) => (
              <SessionRow
                key={session.sessionId}
                session={session}
                onClick={() => onSelect(session.sessionId)}
              />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

import { useMemo } from 'react';
import type { SessionState, SessionStatus } from '../types';
import { sessionTeams } from '../teams';

export interface Selection {
  stream: string | null;
  agent: string | null;
}

const STATUS_RANK: Record<SessionStatus, number> = { tool: 0, thinking: 1, idle: 2 };

function StatusDot({ status }: { status: SessionStatus }) {
  return <span className={`dir-dot dir-dot-${status}`} />;
}

/** Left-nav directory: teams -> agents, with live status. Drives filtering. */
export function Directory({
  sessions,
  selection,
  onSelect,
}: {
  sessions: SessionState[];
  selection: Selection;
  onSelect: (s: Selection) => void;
}) {
  const streams = useMemo(() => {
    const byStream = new Map<string, { name: string; agents: Map<string, SessionState[]> }>();
    for (const s of sessions) {
      const agent = s.agent ?? s.sessionId.slice(0, 8);
      for (const team of sessionTeams(s)) {
        if (!byStream.has(team.id)) {
          byStream.set(team.id, { name: team.name, agents: new Map() });
        }
        const agents = byStream.get(team.id)!.agents;
        if (!agents.has(agent)) {
          agents.set(agent, []);
        }
        agents.get(agent)!.push(s);
      }
    }
    return [...byStream.entries()]
      .map(([stream, { name, agents }]) => ({
        stream,
        name,
        agents: [...agents.entries()]
          .map(([agent, list]) => ({
            agent,
            list,
            status: list.slice().sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])[0]
              .status,
            active: list.filter((s) => s.status !== 'idle').length,
          }))
          .sort((a, b) => a.agent.localeCompare(b.agent)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [sessions]);

  const totalActive = sessions.filter((s) => s.status !== 'idle').length;

  return (
    <nav className="directory">
      <button
        className={`dir-all ${!selection.stream && !selection.agent ? 'sel' : ''}`}
        onClick={() => onSelect({ stream: null, agent: null })}
      >
        All teams <span className="dir-count">{totalActive} active</span>
      </button>

      {streams.map(({ stream, name, agents }) => {
        const streamSel = selection.stream === stream && !selection.agent;
        const active = agents.reduce((n, a) => n + a.active, 0);
        return (
          <div key={stream} className="dir-stream">
            <button
              className={`dir-stream-head ${streamSel ? 'sel' : ''}`}
              onClick={() => onSelect({ stream, agent: null })}
            >
              <span className="dir-stream-name">{name}</span>
              <span className="dir-count">
                {active}/{agents.length}
              </span>
            </button>
            <div className="dir-agents">
              {agents.map(({ agent, status, list }) => (
                <button
                  key={agent}
                  className={`dir-agent ${selection.stream === stream && selection.agent === agent ? 'sel' : ''}`}
                  onClick={() => onSelect({ stream, agent })}
                  title={`${list.length} session${list.length === 1 ? '' : 's'}`}
                >
                  <StatusDot status={status} />
                  <span className="dir-agent-name">{agent}</span>
                  {list.length > 1 && <span className="dir-badge">{list.length}</span>}
                </button>
              ))}
            </div>
          </div>
        );
      })}

      {sessions.length === 0 && <div className="dir-empty">No agents connected</div>}
    </nav>
  );
}

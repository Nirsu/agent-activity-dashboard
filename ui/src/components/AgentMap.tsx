import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionState } from '../types';
import { statusLabel } from '../format';
import { sessionTeams } from '../teams';
import { agentMapLayout } from './agentMapLayout';

interface Cluster {
  stream: string;
  name: string;
  sessions: SessionState[];
  active: number;
}

/** Stable team clusters on a shared canvas, with labels above the session nodes. */
export function AgentMap({
  sessions,
  selectedTeam = null,
  onSelect,
  hasFilters = false,
  onClear,
}: {
  sessions: SessionState[];
  selectedTeam?: string | null;
  onSelect: (id: string) => void;
  hasFilters?: boolean;
  onClear?: () => void;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    if (!canvas.current || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) {
        setWidth(Math.round(entry.contentRect.width));
      }
    });
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);
  const clusters = useMemo<Cluster[]>(() => {
    const byStream = new Map<string, { name: string; sessions: SessionState[] }>();
    for (const s of sessions) {
      for (const team of sessionTeams(s)) {
        if (selectedTeam && team.id !== selectedTeam) {
          continue;
        }
        if (!byStream.has(team.id)) {
          byStream.set(team.id, { name: team.name, sessions: [] });
        }
        byStream.get(team.id)!.sessions.push(s);
      }
    }
    const entries = [...byStream.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
    return entries.map(([stream, { name, sessions: listRaw }]) => {
      const list = listRaw.slice().sort((a, b) => a.sessionId.localeCompare(b.sessionId));
      return {
        stream,
        name,
        sessions: list,
        active: list.filter((s) => s.status !== 'idle').length,
      };
    });
  }, [sessions, selectedTeam]);
  const layout = useMemo(
    () =>
      agentMapLayout(
        clusters.map((cluster) => cluster.sessions.length),
        width,
      ),
    [clusters, width],
  );

  return (
    <div className="map">
      <div className="map-legend">
        <span>
          <span className="dir-dot dir-dot-tool" /> Using a tool
        </span>
        <span>
          <span className="dir-dot dir-dot-thinking" /> Thinking
        </span>
        <span>
          <span className="dir-dot dir-dot-idle" /> Idle
        </span>
        {!selectedTeam && sessions.some((session) => sessionTeams(session).length > 1) && (
          <span>Sessions appear in each assigned team.</span>
        )}
      </div>
      <div ref={canvas} className="map-canvas" style={{ height: layout.height }}>
        {clusters.length === 0 && (
          <div className="map-empty" role="status">
            <h2>{hasFilters ? 'No matching sessions' : 'No agents connected'}</h2>
            <p>
              {hasFilters
                ? 'Try another provider or team.'
                : 'Sessions will appear here when an agent sends activity.'}
            </p>
            {hasFilters && onClear && (
              <button className="scope-clear" onClick={onClear}>
                Clear filters
              </button>
            )}
          </div>
        )}
        {clusters.map((c, clusterIndex) => (
          <section key={c.stream} className="map-cluster" aria-label={`${c.name} sessions`}>
            <header
              className="map-cluster-heading"
              style={{
                left: layout.clusters[clusterIndex].cx,
                top: layout.clusters[clusterIndex].headingY,
                width: layout.clusters[clusterIndex].headingWidth,
              }}
            >
              <h2 className="map-cluster-label" title={c.name}>
                {c.name}
              </h2>
              <span className="map-cluster-count">
                {c.active} active · {c.sessions.length}{' '}
                {c.sessions.length === 1 ? 'session' : 'sessions'}
              </span>
            </header>
            {c.sessions.map((s, nodeIndex) => (
              <button
                key={s.sessionId}
                className={`map-node provider-${s.provider} status-${s.status}`}
                style={{
                  left: layout.clusters[clusterIndex].nodes[nodeIndex].x,
                  top: layout.clusters[clusterIndex].nodes[nodeIndex].y,
                  maxWidth: layout.nodeWidth,
                }}
                onClick={() => onSelect(s.sessionId)}
                title={`${s.agent ?? s.sessionId} — ${statusLabel[s.status]}${s.currentTool ? ': ' + s.currentTool : ''}`}
              >
                <span className="map-node-dot" />
                <span className="map-node-label">
                  <span className="map-node-agent">{s.agent ?? s.sessionId.slice(0, 8)}</span>
                  <span className="map-node-tool">
                    {s.status === 'tool' && s.currentTool ? s.currentTool : statusLabel[s.status]}
                  </span>
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

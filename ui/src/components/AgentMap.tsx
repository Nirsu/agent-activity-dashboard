import { useMemo } from 'react';
import type { SessionState } from '../types';
import { statusLabel } from '../format';
import { sessionTeams } from '../teams';

interface Node {
  s: SessionState;
  x: number; // %
  y: number; // %
}
interface Cluster {
  stream: string;
  name: string;
  cx: number;
  cy: number;
  nodes: Node[];
  active: number;
}

/**
 * "Mission control" — one node per session and team, clustered on a canvas.
 * Positions are deterministic (by sorted index) so nodes don't jump between
 * renders; status drives colour + pulse, current tool shows on the node.
 */
export function AgentMap({
  sessions,
  selectedTeam = null,
  onSelect,
}: {
  sessions: SessionState[];
  selectedTeam?: string | null;
  onSelect: (id: string) => void;
}) {
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
    const n = entries.length || 1;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cellW = 100 / cols;
    const cellH = 100 / rows;

    return entries.map(([stream, { name, sessions: listRaw }], ci) => {
      const list = listRaw.slice().sort((a, b) => a.sessionId.localeCompare(b.sessionId));
      const col = ci % cols;
      const row = Math.floor(ci / cols);
      const cx = (col + 0.5) * cellW;
      const cy = (row + 0.5) * cellH;
      const perRing = 6;
      // Keep nodes inside the canvas; tighter radius near an edge cell.
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      const nodes = list.map((s, i) => {
        if (list.length === 1) return { s, x: clamp(cx, 12, 88), y: clamp(cy, 10, 90) };
        const ring = Math.floor(i / perRing) + 1;
        const inRing = Math.min(perRing, list.length - (ring - 1) * perRing);
        const idxInRing = i % perRing;
        const angle = (idxInRing / inRing) * Math.PI * 2 - Math.PI / 2;
        const rx = 5.5 * ring; // % of width
        const ry = 8 * ring; // % of height
        return {
          s,
          x: clamp(cx + rx * Math.cos(angle), 12, 88),
          y: clamp(cy + ry * Math.sin(angle), 10, 90),
        };
      });
      return {
        stream,
        name,
        cx,
        cy,
        nodes,
        active: list.filter((s) => s.status !== 'idle').length,
      };
    });
  }, [sessions, selectedTeam]);

  return (
    <div className="map">
      <div className="map-legend">
        <span>
          <span className="dir-dot dir-dot-tool" /> tool
        </span>
        <span>
          <span className="dir-dot dir-dot-thinking" /> thinking
        </span>
        <span>
          <span className="dir-dot dir-dot-idle" /> idle
        </span>
        {!selectedTeam && sessions.some((session) => sessionTeams(session).length > 1) && (
          <span>Sessions appear in each assigned team.</span>
        )}
      </div>
      <div className="map-canvas">
        {sessions.length === 0 && <div className="map-empty">No agents connected</div>}
        {clusters.map((c) => (
          <div key={c.stream}>
            <div className="map-cluster-label" style={{ left: `${c.cx}%`, top: `${c.cy}%` }}>
              {c.name}
              <span className="map-cluster-count">
                {c.active}/{c.nodes.length}
              </span>
            </div>
            {c.nodes.map(({ s, x, y }) => (
              <button
                key={s.sessionId}
                className={`map-node provider-${s.provider} status-${s.status}`}
                style={{ left: `${x}%`, top: `${y}%` }}
                onClick={() => onSelect(s.sessionId)}
                title={`${s.agent ?? s.sessionId} — ${statusLabel[s.status]}${s.currentTool ? ': ' + s.currentTool : ''}`}
              >
                <span className="map-node-dot" />
                <span className="map-node-label">
                  <span className="map-node-agent">{s.agent ?? s.sessionId.slice(0, 8)}</span>
                  <span className="map-node-tool">
                    {s.status === 'tool' && s.currentTool
                      ? s.currentTool
                      : s.status === 'thinking'
                        ? 'thinking…'
                        : (s.ticket ?? 'idle')}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

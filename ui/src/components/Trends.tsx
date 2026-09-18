import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../api/ws';
import { tokens, usd } from '../format';

interface Day {
  day: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  prompts: number;
  sessions: number;
  costKnown: boolean;
  tokensKnown: boolean;
  unknownUsageCount: number;
  unattributedCostUsd: number;
}
interface TrendsData {
  enabled: boolean;
  backend?: string;
  days: Day[];
  byStream: Array<{ teamId: string; costUsd: number; tokens: number; costKnown: boolean }>;
}

const WIDTH = 720;
const HEIGHT = 160;
const PAD = { l: 8, r: 8, t: 10, b: 22 };

export function Trends() {
  const [d, setD] = useState<TrendsData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const load = () =>
      apiFetch('/api/trends?days=14')
        .then((r) => { if (!r.ok) throw new Error('History request failed'); return r.json(); })
        .then((data) => { setD(data); setError(false); })
        .catch(() => setError(true));
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const totals = useMemo(() => {
    const days = d?.days ?? [];
    return {
      cost: days.reduce((a, x) => a + x.costUsd, 0),
      tokens: days.reduce((a, x) => a + x.tokensIn + x.tokensOut, 0),
      prompts: days.reduce((a, x) => a + x.prompts, 0),
      sessions: days.reduce((a, x) => a + x.sessions, 0),
      costKnown: days.some((x) => x.costKnown),
      tokensKnown: days.some((x) => x.tokensKnown),
      unknown: days.reduce((a, x) => a + x.unknownUsageCount, 0),
      unattributed: days.reduce((a, x) => a + x.unattributedCostUsd, 0),
    };
  }, [d]);

  if (d && !d.enabled)
    return (
      <div className="trends-empty">
        History is unavailable on this server. Trends appear once
        the server persists events.
      </div>
    );
  if (!d) return <div className="trends-empty">{error ? 'History could not be loaded. Retrying…' : 'Loading trends…'}</div>;

  const days = d.days;
  const maxCost = Math.max(0.0001, ...days.map((x) => x.costUsd));
  const bw = (WIDTH - PAD.l - PAD.r) / Math.max(1, days.length);
  const chartH = HEIGHT - PAD.t - PAD.b;
  const maxStreamCost = Math.max(0.0001, ...d.byStream.map((s) => s.costUsd));

  return (
    <div className="trends">
      {error && <p role="status">History refresh failed. Showing the last received data.</p>}
      <p>
        {d.backend === 'postgres' ? 'PostgreSQL' : 'SQLite'} history · all providers and streams · known usage only.
        {' '}{totals.unknown} usage observations have an unknown cost.
        {' '}{usd(totals.unattributed)} is not linked to a ticket or work item.
        {' '}Session totals count daily appearances; they are not unique over the whole period.
      </p>
      <div className="trends-tiles">
        <Tile label="Known cost · 14d" value={totals.costKnown ? usd(totals.cost) : 'Unavailable'} accent />
        <Tile label="Known tokens · 14d" value={totals.tokensKnown ? tokens(totals.tokens) : 'Unavailable'} />
        <Tile label="Prompts · 14d" value={String(totals.prompts)} />
        <Tile label="Sessions · 14d" value={String(totals.sessions)} />
      </div>

      <div className="trends-chart-card">
        <div className="trends-chart-title">Known cost per day · missing usage is excluded</div>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="trends-svg" role="img" aria-label="Known cost per day">
          {days.map((x, i) => {
            const h = (x.costUsd / maxCost) * chartH;
            const bx = PAD.l + i * bw;
            const by = PAD.t + (chartH - h);
            const showLabel = i % 2 === 0 || i === days.length - 1;
            return (
              <g key={x.day}>
                <rect
                  x={bx + 2}
                  y={by}
                  width={bw - 4}
                  height={Math.max(0, h)}
                  rx={3}
                  className="trends-bar"
                >
                  <title>{`${x.day}: ${x.costKnown ? usd(x.costUsd) : 'cost unavailable'} · ${x.unknownUsageCount} unknown · ${x.prompts} prompts · ${x.sessions} sessions`}</title>
                </rect>
                {showLabel && (
                  <text x={bx + bw / 2} y={HEIGHT - 6} textAnchor="middle" className="trends-axis">
                    {x.day.slice(5)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="trends-chart-card">
        <div className="trends-chart-title">Cost by stream · 14d</div>
        {d.byStream.length === 0 && <div className="trends-empty-inline">No data yet.</div>}
        {d.byStream.map((s) => (
          <div key={s.teamId} className="trends-stream-row">
            <span className="trends-stream-name">{s.teamId}</span>
            <div className="trends-stream-bar">
              <div className="trends-stream-fill" style={{ width: `${(s.costUsd / maxStreamCost) * 100}%` }} />
            </div>
            <span className="trends-stream-val">{s.costKnown ? usd(s.costUsd) : 'Unavailable'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="trends-tile">
      <div className={`trends-tile-value ${accent ? 'accent' : ''}`}>{value}</div>
      <div className="trends-tile-label">{label}</div>
    </div>
  );
}

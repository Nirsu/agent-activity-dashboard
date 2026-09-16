import { useEffect, useMemo, useState } from 'react';
import { useDashboard } from './api/ws';
import { AggregateBar } from './components/AggregateBar';
import { DeliveryDataPanel } from './components/DeliveryDataPanel';
import { DoraStrip } from './components/DoraStrip';
import { SessionCard } from './components/SessionCard';
import { SessionDetail } from './components/SessionDetail';
import { Directory, type Selection } from './components/Directory';
import { AgentMap } from './components/AgentMap';
import { MetricLegend } from './components/MetricLegend';
import { Trends } from './components/Trends';
import { Brain } from './components/Brain';
import type { AgentProvider, SessionState } from './types';

type View = 'board' | 'map' | 'trends' | 'brain';
type ProviderFilter = 'all' | AgentProvider;
const viewFromHash = (): View => {
  const value = location.hash.slice(1).split('/')[0];
  return value === 'brain' || value === 'map' || value === 'trends' ? value : 'board';
};

export default function App() {
  const { connected, sessions, aggregate, events } = useDashboard();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deliveryPanelOpen, setDeliveryPanelOpen] = useState(false);
  const [view, setView] = useState<View>(viewFromHash);
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  const navigate = (value: View) => {
    setView(value);
    location.hash = value;
  };
  const [provider, setProvider] = useState<ProviderFilter>('all');
  const [selection, setSelection] = useState<Selection>({ stream: null, agent: null });

  const providerSessions = useMemo(
    () => sessions.filter((session) => provider === 'all' || session.provider === provider),
    [provider, sessions],
  );

  // Directory filter applied to whichever view is showing.
  const filtered = useMemo(
    () =>
      providerSessions.filter(
        (s) =>
          (!selection.stream || (s.teamId ?? 'unassigned') === selection.stream) &&
          (!selection.agent || (s.agent ?? s.sessionId.slice(0, 8)) === selection.agent),
      ),
    [providerSessions, selection],
  );

  const groups = useMemo(() => {
    const map = new Map<string, SessionState[]>();
    for (const s of filtered) {
      const key = s.teamId ?? 'unassigned';
      (map.get(key) ?? map.set(key, []).get(key)!).push(s);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const selected = sessions.find((s) => s.sessionId === selectedId) ?? null;
  const scopeLabel = selection.agent ?? selection.stream ?? 'All streams';

  return (
    <div className={`app ${view === 'brain' ? 'brain-view' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          <div>
            <div className="brand-title">
              {view === 'brain' ? 'Harmony Brain' : 'Agent Activity Dashboard'}
            </div>
            <div className="brand-sub">
              {view === 'brain'
                ? 'Project memory and code review'
                : 'Observability of agents — build phase · anonymized'}
            </div>
          </div>
        </div>
        <div className="topbar-right">
          <div className="viewswitch">
            <button className={view === 'brain' ? 'on' : ''} onClick={() => navigate('brain')}>
              Harmony Brain
            </button>
            <button className={view === 'board' ? 'on' : ''} onClick={() => navigate('board')}>
              Board
            </button>
            <button className={view === 'map' ? 'on' : ''} onClick={() => navigate('map')}>
              Map
            </button>
            <button className={view === 'trends' ? 'on' : ''} onClick={() => navigate('trends')}>
              Trends
            </button>
          </div>
          {view !== 'brain' && (
            <div className="provider-switch" aria-label="Filter by AI provider">
              {(['all', 'claude', 'codex'] as const).map((value) => (
                <button
                  key={value}
                  className={provider === value ? 'on' : ''}
                  onClick={() => setProvider(value)}
                >
                  {value === 'all' ? 'All AI' : value === 'claude' ? 'Claude' : 'Codex'}
                </button>
              ))}
            </div>
          )}
          {view !== 'brain' && (
            <div className={`conn ${connected ? 'on' : 'off'}`}>
              <span className="dot" />
              {connected ? 'Live' : 'Reconnecting…'}
            </div>
          )}
        </div>
      </header>

      {view === 'brain' ? (
        <Brain />
      ) : (
        <>
          <AggregateBar agg={aggregate} />
          <DoraStrip onOpenDeliveryData={() => setDeliveryPanelOpen(true)} />

          <div className="shell">
            <Directory sessions={providerSessions} selection={selection} onSelect={setSelection} />

            <main className="main">
              {view === 'board' && <MetricLegend />}

              {(selection.stream || selection.agent) && (
                <div className="scopebar">
                  Showing <strong>{scopeLabel}</strong>
                  <button
                    className="scope-clear"
                    onClick={() => setSelection({ stream: null, agent: null })}
                  >
                    clear filter ✕
                  </button>
                </div>
              )}

              {view === 'trends' ? (
                <Trends />
              ) : view === 'map' ? (
                <AgentMap sessions={filtered} onSelect={setSelectedId} />
              ) : filtered.length === 0 ? (
                <div className="empty">
                  <div className="empty-title">No active agent sessions</div>
                  <p className="empty-body">
                    Point a Claude Code session at the dashboard (bootstrap script) — sessions
                    appear here in real time, one anonymized agent per developer.
                  </p>
                </div>
              ) : (
                groups.map(([stream, list]) => (
                  <section key={stream} className="stream">
                    <div className="stream-head">
                      <h2>{stream}</h2>
                      <span className="stream-count">
                        {list.length} session{list.length === 1 ? '' : 's'} ·{' '}
                        {list.filter((s) => s.status !== 'idle').length} active
                      </span>
                    </div>
                    <div className="cards">
                      {list.map((s) => (
                        <SessionCard
                          key={s.sessionId}
                          s={s}
                          onClick={() => setSelectedId(s.sessionId)}
                        />
                      ))}
                    </div>
                  </section>
                ))
              )}
            </main>
          </div>
        </>
      )}

      {view !== 'brain' && selected && (
        <SessionDetail session={selected} events={events} onClose={() => setSelectedId(null)} />
      )}
      <DeliveryDataPanel
        open={view !== 'brain' && deliveryPanelOpen}
        onClose={() => setDeliveryPanelOpen(false)}
      />
    </div>
  );
}

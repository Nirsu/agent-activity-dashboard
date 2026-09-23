import { useEffect, useMemo, useState } from 'react';
import { useDashboard } from './api/ws';
import { AggregateBar } from './components/AggregateBar';
import { LiveSessions } from './components/LiveSessions';
import { SessionDetail } from './components/SessionDetail';
import { Directory, type Selection } from './components/Directory';
import { AgentMap } from './components/AgentMap';
import { MetricLegend } from './components/MetricLegend';
import { Trends } from './components/Trends';
import { Brain } from './components/Brain';
import { BrainActivityBoard } from './components/BrainActivityBoard';
import { Settings } from './components/Settings';
import { canonicalHash, settingsSectionFromHash, viewFromHash, type View } from './navigation';
import type { AgentProvider } from './types';
import { groupSessions } from '../../server/src/session-hierarchy';
import { matchesTeam, selectedTeamLabel } from './teams';

type ProviderFilter = 'all' | AgentProvider;

export default function App() {
  const { connected, sessions, aggregate, providerAggregates, events } = useDashboard();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hash, setHash] = useState(() => canonicalHash(location.hash));
  const view = viewFromHash(hash);
  useEffect(() => {
    const onHash = () => {
      const nextHash = canonicalHash(location.hash);
      if (nextHash !== location.hash) {
        history.replaceState(history.state, '', nextHash);
      }
      setHash(nextHash);
    };
    onHash();
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  const navigate = (value: View) => {
    setHash(canonicalHash(`#${value}`));
    location.hash = value;
  };
  const [provider, setProvider] = useState<ProviderFilter>('all');
  const [selection, setSelection] = useState<Selection>({ stream: null, agent: null });
  const activeProvider = view === 'trends' ? 'all' : provider;

  const providerSessions = useMemo(
    () =>
      sessions.filter((session) => activeProvider === 'all' || session.provider === activeProvider),
    [activeProvider, sessions],
  );

  const hierarchy = useMemo(() => groupSessions(providerSessions), [providerSessions]);
  const matches = (s: (typeof sessions)[number]) =>
    matchesTeam(s, selection.stream) &&
    (!selection.agent || (s.agent ?? s.sessionId.slice(0, 8)) === selection.agent);
  // Apply directory filters to the parent, preserving its complete session tree.
  const groups = hierarchy.groups.filter((group) => matches(group.root));
  const unlinked = hierarchy.unlinked.filter(matches);
  const directorySessions = hierarchy.groups.map((group) =>
    group.active && group.root.status === 'idle'
      ? { ...group.root, status: 'thinking' as const }
      : group.root,
  );
  const filtered = groups.flatMap((group) => [group.root, ...group.children]).concat(unlinked);
  const selected = filtered.find((s) => s.sessionId === selectedId) ?? null;
  const selectedGroup = groups.find(
    (group) =>
      group.root.sessionId === selectedId ||
      group.children.some((child) => child.sessionId === selectedId),
  );
  const scopeLabel = selection.agent ?? selectedTeamLabel(selection.stream, directorySessions);
  const hasFilters = provider !== 'all' || Boolean(selection.stream || selection.agent);
  const sourceAggregate =
    activeProvider === 'all' ? aggregate : (providerAggregates?.[activeProvider] ?? null);
  const filteredAggregate = sourceAggregate
    ? {
        ...sourceAggregate,
        activeSessions: hierarchy.groups.filter((group) => group.active).length,
      }
    : null;
  const providerLabel = provider === 'claude' ? 'Claude' : 'Codex';

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
          <nav className="viewswitch" aria-label="Main navigation">
            <button
              className={view === 'brain' ? 'on' : ''}
              aria-current={view === 'brain' ? 'page' : undefined}
              onClick={() => navigate('brain')}
            >
              Harmony Brain
            </button>
            <button
              className={view === 'board' ? 'on' : ''}
              aria-current={view === 'board' ? 'page' : undefined}
              onClick={() => navigate('board')}
            >
              Board
            </button>
            <button
              className={view === 'map' ? 'on' : ''}
              aria-current={view === 'map' ? 'page' : undefined}
              onClick={() => navigate('map')}
            >
              Map
            </button>
            <button
              className={view === 'trends' ? 'on' : ''}
              aria-current={view === 'trends' ? 'page' : undefined}
              onClick={() => navigate('trends')}
            >
              Trends
            </button>
            <button
              className={view === 'settings' ? 'on' : ''}
              aria-current={view === 'settings' ? 'page' : undefined}
              onClick={() => navigate('settings')}
            >
              Settings
            </button>
          </nav>
          {(view === 'board' || view === 'map') && (
            <div className={`conn ${connected ? 'on' : 'off'}`}>
              <span className="dot" />
              {connected ? 'Live' : 'Reconnecting…'}
            </div>
          )}
        </div>
      </header>

      {view === 'settings' ? (
        <Settings section={settingsSectionFromHash(hash)} />
      ) : view === 'brain' ? (
        <Brain />
      ) : (
        <>
          {view !== 'trends' && (
            <>
              <div className="activity-page-heading">
                <h1>{view === 'map' ? 'Activity map' : 'Activity board'}</h1>
                <p>
                  {view === 'map'
                    ? 'Explore sessions by team. Select an agent to open its activity.'
                    : 'Follow live tasks, agent activity and Brain analyses.'}
                </p>
              </div>
              <AggregateBar
                agg={filteredAggregate}
                provider={activeProvider === 'all' ? undefined : activeProvider}
              />
            </>
          )}

          <div className={`shell${view === 'trends' ? ' shell-wide' : ''}`}>
            {view !== 'trends' && (
              <aside className="activity-sidebar" aria-label="Activity filters">
                <section className="activity-filters" aria-labelledby="activity-filters-title">
                  <h2 id="activity-filters-title">AI Provider</h2>
                  <div className="provider-switch" role="group" aria-label="Filter by AI provider">
                    {(['all', 'claude', 'codex'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={provider === value ? 'on' : ''}
                        aria-pressed={provider === value}
                        onClick={() => {
                          if (value !== provider) {
                            setProvider(value);
                            setSelection({ stream: null, agent: null });
                            setSelectedId(null);
                          }
                        }}
                      >
                        {value === 'all' ? 'All AI' : value === 'claude' ? 'Claude' : 'Codex'}
                      </button>
                    ))}
                  </div>
                </section>
                <Directory
                  sessions={directorySessions}
                  selection={selection}
                  onSelect={setSelection}
                />
              </aside>
            )}

            <main className="main">
              {view === 'board' && <MetricLegend />}

              {view !== 'trends' && (selection.stream || selection.agent) && (
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
                <AgentMap
                  sessions={directorySessions.filter(matches)}
                  selectedTeam={selection.stream}
                  onSelect={setSelectedId}
                  hasFilters={hasFilters}
                  onClear={() => {
                    setProvider('all');
                    setSelection({ stream: null, agent: null });
                  }}
                />
              ) : (
                <LiveSessions
                  groups={groups}
                  unlinked={unlinked}
                  hasFilters={hasFilters}
                  providerLabel={provider === 'all' ? 'agent' : providerLabel}
                  selectedTeam={selection.stream}
                  onSelect={setSelectedId}
                  onClear={() => {
                    setProvider('all');
                    setSelection({ stream: null, agent: null });
                  }}
                />
              )}
              {view === 'board' && <BrainActivityBoard />}
            </main>
          </div>
        </>
      )}

      {(view === 'board' || view === 'map') && selected && (
        <SessionDetail
          session={selected}
          group={selectedGroup}
          events={events}
          onSelect={setSelectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

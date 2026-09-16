import { lazy, Suspense, useEffect, useState } from 'react';
import './Brain.css';

export type { BrainSource } from './brain/types';

const BrainMemory = lazy(() => import('./BrainMemory'));
const BrainAgents = lazy(() => import('./BrainAgents'));
const BrainGraph = lazy(() => import('./BrainGraph'));
const BrainSettings = lazy(() => import('./BrainSettings'));

const tabs = [
  ['memory', 'Memory'],
  ['graph', 'Memory graph'],
  ['agents', 'Project analyses'],
  ['settings', 'Settings'],
] as const;

function currentTab() {
  const value = location.hash.split('/')[1];
  return tabs.find(([tab]) => tab === value)?.[0] ?? 'memory';
}

export function Brain() {
  const [tab, setTab] = useState(currentTab);
  useEffect(() => {
    const update = () => setTab(currentTab());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  return (
    <main className="brain" aria-label="Harmony Brain">
      <div className="brain-toolbar">
        <nav aria-label="Brain views">
          {tabs.map(([value, label]) => (
            <a
              key={value}
              href={`#brain/${value}`}
              className={tab === value ? 'active' : ''}
              aria-current={tab === value ? 'page' : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
      </div>
      <Suspense fallback={<p role="status">Loading Brain…</p>}>
        {tab === 'memory' && <BrainMemory />}
        {tab === 'graph' && <BrainGraph />}
        {tab === 'agents' && <BrainAgents />}
        {tab === 'settings' && <BrainSettings />}
      </Suspense>
      <footer className="brain-footer">
        <span>HARMONY BRAIN</span>
        <p>
          Notion and Git remain the references. Brain preserves the evidence and human decisions.
        </p>
      </footer>
    </main>
  );
}

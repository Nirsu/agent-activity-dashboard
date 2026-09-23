import { lazy, Suspense } from 'react';
import type { SettingsSection } from '../navigation';
import './Brain.css';
import './Settings.css';

const Accounts = lazy(() => import('./Accounts').then((module) => ({ default: module.Accounts })));
const Projects = lazy(() => import('./Projects').then((module) => ({ default: module.Projects })));
const BrainSettings = lazy(() => import('./BrainSettings'));

const sections = [
  { id: 'accounts', label: 'Accounts', description: 'People, teams & workstations' },
  { id: 'projects', label: 'Projects', description: 'Repositories & access' },
  { id: 'brain', label: 'Harmony Brain', description: 'Model pricing & connections' },
] as const;

export function Settings({ section }: { section: SettingsSection }) {
  return (
    <main className="workspace-settings" aria-labelledby="settings-title">
      <header className="settings-heading">
        <span>WORKSPACE</span>
        <h1 id="settings-title">Settings</h1>
        <p>Manage accounts, projects and Harmony Brain in one place.</p>
      </header>
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="Settings sections">
          {sections.map((item) => (
            <a
              key={item.id}
              href={`#settings/${item.id}`}
              aria-current={section === item.id ? 'page' : undefined}
            >
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </a>
          ))}
        </nav>
        <div className={`settings-content${section === 'brain' ? ' brain' : ''}`}>
          <Suspense fallback={<p role="status">Loading settings…</p>}>
            {section === 'accounts' && <Accounts />}
            {section === 'projects' && <Projects />}
            {section === 'brain' && <BrainSettings />}
          </Suspense>
        </div>
      </div>
    </main>
  );
}

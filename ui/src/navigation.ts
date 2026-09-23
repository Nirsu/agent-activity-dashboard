export type View = 'board' | 'map' | 'trends' | 'brain' | 'settings';
export type SettingsSection = 'accounts' | 'projects' | 'brain';

export function canonicalHash(hash: string): string {
  const [view, section] = hash.slice(1).split('/');
  if (view === 'accounts' || view === 'projects') {
    return `#settings/${view}`;
  }
  if (view === 'brain' && section === 'settings') {
    return '#settings/brain';
  }
  if (view === 'settings') {
    return `#settings/${section === 'projects' || section === 'brain' ? section : 'accounts'}`;
  }
  return hash;
}

export function viewFromHash(hash: string): View {
  const view = canonicalHash(hash).slice(1).split('/')[0];
  return view === 'brain' || view === 'map' || view === 'trends' || view === 'settings'
    ? view
    : 'board';
}

export function settingsSectionFromHash(hash: string): SettingsSection {
  const section = canonicalHash(hash).split('/')[1];
  return section === 'projects' || section === 'brain' ? section : 'accounts';
}

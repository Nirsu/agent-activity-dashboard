import type { MemorySource } from './memoryTypes';

export const sourceViews = [
  { id: 'all', label: 'All' },
  { id: 'ready', label: 'Ready' },
  { id: 'draft', label: 'Drafts' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'withdrawn', label: 'Withdrawn' },
] as const;

export type SourceView = (typeof sourceViews)[number]['id'];

export function filterMemorySources(
  sources: MemorySource[],
  query: string,
  scope: string,
  view: SourceView,
) {
  const term = query.trim().toLocaleLowerCase();
  return sources.filter((source) => {
    const matchesQuery = `${source.title} ${source.pageId ?? ''}`
      .toLocaleLowerCase()
      .includes(term);
    const matchesScope =
      scope === 'all' ||
      (scope === 'shared' ? source.shared : source.shared || source.projectIds.includes(scope));
    const matchesView =
      view === 'all' ||
      (view === 'ready' && source.approval === 'approved' && source.status === 'ready') ||
      (view === 'draft' && source.approval === 'draft') ||
      (view === 'attention' && source.status === 'failed') ||
      (view === 'withdrawn' && source.approval === 'withdrawn');
    return matchesQuery && matchesScope && matchesView;
  });
}

export function canSyncSource(source: MemorySource, notionConnected: boolean) {
  return source.approval !== 'withdrawn' && (source.kind !== 'notion' || notionConnected);
}

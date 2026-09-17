import { brainConfig } from '../config.js';
import { fail } from '../analysis/validation.js';
import type { NotionPage } from '../notion/page.js';
import type { MemoryStore } from './store.js';
import type { SourceRegistration } from './types.js';

export function subpagesOf(sources: SourceRegistration[], parentId: string) {
  const descendants: SourceRegistration[] = [];
  const parents = new Set([parentId]);
  for (const id of parents) {
    for (const source of sources) {
      if (source.parentSourceId === id && !parents.has(source.id)) {
        descendants.push(source);
        parents.add(source.id);
      }
    }
  }
  return descendants;
}

export function removeSubpages(store: MemoryStore, parentId: string) {
  for (const source of subpagesOf(store.sources(), parentId)) {
    if (source.approval !== 'withdrawn') {
      store.saveSource({
        ...source,
        approvalBeforeRemoval: source.approval,
        approval: 'withdrawn',
        status: 'withdrawn',
      });
    }
  }
}

export function inheritSubpagePolicy(store: MemoryStore, parent: SourceRegistration) {
  if (!parent.includeSubpages || parent.approval === 'withdrawn') {
    removeSubpages(store, parent.id);
    return;
  }
  for (const source of subpagesOf(store.sources(), parent.id)) {
    const approval =
      parent.autoApproveSubpages && source.approval === 'draft' ? 'approved' : source.approval;
    store.saveSource({
      ...source,
      projectIds: [...parent.projectIds],
      shared: parent.shared,
      includeSubpages: true,
      autoApproveSubpages: Boolean(parent.autoApproveSubpages),
      approval,
      status: approval === 'withdrawn' ? 'withdrawn' : 'pending',
    });
  }
}

export async function reconcileSubpages(
  store: MemoryStore,
  parent: SourceRegistration,
  page: NotionPage,
  fetchPage: (pageId: string) => Promise<NotionPage>,
): Promise<string[]> {
  if (!parent.includeSubpages) {
    return [];
  }
  if (!page.childrenComplete) {
    fail('Notion returned incomplete page content. Subpage discovery could not be completed.');
  }
  const ancestors = new Set<string>();
  let ancestor: SourceRegistration | undefined = parent;
  while (ancestor && !ancestors.has(ancestor.id)) {
    ancestors.add(ancestor.id);
    ancestor = ancestor.parentSourceId ? store.source(ancestor.parentSourceId) : undefined;
  }
  const references = page.childPages ?? [];
  const sources = store.sources();
  // Validate the whole discovery before changing registrations or exclusions.
  for (const reference of references) {
    const id = `notion:${reference.pageId}`;
    if (ancestors.has(id)) {
      fail('Notion returned a cycle in its subpage hierarchy.');
    }
    const existing = store.source(id);
    if (existing && existing.parentSourceId !== parent.id) {
      const sameScope =
        existing.shared === parent.shared &&
        [...existing.projectIds].sort().join(',') === [...parent.projectIds].sort().join(',');
      if (!sameScope) {
        fail(
          'A subpage is already registered in another project scope. Review its source settings.',
        );
      }
      if (existing.parentSourceId) {
        const moved = await fetchPage(reference.pageId);
        if (moved.parentPageId !== parent.pageId) {
          fail(
            'The moved page is not a verified child of its new parent. Synchronize the parent branch.',
          );
        }
      }
    }
  }
  // A policy edit during the remote verification must win over this discovery.
  const inspectedIds = [parent.id, ...references.map((reference) => `notion:${reference.pageId}`)];
  if (
    inspectedIds.some(
      (id) =>
        JSON.stringify(sources.find((source) => source.id === id)) !==
        JSON.stringify(store.source(id)),
    )
  ) {
    fail('Source settings changed during subpage discovery. Synchronize the updated branch.');
  }
  const currentSources = store.sources();
  const newPages = references.filter((reference) => !store.source(`notion:${reference.pageId}`));
  if (currentSources.length + newPages.length > brainConfig.synchronization.maxSources) {
    fail('Subpage discovery exceeds the configured source limit. Narrow the selected branch.');
  }
  const currentIds = new Set(references.map((reference) => `notion:${reference.pageId}`));
  for (const source of currentSources.filter((entry) => entry.parentSourceId === parent.id)) {
    if (!currentIds.has(source.id)) {
      if (source.approval !== 'withdrawn') {
        store.saveSource({
          ...source,
          approvalBeforeRemoval: source.approval,
          approval: 'withdrawn',
          status: 'withdrawn',
        });
      }
      removeSubpages(store, source.id);
    }
  }
  const queued: string[] = [];
  for (const reference of references) {
    const id = `notion:${reference.pageId}`;
    const existing = store.source(id);
    const previousApproval = existing?.approvalBeforeRemoval ?? existing?.approval ?? 'draft';
    const approval =
      previousApproval !== 'withdrawn' && parent.autoApproveSubpages
        ? 'approved'
        : previousApproval;
    const child: SourceRegistration = {
      ...existing,
      id,
      kind: 'notion',
      pageId: reference.pageId,
      title: existing?.title ?? reference.title.slice(0, brainConfig.analysis.maxTitleCharacters),
      url: `https://www.notion.so/${reference.pageId}`,
      parentSourceId: parent.id,
      approvalBeforeRemoval: undefined,
      projectIds: [...parent.projectIds],
      shared: parent.shared,
      mandatory: existing?.mandatory ?? false,
      includeSubpages: true,
      autoApproveSubpages: Boolean(parent.autoApproveSubpages),
      approval,
      status: approval === 'withdrawn' ? 'withdrawn' : 'pending',
    };
    store.saveSource(child);
    if (approval !== 'withdrawn') {
      queued.push(id);
    }
  }
  return queued;
}

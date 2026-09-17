import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { MemorySourceForm } from '../ui/src/components/brain/MemorySourceForm';
import {
  memorySourceStatus,
  memorySourceExplanation,
} from '../ui/src/components/brain/presentation';
import type { MemorySource, SourceRegistration } from '../ui/src/components/brain/memoryTypes';
import {
  canSyncSource,
  filterMemorySources,
  orderMemorySources,
} from '../ui/src/components/brain/memoryView';

test('source filters retain shared project references and separate failed and withdrawn sources', () => {
  const source: MemorySource = {
    id: 'dashboard',
    kind: 'notion',
    title: 'Dashboard reference',
    projectIds: ['dashboard'],
    shared: false,
    mandatory: false,
    approval: 'approved',
    status: 'ready',
  };
  const sources = [
    source,
    { ...source, id: 'other', projectIds: ['mobile'] },
    { ...source, id: 'shared', shared: true, projectIds: [] },
    { ...source, id: 'failed', status: 'failed' as const },
    { ...source, id: 'withdrawn', approval: 'withdrawn' as const, status: 'withdrawn' as const },
  ];
  assert.deepEqual(
    filterMemorySources(sources, ' DASHBOARD ', 'dashboard', 'ready').map((item) => item.id),
    ['dashboard', 'shared'],
  );
  assert.deepEqual(
    filterMemorySources(sources, '', 'dashboard', 'attention').map((item) => item.id),
    ['failed'],
  );
  assert.deepEqual(
    filterMemorySources(sources, '', 'dashboard', 'withdrawn').map((item) => item.id),
    ['withdrawn'],
  );
  assert.deepEqual(
    filterMemorySources(sources, '', 'shared', 'all').map((item) => item.id),
    ['shared'],
  );
});

test('Git can synchronize without Notion while withdrawn sources remain excluded', () => {
  const source: MemorySource = {
    id: 'git',
    kind: 'git',
    title: 'README',
    projectIds: ['dashboard'],
    shared: false,
    mandatory: true,
    approval: 'approved',
    status: 'pending',
  };
  assert.equal(canSyncSource(source, false), true);
  assert.equal(canSyncSource({ ...source, kind: 'notion' }, false), false);
  assert.equal(canSyncSource({ ...source, approval: 'withdrawn' }, true), false);
});

test('source forms surface save errors beside the controls and lock inputs during a write', () => {
  const html = renderToStaticMarkup(
    <MemorySourceForm
      projects={[]}
      busy
      saveError="Administrator access required."
      adminRequired
      onSave={async () => false}
      onCancel={() => {}}
    />,
  );
  assert.match(html, /<fieldset\b[^>]*\bdisabled=""/);
  assert.match(html, /role="alert"/);
  assert.match(html, /Administrator access required/);
  assert.match(html, /Set administrator access in Settings/);
  assert.match(html, /Drafts are excluded from analyses/);
});

test('a captured draft awaits approval while synchronization failures stay visible', () => {
  const source: MemorySource = {
    id: 'page',
    kind: 'notion',
    title: 'Draft page',
    projectIds: ['dashboard'],
    shared: false,
    mandatory: false,
    approval: 'draft',
    status: 'pending',
    currentSourceId: 'snapshot',
  };
  assert.equal(memorySourceStatus(source), 'Awaiting approval');
  assert.match(memorySourceExplanation(source), /Captured for inspection/);
  assert.equal(memorySourceStatus({ ...source, status: 'failed' }), 'failed');
  assert.match(
    memorySourceExplanation({ ...source, status: 'failed' }),
    /synchronization is incomplete/,
  );
  assert.equal(memorySourceExplanation({ ...source, approval: 'approved', status: 'ready' }), '');
});

test('new pages require an explicit scope and default to draft approval', () => {
  const html = renderToStaticMarkup(
    <MemorySourceForm
      projects={[{ id: 'dashboard', name: 'Dashboard' }]}
      busy={false}
      onSave={async () => true}
      onCancel={() => {}}
    />,
  );
  assert.match(html, /<option value="draft" selected="">/);
  assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /Notion page link or ID/);
  assert.match(html, /The original Notion page is never changed/);
  assert.match(html, /Include subpages/);
  assert.doesNotMatch(html, /Automatically approve all subpages/);
});

test('subpage options are submitted explicitly and disabling discovery resets automatic approval', async () => {
  const source: MemorySource = {
    id: 'root',
    pageId: 'a'.repeat(32),
    title: 'Project pages',
    kind: 'notion',
    projectIds: ['dashboard'],
    shared: false,
    mandatory: false,
    approval: 'draft',
    status: 'pending',
  };
  const saved: SourceRegistration[] = [];
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <MemorySourceForm
        source={source}
        projects={[{ id: 'dashboard', name: 'Dashboard' }]}
        busy={false}
        onSave={async (value) => {
          saved.push(value);
          return true;
        }}
        onCancel={() => {}}
      />,
    );
  });
  const checkbox = (text: string) =>
    renderer.root
      .findAllByType('label')
      .find((label) =>
        label.children.some((child) => typeof child === 'string' && child.includes(text)),
      )!
      .findByType('input');
  try {
    await act(async () =>
      checkbox('Include subpages').props.onChange({ target: { checked: true } }),
    );
    assert.equal(checkbox('Automatically approve all subpages').props.checked, false);
    await act(async () =>
      checkbox('Automatically approve all subpages').props.onChange({ target: { checked: true } }),
    );
    await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    assert.equal(saved[0].includeSubpages, true);
    assert.equal(saved[0].autoApproveSubpages, true);
    assert.equal(
      saved[0].approval,
      'draft',
      'The container and its subpages have separate approval',
    );
    await act(async () =>
      checkbox('Include subpages').props.onChange({ target: { checked: false } }),
    );
    await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    assert.equal(saved[1].includeSubpages, false);
    assert.equal(saved[1].autoApproveSubpages, false);
  } finally {
    act(() => renderer.unmount());
  }
});

test('source ordering keeps subpages below their parent and retains children when filters hide that parent', () => {
  const parent: MemorySource = {
    id: 'root',
    title: 'Project',
    kind: 'notion',
    projectIds: ['dashboard'],
    shared: false,
    mandatory: false,
    approval: 'draft',
    status: 'pending',
  };
  const child = { ...parent, id: 'child', parentSourceId: 'root' };
  const nested = { ...parent, id: 'nested', parentSourceId: 'child' };
  assert.deepEqual(
    orderMemorySources([nested, child, parent]).map((source) => source.id),
    ['root', 'child', 'nested'],
  );
  assert.deepEqual(
    orderMemorySources([nested, child]).map((source) => source.id),
    ['child', 'nested'],
  );
  const html = renderToStaticMarkup(
    <MemorySourceForm
      source={child}
      projects={[]}
      busy={false}
      onSave={async () => true}
      onCancel={() => {}}
    />,
  );
  assert.match(html, /Project scope and subpage discovery follow the root page/);
  assert.doesNotMatch(html, /Automatically approve all subpages/);
});

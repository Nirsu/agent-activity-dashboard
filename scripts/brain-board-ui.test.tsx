import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import type { BrainActivityRun } from '../ui/src/components/brain/useBrainActivity';

test('Brain board links work and reviews while keeping unknown usage distinct from zero', async (t) => {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: new URL('http://localhost/'),
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
  });
  t.after(() => {
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else Reflect.deleteProperty(globalThis, 'location');
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const vite = await createServer({
    root: resolve('ui'),
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: 'custom',
    logLevel: 'error',
  });
  t.after(() => vite.close());
  const { BrainActivityView } = await vite.ssrLoadModule('/src/components/BrainActivityBoard.tsx');
  const run: BrainActivityRun = {
    id: 'run/one',
    projectId: 'pilot',
    projectName: 'Pilot',
    status: 'succeeded',
    stage: 'Analysis complete',
    startedAt: '2026-09-18T10:00:00Z',
    model: 'fixture',
    ticket: 'HM-42',
    usage: { inputTokens: 0, outputTokens: 0 },
    usageKnown: false,
    costUsd: null,
    findingCount: 2,
    differenceCount: 1,
    pendingReviewCount: 1,
  };
  const render = (runs: BrainActivityRun[]) =>
    renderToStaticMarkup(<BrainActivityView runs={runs} loaded error="" updatedAt={Date.now()} />);
  const unknown = render([run]);
  assert.match(unknown, /HM-42/);
  assert.match(unknown, /#brain\/agents\/run%2Fone/);
  assert.match(unknown, /Cost unavailable/);
  assert.match(unknown, /Tokens unavailable/);
  assert.match(unknown, /1 awaiting review/);
  assert.match(unknown, /Human decisions remain separate/);
  const zero = render([{ ...run, costUsd: 0, usageKnown: true }]);
  assert.doesNotMatch(zero, /Cost unavailable|Tokens unavailable/);
  assert.match(zero, /estimated/);
  assert.match(zero, /0 tokens/);
  const failed = render([{ ...run, status: 'failed', pendingReviewCount: 0, differenceCount: 0 }]);
  assert.match(failed, /No conclusion/);
  assert.doesNotMatch(failed, /0 differences/);

  await t.test(
    'status and project filters preserve priority and reset expanded history',
    async () => {
      const runs: BrainActivityRun[] = [
        ...Array.from({ length: 4 }, (_, index) => ({
          ...run,
          id: `completed-${index}`,
          pendingReviewCount: 0,
        })),
        { ...run, id: 'review', projectId: 'other', projectName: 'Other project' },
        { ...run, id: 'running', status: 'running', pendingReviewCount: 0 },
      ];
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(<BrainActivityView runs={runs} loaded error="" updatedAt={Date.now()} />);
      });
      t.after(() => act(() => renderer.unmount()));
      const links = () =>
        renderer.root.findAllByType('a').filter((link) => link.props.className === 'brain-run');
      const filter = (name: string) =>
        renderer.root.findAllByType('button').find((button) => button.props.children[0] === name)!;
      assert.equal(links().length, 3);
      assert.equal(links()[0].props.href, '#brain/agents/running');
      assert.equal(links()[1].props.href, '#brain/agents/review');
      await act(async () => filter('Running').props.onClick());
      assert.deepEqual(
        links().map((link) => link.props.href),
        ['#brain/agents/running'],
      );
      await act(async () => filter('To review').props.onClick());
      assert.deepEqual(
        links().map((link) => link.props.href),
        ['#brain/agents/review'],
      );
      await act(async () => filter('All analyses').props.onClick());
      const expand = () =>
        renderer.root
          .findAllByType('button')
          .find((button) => button.props['aria-controls'] === 'brain-activity-list')!;
      await act(async () => expand().props.onClick());
      assert.equal(expand().props['aria-expanded'], true);
      assert.equal(links().length, 6);
      await act(async () =>
        renderer.root.findByType('select').props.onChange({ target: { value: 'other' } }),
      );
      assert.deepEqual(
        links().map((link) => link.props.href),
        ['#brain/agents/review'],
      );
      await act(async () =>
        renderer.root.findByType('select').props.onChange({ target: { value: '' } }),
      );
      assert.equal(links().length, 3);
      assert.equal(expand().props['aria-expanded'], false);
    },
  );

  await t.test('board places the metric guide, live area and Brain analyses in order', async () => {
    const { default: App } = await vite.ssrLoadModule('/src/App.tsx');
    const html = renderToStaticMarkup(<App />);
    const guide = html.indexOf('id="metric-guide-title"');
    const live = html.indexOf('Live sessions');
    const empty = html.indexOf('No active tasks');
    const brain = html.indexOf('id="brain-activity-title"');
    assert.ok(guide >= 0 && live > guide);
    assert.ok(empty > live && brain > empty);
  });
});

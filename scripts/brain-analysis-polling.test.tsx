import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { act, create } from 'react-test-renderer';
import type { Analysis, AnalysisRun } from '../ui/src/components/brain/types';
import type { useProjectAnalyses } from '../ui/src/components/brain/useProjectAnalyses';

test('analysis summaries reload changed details without polling immutable captures or applying stale responses', async (t) => {
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
    for (const [name, descriptor] of [
      ['location', originalLocation],
      ['localStorage', originalStorage],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
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
  const hookModule = await vite.ssrLoadModule('/src/components/brain/useProjectAnalyses.ts');
  const hook: typeof useProjectAnalyses = hookModule.useProjectAnalyses;
  const { brainConfig } = await vite.ssrLoadModule('/src/components/brain/config.ts');
  const run: AnalysisRun = {
    id: 'newer',
    detailVersion: '1:current',
    projectId: 'dashboard',
    projectName: 'Dashboard',
    status: 'succeeded',
    stage: 'Complete',
    startedAt: '2026-09-16T10:00:00Z',
    model: 'test',
    events: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    findingCount: 0,
  };
  const runs = [run, { ...run, id: 'older', detailVersion: '1:historical' }];
  const pending: { id: string; respond: (response: Response) => void }[] = [];
  let detailRequests = 0;
  let summaryRequests = 0;
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    assert.equal(init?.method, 'GET');
    const path = new URL(input).pathname;
    if (path === '/api/brain/agents') {
      summaryRequests++;
      return Response.json({
        configured: true,
        reason: '',
        model: 'test',
        projects: [{ id: 'dashboard', name: 'Dashboard', scope: 'Exports', codePaths: [] }],
        runs,
        activeRunId: null,
      });
    }
    assert.match(path, /^\/api\/brain\/analyses\/(newer|older)$/);
    detailRequests++;
    return new Promise<Response>((respond) => {
      pending.push({ id: path.split('/').at(-1)!, respond });
    });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let current!: ReturnType<typeof useProjectAnalyses>;
  function Probe() {
    current = hook();
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<Probe />);
  });
  t.after(() => {
    act(() => renderer.unmount());
    t.mock.timers.reset();
  });

  async function respondNext(id: string, currentAnalysis = true) {
    const request = pending.shift()!;
    assert.equal(request.id, id);
    const analysis: Analysis = {
      ...run,
      id,
      sources: [],
      requirements: [],
      findings: [],
      current: currentAnalysis,
    };
    await act(async () => request.respond(Response.json(analysis)));
  }
  async function pollSummary() {
    await act(async () => t.mock.timers.tick(brainConfig.ui.pollIntervalMs));
  }

  assert.equal(detailRequests, 1);
  await respondNext('newer');
  await pollSummary();
  await pollSummary();
  assert.equal(summaryRequests, 3);
  assert.equal(detailRequests, 1, 'Unchanged summaries must not retransmit complete sources');

  run.detailVersion = '1:historical';
  await pollSummary();
  assert.equal(detailRequests, 2, 'Memory/currentness changes must refresh the selected result');
  await respondNext('newer', false);
  assert.equal(current.detail?.current, false);

  await act(async () => current.selectRun('older'));
  await act(async () => current.selectRun('newer'));
  assert.equal(detailRequests, 4);
  await respondNext('older', false);
  assert.equal(current.detail?.id, 'newer', 'A response from the previous selection is ignored');
  await respondNext('newer', false);

  run.detailVersion = '2:historical';
  await pollSummary();
  assert.equal(detailRequests, 5, 'A new stored revision must refresh detail');
  await respondNext('newer', false);
  await pollSummary();
  assert.equal(detailRequests, 5);

  let retry!: Promise<void>;
  await act(async () => {
    retry = current.retryDetail();
  });
  assert.equal(detailRequests, 6, 'Explicit retry remains available for an unchanged version');
  await respondNext('newer', false);
  await retry;
});

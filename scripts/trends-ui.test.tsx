import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { act, create } from 'react-test-renderer';

test('Trends retries failures, retains received data and cancels obsolete requests', async (t) => {
  let renderer: ReturnType<typeof create> | undefined;
  const restore: Array<() => void> = [];
  const requests: Array<{ signal: AbortSignal; complete: (response: Response) => void }> = [];
  let poll: (() => void) | undefined;
  let pollCleared = false;
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const intervalId = {} as ReturnType<typeof setInterval>;
  const replacements = {
    location: new URL('http://localhost/#trends'),
    localStorage: { getItem: () => null },
    fetch: (_url: string, options: RequestInit) =>
      new Promise<Response>((complete) => {
        requests.push({ signal: options.signal as AbortSignal, complete });
      }),
    setInterval: (callback: () => void, delay: number) => {
      if (delay === 30_000) {
        poll = callback;
        return intervalId;
      }
      return originalInterval(callback, delay);
    },
    clearInterval: (id: ReturnType<typeof setInterval>) => {
      if (id === intervalId) {
        pollCleared = true;
        return;
      }
      originalClear(id);
    },
  };
  const vite = await createServer({
    root: resolve('ui'),
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: 'custom',
    logLevel: 'error',
  });
  t.after(async () => {
    if (renderer) {
      await act(async () => renderer?.unmount());
    }
    for (const reset of restore) {
      reset();
    }
    await vite.close();
  });
  for (const [name, value] of Object.entries(replacements)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    restore.push(() => {
      if (original) {
        Object.defineProperty(globalThis, name, original);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    });
  }
  const { Trends } = await vite.ssrLoadModule('/src/components/Trends.tsx');
  await act(async () => {
    renderer = create(<Trends />);
  });
  const output = () => JSON.stringify(renderer!.toJSON());
  const button = () => renderer!.root.findByType('button');
  assert.equal(requests.length, 1);
  assert.equal(button().props.disabled, true);
  await act(async () => poll?.());
  assert.equal(requests.length, 1, 'polling cannot overlap an unfinished request');
  await act(async () => requests[0].complete(new Response('', { status: 503 })));
  assert.equal(button().props.children, 'Retry loading');
  assert.match(output(), /History could not be loaded/);
  await act(async () => button().props.onClick());
  const day = {
    day: '2026-09-22',
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    prompts: 1,
    sessions: 1,
    costKnown: false,
    tokensKnown: false,
    unknownUsageCount: 1,
    unattributedCostUsd: 0,
  };
  await act(async () =>
    requests[1].complete(
      new Response(
        JSON.stringify({
          enabled: true,
          backend: 'postgres',
          days: [
            day,
            {
              ...day,
              day: '2026-09-23',
              costUsd: 1.2,
              costKnown: true,
              tokensKnown: true,
              tokensIn: 100,
              tokensOut: 20,
              unknownUsageCount: 0,
            },
          ],
          byStream: [],
        }),
      ),
    ),
  );
  const rows = renderer!.root.findByType('tbody').findAllByType('tr');
  assert.deepEqual(
    rows[0].findAllByType('td').map((cell) => cell.props.children),
    ['Unavailable', 'Unavailable', 1, 1, 1],
  );
  assert.deepEqual(
    rows[1].findAllByType('td').map((cell) => cell.props.children),
    ['$1.20', '120', 1, 1, 0],
  );
  assert.doesNotMatch(output(), /PostgreSQL|SQLite/);
  assert.match(output(), /Session appearances/);
  await act(async () => poll?.());
  await act(async () => requests[2].complete(new Response('', { status: 500 })));
  assert.match(output(), /Showing the last received data/);
  assert.equal(renderer!.root.findByType('tbody').findAllByType('tr').length, 2);
  await act(async () => button().props.onClick());
  const pending = requests[3];
  assert.equal(pending.signal.aborted, false);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  assert.equal(pending.signal.aborted, true);
  assert.equal(pollCleared, true);
  await act(async () =>
    pending.complete(new Response(JSON.stringify({ enabled: true, days: [], byStream: [] }))),
  );
});

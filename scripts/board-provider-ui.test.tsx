import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { act, create } from 'react-test-renderer';
import type { Aggregate, SessionState } from '../ui/src/types';

test('Board filters sessions, summaries and live updates by AI provider', async (t) => {
  let renderer!: ReturnType<typeof create>;
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  const restoreGlobals: Array<() => void> = [];
  t.after(async () => {
    if (renderer) {
      await act(async () => renderer.unmount());
    }
    await vite?.close();
    for (const restore of restoreGlobals) {
      restore();
    }
  });
  class TestSocket {
    static latest: TestSocket;
    onmessage?: (message: { data: string }) => void;
    onopen?: () => void;
    onclose?: () => void;
    constructor() {
      TestSocket.latest = this;
    }
    close() {}
  }
  const browserEvents = new EventTarget();
  const replacements = {
    location: new URL('http://localhost/#board'),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: browserEvents.addEventListener.bind(browserEvents),
    removeEventListener: browserEvents.removeEventListener.bind(browserEvents),
    dispatchEvent: browserEvents.dispatchEvent.bind(browserEvents),
    WebSocket: TestSocket,
    fetch: async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes('/api/trends') ? { enabled: true, days: [], byStream: [] } : { runs: [] },
        ),
      ),
  };
  for (const [name, value] of Object.entries(replacements)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    restoreGlobals.push(() => {
      if (original) {
        Object.defineProperty(globalThis, name, original);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    });
  }
  vite = await createServer({
    root: resolve('ui'),
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: 'custom',
    logLevel: 'error',
  });
  const { default: App } = await vite.ssrLoadModule('/src/App.tsx');
  const { SessionCard } = await vite.ssrLoadModule('/src/components/SessionCard.tsx');
  const { AggregateBar } = await vite.ssrLoadModule('/src/components/AggregateBar.tsx');
  const { Directory } = await vite.ssrLoadModule('/src/components/Directory.tsx');
  const { SessionDetail } = await vite.ssrLoadModule('/src/components/SessionDetail.tsx');
  const { AgentMap } = await vite.ssrLoadModule('/src/components/AgentMap.tsx');

  const session = (provider: SessionState['provider']): SessionState => ({
    sessionId: `${provider}:session`,
    provider,
    teamId: `${provider}-stream`,
    agent: `${provider}-agent`,
    status: 'thinking',
    turnTokens: 0,
    turnCostUsd: 0,
    sessionTokens: 0,
    sessionCostUsd: 0,
    costKnown: false,
    tokensKnown: false,
    promptCount: 1,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
  });
  const aggregate = (costTodayUsd: number): Aggregate => ({
    activeSessions: 1,
    promptsLastHour: 1,
    costTodayUsd,
    costKnown: true,
    tokensKnown: false,
    tokensTodayInput: 0,
    tokensTodayOutput: 0,
    unknownUsageCount: 0,
    editWriteAccepts: 0,
    editWriteRejects: 0,
    recentErrors: [],
  });
  const claude = session('claude');
  const codex = session('codex');
  const summary = { claude: aggregate(2), codex: aggregate(5) };
  await act(async () => {
    renderer = create(<App />);
  });
  const publish = async (
    type: 'snapshot' | 'sessions',
    sessions: SessionState[],
    withSummary = true,
    total = aggregate(7),
  ) => {
    await act(async () =>
      TestSocket.latest.onmessage?.({
        data: JSON.stringify({
          type,
          sessions,
          aggregate: total,
          providerAggregates: withSummary ? summary : undefined,
          recentEvents: [],
        }),
      }),
    );
  };
  const cards = () => renderer.root.findAllByType(SessionCard);
  const cardProviders = () => cards().map((card) => card.props.s.provider);
  const providerButton = (label: string) =>
    renderer.root
      .findByProps({ 'aria-label': 'Filter by AI provider' })
      .findAllByType('button')
      .find((button) => button.props.children === label)!;
  const click = async (label: string) => {
    await act(async () => providerButton(label).props.onClick());
    assert.equal(providerButton(label).props['aria-pressed'], true);
    assert.equal(
      ['All AI', 'Claude', 'Codex'].filter((name) => providerButton(name).props['aria-pressed'])
        .length,
      1,
    );
  };
  const cost = () => renderer.root.findByType(AggregateBar).props.agg?.costTodayUsd;

  await publish('snapshot', [claude, codex]);
  assert.deepEqual(cardProviders(), ['claude', 'codex']);
  assert.equal(cost(), 7);
  await click('Claude');
  assert.deepEqual(cardProviders(), ['claude']);
  assert.equal(cost(), 2);
  assert.deepEqual(renderer.root.findByType(Directory).props.sessions, [claude]);

  await act(async () =>
    renderer.root
      .findByType(Directory)
      .props.onSelect({ stream: claude.teamId, agent: claude.agent }),
  );
  await act(async () => cards()[0].props.onClick());
  assert.equal(renderer.root.findAllByType(SessionDetail).length, 1);
  await click('Codex');
  assert.deepEqual(
    cardProviders(),
    ['codex'],
    'changing AI clears an incompatible directory selection',
  );
  assert.equal(cost(), 5);
  assert.equal(renderer.root.findAllByType(SessionDetail).length, 0);
  assert.deepEqual(renderer.root.findByType(Directory).props.selection, {
    stream: null,
    agent: null,
  });

  summary.codex = aggregate(6);
  await publish('sessions', [claude, codex, { ...codex, sessionId: 'codex:new' }]);
  assert.deepEqual(cardProviders(), ['codex', 'codex']);
  assert.equal(cost(), 6);
  await click('All AI');
  assert.equal(cards().length, 3);
  assert.equal(cost(), 7);

  await click('Codex');
  await publish('sessions', [claude]);
  assert.equal(cards().length, 0);
  assert.equal(cost(), 6, 'daily cost survives session removal');
  assert.equal(
    renderer.root.findByProps({ className: 'empty-title' }).props.children,
    'No matching sessions',
  );
  const clear = renderer.root
    .findAllByType('button')
    .find((button) => button.props.children === 'Clear filters')!;
  await act(async () => clear.props.onClick());
  assert.deepEqual(cardProviders(), ['claude']);
  assert.equal(providerButton('All AI').props['aria-pressed'], true);

  await publish('snapshot', [claude], false);
  await click('Claude');
  assert.equal(
    cost(),
    undefined,
    'an older server must not display global totals for a selected AI',
  );

  await click('All AI');
  const root = { ...codex, sessionRole: 'main' as const, status: 'idle' as const };
  const child = {
    ...codex,
    sessionId: 'codex:child',
    sessionRole: 'subagent' as const,
    parentSessionId: root.sessionId,
    teamId: 'different-child-stream',
    agent: 'child-agent',
  };
  const check = {
    ...child,
    sessionId: 'codex:check',
    parentSessionId: child.sessionId,
    sessionRole: 'internal' as const,
    agentType: 'Approval check',
  };
  const unknown = {
    ...codex,
    sessionId: 'codex:unknown',
    sessionRole: 'unknown' as const,
    promptCount: 0,
  };
  const inactive = { ...claude, status: 'idle' as const };
  await publish('sessions', [unknown, check, child, root, inactive]);
  assert.equal(cards().length, 1, 'only the active main task gets a prominent card');
  assert.equal(cards()[0].props.s.sessionId, root.sessionId);
  assert.equal(cards()[0].props.group.children.length, 2);
  assert.equal(renderer.root.findByType(AggregateBar).props.agg.activeSessions, 1);
  assert.equal(
    renderer.root.findAllByType('details').length,
    2,
    'inactive and unlinked work is collapsed',
  );
  assert.ok(renderer.root.findAllByType('details').every((item) => !item.props.open));
  await act(async () =>
    renderer.root.findByType(Directory).props.onSelect({ stream: root.teamId, agent: root.agent }),
  );
  await act(async () => cards()[0].props.onClick());
  let detail = renderer.root.findByType(SessionDetail);
  assert.equal(
    detail.props.group.children.length,
    2,
    'directory selection retains children with different attribution',
  );
  await act(async () => detail.props.onSelect(child.sessionId));
  detail = renderer.root.findByType(SessionDetail);
  assert.equal(detail.props.session.sessionId, child.sessionId);
  assert.equal(detail.props.group.root.sessionId, root.sessionId);
  assert.ok(
    detail
      .findAllByType('button')
      .some((button) => button.props.children === '← Back to main task'),
  );
  await publish('sessions', [
    unknown,
    { ...check, status: 'idle' },
    { ...child, status: 'idle' },
    root,
    inactive,
  ]);
  assert.equal(
    cards().length,
    0,
    'finished delegated work moves the main task into the inactive list',
  );
  assert.equal(
    renderer.root.findByType(AggregateBar).props.agg.activeSessions,
    0,
    'unclassified activity never inflates main task count',
  );

  await click('Codex');
  const navigate = async (label: string) => {
    const button = renderer.root
      .findByProps({ className: 'viewswitch' })
      .findAllByType('button')
      .find((entry) => entry.props.children === label)!;
    await act(async () => button.props.onClick());
  };
  await navigate('Trends');
  assert.equal(renderer.root.findAllByProps({ 'aria-label': 'Filter by AI provider' }).length, 0);
  assert.equal(renderer.root.findAllByType(Directory).length, 0);
  assert.equal(renderer.root.findAllByType(SessionDetail).length, 0);
  assert.equal(cost(), 7, 'global history must not show a provider-filtered KPI');
  assert.equal(renderer.root.findByType(AggregateBar).props.provider, undefined);
  assert.match(JSON.stringify(renderer.toJSON()), /all providers and streams/);
  await navigate('Board');
  assert.equal(providerButton('Codex').props['aria-pressed'], true);
  assert.equal(cost(), 6, 'returning to the board restores its provider selection');

  await t.test(
    'multi-team tasks are filterable by each team while totals stay unique',
    async () => {
      await click('All AI');
      const shared = {
        ...codex,
        teams: [
          { id: 'team-alpha', name: 'Alpha' },
          { id: 'team-beta', name: 'Beta' },
        ],
        sessionTokens: 12000,
        tokensKnown: true,
      };
      const total = { ...aggregate(7), tokensKnown: true, tokensTodayInput: 12000 };
      await publish('sessions', [shared, claude], true, total);
      assert.equal(cards().length, 3, 'the shared task appears in both teams');
      assert.equal(cards().filter((card) => card.props.s.sessionId === shared.sessionId).length, 2);
      assert.equal(renderer.root.findByType(AggregateBar).props.agg.activeSessions, 2);
      assert.equal(renderer.root.findByType(AggregateBar).props.agg.tokensTodayInput, 12000);
      assert.equal(cost(), 7);
      assert.deepEqual(
        renderer.root.findAllByProps({ className: 'active-task-count' })[0].props.children,
        [2, ' active ', 'tasks'],
      );
      const directoryNames = () =>
        renderer.root
          .findByType(Directory)
          .findAllByProps({ className: 'dir-stream-name' })
          .map((name) => name.props.children);
      assert.deepEqual(directoryNames(), ['Alpha', 'Beta', 'claude-stream']);
      const select = async (stream: string | null, agent: string | null = null) => {
        await act(async () =>
          renderer.root.findByType(Directory).props.onSelect({ stream, agent }),
        );
      };
      await select('team-beta');
      assert.equal(cards().length, 1, 'the second membership is selectable');
      assert.equal(
        renderer.root.findByProps({ className: 'scopebar' }).findByType('strong').props.children,
        'Beta',
      );
      assert.deepEqual(
        renderer.root
          .findAllByProps({ className: 'stream-head' })
          .map((head) => head.findByType('h2').props.children),
        ['Beta'],
      );
      await select('team-beta', shared.agent);
      assert.equal(
        renderer.root.findByType(Directory).findAllByProps({ className: 'dir-agent sel' }).length,
        1,
        'the same agent in another team is not highlighted',
      );
      await act(async () => cards()[0].props.onClick());
      assert.match(
        renderer.root
          .findByType(SessionDetail)
          .findByProps({ className: 'drawer-sub' })
          .props.children.join(''),
        /Alpha, Beta/,
      );
      const renamed = {
        ...shared,
        teams: [shared.teams[0], { id: 'team-beta', name: 'Beta renamed' }],
      };
      await publish('sessions', [renamed, claude], true, total);
      assert.equal(cards().length, 1, 'renaming a team preserves selection by ID');
      assert.ok(directoryNames().includes('Beta renamed'));
      await navigate('Map');
      assert.equal(renderer.root.findByType(AgentMap).findAllByType('button').length, 1);
      assert.match(
        renderer.root.findByProps({ className: 'map-cluster-label' }).props.children.join(''),
        /Beta renamed/,
      );
      await select(null);
      assert.equal(renderer.root.findByType(AgentMap).findAllByType('button').length, 3);
      await publish('sessions', [{ ...shared, teams: [] }, claude], true, total);
      assert.deepEqual(directoryNames(), ['claude-stream', 'No team']);
      await select('unassigned');
      await navigate('Board');
      assert.equal(cards().length, 1, 'clearing membership overrides stale legacy teamId');
      assert.equal(
        renderer.root.findByProps({ className: 'stream-head' }).findByType('h2').props.children,
        'No team',
      );
      await act(async () => cards()[0].props.onClick());
      assert.match(
        renderer.root
          .findByType(SessionDetail)
          .findByProps({ className: 'drawer-sub' })
          .props.children.join(''),
        /No team/,
      );
      await publish('sessions', [codex, claude]);
      assert.equal(cards().length, 0, 'legacy team attribution does not match No team');
      await select(codex.teamId!);
      assert.deepEqual(cardProviders(), ['codex']);
      assert.ok(
        directoryNames().includes('codex-stream'),
        'legacy sessions retain their team label',
      );
    },
  );

  await t.test(
    'replacing dashboard credentials ignores late messages and closure from the old socket',
    async () => {
      const { useDashboard, setDashboardToken } = await vite!.ssrLoadModule('/src/api/ws.ts');
      let current: { connected: boolean; sessions: SessionState[] };
      function Probe() {
        current = useDashboard();
        return null;
      }
      await act(async () => renderer.unmount());
      await act(async () => {
        renderer = create(<Probe />);
      });
      const previous = TestSocket.latest;
      await act(async () => previous.onopen?.());
      await publish('snapshot', [claude]);
      assert.equal(current!.sessions.length, 1);
      await act(async () => setDashboardToken('replacement-viewer-token'));
      assert.equal(current!.connected, false);
      assert.equal(current!.sessions.length, 0);
      assert.notEqual(TestSocket.latest, previous);
      await act(async () => TestSocket.latest.onopen?.());
      await publish('snapshot', [codex]);
      await act(async () => {
        previous.onmessage?.({
          data: JSON.stringify({ type: 'sessions', sessions: [claude], aggregate: aggregate(2) }),
        });
        previous.onclose?.();
      });
      assert.equal(current!.connected, true);
      assert.deepEqual(
        current!.sessions.map((session) => session.provider),
        ['codex'],
      );
    },
  );
});

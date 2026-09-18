import assert from 'node:assert/strict';
import test from 'node:test';
import { groupSessions } from './session-hierarchy.js';
import { Store } from './store/store.js';
import { config } from './config.js';
import type { SessionState, AgentEvent } from './types.js';

function session(id: string, extra: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: `codex:${id}`,
    provider: 'codex',
    status: 'idle',
    promptCount: 0,
    turnTokens: 0,
    turnCostUsd: 0,
    sessionTokens: 0,
    sessionCostUsd: 0,
    tokensKnown: false,
    costKnown: false,
    startedAt: 1,
    lastEventAt: 1,
    ...extra,
  };
}

test('groups nested descendants under one main task, with delegated activity and separate usage', () => {
  const root = session('root', { sessionRole: 'main', sessionTokens: 100 });
  const child = session('child', {
    parentSessionId: root.sessionId,
    sessionRole: 'subagent',
    sessionTokens: 20,
  });
  const nested = session('nested', {
    parentSessionId: child.sessionId,
    sessionRole: 'internal',
    status: 'thinking',
    lastEventAt: 5,
  });
  const { groups, unlinked } = groupSessions([nested, child, root]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].active, true);
  assert.equal(groups[0].lastEventAt, 5);
  assert.equal(
    groups[0].root.sessionTokens,
    100,
    'does not add potentially inclusive child accounting',
  );
  assert.deepEqual(
    groups[0].children.map((item) => item.sessionId),
    [nested.sessionId, child.sessionId],
  );
  assert.deepEqual(unlinked, []);
});

test('unknown, internal, missing-parent, cross-provider and cyclic sessions never become extra main tasks', () => {
  const items = [
    session('main', { sessionRole: 'main' }),
    session('internal', { sessionRole: 'internal', promptCount: 3, status: 'thinking' }),
    session('unknown', { status: 'tool' }),
    session('missing', { parentSessionId: 'codex:absent' }),
    session('a', { parentSessionId: 'codex:b' }),
    session('b', { parentSessionId: 'codex:a' }),
    session('other', { provider: 'claude', parentSessionId: 'codex:main' }),
  ];
  const result = groupSessions(items);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].active, false);
  assert.equal(result.unlinked.length, 6);
});

test('store keeps stopped children in the detail and counts only active main task groups', (t) => {
  const store = new Store();
  t.after(() => store.close());
  let sequence = 0;
  const send = (extra: Partial<AgentEvent>) =>
    store.ingest({
      id: `hierarchy-${++sequence}`,
      ts: Date.now(),
      kind: 'activity',
      provider: 'codex',
      sessionId: 'root',
      subtype: 'session_start',
      ...extra,
    });
  send({ sessionRole: 'main' });
  send({
    subtype: 'subagent_start',
    sessionId: 'child',
    parentSessionId: 'root',
    sessionRole: 'subagent',
    agentType: 'explorer',
  });
  send({
    subtype: 'subagent_start',
    sessionId: 'check',
    parentSessionId: 'child',
    sessionRole: 'internal',
  });
  send({ kind: 'user_prompt', sessionId: 'unlinked-internal', sessionRole: 'internal' });
  assert.equal(store.getAggregate().activeSessions, 1);
  assert.equal(store.getProviderAggregates().claude.activeSessions, 0);
  send({ subtype: 'subagent_stop', sessionId: 'child', parentSessionId: 'root' });
  assert.equal(
    store.getAggregate().activeSessions,
    1,
    'nested internal work still belongs to the main task',
  );
  send({ subtype: 'subagent_stop', sessionId: 'check' });
  assert.equal(store.getAggregate().activeSessions, 0);
  send({ kind: 'api_request', sessionId: 'child', inputTokens: 10, outputTokens: 2 });
  const child = store.getSessions().find((item) => item.rawSessionId === 'child')!;
  assert.equal(child.parentSessionId, 'codex:root');
  assert.equal(child.status, 'idle');
  assert.ok(child.endedAt);
  assert.equal(child.sessionTokens, 12);
  assert.equal(store.getAggregate().activeSessions, 0, 'late usage does not revive finished work');
  for (const subtype of ['pre_tool', 'post_tool'] as const) {
    send({ subtype, sessionId: 'child', toolName: 'File read' });
    assert.equal(child.status, 'idle', `${subtype} cannot revive a stopped subagent`);
    assert.equal(store.getAggregate().activeSessions, 0);
  }
  send({ subtype: 'subagent_start', sessionId: 'child' });
  assert.equal(store.getAggregate().activeSessions, 1);
  assert.equal(child.endedAt, undefined);
});

test('a main task remains visible while linked children still report activity', (t) => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: start });
  const store = new Store();
  t.after(() => store.close());
  store.ingest({
    id: 'old-root',
    ts: start,
    kind: 'activity',
    subtype: 'session_start',
    provider: 'codex',
    sessionId: 'root',
    sessionRole: 'main',
  });
  t.mock.timers.tick(config.sessionTtlMs - 10000);
  store.ingest({
    id: 'new-child',
    ts: Date.now(),
    kind: 'activity',
    subtype: 'subagent_start',
    provider: 'codex',
    sessionId: 'child',
    parentSessionId: 'root',
    sessionRole: 'subagent',
  });
  t.mock.timers.tick(15000);
  assert.equal(store.getSessions().length, 2);
  assert.equal(store.getAggregate().activeSessions, 1);
  t.mock.timers.tick(config.sessionTtlMs + 5000);
  assert.equal(store.getSessions().length, 0);
});

test('expiry retains every ancestor of a working nested subagent, then evicts the whole stale chain', (t) => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: start });
  const store = new Store();
  t.after(() => store.close());
  for (const [id, parent] of [
    ['root', undefined],
    ['middle', 'root'],
  ] as const) {
    store.ingest({
      id,
      ts: start,
      kind: 'activity',
      subtype: 'session_start',
      provider: 'codex',
      sessionId: id,
      parentSessionId: parent,
      sessionRole: parent ? 'subagent' : 'main',
    });
  }
  t.mock.timers.tick(config.sessionTtlMs - 10000);
  store.ingest({
    id: 'leaf',
    ts: Date.now(),
    kind: 'activity',
    subtype: 'subagent_start',
    provider: 'codex',
    sessionId: 'leaf',
    parentSessionId: 'middle',
    sessionRole: 'subagent',
  });
  t.mock.timers.tick(15000);
  const grouped = groupSessions(store.getSessions());
  assert.equal(grouped.groups.length, 1);
  assert.equal(grouped.groups[0].active, true);
  assert.equal(grouped.groups[0].children.length, 2);
  assert.equal(grouped.unlinked.length, 0);
  t.mock.timers.tick(config.sessionTtlMs + 5000);
  assert.equal(store.getSessions().length, 0);
});

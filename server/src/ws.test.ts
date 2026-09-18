import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { Store } from './store/store.js';
import { registerWebSocket } from './ws.js';
import type { ServerMessage, SnapshotMessage, SessionsMessage } from './types.js';

test(
  'WebSocket snapshots and live updates include independent provider summaries',
  { timeout: 5000 },
  async () => {
    const app = Fastify();
    const store = new Store();
    await app.register(websocket);
    registerWebSocket(app, store);
    await app.ready();
    let receiveSnapshot!: (message: SnapshotMessage) => void;
    let receiveUpdate!: (message: SessionsMessage) => void;
    const snapshot = new Promise<SnapshotMessage>((resolve) => {
      receiveSnapshot = resolve;
    });
    const update = new Promise<SessionsMessage>((resolve) => {
      receiveUpdate = resolve;
    });
    const socket = await app.injectWS(
      '/live',
      {},
      {
        onInit(client) {
          client.on('message', (data: Buffer) => {
            const message = JSON.parse(data.toString()) as ServerMessage;
            if (message.type === 'snapshot') {
              receiveSnapshot(message);
            } else if (message.type === 'sessions') {
              receiveUpdate(message);
            }
          });
        },
      },
    );
    try {
      const initial = await snapshot;
      assert.equal(initial.providerAggregates?.claude.activeSessions, 0);
      assert.equal(initial.providerAggregates?.codex.activeSessions, 0);
      store.ingest({
        id: 'codex-prompt',
        ts: Date.now(),
        kind: 'activity',
        subtype: 'prompt_submit',
        provider: 'codex',
        sessionId: 'provider-filter-session',
      });
      const current = await update;
      assert.equal(current.aggregate.activeSessions, 1);
      assert.equal(current.providerAggregates?.codex.activeSessions, 1);
      assert.equal(current.providerAggregates?.codex.promptsLastHour, 1);
      assert.equal(current.providerAggregates?.claude.activeSessions, 0);
      assert.equal(current.providerAggregates?.claude.promptsLastHour, 0);
    } finally {
      socket.terminate();
      store.close();
      await app.close();
    }
  },
);

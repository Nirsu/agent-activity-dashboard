import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { Store } from './store/store.js';
import type { ServerMessage } from './types.js';

/** Registers WS /live and broadcasts store changes to all connected clients. */
export function registerWebSocket(app: FastifyInstance, store: Store): void {
  const clients = new Set<WebSocket>();

  const send = (ws: WebSocket, msg: ServerMessage) => {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* client gone; cleaned up on close */
    }
  };
  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      try {
        ws.send(data);
      } catch {
        /* ignore */
      }
    }
  };

  store.on('event', (event) => broadcast({ type: 'event', event }));
  store.on('sessions', (sessions, aggregate) =>
    broadcast({
      type: 'sessions',
      sessions,
      aggregate,
      providerAggregates: store.getProviderAggregates(),
    }),
  );

  app.get('/live', { websocket: true }, (socket) => {
    clients.add(socket);
    send(socket, {
      type: 'snapshot',
      sessions: store.getSessions(),
      aggregate: store.getAggregate(),
      providerAggregates: store.getProviderAggregates(),
      recentEvents: store.getRecentEvents(100),
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });
}

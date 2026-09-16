import { gunzipSync } from 'node:zlib';
import { appendFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { Store } from './store/store.js';
import { parseLogs, parseMetrics } from './otlp/parse.js';
import { registerWebSocket } from './ws.js';
import { history } from './db.js';
import { cachedTitle, isTicketKey, resolveTitle } from './jira.js';
import { DeliveryService, type DeliverySettingsInput } from './delivery.js';
import { registerBrain } from './brain.js';
import type { ActivitySubtype, AgentEvent } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = resolve(config.dataDir, 'cost-ledger.jsonl');
const LEGACY_DORA_PATH = resolve(__dirname, '../../analytics/baseline/out/latest-dora.json');

let activitySeq = 0;
let historyInitialized = false;
let historyUsers = 0;

const nextActivityId = (suffix: string) =>
  `${Date.now().toString(36)}-${(++activitySeq).toString(36)}-${suffix}`;

interface ActivityBody {
  event?: ActivitySubtype;
  session_id?: string;
  user?: string;
  team_id?: string;
  department?: string;
  repo?: string;
  branch?: string;
  ticket?: string;
  cwd?: string;
  tool_name?: string;
  provider?: 'claude' | 'codex';
  client?: 'cli' | 'desktop' | 'vscode' | 'unknown';
}

// Tokens are read from headers only. A token in the query string ends up in
// browser history, referrers, screenshots, proxy and access logs, so `?token=`
// is deliberately NOT accepted. Browsers cannot set headers on a WebSocket
// handshake, so /live carries it in the Sec-WebSocket-Protocol header instead.
export const WS_TOKEN_PROTOCOL_PREFIX = 'aad-token.';

export function presentedToken(req: { headers: Record<string, unknown> }): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  const hdr = req.headers['x-aad-token'];
  if (typeof hdr === 'string') return hdr;
  const proto = req.headers['sec-websocket-protocol'];
  if (typeof proto === 'string') {
    for (const entry of proto.split(',')) {
      const value = entry.trim();
      if (value.startsWith(WS_TOKEN_PROTOCOL_PREFIX)) {
        return decodeURIComponent(value.slice(WS_TOKEN_PROTOCOL_PREFIX.length));
      }
    }
  }
  return undefined;
}

async function readDoraPayload(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(config.delivery.latestDoraPath, 'utf8'));
  } catch {
    return JSON.parse(await readFile(LEGACY_DORA_PATH, 'utf8'));
  }
}

async function ensureHistoryInit(): Promise<void> {
  if (historyInitialized) return;
  await history.init();
  historyInitialized = true;
}

export async function buildApp(options: { deliveryService?: DeliveryService } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 16 * 1024 * 1024 });
  const store = new Store();
  const delivery = options.deliveryService ?? new DeliveryService({ logger: app.log });

  if (process.env.COST_LEDGER !== '0') {
    store.on('usage', (rec) => {
      if (!rec.ticket || !rec.dUsd) return;
      appendFile(
        LEDGER_PATH,
        JSON.stringify({
          ts: rec.ts,
          sessionId: rec.sessionId,
          provider: rec.provider,
          client: rec.client,
          ticket: rec.ticket,
          repo: rec.repo,
          teamId: rec.teamId,
          dUsd: rec.dUsd,
        }) + '\n',
      ).catch((err) => app.log.warn({ err: String(err) }, 'cost-ledger append failed'));
    });
  }

  await ensureHistoryInit();
  historyUsers += 1;
  app.addHook('onClose', async () => {
    store.removeAllListeners();
    historyUsers -= 1;
    if (historyUsers === 0) { history.close(); historyInitialized = false; }
  });
  if (history.enabled) {
    store.restoreCumulative(history.loadCumulative());
    store.hydrateToday(history.todayTotals());
    store.on('event', (e) => history.recordEvent(e));
    store.on('usage', (u) => history.recordUsage(u));
    store.on('cumulative', (c) => history.recordCumulative(c.sessionId, c.cost, c.tokens, c.ts));
    app.log.info('history persistence enabled');
  }
  await delivery.init();

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    const originAllowed =
      !origin ||
      (() => {
        try {
          const url = new URL(origin);
          return url.host === host || url.hostname === '127.0.0.1' || url.hostname === 'localhost';
        } catch {
          return false;
        }
      })();
    if (origin && originAllowed) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
    }
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'content-type,content-encoding,authorization,x-aad-token');
    if (req.method === 'OPTIONS') {
      return originAllowed
        ? reply.code(204).send()
        : reply.code(403).send({ error: 'origin not allowed' });
    }
    if (
      !originAllowed &&
      req.url.startsWith('/api/delivery') &&
      req.method !== 'GET'
    ) {
      return reply.code(403).send({ error: 'origin not allowed' });
    }
  });

  const ingestRoutes = new Set(['/v1/logs', '/v1/metrics', '/v1/traces', '/activity']);
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    const isIngest = ingestRoutes.has(path);
    const isViewer = path.startsWith('/api/') || path === '/live';
    const required = isIngest ? config.ingestToken : isViewer ? config.viewerToken : undefined;
    if (required && presentedToken(req) !== required) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.addContentTypeParser(
    ['application/json', 'application/x-protobuf', 'application/octet-stream', '*'],
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      try {
        let buf = body;
        if (req.headers['content-encoding']?.includes('gzip') && buf.length) {
          buf = gunzipSync(buf);
        }
        if (!buf.length) return done(null, {});
        done(null, JSON.parse(buf.toString('utf8')));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // `ws` must echo one of the client's offered subprotocols; without this the
  // browser closes the connection immediately after a successful handshake.
  await app.register(websocket, {
    options: {
      handleProtocols: (protocols: Set<string>) => {
        for (const p of protocols) if (p.startsWith(WS_TOKEN_PROTOCOL_PREFIX)) return p;
        return false;
      },
    },
  });
  registerWebSocket(app, store);

  app.post('/v1/logs', async (req, reply) => {
    store.ingestMany(parseLogs(req.body));
    return reply.send({});
  });
  app.post('/v1/metrics', async (req, reply) => {
    store.ingestMany(parseMetrics(req.body));
    return reply.send({});
  });
  app.post('/v1/traces', async (_req, reply) => reply.send({}));

  app.post('/activity', async (req, reply) => {
    const b = (req.body ?? {}) as ActivityBody;
    if (!b.session_id || !b.event) {
      return reply.code(400).send({ error: 'session_id and event are required' });
    }
    const branchKey = b.branch?.match(/[A-Z][A-Z0-9]+-\d+/)?.[0];
    const ticket = isTicketKey(b.ticket) ? b.ticket : isTicketKey(branchKey) ? branchKey : undefined;
    const ev: AgentEvent = {
      id: nextActivityId('act'),
      ts: Date.now(),
      kind: 'activity',
      provider: b.provider === 'codex' ? 'codex' : 'claude',
      client: b.client,
      subtype: b.event,
      sessionId: b.session_id,
      userEmail: b.user,
      teamId: b.team_id,
      department: b.department,
      repo: b.repo,
      branch: b.branch,
      ticket,
      ticketTitle: ticket ? cachedTitle(ticket) : undefined,
      cwd: b.cwd,
      toolName: b.tool_name,
    };
    store.ingest(ev);
    if (ticket) {
      void resolveTitle(ticket).then((title) => {
        if (title && title !== ticket) {
          store.ingest({
            id: nextActivityId('title'),
            ts: Date.now(),
            kind: 'activity',
            provider: b.provider === 'codex' ? 'codex' : 'claude',
            client: b.client,
            subtype: 'context_update',
            sessionId: b.session_id,
            ticket,
            ticketTitle: title,
          });
        }
      });
    }
    return reply.send({ ok: true });
  });

  app.get('/healthz', async () => ({
    ok: true,
    sessions: store.getSessions().length,
    events: store.getRecentEvents().length,
  }));
  app.get('/api/state', async () => ({
    sessions: store.getSessions(),
    aggregate: store.getAggregate(),
    recentEvents: store.getRecentEvents(100),
  }));
  app.get<{ Params: { promptId: string } }>('/api/prompt/:promptId', async (req) => ({
    events: store.getPromptEvents(req.params.promptId),
  }));
  app.get<{ Querystring: { days?: string } }>('/api/trends', async (req) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    return history.trends(days);
  });
  app.get<{ Params: { agent: string } }>('/api/history/agent/:agent', async (req) =>
    history.agentHistory(req.params.agent),
  );

  app.get('/api/dora', async (_req, reply) => {
    try {
      return await readDoraPayload();
    } catch {
      return reply.code(404).send({ error: 'no metrics yet — connect delivery data and run an import' });
    }
  });

  app.get('/api/delivery', async () => delivery.getState());
  app.get('/api/delivery/imports', async () => {
    const state = await delivery.getState();
    return { activeRun: state.activeRun, runs: state.runs };
  });
  app.put<{ Body: DeliverySettingsInput }>('/api/delivery/settings', async (req, reply) => {
    try {
      const settings = await delivery.saveSettings(req.body);
      return reply.send({ settings });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid delivery settings' });
    }
  });
  app.delete('/api/delivery/settings', async () => {
    await delivery.deleteSettings();
    return { ok: true };
  });
  app.post<{ Body: DeliverySettingsInput | undefined }>('/api/delivery/test', async (req, reply) => {
    try {
      return await delivery.testConnections(req.body);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'delivery connection test failed' });
    }
  });
  app.post<{ Body: { startDate?: string } | undefined }>('/api/delivery/imports', async (req, reply) => {
    try {
      const run = await delivery.startImport(req.body?.startDate);
      return reply.code(202).send(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'delivery import failed to start';
      const statusCode = /already running/i.test(message) ? 409 : 400;
      return reply.code(statusCode).send({ error: message });
    }
  });

  await registerBrain(app);
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await buildApp();
  app
    .listen({ port: config.port, host: config.host })
    .then((addr) => app.log.info(`Agent Activity Dashboard server on ${addr} (ws /live)`))
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}

import { gunzipSync } from 'node:zlib';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { Store } from './store/store.js';
import { PROMPT_WINDOW_MS, PROMPT_PAIR_WINDOW_MS } from './store/prompts.js';
import { openCodexMetadata } from './codex-metadata.js';
import { safeId, safeLabel } from './session-metadata.js';
import { parseLogs, parseMetrics } from './otlp/parse.js';
import { registerWebSocket } from './ws.js';
import { history } from './db.js';
import { closePostgresPool } from './persistence/postgres.js';
import { PersistenceQueue } from './persistence/queue.js';
import { cachedTitle, isTicketKey, resolveTitle } from './jira.js';
import { registerBrain } from './brain.js';
import { isBrainCallback } from './brain/access.js';
import { AccessStore } from './access/store.js';
import { registerAccessRoutes } from './access/routes.js';
import { ProjectRegistry } from './brain/project-registry.js';
import { attributeEvent } from './access/identity.js';
import { normalizeRepositoryRemote } from './access/repositories.js';
import type { FastifyRequest } from 'fastify';
import type { ActivitySubtype, AgentEvent, UsageDelta } from './types.js';
import type { BrainActivity } from './brain/analysis/types.js';
import { PricingService } from './brain/pricing/service.js';
import { brainConfig } from './brain/config.js';
import { estimateModelCost } from './model-cost.js';

const LEDGER_PATH = resolve(config.dataDir, 'cost-ledger.jsonl');

let activitySeq = 0;
let historyInitialized = false;
let historyUsers = 0;
let historyLifecycle: Promise<void> = Promise.resolve();

const nextActivityId = (suffix: string) =>
  `${Date.now().toString(36)}-${(++activitySeq).toString(36)}-${suffix}`;

interface ActivityBody {
  event_id?: string;
  timestamp?: number;
  event?: ActivitySubtype;
  session_id?: string;
  parent_session_id?: string;
  session_role?: 'main' | 'subagent' | 'internal' | 'unknown';
  agent_type?: string;
  prompt_id?: string;
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
  project_id?: string;
  work_item_id?: string;
  run_id?: string;
  parent_run_id?: string;
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

function isLocalRequest(request: FastifyRequest) {
  return (
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip) &&
    /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(request.headers.host ?? '')
  );
}

async function acquireHistory(): Promise<void> {
  historyUsers += 1;
  const initialization = historyLifecycle.then(async () => {
    if (!historyInitialized) {
      await history.init();
      historyInitialized = true;
    }
  });
  historyLifecycle = initialization.catch(() => undefined);
  await initialization;
}

async function releaseHistory(): Promise<void> {
  historyUsers -= 1;
  const shutdown = historyLifecycle.then(async () => {
    if (historyUsers !== 0) {
      return;
    }
    try {
      await history.close();
    } finally {
      historyInitialized = false;
      await closePostgresPool();
    }
  });
  historyLifecycle = shutdown.catch(() => undefined);
  await shutdown;
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: [
        'req.headers.authorization',
        'req.headers.x-aad-token',
        'req.headers.x-brain-admin-token',
      ],
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url?.split('?')[0],
            remoteAddress: request.ip,
          };
        },
      },
    },
    bodyLimit: 16 * 1024 * 1024,
  });
  const store = new Store();
  const access = new AccessStore(resolve(config.dataDir, 'access.db'));
  const pricing = new PricingService(access.storage, {
    onUsage: async (jobId, model, result) => {
      const usage: UsageDelta = {
        usageId: `pricing:${jobId}:${model}`,
        source: 'brain',
        provider: 'brain',
        ts: Date.now(),
        runId: jobId,
        model: result.model ?? process.env.BRAIN_MODEL,
        dUsd: result.usageKnown ? estimateModelCost(result) : null,
        dTokensIn: result.usageKnown ? result.inputTokens : null,
        dTokensOut: result.usageKnown ? result.outputTokens : null,
        costStatus:
          result.usageKnown && estimateModelCost(result) !== null ? 'estimated' : 'unknown',
      };
      writes.enqueue(() => persistUsage(usage));
      await writes.flush();
    },
  });
  app.decorateRequest('accessPrincipal', null);
  app.decorateRequest('authorizedRepository', null);
  function ingestEvent(event: AgentEvent, request: FastifyRequest) {
    const principal = request.accessPrincipal;
    // Async enrichment can finish after an administrator changes team memberships.
    const attributed = attributeEvent(
      event,
      principal
        ? { ...principal, teams: access.teamsForAccount(principal.account.id) ?? [] }
        : principal,
    );
    return request.authorizedRepository
      ? {
          ...attributed,
          repo: request.authorizedRepository.name,
          projectId: request.authorizedRepository.brainProjectId,
        }
      : attributed;
  }
  const codexMetadata = openCodexMetadata(config.codexMetadataDb);
  if (config.codexMetadataDb && !codexMetadata.available)
    app.log.warn('Local Codex metadata is unavailable; sessions will use reported telemetry only.');
  const writes = new PersistenceQueue(() =>
    app.log.error('Activity persistence failed; ingestion requires recovery.'),
  );
  async function persistUsage(usage: UsageDelta): Promise<void> {
    pricing.observeModels([usage]);
    const inserted = await history.recordUsage(usage);
    if (inserted && usage.source === 'brain') {
      store.ingestExternalUsage(usage);
    }
    if (inserted && process.env.COST_LEDGER !== '0') {
      // Compatibility export only. The database is the source for analytics.
      await appendFile(LEDGER_PATH, JSON.stringify(usage) + '\n').catch(() => {
        app.log.warn('Cost ledger export failed; canonical usage remains in the database.');
      });
    }
  }

  let historyClaimed = false;
  let resourcesReleased = false;
  async function releaseResources(): Promise<void> {
    if (resourcesReleased) {
      return;
    }
    resourcesReleased = true;
    store.close();
    codexMetadata.close();
    await writes.flush().catch(() => undefined);
    await pricing.close();
    await access.close();
    if (historyClaimed) {
      await releaseHistory();
    }
  }
  app.addHook('onClose', releaseResources);

  try {
    historyClaimed = true;
    await acquireHistory();
    await access.init();
    await pricing.init();
    pricing.observeModels(await history.loadObservedModels(brainConfig.pricing.maxModels));
    pricing.observeModels([{ model: process.env.BRAIN_MODEL, provider: 'brain' }]);
    store.on('event', (event) => pricing.observeModels([event]));
    store.on('usage', (usage) => pricing.observeModels([usage]));
    store.on('usage_aliases', (update) =>
      pricing.observeModels([{ model: update.measurements?.model, provider: 'codex' }]),
    );
    app.addHook('onReady', async () => pricing.startAutomatic());
    if (history.enabled) {
      store.restoreCumulative(await history.loadCumulative());
      const usageIdentities = await history.loadUsageIdentityMap();
      store.restoreUsageIds(usageIdentities.keys());
      store.restoreUsageIdentityMap(usageIdentities);
      store.restoreRequestUsage(await history.loadRequestUsage());
      store.restoreSessionTotals(await history.loadSessionTotals());
      store.restorePrompts(
        await history.loadPromptEvents(Date.now() - PROMPT_WINDOW_MS - PROMPT_PAIR_WINDOW_MS),
      );
      store.hydrateToday(await history.todayTotals());
      for (const provider of ['claude', 'codex'] as const) {
        store.hydrateToday(await history.todayTotals(provider), provider);
      }
      store.on('event', (event) => writes.enqueue(() => history.recordEvent(event)));
      store.on('usage', (usage) => writes.enqueue(() => persistUsage(usage)));
      store.on('cumulative', (snapshot) =>
        writes.enqueue(() => history.recordCumulative(snapshot)),
      );
      store.on('usage_aliases', (update) =>
        writes.enqueue(async () => {
          await history.recordUsageAliases(update);
          if (update.measurements && process.env.COST_LEDGER !== '0') {
            await appendFile(
              LEDGER_PATH,
              JSON.stringify({ recordType: 'usage_completion', ...update }) + '\n',
            ).catch(() =>
              app.log.warn(
                'Cost ledger completion export failed; canonical usage remains in the database.',
              ),
            );
          }
        }),
      );
      app.log.info('history persistence enabled');
    }
    app.addHook('onRequest', async (req, reply) => {
      const origin = req.headers.origin;
      const host = req.headers.host;
      const originAllowed =
        !origin ||
        (() => {
          try {
            const url = new URL(origin);
            return (
              url.host === host || url.hostname === '127.0.0.1' || url.hostname === 'localhost'
            );
          } catch {
            return false;
          }
        })();
      // CORS preflights do not cover simple POSTs or WebSocket handshakes.
      if (!originAllowed) {
        return reply.code(403).send({ error: 'origin not allowed' });
      }
      if (origin && originAllowed) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
      }
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      reply.header(
        'Access-Control-Allow-Headers',
        'content-type,content-encoding,authorization,x-aad-token,x-brain-admin-token',
      );
      if (req.method === 'OPTIONS') {
        return reply.code(204).send();
      }
    });

    const ingestRoutes = new Set(['/v1/logs', '/v1/metrics', '/v1/traces', '/activity']);
    app.addHook('onRequest', async (req, reply) => {
      const path = req.routeOptions.url ?? req.url.split('?')[0];
      if (isBrainCallback(req)) {
        return;
      }
      const isIngest = ingestRoutes.has(path);
      if (isIngest && !writes.healthy) {
        return reply.code(503).send({ error: 'Activity persistence is unavailable.' });
      }
      const isViewer = path.startsWith('/api/') || path === '/live';
      const token = presentedToken(req);
      const isMcp = path === '/api/brain/mcp';
      const isAgentPolicy = path === '/api/agent-policy';
      if (token?.startsWith('hb_')) {
        const principal = await access.authenticate(token);
        if (!principal)
          return reply.code(401).send({ error: 'Invalid, expired or revoked workstation token.' });
        if (!isIngest && !isMcp && !isAgentPolicy)
          return reply
            .code(403)
            .send({ error: 'Workstation tokens only allow telemetry and Brain MCP.' });
        req.accessPrincipal = principal;
        return;
      }
      if (isIngest || isMcp || isAgentPolicy) {
        return reply.code(401).send({ error: 'An individual workstation token is required.' });
      }
      const required = isViewer ? config.viewerToken : undefined;
      if (required && token !== required) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (!required && isViewer && !isLocalRequest(req)) {
        return reply.code(401).send({ error: 'Authentication is required for remote access.' });
      }
    });

    app.addHook('onRequest', async (request, reply) => {
      const path = request.routeOptions.url ?? request.url.split('?')[0];
      if (!ingestRoutes.has(path) || !access.filterRepositories) return;
      const remote = normalizeRepositoryRemote(request.headers['x-harmonie-repository']);
      const repository = access
        .repositories()
        .find((repo) => repo.enabled && repo.remote === remote);
      if (!repository)
        return reply
          .code(403)
          .header('x-harmonie-policy-rejected', 'repository')
          .send({ error: 'Repository is not authorized.', code: 'repository_not_allowed' });
      request.authorizedRepository = repository;
    });
    app.get('/api/agent-policy', async (_request, reply) =>
      reply.header('Cache-Control', 'no-store').send(access.repositoryPolicy()),
    );

    app.addContentTypeParser(
      ['application/json', 'application/x-protobuf', 'application/octet-stream', '*'],
      { parseAs: 'buffer' },
      (req, body: Buffer, done) => {
        try {
          let buf = body;
          if (req.headers['content-encoding']?.includes('gzip') && buf.length) {
            buf = gunzipSync(buf, { maxOutputLength: req.routeOptions.bodyLimit });
          }
          if (!buf.length) return done(null, {});
          done(null, JSON.parse(buf.toString('utf8')));
        } catch (error) {
          const tooLarge = (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE';
          done(
            Object.assign(
              new Error(tooLarge ? 'Request body is too large.' : 'Invalid request body.'),
              {
                statusCode: tooLarge ? 413 : 400,
              },
            ),
            undefined,
          );
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
      store.ingestMany(
        parseLogs(req.body).map((event) =>
          ingestEvent(isLocalRequest(req) ? codexMetadata.enrich(event) : event, req),
        ),
      );
      await writes.flush();
      return reply.send({});
    });
    app.post('/v1/metrics', async (req, reply) => {
      store.ingestMany(parseMetrics(req.body).map((event) => ingestEvent(event, req)));
      await writes.flush();
      return reply.send({});
    });
    app.post('/v1/traces', async (_req, reply) => reply.send({}));

    app.post('/activity', async (req, reply) => {
      const b = (req.body ?? {}) as ActivityBody;
      if (!b.session_id || !b.event) {
        return reply.code(400).send({ error: 'session_id and event are required' });
      }
      const branchKey = b.branch?.match(/[A-Z][A-Z0-9]+-\d+/)?.[0];
      const ticket = isTicketKey(b.ticket)
        ? b.ticket
        : isTicketKey(branchKey)
          ? branchKey
          : undefined;
      const ev: AgentEvent = {
        id:
          typeof b.event_id === 'string' && b.event_id.length <= 160
            ? b.event_id
            : nextActivityId('act'),
        ts:
          Number.isSafeInteger(b.timestamp) && b.timestamp! > 0 && b.timestamp! <= Date.now()
            ? b.timestamp!
            : Date.now(),
        kind: 'activity',
        provider: b.provider === 'codex' ? 'codex' : 'claude',
        client: b.client,
        subtype: b.event,
        sessionId: b.session_id,
        parentSessionId: safeId(b.parent_session_id),
        sessionRole: ['main', 'subagent', 'internal', 'unknown'].includes(b.session_role ?? '')
          ? b.session_role
          : undefined,
        agentType: safeLabel(b.agent_type),
        promptId: safeId(b.prompt_id),
        userEmail: b.user,
        teamId: b.team_id,
        department: b.department,
        repo: b.repo,
        branch: b.branch,
        ticket,
        ticketTitle: ticket ? cachedTitle(ticket) : undefined,
        cwd: b.cwd,
        toolName: b.tool_name,
        projectId: b.project_id,
        workItemId: b.work_item_id ?? ticket,
        runId: b.run_id,
        parentRunId: b.parent_run_id,
      };
      store.ingest(ingestEvent(ev, req));
      if (ticket) {
        void resolveTitle(ticket).then((title) => {
          if (title && title !== ticket) {
            store.ingest(
              ingestEvent(
                {
                  id: nextActivityId('title'),
                  ts: Date.now(),
                  kind: 'activity',
                  provider: b.provider === 'codex' ? 'codex' : 'claude',
                  client: b.client,
                  subtype: 'context_update',
                  sessionId: b.session_id,
                  ticket,
                  ticketTitle: title,
                },
                req,
              ),
            );
          }
        });
      }
      await writes.flush();
      return reply.send({ ok: true });
    });

    app.get('/healthz', async (_request, reply) =>
      reply.code(writes.healthy ? 200 : 503).send({
        ok: writes.healthy,
        persistence: {
          enabled: history.enabled,
          healthy: writes.healthy,
          storage: history.storageKind,
        },
        sessions: store.getSessions().length,
        codexMetadata: {
          enabled: Boolean(config.codexMetadataDb),
          available: codexMetadata.available,
        },
        events: store.getRecentEvents().length,
      }),
    );
    app.get('/api/state', async () => ({
      sessions: store.getSessions(),
      aggregate: store.getAggregate(),
      providerAggregates: store.getProviderAggregates(),
      recentEvents: store.getRecentEvents(100),
    }));
    app.get<{ Params: { promptId: string } }>('/api/prompt/:promptId', async (req) => ({
      events: store.getPromptEvents(req.params.promptId),
    }));
    app.get<{ Querystring: { days?: string } }>('/api/trends', async (req) => {
      await writes.flush();
      const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
      return history.trends(days, access.legacyTeamAliases());
    });
    app.get<{ Params: { agent: string } }>('/api/history/agent/:agent', async (req) => {
      await writes.flush();
      return history.agentHistory(req.params.agent);
    });

    const registry = new ProjectRegistry(
      access,
      process.env.BRAIN_PROJECTS_PATH ??
        resolve(fileURLToPath(new URL('../..', import.meta.url)), 'brain.projects.json'),
      process.env.BRAIN_GITHUB_CACHE_PATH ?? resolve(config.dataDir, 'brain-repositories'),
    );
    await registry.init();
    registerAccessRoutes(app, access, registry, () => {
      store.refreshTeams((sessionId) => {
        const accountId = /^(?:codex|claude):([^/]+)\//.exec(sessionId)?.[1];
        return accountId ? access.teamsForAccount(accountId) : undefined;
      });
    });
    await registerBrain(app, {
      registry,
      pricing,
      onActivity: async (event: BrainActivity) => {
        if (
          event.kind === 'brain_model_call' &&
          event.phase !== 'started' &&
          event.phase !== 'progress'
        ) {
          const usage: UsageDelta = {
            usageId: event.id,
            source: 'brain',
            ts: event.ts,
            provider: 'brain',
            projectId: event.projectId,
            workItemId: event.workItemId ?? event.ticket,
            ticket: event.ticket,
            runId: event.runId,
            parentRunId: event.parentRunId,
            sessionId: event.originSessionId,
            model: event.model,
            dUsd: event.costUsd ?? null,
            dTokensIn: event.usageKnown ? (event.inputTokens ?? null) : null,
            dTokensOut: event.usageKnown ? (event.outputTokens ?? null) : null,
            costStatus: event.costUsd == null ? 'unknown' : 'estimated',
          };
          writes.enqueue(() => persistUsage(usage));
          await writes.flush();
        }
      },
    });
    return app;
  } catch (error) {
    // A failed build never reaches the caller, so the caller cannot close it.
    // Close already registered Brain hooks, then release shared history even
    // when Fastify itself fails while closing a partially initialized plugin.
    await app
      .close()
      .catch(() => app.log.error('Application cleanup failed after initialization error.'));
    await releaseResources().catch(() =>
      app.log.error('History cleanup failed after initialization error.'),
    );
    throw error;
  }
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

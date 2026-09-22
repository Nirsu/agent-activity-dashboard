#!/usr/bin/env node
// Loopback-only collector. Unselected and unidentified sessions never reach the dashboard.
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { dirname, join } from 'node:path';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  defaultConfigPath,
  readPolicy,
  selectedRepository,
  repositoryAt,
  repositoryContext,
} from './project-policy.mjs';
import { RelayOutbox, relayCredentialId, requireAgentToken } from './relay-outbox.mjs';

const relayLimits = createRequire(import.meta.url)('./relay-config.json');

const maximumBodyBytes = 16 * 1024 * 1024;
const sessionLifetimeMs = 24 * 60 * 60 * 1000;
const maximumSessions = 10000;

function attributes(values) {
  return Object.fromEntries(
    (Array.isArray(values) ? values : [])
      .filter((value) => typeof value?.key === 'string')
      .map((value) => [value.key, value.value?.stringValue]),
  );
}

function sessionId(local, resource) {
  return (
    local['session.id'] ??
    resource['session.id'] ??
    local['conversation.id'] ??
    local.conversation_id ??
    resource['conversation.id'] ??
    resource.conversation_id
  );
}

const sessionKey = (provider, id) => `${provider}:${id}`;

function selectedWorkspaceRepository(workspace, policy, workspaceChecks) {
  if (!workspaceChecks.has(workspace)) {
    workspaceChecks.set(
      workspace,
      selectedRepository(workspace, policy.projects, policy.workspaceBindings),
    );
  }
  return workspaceChecks.get(workspace);
}

export class ProjectFilter {
  sessions = new Map();
  policySignature;
  dashboardUrl;

  applyPolicy(policy) {
    const signature = JSON.stringify([
      policy.dashboardUrl,
      policy.projects,
      policy.workspaceBindings,
    ]);
    if (this.policySignature === signature) return;
    if (this.dashboardUrl !== policy.dashboardUrl) {
      this.sessions.clear();
    }
    const workspaceChecks = new Map();
    for (const [key, session] of this.sessions) {
      if (
        !policy.projects.includes(session.project) ||
        (session.workspace &&
          selectedWorkspaceRepository(session.workspace, policy, workspaceChecks) !==
            session.project)
      ) {
        this.sessions.delete(key);
      }
    }
    this.dashboardUrl = policy.dashboardUrl;
    this.policySignature = signature;
  }

  activity(payload, policy) {
    this.applyPolicy(policy);
    if (
      !payload ||
      !['codex', 'claude'].includes(payload.provider) ||
      typeof payload.session_id !== 'string' ||
      typeof payload.event !== 'string'
    )
      return undefined;
    const key = sessionKey(payload.provider, payload.session_id);
    // No fallback to a previous authorization when cwd is missing or has changed.
    const project = selectedRepository(payload.cwd, policy.projects, policy.workspaceBindings);
    if (!project) {
      this.sessions.delete(key);
      return undefined;
    }
    this.sessions.delete(key);
    const workspace = repositoryAt(payload.cwd) ? undefined : payload.cwd;
    this.sessions.set(key, { project, at: Date.now(), ...(workspace ? { workspace } : {}) });
    if (this.sessions.size > maximumSessions)
      this.sessions.delete(this.sessions.keys().next().value);
    // A child hook establishes only that child. Its parent must identify its own cwd.
    return workspace ? { ...payload, ...repositoryContext(project) } : payload;
  }

  allowed(provider, id, policy, workspaceChecks = new Map()) {
    this.applyPolicy(policy);
    if (typeof id !== 'string') return false;
    const key = sessionKey(provider, id);
    const session = this.sessions.get(key);
    if (
      !session ||
      Date.now() - session.at > sessionLifetimeMs ||
      !policy.projects.includes(session.project)
    ) {
      this.sessions.delete(key);
      return false;
    }
    if (
      session.workspace &&
      selectedWorkspaceRepository(session.workspace, policy, workspaceChecks) !== session.project
    ) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  logs(body, policy) {
    const resourceLogs = [];
    const workspaceChecks = new Map();
    for (const resource of body?.resourceLogs ?? []) {
      const resourceAttrs = attributes(resource.resource?.attributes);
      const scopeLogs = [];
      for (const scope of resource.scopeLogs ?? []) {
        const logRecords = (scope.logRecords ?? []).filter((record) => {
          const attrs = attributes(record.attributes);
          const event = attrs['event.name'] ?? record.body?.stringValue ?? attrs.name;
          const provider = event?.startsWith('codex.')
            ? 'codex'
            : event?.startsWith('claude_code.')
              ? 'claude'
              : undefined;
          return (
            provider &&
            this.allowed(provider, sessionId(attrs, resourceAttrs), policy, workspaceChecks)
          );
        });
        if (logRecords.length) scopeLogs.push({ ...scope, logRecords });
      }
      if (scopeLogs.length) resourceLogs.push({ ...resource, scopeLogs });
    }
    return resourceLogs.length ? { resourceLogs } : undefined;
  }

  metrics(body, policy) {
    const resourceMetrics = [];
    const workspaceChecks = new Map();
    for (const resource of body?.resourceMetrics ?? []) {
      const resourceAttrs = attributes(resource.resource?.attributes);
      const scopeMetrics = [];
      for (const scope of resource.scopeMetrics ?? []) {
        const metrics = [];
        for (const metric of scope.metrics ?? []) {
          const provider = metric.name?.startsWith('codex.')
            ? 'codex'
            : metric.name?.startsWith('claude_code.')
              ? 'claude'
              : undefined;
          if (!provider) continue;
          const filtered = {
            name: metric.name,
            description: metric.description,
            unit: metric.unit,
          };
          let kept = false;
          for (const type of ['sum', 'gauge', 'histogram', 'exponentialHistogram', 'summary']) {
            if (!metric[type]) continue;
            const dataPoints = (metric[type].dataPoints ?? []).filter((point) =>
              this.allowed(
                provider,
                sessionId(attributes(point.attributes), resourceAttrs),
                policy,
                workspaceChecks,
              ),
            );
            if (dataPoints.length) {
              filtered[type] = { ...metric[type], dataPoints };
              kept = true;
            }
          }
          if (kept) metrics.push(filtered);
        }
        if (metrics.length) scopeMetrics.push({ ...scope, metrics });
      }
      if (scopeMetrics.length) resourceMetrics.push({ ...resource, scopeMetrics });
    }
    return resourceMetrics.length ? { resourceMetrics } : undefined;
  }
}

export async function startRelay({
  configPath = defaultConfigPath(),
  port,
  token = process.env.HARMONIE_TOKEN,
  forward = fetch,
  limits = relayLimits,
} = {}) {
  requireAgentToken(token);
  const initial = readPolicy(configPath);
  const credentialId = relayCredentialId(token);
  const filter = new ProjectFilter();
  filter.applyPolicy(initial);
  const sessionsPath = join(dirname(configPath), 'relay-sessions.json');
  try {
    const saved = JSON.parse(await readFile(sessionsPath, 'utf8'));
    if (
      saved.dashboardUrl === initial.dashboardUrl &&
      saved.credentialId === credentialId &&
      Array.isArray(saved.sessions)
    ) {
      const workspaceChecks = new Map();
      for (const [key, session] of saved.sessions.slice(-maximumSessions)) {
        if (
          typeof key === 'string' &&
          Number.isFinite(session?.at) &&
          Date.now() - session.at < sessionLifetimeMs &&
          initial.projects.includes(session.project) &&
          (!session.workspace ||
            selectedWorkspaceRepository(session.workspace, initial, workspaceChecks) ===
              session.project)
        ) {
          filter.sessions.set(key, session);
        }
      }
    }
  } catch {
    /* A new or damaged session cache requires a fresh identifying hook. */
  }
  let sessionWrites = Promise.resolve();
  function saveSessions(policy) {
    const text = JSON.stringify({
      dashboardUrl: policy.dashboardUrl,
      credentialId,
      sessions: [...filter.sessions],
    });
    const write = sessionWrites.then(async () => {
      await writeFile(`${sessionsPath}.tmp`, text, { mode: 0o600 });
      await rename(`${sessionsPath}.tmp`, sessionsPath);
    });
    sessionWrites = write.catch(() => {});
    return write;
  }
  const outbox = new RelayOutbox(configPath, forward, token, limits);
  await outbox.init();
  const server = createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    // No browser-accessible management API and no content/body logging.
    if (request.headers.origin) return send(403, {});
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        const policy = readPolicy(configPath);
        return send(200, {
          ok: true,
          service: 'harmonie-project-relay',
          version: 6,
          credentialId,
          configurationId: createHash('sha256').update(resolve(configPath)).digest('hex'),
          projects: policy.projects.length,
          delivery: outbox.status(),
        });
      }
      if (
        request.method !== 'POST' ||
        !['/activity', '/v1/logs', '/v1/metrics', '/v1/traces'].includes(request.url)
      ) {
        return send(404, {});
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maximumBodyBytes) return send(413, {});
        chunks.push(chunk);
      }
      let data = Buffer.concat(chunks);
      if (request.headers['content-encoding'] === 'gzip') {
        data = gunzipSync(data, { maxOutputLength: maximumBodyBytes });
      }
      const body = JSON.parse(data.toString('utf8') || '{}');
      const policy = readPolicy(configPath);
      if (request.url === '/activity') {
        const payload = filter.activity(body, policy);
        // Bind this event before another request can change the session's cwd.
        const session = payload
          ? filter.sessions.get(sessionKey(payload.provider, payload.session_id))
          : undefined;
        await saveSessions(policy);
        if (payload) {
          await outbox.enqueue(
            request.url,
            payload,
            session.project,
            policy.dashboardUrl,
            session.workspace,
          );
        }
      } else if (request.url === '/v1/logs' || request.url === '/v1/metrics') {
        filter.applyPolicy(policy);
        const sessions = [...filter.sessions];
        const batches = [];
        const groups = new Map();
        for (const [key, session] of sessions) {
          const groupKey = JSON.stringify([session.project, session.workspace]);
          if (!groups.has(groupKey)) {
            groups.set(groupKey, {
              project: session.project,
              workspace: session.workspace,
              sessions: [],
            });
          }
          groups.get(groupKey).sessions.push([key, session]);
        }
        for (const { project, workspace, sessions: groupSessions } of groups.values()) {
          const scoped = new ProjectFilter();
          scoped.applyPolicy(policy);
          scoped.sessions = new Map(groupSessions);
          const payload =
            request.url === '/v1/logs' ? scoped.logs(body, policy) : scoped.metrics(body, policy);
          if (payload) batches.push({ payload, project, workspace });
        }
        for (const { payload, project, workspace } of batches) {
          await outbox.enqueue(request.url, payload, project, policy.dashboardUrl, workspace);
        }
      }
      // Acknowledge durable local acceptance; delivery must not block the coding client.
      send(200, {});
      void outbox.flush();
    } catch {
      send(503, { error: 'Local project filtering or forwarding is unavailable.' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port ?? initial.relayPort, '127.0.0.1', resolve);
  });
  const retry = setInterval(() => void outbox.flush(), limits.retryIntervalMs);
  retry.unref();
  server.once('close', () => clearInterval(retry));
  server.flushTelemetry = () => outbox.flush();
  server.telemetryStatus = () => outbox.status();
  void outbox.flush();
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = await startRelay();
    console.log(`Project telemetry relay: http://127.0.0.1:${server.address().port}`);
    console.log('Only explicitly selected repositories are forwarded. Press Ctrl+C to stop.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  } catch (error) {
    console.error(
      error.code === 'EADDRINUSE'
        ? 'The local relay port is already in use.'
        : 'Unable to start the relay. Set HARMONIE_TOKEN to an Accounts workstation token and check agents:setup.',
    );
    process.exitCode = 1;
  }
}

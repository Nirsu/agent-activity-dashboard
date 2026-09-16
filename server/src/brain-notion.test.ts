import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { NotionConnection } from './brain/notion/service.js';
import { normalizePageId, parseNotionPage } from './brain/notion/page.js';
import { registerNotionRoutes } from './brain/notion/routes.js';
import { config } from './config.js';
import { brainConfig } from './brain/config.js';
import type { DeliveryService } from './delivery.js';

const pageId = '3dddeff1b90780b7baedffb10c08a0d3';
const encryptionKey = 'a-test-only-encryption-key-long-enough';
const redirectUrl = 'http://127.0.0.1:4318/api/brain/connections/notion/callback';
const originalContent =
  'Une spécification publiée.\n<page url="https://app.notion.com/p/3dddeff1b9078054960df84e5ed1214f">Child page</page>\n';
const rawPage = `<page url="https://app.notion.com/p/${pageId}">\n<properties>\n{"title":"Test - Harmonie Brain","Statut":"Publié","last_edited_time":"2026-09-16T10:00:00Z"}\n</properties>\n<content>\n${originalContent}</content>\n</page>`;
const toolResult = { content: [{ type: 'text', text: JSON.stringify({ text: rawPage }) }] };

function fakeNotion() {
  let now = Date.parse('2026-09-16T10:00:00Z');
  let refreshes = 0;
  let exchanges = 0;
  let registrations = 0;
  let pageReads = 0;
  let tokenNumber = 1;
  let refreshError: string | undefined;
  let rejectAccessOnce = false;
  let concurrentRejections = 0;
  let releaseRejections: () => void = () => {};
  let concurrentResponses = Promise.resolve();
  let pauseNextPage = false;
  let pageStarted: () => void = () => {};
  const refreshTokens: string[] = [];
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  const fetchFn: FetchLike = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json({
        resource: 'https://mcp.notion.com/mcp',
        authorization_servers: ['https://mcp.notion.com'],
        scopes_supported: ['default'],
      });
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      return json({
        issuer: 'https://mcp.notion.com',
        authorization_endpoint: 'https://mcp.notion.com/authorize',
        token_endpoint: 'https://mcp.notion.com/token',
        registration_endpoint: 'https://mcp.notion.com/register',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.pathname === '/register') {
      registrations += 1;
      const metadata = JSON.parse(String(init.body));
      assert.deepEqual(metadata.redirect_uris, [redirectUrl]);
      return json({ ...metadata, client_id: 'registered-client' }, 201);
    }
    if (url.pathname === '/token') {
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get('client_id'), 'registered-client');
      if (body.get('grant_type') === 'authorization_code') {
        exchanges += 1;
        assert.ok(body.get('code_verifier'));
        assert.equal(body.get('redirect_uri'), redirectUrl);
        assert.equal(body.get('code'), 'valid-code');
      } else {
        refreshes += 1;
        assert.equal(body.get('grant_type'), 'refresh_token');
        refreshTokens.push(body.get('refresh_token')!);
        if (refreshError) {
          return json(
            {
              error: refreshError,
              error_description: 'Private provider details must never be displayed.',
            },
            refreshError === 'server_error' ? 503 : 400,
          );
        }
        tokenNumber += 1;
      }
      return json({
        access_token: `private-access-${tokenNumber}`,
        refresh_token: `private-refresh-${tokenNumber}`,
        token_type: 'Bearer',
        expires_in: 120,
      });
    }
    if (url.pathname === '/mcp') {
      const request = init.method === 'GET' ? undefined : JSON.parse(String(init.body));
      if (concurrentRejections > 0 && (init.method === 'GET' || request?.method === 'tools/call')) {
        concurrentRejections -= 1;
        if (concurrentRejections === 0) {
          releaseRejections();
        }
        await concurrentResponses;
        return json({ error: 'expired' }, 401);
      }
      if (init.method === 'GET') {
        return new Response(null, { status: 405 });
      }
      if (rejectAccessOnce) {
        rejectAccessOnce = false;
        return json({ error: 'expired' }, 401);
      }
      assert.equal(
        new Headers(init.headers).get('Authorization'),
        `Bearer private-access-${tokenNumber}`,
      );
      if (request.method === 'initialize') {
        return json({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'notion-test', version: '1' },
          },
        });
      }
      if (request.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      assert.equal(request.method, 'tools/call');
      if (request.params.name === 'notion-get-self') {
        return json({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [
              { type: 'text', text: JSON.stringify({ bot: { workspace_name: 'Test workspace' } }) },
            ],
          },
        });
      }
      assert.equal(request.params.name, 'notion-fetch');
      assert.deepEqual(request.params.arguments, { id: pageId });
      pageReads += 1;
      if (pauseNextPage) {
        pauseNextPage = false;
        await new Promise<void>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          pageStarted();
        });
      }
      return json({ jsonrpc: '2.0', id: request.id, result: toolResult });
    }
    throw new Error(`Unexpected request to ${url.pathname}.`);
  };
  return {
    fetchFn,
    now: () => now,
    advance: () => {
      now += 120_000;
    },
    rejectRefresh: (error?: string) => {
      refreshError = error;
    },
    rejectAccess: () => {
      rejectAccessOnce = true;
    },
    rejectConcurrentAccess: () => {
      concurrentRejections = 2;
      concurrentResponses = new Promise<void>((resolve) => {
        releaseRejections = resolve;
      });
    },
    pausePage: () => {
      pauseNextPage = true;
      return new Promise<void>((resolve) => {
        pageStarted = resolve;
      });
    },
    counts: () => ({ refreshes, exchanges, registrations, pageReads, refreshTokens }),
  };
}

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'brain-notion-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const provider = fakeNotion();
  const options = {
    dataDir,
    encryptionKey,
    redirectUrl,
    fetchFn: provider.fetchFn,
    now: provider.now,
  };
  const connection = new NotionConnection(options);
  await connection.init();
  const connect = async (service = connection) => {
    const { authorizationUrl } = await service.connect();
    const url = new URL(authorizationUrl);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'));
    return url.searchParams.get('state')!;
  };
  return { dataDir, provider, options, connection, connect };
}

test('Notion OAuth keeps registration, PKCE, tokens and page access across restarts without plaintext secrets', async (t) => {
  const { dataDir, provider, options, connection, connect } = await fixture(t);
  const state = await connect();
  const restarted = new NotionConnection(options);
  await restarted.init();
  await assert.rejects(restarted.callback('valid-code', 'wrong-state'), /Invalid, expired/);
  await restarted.callback('valid-code', state);
  await assert.rejects(restarted.callback('valid-code', state), /already used/);
  assert.equal(restarted.state().connected, true);
  const again = new NotionConnection(options);
  await again.init();
  const page = await again.fetchPage(pageId);
  assert.equal(page.title, 'Test - Harmonie Brain');
  assert.equal(page.properties.Statut, 'Publié');
  assert.equal(page.content, originalContent);
  assert.equal(page.raw, rawPage);
  assert.equal(provider.counts().registrations, 1);
  assert.equal(provider.counts().exchanges, 1);
  assert.equal(provider.counts().pageReads, 1);
  assert.ok(again.state().lastCheckedAt);
  assert.equal(again.state().workspace, 'Test workspace');
  const stored = await readFile(resolve(dataDir, 'brain/notion/credentials.json'), 'utf8');
  assert.doesNotMatch(stored, /private-access|private-refresh|registered-client|code_verifier/);
  assert.doesNotMatch(JSON.stringify(again.state()), /private-access|private-refresh/);
  assert.equal(connection.state().status, 'connecting');
});

test('Notion serializes expiration refresh and persists the rotated refresh token', async (t) => {
  const { connection, provider, connect, options } = await fixture(t);
  await connection.callback('valid-code', await connect());
  provider.advance();
  await Promise.all([connection.fetchPage(pageId), connection.fetchPage(pageId)]);
  assert.equal(provider.counts().refreshes, 1);
  assert.deepEqual(provider.counts().refreshTokens, ['private-refresh-1']);
  const restarted = new NotionConnection(options);
  await restarted.init();
  provider.advance();
  await restarted.fetchPage(pageId);
  assert.deepEqual(provider.counts().refreshTokens, ['private-refresh-1', 'private-refresh-2']);
  provider.rejectAccess();
  await restarted.fetchPage(pageId);
  assert.equal(provider.counts().refreshes, 3);
});

test('Notion coalesces refresh for overlapping MCP event-stream and tool requests', async (t) => {
  const { connection, provider, connect } = await fixture(t);
  await connection.callback('valid-code', await connect());
  provider.rejectConcurrentAccess();
  await connection.fetchPage(pageId);
  assert.equal(provider.counts().refreshes, 1);
  assert.equal(connection.state().connected, true);
});

test('connection-only checks never read a hidden pilot page', async (t) => {
  const { connection, provider, connect } = await fixture(t);
  await connection.callback('valid-code', await connect());
  const result = await connection.test();
  assert.equal(result.connected, true);
  assert.equal(result.workspace, 'Test workspace');
  assert.ok(result.lastCheckedAt);
  assert.equal(provider.counts().pageReads, 0);
});

test('Notion shutdown aborts an outstanding read while preserving the saved grant', async (t) => {
  const { connection, provider, connect, options } = await fixture(t);
  await connection.callback('valid-code', await connect());
  const started = provider.pausePage();
  const failedRead = assert.rejects(connection.fetchPage(pageId), /Notion could not be reached/);
  await started;
  await connection.close();
  await failedRead;
  await assert.rejects(connection.test(), /shutting down/);
  const restarted = new NotionConnection(options);
  await restarted.init();
  assert.equal(restarted.state().connected, true);
  await restarted.fetchPage(pageId);
  await restarted.close();
});

test('Notion revoked grants require reconnect and never silently start a new authorization', async (t) => {
  const { connection, provider, connect, options } = await fixture(t);
  await connection.callback('valid-code', await connect());
  provider.advance();
  provider.rejectRefresh('invalid_grant');
  await assert.rejects(connection.fetchPage(pageId), /revoked\. Reconnect/);
  assert.equal(connection.state().status, 'reconnect_required');
  assert.doesNotMatch(connection.state().error!, /Private provider/);
  const restarted = new NotionConnection(options);
  await restarted.init();
  assert.equal(restarted.state().status, 'reconnect_required');
  await assert.rejects(restarted.fetchPage(pageId), /reconnect Notion/);
  assert.equal(provider.counts().refreshes, 1);
  assert.equal(provider.counts().registrations, 1);
});

test('temporary OAuth errors keep credentials and expired callbacks cannot exchange a code', async (t) => {
  const { connection, provider, connect, options } = await fixture(t);
  await connection.callback('valid-code', await connect());
  provider.advance();
  provider.rejectRefresh('server_error');
  await assert.rejects(connection.fetchPage(pageId), /Notion could not be reached/);
  assert.equal(connection.state().connected, true);
  provider.rejectRefresh();
  await connection.fetchPage(pageId);
  const expiring = new NotionConnection({ ...options, authorizationTimeoutMs: 1 });
  await expiring.init();
  const state = await connect(expiring);
  provider.advance();
  await assert.rejects(expiring.callback('valid-code', state), /expired/);
  assert.equal(provider.counts().exchanges, 1);
});

test('Notion can register a new client after a revoked OAuth registration', async (t) => {
  const { connection, provider, connect } = await fixture(t);
  await connection.callback('valid-code', await connect());
  provider.advance();
  provider.rejectRefresh('invalid_client');
  await assert.rejects(connection.fetchPage(pageId), /Reconnect Notion/);
  assert.equal(connection.state().status, 'reconnect_required');
  provider.rejectRefresh();
  await connection.callback('valid-code', await connect());
  assert.equal(provider.counts().registrations, 2);
  await connection.fetchPage(pageId);
});

test('wrong encryption keys cannot overwrite a saved connection before an explicit disconnect', async (t) => {
  const { connection, connect, options, dataDir } = await fixture(t);
  await connection.callback('valid-code', await connect());
  const path = resolve(dataDir, 'brain/notion/credentials.json');
  const before = await readFile(path, 'utf8');
  const wrongKey = new NotionConnection({
    ...options,
    encryptionKey: 'another-test-key-that-is-long-enough',
  });
  await wrongKey.init();
  assert.equal(wrongKey.state().status, 'error');
  await assert.rejects(wrongKey.connect(), /could not be decrypted/);
  assert.equal(await readFile(path, 'utf8'), before);
  await wrongKey.disconnect();
  assert.equal(wrongKey.state().status, 'disconnected');
});

test('Notion page parsing preserves content and metadata while rejecting mismatched captures', () => {
  assert.equal(
    normalizePageId(
      `https://app.notion.com/p/harmonie-mutuelle/Test-Harmonie-Brain-${pageId}?source=copy_link`,
    ),
    pageId,
  );
  assert.throws(() => normalizePageId(`https://untrusted.example/${pageId}`), /Notion page URL/);
  assert.equal(normalizePageId(`https://team.notion.site/Test-${pageId}#section`), pageId);
  assert.equal(normalizePageId('3DDDEFF1-B907-80B7-BAED-FFB10C08A0D3'), pageId);
  assert.throws(() => normalizePageId(`https://notion.so.example.com/${pageId}`), {
    statusCode: 400,
  });
  assert.throws(() => normalizePageId('https://'), { statusCode: 400 });
  assert.throws(() => normalizePageId('not a page'), { statusCode: 400 });
  for (const invalid of [`ftp://untrusted.example/${pageId}`, `prefix/${pageId}`, `/${pageId}`]) {
    assert.throws(() => normalizePageId(invalid), { statusCode: 400 });
  }
  assert.throws(
    () => parseNotionPage('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', toolResult, 10_000),
    /different page/,
  );
  assert.throws(() => parseNotionPage(pageId, toolResult, 1), /oversized page/);
  assert.throws(
    () => parseNotionPage(pageId, { isError: true, content: toolResult.content }, 10_000),
    /could not fetch/,
  );
});

test('Notion administration requires the supplied admin guard while the OAuth callback validates state', async (t) => {
  const { connection, connect } = await fixture(t);
  const app = Fastify();
  t.after(() => app.close());
  await registerNotionRoutes(app, connection, async (request, reply) => {
    if (request.headers.authorization !== 'Bearer admin') {
      return reply.code(403).send({ error: 'Administrator access is required.' });
    }
  });
  assert.equal((await app.inject({ url: '/api/brain/connections/notion' })).statusCode, 403);
  const state = await connect();
  const response = await app.inject({
    url: `/api/brain/connections/notion/callback?code=valid-code&state=${state}`,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.doesNotMatch(response.body, /private-access|private-refresh|valid-code/);
  const disconnected = await app.inject({
    method: 'DELETE',
    url: '/api/brain/connections/notion',
    headers: { authorization: 'Bearer admin' },
  });
  assert.equal(disconnected.statusCode, 200);
  assert.equal(disconnected.json().status, 'disconnected');
});

test('shared HTTP routes enforce real administrator guards without hanging and keep callback authentication separate', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-http-admin-'));
  const previousConfiguration = {
    viewerToken: config.viewerToken,
    dataDir: config.dataDir,
    credentialEncryptionKey: config.credentialEncryptionKey,
  };
  const environment = {
    BRAIN_ADMIN_TOKEN: 'test-http-admin',
    BRAIN_DB_PATH: resolve(root, 'brain.db'),
    BRAIN_PROJECTS_PATH: resolve(root, 'projects.json'),
    DB_PATH: resolve(root, 'history.db'),
    COGNEE_API_URL: '',
    BRAIN_GITHUB_WEBHOOK_PROJECTS: '{}',
    BRAIN_GITHUB_WEBHOOK_SECRET: '',
    BRAIN_NOTION_WEBHOOK_VERIFICATION_TOKEN: '',
    COST_LEDGER: '0',
    LOG_LEVEL: 'silent',
  };
  const previousEnvironment = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  Object.assign(config, {
    viewerToken: 'test-http-viewer',
    dataDir: root,
    credentialEncryptionKey: encryptionKey,
  });
  await writeFile(
    environment.BRAIN_PROJECTS_PATH,
    JSON.stringify([
      {
        id: 'dashboard',
        name: 'Dashboard',
        scope: 'HTTP fixture',
        repoPath: root,
        codePaths: ['feature.ts'],
        specs: [],
      },
    ]),
  );
  const { buildApp } = await import('./index.js');
  const app = await buildApp({
    deliveryService: { init: async () => {} } as unknown as DeliveryService,
  });
  t.after(async () => {
    await app.close();
    Object.assign(config, previousConfiguration);
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const viewer = { authorization: 'Bearer test-http-viewer' };
  const administrator = { ...viewer, 'x-brain-admin-token': 'test-http-admin' };
  const request = (path: string, options: RequestInit = {}) =>
    fetch(`${address}${path}`, {
      ...options,
      signal: AbortSignal.timeout(brainConfig.client.requestTimeoutMs),
    });
  assert.equal((await request('/api/brain/memory')).status, 401);
  assert.equal((await request('/api/brain/memory', { headers: viewer })).status, 200);
  assert.equal((await request('/api/brain/connections/notion', { headers: viewer })).status, 403);
  assert.equal(
    (await request('/api/brain/connections/notion', { headers: administrator })).status,
    200,
  );
  assert.equal(
    (await request('/api/brain/connections/notion', { method: 'DELETE', headers: viewer })).status,
    403,
  );
  assert.equal(
    (await request('/api/brain/connections/notion', { method: 'DELETE', headers: administrator }))
      .status,
    200,
  );
  const body = JSON.stringify({
    pageId,
    projectIds: ['dashboard'],
    shared: false,
    mandatory: false,
    approval: 'draft',
  });
  assert.equal(
    (
      await request('/api/brain/memory/sources', {
        method: 'POST',
        body,
        headers: { ...viewer, 'content-type': 'application/json' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('/api/brain/memory/sources', {
        method: 'POST',
        body,
        headers: { ...administrator, 'content-type': 'application/json' },
      })
    ).status,
    201,
  );
  const callback = await request(
    `/api/brain/connections/notion/callback?code=unused&state=${'a'.repeat(64)}`,
  );
  assert.equal(callback.status, 400);
  assert.equal(callback.headers.get('cache-control'), 'no-store');
  assert.equal(
    (
      await request('/api/brain/webhooks/notion', {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' },
      })
    ).status,
    503,
  );
  assert.equal((await request('/api/brain/webhooks/notion')).status, 401);
  const reviewBody = JSON.stringify({
    findingId: 'missing',
    decision: 'confirmed',
    note: 'HTTP guard fixture',
  });
  assert.equal(
    (
      await request('/api/brain/analyses/missing/reviews', {
        method: 'POST',
        body: reviewBody,
        headers: { ...viewer, 'content-type': 'application/json' },
      })
    ).status,
    403,
  );
});

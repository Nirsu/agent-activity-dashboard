import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  auth,
  refreshAuthorization,
  selectResourceURL,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  InvalidClientError,
  InvalidGrantError,
  UnauthorizedClientError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { config } from '../../config.js';
import { brainConfig } from '../config.js';
import {
  CredentialStore,
  type NotionCredentials,
  type PendingAuthorization,
} from './credentials.js';
import { normalizePageId, NotionError, parseNotionPage, parseWorkspace } from './page.js';

export { NotionError } from './page.js';
export type { NotionPage } from './page.js';

const serverUrl = new URL('https://mcp.notion.com/mcp');

export type NotionConnectionOptions = {
  dataDir?: string;
  encryptionKey?: string;
  redirectUrl?: string;
  requestTimeoutMs?: number;
  authorizationTimeoutMs?: number;
  fetchFn?: FetchLike;
  now?: () => number;
};

export type NotionConnectionState = {
  configured: boolean;
  connected: boolean;
  status:
    'unconfigured' | 'disconnected' | 'connecting' | 'connected' | 'reconnect_required' | 'error';
  workspace?: string;
  lastCheckedAt?: string;
  error?: string;
};

export class NotionConnection {
  private credentials: NotionCredentials = {};
  private readonly store?: CredentialStore;
  private readonly redirectUrl: string;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly authorizationTimeoutMs: number;
  private readonly requestFetch: FetchLike;
  private queue: Promise<unknown> = Promise.resolve();
  private refreshing?: Promise<void>;
  private readonly shutdown = new AbortController();
  private activeClient?: Client;
  private stopped = false;
  private initialization?: Promise<void>;
  private loadFailed = false;
  private error?: string;
  private configurationError?: string;

  constructor(options: NotionConnectionOptions = {}) {
    const secret = options.encryptionKey ?? config.credentialEncryptionKey;
    this.redirectUrl =
      options.redirectUrl ??
      process.env.BRAIN_NOTION_REDIRECT_URL ??
      brainConfig.notionMcp.defaultRedirectUrl;
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? brainConfig.notionMcp.requestTimeoutMs;
    this.authorizationTimeoutMs =
      options.authorizationTimeoutMs ?? brainConfig.notionMcp.authorizationTimeoutMs;
    if (!secret || secret.length < 32) {
      this.configurationError =
        'Configure a CREDENTIAL_ENCRYPTION_KEY of at least 32 characters to connect Notion.';
    } else {
      this.store = new CredentialStore(
        resolve(options.dataDir ?? config.dataDir, 'brain/notion/credentials.json'),
        secret,
      );
    }
    try {
      const callback = new URL(this.redirectUrl);
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname);
      if (
        (callback.protocol !== 'https:' && !(callback.protocol === 'http:' && local)) ||
        callback.username ||
        callback.password ||
        callback.search ||
        callback.hash
      ) {
        throw new Error('Invalid callback.');
      }
    } catch {
      this.configurationError =
        'BRAIN_NOTION_REDIRECT_URL must be an HTTPS callback or a local HTTP callback without credentials or query parameters.';
    }
    const fetchFn = options.fetchFn ?? fetch;
    this.requestFetch = (input, init = {}) => {
      const timeout = AbortSignal.timeout(this.requestTimeoutMs);
      const signal = AbortSignal.any([
        this.shutdown.signal,
        timeout,
        ...(init.signal ? [init.signal] : []),
      ]);
      return fetchFn(input, { ...init, signal });
    };
  }

  init(): Promise<void> {
    this.initialization ??= this.load();
    return this.initialization;
  }

  private async load(): Promise<void> {
    if (!this.store || this.configurationError) {
      return;
    }
    try {
      this.credentials = await this.store.read();
      if (this.credentials.redirectUrl && this.credentials.redirectUrl !== this.redirectUrl) {
        await this.save({
          ...this.credentials,
          tokens: undefined,
          pending: undefined,
          client: undefined,
          reconnectRequired: true,
        });
      }
    } catch {
      this.loadFailed = true;
      this.error =
        'Stored Notion credentials could not be decrypted. Restore the original encryption key or disconnect to reset the connection.';
    }
  }

  state(): NotionConnectionState {
    const configured = !this.configurationError;
    const connected =
      configured &&
      !this.loadFailed &&
      !this.credentials.reconnectRequired &&
      !!this.credentials.tokens;
    const pending = this.credentials.pending && this.credentials.pending.expiresAt > this.now();
    return {
      configured,
      connected,
      status: !configured
        ? 'unconfigured'
        : this.loadFailed
          ? 'error'
          : this.credentials.reconnectRequired
            ? 'reconnect_required'
            : connected
              ? 'connected'
              : pending
                ? 'connecting'
                : 'disconnected',
      workspace: this.credentials.workspace,
      lastCheckedAt: this.credentials.lastCheckedAt,
      error: this.configurationError ?? this.error,
    };
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    // ponytail: one connection and one worker; use per-connection locks if accounts become independent.
    const result = this.queue.then(async () => {
      if (this.stopped) {
        throw new NotionError('Notion connection is shutting down.', 503);
      }
      await this.init();
      if (this.configurationError) {
        throw new NotionError(this.configurationError, 503);
      }
      return operation();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private async save(credentials: NotionCredentials): Promise<void> {
    await this.store!.write(credentials);
    this.credentials = credentials;
  }

  private provider(
    pending?: PendingAuthorization,
    onRedirect?: (url: URL) => void,
  ): OAuthClientProvider {
    return {
      redirectUrl: this.redirectUrl,
      clientMetadata: {
        client_name: 'Harmony Brain',
        redirect_uris: [this.redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      state: () => {
        if (!pending) {
          throw new NotionError('Reconnect Notion to authorize access.', 409);
        }
        return pending.state;
      },
      clientInformation: () => this.credentials.client,
      saveClientInformation: (client) => this.save({ ...this.credentials, client }),
      tokens: () => this.credentials.tokens,
      saveTokens: async (tokens) => {
        await this.save({
          ...this.credentials,
          tokens,
          tokenExpiresAt:
            tokens.expires_in === undefined ? undefined : this.now() + tokens.expires_in * 1000,
          reconnectRequired: false,
        });
      },
      discoveryState: () => this.credentials.discovery,
      saveDiscoveryState: (discovery) => this.save({ ...this.credentials, discovery }),
      codeVerifier: () => {
        if (!pending?.verifier) {
          throw new NotionError('Authorization is missing or expired. Connect Notion again.', 400);
        }
        return pending.verifier;
      },
      saveCodeVerifier: async (verifier) => {
        if (!pending) {
          throw new NotionError('Connect Notion again to authorize access.', 409);
        }
        pending.verifier = verifier;
        await this.save({ ...this.credentials, pending });
      },
      redirectToAuthorization: (url) => {
        if (!onRedirect) {
          throw new NotionError('Notion authorization failed. Connect Notion again.', 409);
        }
        onRedirect(url);
      },
      invalidateCredentials: async (scope) => {
        await this.requireReconnect(scope === 'all' || scope === 'client');
        throw new NotionError(
          'Notion authorization expired or was revoked. Reconnect Notion.',
          409,
        );
      },
    };
  }

  connect(): Promise<{ authorizationUrl: string }> {
    return this.run(async () => {
      if (this.loadFailed) {
        throw new NotionError(this.error!, 409);
      }
      const pending = {
        state: randomBytes(32).toString('hex'),
        expiresAt: this.now() + this.authorizationTimeoutMs,
      };
      await this.save({
        ...this.credentials,
        redirectUrl: this.redirectUrl,
        tokens: undefined,
        tokenExpiresAt: undefined,
        pending,
        reconnectRequired: false,
        workspace: undefined,
        lastCheckedAt: undefined,
      });
      let authorizationUrl: string | undefined;
      try {
        await auth(
          this.provider(pending, (url) => {
            authorizationUrl = url.href;
          }),
          { serverUrl, fetchFn: this.requestFetch },
        );
        if (!authorizationUrl) {
          throw new NotionError(
            'Notion did not return an authorization URL. Try connecting again.',
          );
        }
        this.error = undefined;
        return { authorizationUrl };
      } catch (error) {
        throw this.safeError(error);
      }
    });
  }

  callback(code: string, state: string): Promise<NotionConnectionState> {
    return this.run(async () => {
      const pending = this.credentials.pending;
      const expected = Buffer.from(pending?.state ?? '');
      const received = Buffer.from(state);
      if (
        !pending ||
        pending.expiresAt <= this.now() ||
        !code ||
        expected.length !== received.length ||
        !timingSafeEqual(expected, received)
      ) {
        throw new NotionError(
          'Invalid, expired, or already used Notion authorization. Connect again.',
          400,
        );
      }
      await this.save({ ...this.credentials, pending: undefined });
      try {
        await auth(this.provider(pending), {
          serverUrl,
          authorizationCode: code,
          fetchFn: this.requestFetch,
        });
        this.error = undefined;
        return this.state();
      } catch (error) {
        throw this.safeError(error);
      }
    });
  }

  disconnect(): Promise<NotionConnectionState> {
    return this.run(async () => {
      await this.save({});
      this.loadFailed = false;
      this.error = undefined;
      return this.state();
    });
  }

  private async requireReconnect(resetClient = false): Promise<void> {
    await this.save({
      ...this.credentials,
      client: resetClient ? undefined : this.credentials.client,
      discovery: resetClient ? undefined : this.credentials.discovery,
      tokens: undefined,
      tokenExpiresAt: undefined,
      pending: undefined,
      reconnectRequired: true,
    });
  }

  private refresh(force = false): Promise<void> {
    this.refreshing ??= this.renewTokens(force).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async renewTokens(force: boolean): Promise<void> {
    const { tokens, client, discovery, tokenExpiresAt } = this.credentials;
    if (!tokens || this.credentials.reconnectRequired || this.loadFailed) {
      throw new NotionError('Connect or reconnect Notion before reading sources.', 409);
    }
    if (
      !force &&
      (tokenExpiresAt === undefined ||
        tokenExpiresAt > this.now() + brainConfig.notionMcp.refreshSkewMs)
    ) {
      return;
    }
    if (!tokens.refresh_token || !client || !discovery) {
      await this.requireReconnect();
      throw new NotionError('Notion authorization expired. Reconnect Notion.', 409);
    }
    try {
      const provider = this.provider();
      const refreshed = await refreshAuthorization(discovery.authorizationServerUrl, {
        metadata: discovery.authorizationServerMetadata,
        clientInformation: client,
        refreshToken: tokens.refresh_token,
        resource: await selectResourceURL(serverUrl, provider, discovery.resourceMetadata),
        fetchFn: this.requestFetch,
      });
      await provider.saveTokens(refreshed);
    } catch (error) {
      if (
        error instanceof InvalidGrantError ||
        error instanceof InvalidClientError ||
        error instanceof UnauthorizedClientError
      ) {
        await this.requireReconnect(!(error instanceof InvalidGrantError));
        throw new NotionError(
          'Notion authorization expired or was revoked. Reconnect Notion.',
          409,
        );
      }
      throw error;
    }
  }

  private withClient<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    return this.run(async () => {
      const client = new Client({ name: 'harmony-brain', version: '0.1.0' });
      this.activeClient = client;
      try {
        await this.refresh();
        const authenticatedFetch: FetchLike = async (input, init = {}) => {
          let sentToken: string;
          const send = () => {
            const headers = new Headers(init.headers);
            sentToken = this.credentials.tokens!.access_token;
            headers.set('Authorization', `Bearer ${sentToken}`);
            return this.requestFetch(input, { ...init, headers });
          };
          let response = await send();
          if (response.status === 401) {
            await response.body?.cancel();
            if (this.credentials.tokens?.access_token === sentToken!) {
              await this.refresh(true);
            }
            response = await send();
            if (response.status === 401) {
              await this.requireReconnect();
              throw new NotionError(
                'Notion rejected the renewed authorization. Reconnect Notion.',
                409,
              );
            }
          }
          return response;
        };
        const transport = new StreamableHTTPClientTransport(serverUrl, {
          fetch: authenticatedFetch,
        });
        await client.connect(transport, { timeout: this.requestTimeoutMs });
        if (!this.credentials.workspace) {
          try {
            const identity = await client.callTool(
              { name: 'notion-get-self', arguments: {} },
              undefined,
              { timeout: this.requestTimeoutMs },
            );
            const workspace = parseWorkspace(identity);
            if (workspace) {
              await this.save({ ...this.credentials, workspace });
            }
          } catch (error) {
            if (this.credentials.reconnectRequired) {
              throw error;
            }
            // Some Notion connections do not expose the optional identity tool.
          }
        }
        const result = await operation(client);
        await this.save({ ...this.credentials, lastCheckedAt: new Date(this.now()).toISOString() });
        this.error = undefined;
        return result;
      } catch (error) {
        throw this.safeError(error);
      } finally {
        await client.close().catch(() => {});
        await this.refreshing?.catch(() => {});
        this.activeClient = undefined;
      }
    });
  }

  fetchPage(pageId: string) {
    const id = normalizePageId(pageId);
    return this.withClient(async (client) => {
      const result = await client.callTool({ name: 'notion-fetch', arguments: { id } }, undefined, {
        timeout: this.requestTimeoutMs,
      });
      return parseNotionPage(id, result, brainConfig.notionMcp.maxPageCharacters);
    });
  }

  async test(pageId?: string) {
    if (pageId) {
      const page = await this.fetchPage(pageId);
      return { ...this.state(), page: { pageId: page.pageId, title: page.title, url: page.url } };
    }
    await this.withClient(async () => undefined);
    return this.state();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.shutdown.abort();
    await this.activeClient?.close().catch(() => {});
    await this.queue;
  }

  private safeError(error: unknown): NotionError {
    const safe =
      error instanceof NotionError
        ? error
        : error instanceof StreamableHTTPError && error.code === 403
          ? new NotionError('Notion denied access. Check page and workspace permissions.', 403)
          : new NotionError(
              'Notion could not be reached or returned an invalid response. Check the connection and try again.',
            );
    this.error = safe.message;
    return safe;
  }
}

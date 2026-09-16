import { brainConfig } from '../config.js';
import type { CogneeOptions } from './types.js';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cognee returned an invalid response.');
  }
  return value as Record<string, unknown>;
}

export function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  ) {
    throw new Error('Cognee returned an invalid identifier.');
  }
  return value;
}

export class CogneeHttp {
  private readonly url: string;
  private readonly staticToken?: string;
  private readonly username: string;
  private readonly password?: string;
  private readonly fetcher: typeof fetch;
  private token?: string;
  private loginPending?: Promise<string>;
  private readonly controller = new AbortController();

  constructor(options: CogneeOptions = {}) {
    this.url = (options.url ?? process.env.COGNEE_API_URL ?? '').replace(/\/$/, '');
    this.staticToken = (options.token ?? process.env.COGNEE_API_TOKEN)?.trim() || undefined;
    this.username = options.username ?? process.env.COGNEE_USERNAME ?? 'brain@example.com';
    this.password = options.password ?? process.env.COGNEE_PASSWORD;
    this.fetcher = options.fetch ?? fetch;
  }

  get configured() {
    return Boolean(this.url && (this.staticToken || this.password));
  }

  get signal() {
    return this.controller.signal;
  }

  close() {
    this.controller.abort();
  }

  async request(path: string, options: RequestInit = {}): Promise<unknown> {
    if (!this.configured) {
      throw new Error('Configure COGNEE_API_URL and Cognee service credentials on the server.');
    }
    const token = this.staticToken ?? this.token ?? (await this.login());
    let response = await this.send(path, options, token);
    if (response.status === 401 && !this.staticToken) {
      await response.body?.cancel();
      if (this.token === token) {
        this.token = undefined;
      }
      response = await this.send(path, options, this.token ?? (await this.login()));
    }
    return this.read(response);
  }

  private async login(): Promise<string> {
    if (this.loginPending) {
      return this.loginPending;
    }
    this.loginPending = this.performLogin();
    try {
      return await this.loginPending;
    } finally {
      this.loginPending = undefined;
    }
  }

  private async performLogin(): Promise<string> {
    const body = new URLSearchParams({ username: this.username, password: this.password ?? '' });
    const result = record(
      await this.read(await this.send('/api/v1/auth/login', { method: 'POST', body })),
    );
    if (typeof result.access_token !== 'string' || !result.access_token) {
      throw new Error('Cognee authentication returned no access token.');
    }
    this.token = result.access_token;
    return this.token;
  }

  private async send(path: string, options: RequestInit, token?: string) {
    const url = new URL(this.url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        'COGNEE_API_URL must be an HTTP service URL without credentials or query parameters.',
      );
    }
    const headers = new Headers(options.headers);
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    try {
      return await this.fetcher(`${this.url}${path}`, {
        ...options,
        headers,
        redirect: 'error',
        signal: AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(brainConfig.cognee.requestTimeoutMs),
        ]),
      });
    } catch {
      throw new Error('Cognee is unavailable or the service request timed out.');
    }
  }

  private async read(response: Response): Promise<unknown> {
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        throw new Error('Cognee service authentication failed. Check its server credentials.');
      }
      throw new Error(
        `Cognee request failed (HTTP ${response.status}). Check the private service logs.`,
      );
    }
    if (response.status === 204) {
      return null;
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        bytes += next.value.byteLength;
        if (bytes > brainConfig.cognee.maxResponseBytes) {
          await reader.cancel();
          throw new Error('Cognee response exceeds the configured size limit.');
        }
        chunks.push(next.value);
      }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new Error('Cognee returned invalid JSON.');
    }
  }
}

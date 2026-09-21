import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { BrainStorage } from '../brain/persistence.js';
import { brainConfig } from '../brain/config.js';
import { config } from '../config.js';
import { agentLabel } from '../identity.js';
import { normalizeRepositoryRemote, type AuthorizedRepository } from './repositories.js';

export interface DeveloperAccount {
  id: string;
  name: string;
  email: string;
  team: string;
  /** Retained only when reading older records; permissions are now shared. */
  projectIds?: string[];
  enabled: boolean;
  createdAt: string;
}

export interface DeviceToken {
  id: string;
  accountId: string;
  label: string;
  digest: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

export interface AccessPrincipal {
  account: DeveloperAccount;
  token: Omit<DeviceToken, 'digest'>;
}

export function accessError(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const publicToken = ({ digest: _digest, ...token }: DeviceToken) => token;

export class AccessStore {
  readonly storage: BrainStorage;

  constructor(path: string) {
    this.storage = new BrainStorage(
      path,
      [
        'access_accounts',
        'access_tokens',
        'access_audit',
        'access_settings',
        'access_repositories',
      ],
      3,
    );
  }

  init() {
    return this.storage.init();
  }
  close() {
    return this.storage.close();
  }

  get requireDeviceTokens() {
    return (
      this.storage.get<{ required: boolean }>('access_settings', 'device-tokens')?.required ?? false
    );
  }

  snapshot() {
    return {
      accounts: this.storage.entries<DeveloperAccount>('access_accounts').map(({ data }) => ({
        ...data,
        activityLabel: config.anonymize ? agentLabel(`account:${data.id}`) : `account:${data.id}`,
      })),
      tokens: this.storage
        .entries<DeviceToken>('access_tokens')
        .map(({ data }) => publicToken(data)),
      audit: this.storage
        .entries<{ id: string; at: string; actor: string; action: string; target: string }>(
          'access_audit',
        )
        .slice(0, brainConfig.access.auditDisplayLimit)
        .map(({ data }) => data),
      requireDeviceTokens: this.requireDeviceTokens,
      repositories: this.repositories(),
      filterRepositories: this.filterRepositories,
    };
  }

  private audit(action: string, target: string, actor: string) {
    const id = randomUUID();
    return this.storage.put(
      'access_audit',
      id,
      { id, at: new Date().toISOString(), actor, action, target },
      true,
    );
  }

  repositories() {
    return this.storage
      .entries<AuthorizedRepository>('access_repositories')
      .map(({ data }) => data);
  }

  get filterRepositories() {
    return (
      this.storage.get<{ enabled: boolean }>('access_settings', 'repository-filter')?.enabled ??
      false
    );
  }

  repositoryPolicy() {
    return {
      enabled: this.filterRepositories,
      repositories: this.repositories()
        .filter((repo) => repo.enabled)
        .map((repo) => repo.remote),
    };
  }

  async saveRepository(
    input: Omit<AuthorizedRepository, 'id' | 'createdAt'>,
    actor: string,
    id?: string,
  ) {
    const remote = normalizeRepositoryRemote(input.remote);
    if (!remote)
      accessError(
        'Enter a Git HTTPS or SSH repository URL without credentials, query or fragment.',
      );
    return this.storage.transaction(async () => {
      const existing = id
        ? this.storage.get<AuthorizedRepository>('access_repositories', id)
        : undefined;
      if (id && !existing) accessError('Repository not found.', 404);
      if (this.repositories().some((repo) => repo.remote === remote && repo.id !== id))
        accessError('This repository is already registered.', 409);
      const repository = {
        ...input,
        remote,
        id: existing?.id ?? randomUUID(),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      await this.storage.put('access_repositories', repository.id, repository);
      await this.audit(
        existing ? 'repository.updated' : 'repository.created',
        repository.id,
        actor,
      );
      return repository;
    });
  }

  async setRepositoryFiltering(enabled: boolean, actor: string) {
    await this.storage.transaction(async () => {
      await this.storage.put('access_settings', 'repository-filter', { enabled });
      await this.audit(
        enabled ? 'repository-filter.enabled' : 'repository-filter.disabled',
        'repositories',
        actor,
      );
    });
  }

  async saveAccount(input: Omit<DeveloperAccount, 'id' | 'createdAt'>, actor: string, id?: string) {
    return this.storage.transaction(async () => {
      const existing = id ? this.storage.get<DeveloperAccount>('access_accounts', id) : undefined;
      if (id && !existing) accessError('Account not found.', 404);
      const duplicate = this.storage
        .entries<DeveloperAccount>('access_accounts')
        .some(({ data }) => data.id !== id && data.email === input.email);
      if (duplicate) accessError('An account with this email already exists.', 409);
      const account = {
        ...input,
        id: existing?.id ?? randomUUID(),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      await this.storage.put('access_accounts', account.id, account);
      if (!account.enabled) {
        for (const { data: token } of this.storage.entries<DeviceToken>('access_tokens')) {
          if (token.accountId === account.id && !token.revokedAt) {
            await this.storage.put('access_tokens', token.id, {
              ...token,
              revokedAt: new Date().toISOString(),
            });
          }
        }
      }
      await this.audit(existing ? 'account.updated' : 'account.created', account.id, actor);
      return account;
    });
  }

  async issue(accountId: string, label: string, expiresInDays: number, actor: string) {
    return this.storage.transaction(async () => {
      const account = this.storage.get<DeveloperAccount>('access_accounts', accountId);
      if (!account?.enabled) accessError('An active account is required.');
      const id = randomUUID();
      const secret = `hb_${id}.${randomBytes(32).toString('base64url')}`;
      const token: DeviceToken = {
        id,
        accountId,
        label,
        digest: digest(secret),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + expiresInDays * 86400000).toISOString(),
      };
      await this.storage.put('access_tokens', id, token);
      await this.audit('token.created', id, actor);
      return { token: publicToken(token), secret };
    });
  }

  async revoke(id: string, actor: string) {
    await this.storage.transaction(async () => {
      const token = this.storage.get<DeviceToken>('access_tokens', id);
      if (!token) accessError('Token not found.', 404);
      if (!token.revokedAt) {
        await this.storage.put('access_tokens', id, {
          ...token,
          revokedAt: new Date().toISOString(),
        });
        await this.audit('token.revoked', id, actor);
      }
    });
  }

  async setRequired(required: boolean, actor: string) {
    await this.storage.transaction(async () => {
      if (
        required &&
        !this.storage.entries<DeviceToken>('access_tokens').some(({ data }) => this.active(data))
      ) {
        accessError('Create an active workstation token before requiring individual tokens.');
      }
      await this.storage.put('access_settings', 'device-tokens', { required });
      await this.audit(
        required ? 'individual-tokens.required' : 'legacy-access.allowed',
        'device-tokens',
        actor,
      );
    });
  }

  private active(token: DeviceToken) {
    return (
      !token.revokedAt &&
      Date.parse(token.expiresAt) > Date.now() &&
      this.storage.get<DeveloperAccount>('access_accounts', token.accountId)?.enabled
    );
  }

  async authenticate(secret: string): Promise<AccessPrincipal | null> {
    const match = /^hb_([a-f0-9-]{36})\.[A-Za-z0-9_-]{43}$/.exec(secret);
    if (!match) return null;
    return this.storage.transaction(async () => {
      const token = this.storage.get<DeviceToken>('access_tokens', match[1]);
      if (!token || !this.active(token)) return null;
      if (!timingSafeEqual(Buffer.from(token.digest, 'hex'), Buffer.from(digest(secret), 'hex')))
        return null;
      if (
        !token.lastUsedAt ||
        Date.now() - Date.parse(token.lastUsedAt) >= brainConfig.access.lastUsedIntervalMs
      ) {
        token.lastUsedAt = new Date().toISOString();
        await this.storage.put('access_tokens', token.id, token);
      }
      return {
        account: this.storage.get<DeveloperAccount>('access_accounts', token.accountId)!,
        token: publicToken(token),
      };
    });
  }
}

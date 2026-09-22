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
  teamIds: string[];
  /** Retained only when reading older records; permissions are now shared. */
  projectIds?: string[];
  enabled: boolean;
  createdAt: string;
}

export interface ManagedTeam {
  id: string;
  name: string;
  createdAt: string;
}

interface LegacyTeamAlias {
  legacyName: string;
  id: string;
  name: string;
}

export interface DeviceToken {
  id: string;
  accountId: string;
  label: string;
  digest: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt?: string;
  lastUsedAt?: string;
}

export interface AccessPrincipal {
  account: DeveloperAccount;
  token: Omit<DeviceToken, 'digest'>;
  teams: Pick<ManagedTeam, 'id' | 'name'>[];
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
        'access_teams',
        'access_tokens',
        'access_audit',
        'access_settings',
        'access_repositories',
        'access_brain_projects',
      ],
      3,
    );
  }

  async init() {
    await this.storage.init();
    try {
      await this.storage.transaction(async () => {
        // Keep existing accounts and credentials while replacing free-text team assignments.
        await this.migrateTeams();
        await this.storage.remove('access_settings', 'device-tokens');
      });
    } catch (error) {
      await this.storage.close();
      throw error;
    }
  }
  close() {
    return this.storage.close();
  }

  private async migrateTeams() {
    type StoredAccount = Omit<DeveloperAccount, 'teamIds'> & { team?: string; teamIds?: string[] };
    const teamsByName = new Map(this.teams().map((team) => [team.name.trim().toLowerCase(), team]));
    const savedAliases = this.storage.get<LegacyTeamAlias[]>(
      'access_settings',
      'legacy-team-aliases',
    );
    // Bootstrap installations already migrated by the first managed-team release once.
    // Retain aliases after deletion so a reused name cannot inherit another team's history.
    const aliases = new Map(
      (savedAliases ?? this.teams().map(({ id, name }) => ({ legacyName: name, id, name }))).map(
        (alias) => [alias.legacyName.trim().toLowerCase(), alias],
      ),
    );
    for (const { data } of this.storage.entries<StoredAccount>('access_accounts')) {
      if (Array.isArray(data.teamIds) && !('team' in data)) {
        continue;
      }
      const { team: legacyTeam, ...account } = data;
      const teamIds = Array.isArray(account.teamIds) ? [...new Set(account.teamIds)] : [];
      const name = typeof legacyTeam === 'string' ? legacyTeam.trim() : '';
      if (!Array.isArray(account.teamIds) && name) {
        const key = name.toLowerCase();
        let team = teamsByName.get(key);
        if (!team) {
          team = { id: randomUUID(), name, createdAt: new Date().toISOString() };
          await this.storage.put('access_teams', team.id, team);
          teamsByName.set(key, team);
        }
        teamIds.push(team.id);
        if (!aliases.has(key)) {
          aliases.set(key, { legacyName: name, id: team.id, name: team.name });
        }
      }
      await this.storage.put('access_accounts', account.id, { ...account, teamIds });
    }
    if (!savedAliases || aliases.size !== savedAliases.length) {
      await this.storage.put('access_settings', 'legacy-team-aliases', [...aliases.values()]);
    }
  }

  snapshot() {
    return {
      accounts: this.storage.entries<DeveloperAccount>('access_accounts').map(({ data }) => ({
        ...data,
        activityLabel: config.anonymize ? agentLabel(`account:${data.id}`) : `account:${data.id}`,
      })),
      teams: this.teams(),
      tokens: this.storage
        .entries<DeviceToken>('access_tokens')
        .map(({ data }) => publicToken(data)),
      audit: this.storage
        .entries<{ id: string; at: string; actor: string; action: string; target: string }>(
          'access_audit',
        )
        .slice(0, brainConfig.access.auditDisplayLimit)
        .map(({ data }) => data),
      repositories: this.repositories(),
      filterRepositories: this.filterRepositories,
    };
  }

  teams(): ManagedTeam[] {
    return this.storage.entries<ManagedTeam>('access_teams').map(({ data }) => data);
  }

  legacyTeamAliases(): ReadonlyMap<string, Pick<ManagedTeam, 'id' | 'name'>> {
    const aliases =
      this.storage.get<LegacyTeamAlias[]>('access_settings', 'legacy-team-aliases') ?? [];
    return new Map(
      aliases.map((alias) => {
        const team = this.storage.get<ManagedTeam>('access_teams', alias.id);
        return [
          alias.legacyName.trim().toLowerCase(),
          { id: alias.id, name: team?.name ?? alias.name },
        ];
      }),
    );
  }

  teamsForAccount(accountId: string): AccessPrincipal['teams'] | undefined {
    const account = this.storage.get<DeveloperAccount>('access_accounts', accountId);
    if (!account) {
      return undefined;
    }
    return account.teamIds.flatMap((id) => {
      const team = this.storage.get<ManagedTeam>('access_teams', id);
      return team ? [{ id: team.id, name: team.name }] : [];
    });
  }

  async saveTeam(input: { name: string }, actor: string, id?: string) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80) {
      accessError('Team name must contain 1 to 80 characters.');
    }
    return this.storage.transaction(async () => {
      const existing = id ? this.storage.get<ManagedTeam>('access_teams', id) : undefined;
      if (id && !existing) {
        accessError('Team not found.', 404);
      }
      if (
        this.teams().some(
          (team) => team.id !== id && team.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        accessError('A team with this name already exists.', 409);
      }
      const team: ManagedTeam = {
        id: existing?.id ?? randomUUID(),
        name,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      await this.storage.put('access_teams', team.id, team);
      await this.audit(existing ? 'team.updated' : 'team.created', team.id, actor);
      return team;
    });
  }

  async removeTeam(id: string, actor: string) {
    return this.storage.transaction(async () => {
      if (!this.storage.get<ManagedTeam>('access_teams', id)) {
        accessError('Team not found.', 404);
      }
      const assigned = this.storage
        .entries<DeveloperAccount>('access_accounts')
        .some(({ data }) => data.teamIds.includes(id));
      if (assigned) {
        accessError('Remove all account assignments before deleting this team.', 409);
      }
      await this.storage.remove('access_teams', id);
      await this.audit('team.deleted', id, actor);
    });
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
      if (
        !Array.isArray(input.teamIds) ||
        input.teamIds.some(
          (teamId) =>
            typeof teamId !== 'string' || !this.storage.get<ManagedTeam>('access_teams', teamId),
        )
      ) {
        accessError('Select existing teams for this account.');
      }
      const existing = id ? this.storage.get<DeveloperAccount>('access_accounts', id) : undefined;
      if (id && !existing) accessError('Account not found.', 404);
      const duplicate = this.storage
        .entries<DeveloperAccount>('access_accounts')
        .some(({ data }) => data.id !== id && data.email === input.email);
      if (duplicate) accessError('An account with this email already exists.', 409);
      const account = {
        ...input,
        teamIds: [...new Set(input.teamIds)],
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

  async issue(
    accountId: string,
    label: string,
    expiresInDays: number | null | undefined,
    actor: string,
  ) {
    if (
      expiresInDays != null &&
      (!Number.isInteger(expiresInDays) ||
        expiresInDays < 1 ||
        expiresInDays > brainConfig.access.maxTokenDays)
    ) {
      accessError(
        `Token expiration must be a whole number from 1 to ${brainConfig.access.maxTokenDays} days, or no expiration.`,
      );
    }
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
        expiresAt:
          expiresInDays == null
            ? null
            : new Date(Date.now() + expiresInDays * 86400000).toISOString(),
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

  private active(token: DeviceToken) {
    const expiration = token.expiresAt;
    const timestamp = typeof expiration === 'string' ? Date.parse(expiration) : NaN;
    const notExpired =
      expiration === null ||
      (Number.isFinite(timestamp) &&
        new Date(timestamp).toISOString() === expiration &&
        timestamp > Date.now());
    return (
      !token.revokedAt &&
      notExpired &&
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
      const account = this.storage.get<DeveloperAccount>('access_accounts', token.accountId)!;
      return {
        account,
        token: publicToken(token),
        teams: this.teamsForAccount(account.id)!,
      };
    });
  }
}

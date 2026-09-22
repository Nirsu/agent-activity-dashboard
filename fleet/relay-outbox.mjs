import { mkdir, readdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readPolicy, repositoryRemote, selectedRepository } from './project-policy.mjs';
import { safeTelemetry } from './safe-telemetry.mjs';

const defaults = createRequire(import.meta.url)('./relay-config.json');

export function requireAgentToken(token) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('Set HARMONIE_TOKEN to a workstation token issued in Accounts.');
  }
  return token;
}

// Fingerprints bind queued events and running relays without storing the bearer secret.
export const relayCredentialId = (token) =>
  createHash('sha256')
    .update(token || '')
    .digest('hex');

export class RelayOutbox {
  entries = [];
  bytes = 0;
  discarded = 0;
  lastError = null;
  serial = Date.now() * 1000;
  writing = Promise.resolve();
  draining = null;
  remotePolicy = null;

  constructor(configPath, forward, token, limits = defaults) {
    this.configPath = configPath;
    this.directory = join(dirname(configPath), 'outbox');
    this.forward = forward;
    this.token = requireAgentToken(token);
    this.credentialId = relayCredentialId(token);
    this.limits = limits;
  }

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of (await readdir(this.directory))
      .filter((name) => /^\d+-[a-z]+\.json$/.test(name))
      .sort()) {
      const text = await readFile(join(this.directory, name), 'utf8');
      try {
        const entry = JSON.parse(text);
        if (
          !entry.project ||
          !entry.dashboardUrl ||
          !['/activity', '/v1/logs', '/v1/metrics'].includes(entry.path) ||
          !Number.isFinite(entry.createdAt)
        )
          throw new Error('Invalid queued event');
        this.entries.push({ name, entry, bytes: Buffer.byteLength(text) });
        this.bytes += Buffer.byteLength(text);
        this.serial = Math.max(this.serial, Number(name.split('-')[0]));
      } catch {
        this.lastError = 'A damaged queue entry was quarantined.';
        await rename(join(this.directory, name), join(this.directory, `${name}.invalid`));
      }
    }
  }

  status() {
    return {
      pending: this.entries.length,
      bytes: this.bytes,
      discarded: this.discarded,
      lastError: this.lastError,
    };
  }

  enqueue(path, body, project, dashboardUrl, workspace) {
    const operation = this.writing.then(async () => {
      const entry = {
        path,
        body: safeTelemetry(path, body),
        project,
        dashboardUrl,
        repository: repositoryRemote(project),
        createdAt: Date.now(),
        credentialId: this.credentialId,
        ...(workspace ? { workspace } : {}),
      };
      const text = JSON.stringify(entry);
      const bytes = Buffer.byteLength(text);
      if (
        this.entries.length >= this.limits.maxQueueEntries ||
        this.bytes + bytes > this.limits.maxQueueBytes
      ) {
        this.lastError = 'Telemetry queue is full; new events could not be saved.';
        throw new Error(this.lastError);
      }
      this.serial = Math.max(this.serial + 1, Date.now() * 1000);
      const name = `${this.serial}-event.json`;
      const temporary = join(this.directory, `${name}.tmp`);
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(text);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(this.directory, name));
      this.entries.push({ name, entry, bytes });
      this.bytes += bytes;
    });
    this.writing = operation.catch(() => {});
    return operation;
  }

  flush() {
    if (this.draining) return this.draining;
    this.draining = this.drain()
      .catch((error) => {
        if (error.code !== 'POLICY_HTTP')
          this.lastError = 'Telemetry delivery is unavailable; saved events will be retried.';
      })
      .finally(() => {
        this.draining = null;
      });
    return this.draining;
  }

  async drain() {
    await this.writing;
    let differentCredential = false;
    for (const current of [...this.entries]) {
      const { entry } = current;
      const isRetired = () => {
        const policy = readPolicy(this.configPath);
        return (
          policy.dashboardUrl !== entry.dashboardUrl ||
          !policy.projects.includes(entry.project) ||
          (entry.workspace &&
            selectedRepository(entry.workspace, policy.projects, policy.workspaceBindings) !==
              entry.project)
        );
      };
      let retired = isRetired();
      const expired = Date.now() - entry.createdAt > this.limits.maxQueueAgeMs;
      if (!retired && !expired && entry.credentialId !== this.credentialId) {
        // Keep the original identity, including unknown entries from older relays.
        // A replacement credential may belong to a different developer.
        differentCredential = true;
        continue;
      }
      if (!retired && !expired) {
        const rules = await this.repositoryPolicy(entry.dashboardUrl);
        if (
          rules.enabled &&
          (!entry.repository || !rules.repositories.includes(entry.repository))
        ) {
          retired = true;
          this.lastError =
            'Repository is not authorized by the dashboard; queued activity was discarded.';
        }
        // The local binding may have been removed while fetching shared policy.
        retired = retired || isRetired();
      }
      if (!retired && !expired) {
        const headers = {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
        };
        if (entry.repository) headers['x-harmonie-repository'] = entry.repository;
        const result = await this.forward(`${entry.dashboardUrl}${entry.path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(entry.body),
          redirect: 'error',
          signal: AbortSignal.timeout(this.limits.forwardTimeoutMs),
        });
        await result.body?.cancel();
        if (
          result.status === 403 &&
          result.headers.get('x-harmonie-policy-rejected') === 'repository'
        ) {
          this.remotePolicy = null;
          this.discarded++;
          this.lastError = 'Repository authorization was removed; queued activity was discarded.';
        } else if (!result.ok) {
          this.lastError = `Dashboard returned HTTP ${result.status}; saved events will be retried.`;
          return;
        } else {
          this.lastError = null;
        }
      } else {
        this.discarded++;
      }
      await unlink(join(this.directory, current.name));
      this.entries.splice(this.entries.indexOf(current), 1);
      this.bytes -= current.bytes;
    }
    if (differentCredential) {
      this.lastError =
        'Saved events with a different credential or unknown identity were not sent. Check the queue before they expire.';
    }
  }

  async repositoryPolicy(dashboardUrl) {
    if (
      this.remotePolicy?.dashboardUrl === dashboardUrl &&
      Date.now() - this.remotePolicy.at < this.limits.policyCacheMs
    )
      return this.remotePolicy.value;
    const response = await this.forward(`${dashboardUrl}/api/agent-policy`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(this.limits.forwardTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      this.lastError = `Dashboard policy returned HTTP ${response.status}; saved events will be retried.`;
      throw Object.assign(new Error(this.lastError), { code: 'POLICY_HTTP' });
    }
    const value = await response.json();
    if (
      typeof value.enabled !== 'boolean' ||
      !Array.isArray(value.repositories) ||
      value.repositories.some((remote) => typeof remote !== 'string')
    )
      throw new Error('Invalid repository policy');
    this.remotePolicy = { dashboardUrl, at: Date.now(), value };
    return value;
  }
}

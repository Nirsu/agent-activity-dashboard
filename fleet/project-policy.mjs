import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const { normalizeRepositoryRemote } = createRequire(import.meta.url)('./repository-url.cjs');

export const defaultRelayPort = 14318;
export const defaultConfigPath = () =>
  process.env.AAD_TELEMETRY_CONFIG ||
  join(homedir(), '.config', 'harmonie-agents', 'telemetry.json');

export function dashboardOrigin(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  ) {
    throw new Error(
      'Use an HTTPS dashboard origin, or HTTP on localhost, without credentials or a path.',
    );
  }
  return url.origin;
}

export function validatePolicy(value) {
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.projects) ||
    value.projects.some((path) => typeof path !== 'string' || !isAbsolute(path)) ||
    !Number.isInteger(value.relayPort) ||
    value.relayPort < 1024 ||
    value.relayPort > 65535
  ) {
    throw new Error('Invalid telemetry configuration. No telemetry will be forwarded.');
  }
  const dashboardUrl = dashboardOrigin(value.dashboardUrl);
  const target = new URL(dashboardUrl);
  if (
    ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) &&
    Number(target.port || (target.protocol === 'https:' ? 443 : 80)) === value.relayPort
  ) {
    throw new Error('The relay and dashboard must use different ports.');
  }
  return {
    version: 1,
    dashboardUrl,
    relayPort: value.relayPort,
    projects: [...new Set(value.projects)],
  };
}

export function readPolicy(path = defaultConfigPath()) {
  return validatePolicy(JSON.parse(readFileSync(path, 'utf8')));
}

function canonical(path) {
  const result = realpathSync.native(path);
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

/** Match repository identity, not a basename or path prefix. Linked worktrees share it. */
export function repositoryAt(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return undefined;
  try {
    const options = {
      cwd: path,
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    };
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], options).trim();
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], options).trim();
    return { path: realpathSync.native(root), identity: canonical(resolve(path, common)) };
  } catch {
    return undefined;
  }
}

export function selectedRepository(cwd, projects) {
  const current = repositoryAt(cwd);
  if (!current) return undefined;
  return projects.find((path) => repositoryAt(path)?.identity === current.identity);
}

export function repositoryRemote(path) {
  try {
    return normalizeRepositoryRemote(
      execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: path,
        encoding: 'utf8',
        timeout: 1500,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
  } catch {
    return undefined;
  }
}

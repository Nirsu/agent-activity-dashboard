import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { brainConfig } from '../config.js';
import type { Project } from './types.js';

const executeFile = promisify(execFile);
const objectIdPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const noConfiguration = process.platform === 'win32' ? 'NUL' : '/dev/null';

export type GithubGitInvocation = {
  args: string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
};

type GithubCodeOptions = {
  environment?: () => NodeJS.ProcessEnv;
  execute?: (invocation: GithubGitInvocation) => Promise<string>;
};

export function githubRepositoryUrl(remote: string): string {
  const match = /^github\.com\/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9_.-]{1,100})$/i.exec(
    remote,
  );
  if (!match || match[2] === '.' || match[2] === '..') {
    throw new Error(
      'Automatic code access requires a GitHub repository in github.com/owner/repo format.',
    );
  }
  const repository = match[2].replace(/\.git$/i, '');
  if (!repository || repository === '.' || repository === '..') {
    throw new Error('The GitHub repository name is invalid.');
  }
  return `https://github.com/${match[1]}/${repository}.git`;
}

function gitEnvironment(source: NodeJS.ProcessEnv, url?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    // Never inherit caller Git directories, tracing, config injection or askpass programs.
    if (!/^(?:GIT_|GCM_)/i.test(key) && key !== 'BRAIN_GITHUB_TOKEN') {
      environment[key] = value;
    }
  }
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: noConfiguration,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
  });
  const settings = [
    ['credential.helper', ''],
    ['credential.interactive', 'false'],
    ['core.askPass', ''],
    ['core.hooksPath', noConfiguration],
    ['protocol.allow', 'never'],
    ['protocol.https.allow', 'always'],
    ['http.followRedirects', 'false'],
    ['fetch.recurseSubmodules', 'false'],
    ['maintenance.auto', 'false'],
    ['gc.auto', '0'],
  ];
  if (url && source.BRAIN_GITHUB_TOKEN?.trim()) {
    const token = source.BRAIN_GITHUB_TOKEN.trim();
    if (/[\r\n\0]/.test(token)) {
      throw new Error('The server GitHub token configuration is invalid.');
    }
    const authorization = Buffer.from(`x-access-token:${token}`).toString('base64');
    // An environment-only, exact-URL setting avoids secrets in argv or repository config.
    settings.push([`http.${url}.extraHeader`, `Authorization: Basic ${authorization}`]);
  }
  environment.GIT_CONFIG_COUNT = String(settings.length);
  settings.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return environment;
}

async function executeGit(invocation: GithubGitInvocation): Promise<string> {
  const result = await executeFile(
    invocation.environment.BRAIN_GIT_BINARY ?? 'git',
    invocation.args,
    {
      encoding: 'utf8',
      env: invocation.environment,
      timeout: invocation.timeoutMs,
      maxBuffer: brainConfig.git.maxBufferBytes,
      windowsHide: true,
    },
  );
  return result.stdout;
}

export function createGithubCodeAccess(options: GithubCodeOptions = {}) {
  const execute = options.execute ?? executeGit;
  const environment = options.environment ?? (() => process.env);
  const pending = new Map<string, Promise<unknown>>();

  async function git(args: string[], url?: string, network = false) {
    return execute({
      args,
      environment: gitEnvironment(environment(), url),
      timeoutMs: network ? brainConfig.git.fetchTimeoutMs : brainConfig.git.timeoutMs,
    });
  }

  async function checkAccess(remote: string): Promise<{ commit: string }> {
    const url = githubRepositoryUrl(remote);
    try {
      const output = await git(['ls-remote', '--exit-code', url, 'HEAD'], url, true);
      const commit = output.trim().split(/\s+/)[0];
      if (!objectIdPattern.test(commit)) {
        throw new Error('No default commit.');
      }
      return { commit: commit.toLowerCase() };
    } catch {
      throw new Error(
        'GitHub code is unavailable. Check that the repository has a commit and that the server BRAIN_GITHUB_TOKEN has read access.',
      );
    }
  }

  async function ensureCache(path: string, url: string) {
    await mkdir(path, { recursive: true });
    const directory = await lstat(path);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('The managed GitHub cache must be a regular directory.');
    }
    const entries = await readdir(path);
    const marker = resolve(path, 'brain-origin.json');
    if (entries.includes('brain-origin.json')) {
      const markerFile = await lstat(marker);
      if (!markerFile.isFile() || markerFile.isSymbolicLink()) {
        throw new Error('The managed GitHub cache marker must be a regular file.');
      }
      const ownership = JSON.parse(await readFile(marker, 'utf8')) as { url?: unknown };
      if (ownership.url !== url) {
        throw new Error('The managed GitHub cache belongs to a different repository.');
      }
    } else {
      if (entries.length !== 0) {
        // Older complete caches can acquire a marker; unknown partial directories cannot.
        if ((await git(['-C', path, 'rev-parse', '--is-bare-repository'])).trim() !== 'true') {
          throw new Error('The managed GitHub cache must be a bare repository.');
        }
        const origin = (await git(['-C', path, 'config', '--get', 'remote.origin.url'])).trim();
        if (origin.toLowerCase() !== url.toLowerCase()) {
          throw new Error('The managed GitHub cache belongs to a different repository.');
        }
      }
      // Record ownership before Git writes anything, so an interrupted init is recoverable.
      await writeFile(marker, JSON.stringify({ url }), { flag: 'wx' });
    }
    if (entries.includes('.git')) {
      throw new Error('A working checkout cannot be used as a managed GitHub cache.');
    }
    if (entries.includes('config')) {
      const configuration = resolve(path, 'config');
      const configurationFile = await lstat(configuration);
      if (!configurationFile.isFile() || configurationFile.isSymbolicLink()) {
        throw new Error('The managed GitHub cache configuration must be a regular file.');
      }
      if (
        (await git(['config', '--file', configuration, '--get', 'core.bare'])).trim() !== 'true'
      ) {
        throw new Error('The managed GitHub cache must be a bare repository.');
      }
      const origin = await git([
        'config',
        '--file',
        configuration,
        '--get',
        'remote.origin.url',
      ]).catch(() => '');
      if (origin.trim() && origin.trim().toLowerCase() !== url.toLowerCase()) {
        throw new Error('The managed GitHub cache belongs to a different repository.');
      }
    }
    // Git init repairs missing bare metadata and leaves existing objects and refs intact.
    await git(['init', '--bare', '--template=', path]);
    await git(['-C', path, 'config', 'remote.origin.url', url]);
    if ((await git(['-C', path, 'rev-parse', '--is-bare-repository'])).trim() !== 'true') {
      throw new Error('The managed GitHub cache must be a bare repository.');
    }
    const configuredUrl = (await git(['-C', path, 'config', '--get', 'remote.origin.url'])).trim();
    if (configuredUrl.toLowerCase() !== url.toLowerCase()) {
      throw new Error('The managed GitHub cache belongs to a different repository.');
    }
  }

  async function hasCommit(path: string, commit: string): Promise<boolean> {
    try {
      const resolved = await git(['-C', path, 'rev-parse', '--verify', `${commit}^{commit}`]);
      return resolved.trim().toLowerCase() === commit;
    } catch {
      return false;
    }
  }

  async function prepare(project: Project, requestedCommit?: string): Promise<string | undefined> {
    if (!project.repositoryRemote) {
      return requestedCommit;
    }
    const remote = project.repositoryRemote;
    const url = githubRepositoryUrl(remote);
    if (requestedCommit && !objectIdPattern.test(requestedCommit)) {
      throw new Error('GitHub analysis requires a complete commit SHA.');
    }
    const path = resolve(project.repoPath);
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    const previous = pending.get(key) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          await ensureCache(path, url);
          const commit = requestedCommit?.toLowerCase() ?? (await checkAccess(remote)).commit;
          if (!(await hasCommit(path, commit))) {
            await git(
              [
                '-C',
                path,
                'fetch',
                '--quiet',
                '--no-tags',
                '--no-recurse-submodules',
                '--no-write-fetch-head',
                '--no-auto-maintenance',
                url,
                `${commit}:refs/brain/commits/${commit}`,
              ],
              url,
              true,
            );
            if (!(await hasCommit(path, commit))) {
              throw new Error('Requested commit is missing.');
            }
          }
          if (!requestedCommit) {
            await git(['-C', path, 'update-ref', '--no-deref', 'HEAD', commit]);
          }
          return commit;
        } catch {
          // Git errors may contain credentials from helpers, URLs or HTTP diagnostics.
          throw new Error(
            'GitHub code could not be retrieved. Check server repository read access and push the baseline commit before submitting local changes.',
          );
        }
      });
    pending.set(key, operation);
    try {
      return await operation;
    } finally {
      if (pending.get(key) === operation) {
        pending.delete(key);
      }
    }
  }

  return { prepareGithubRevision: prepare, checkGithubAccess: checkAccess };
}

const github = createGithubCodeAccess();
export const prepareGithubRevision = github.prepareGithubRevision;
export const checkGithubAccess = github.checkGithubAccess;

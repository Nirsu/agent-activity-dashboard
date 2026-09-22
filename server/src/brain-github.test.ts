import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import {
  createGithubCodeAccess,
  githubRepositoryUrl,
  type GithubGitInvocation,
} from './brain/analysis/github.js';
import type { Project } from './brain/analysis/types.js';
import { brainConfig } from './brain/config.js';
import { fixtureGit } from './brain/testing/git.js';

const exec = promisify(execFile);
const remote = 'github.com/example/source';
const url = 'https://github.com/example/source.git';
const token = 'TEST_GITHUB_TOKEN_SENTINEL';

async function fixture(t: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-github-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = resolve(root, 'source');
  await mkdir(source);
  const sourceGit = fixtureGit(source);
  await sourceGit('init');
  await writeFile(resolve(source, 'main.ts'), 'export const version = 1;\n');
  await sourceGit('add', '.');
  await sourceGit('commit', '-m', 'Baseline');
  const commit = await sourceGit('rev-parse', 'HEAD');
  const project: Project = {
    id: 'source',
    name: 'Source',
    scope: 'Source test',
    repoPath: resolve(root, 'cache'),
    repositoryRemote: remote,
    codePaths: ['main.ts'],
    specs: [],
  };
  const invocations: GithubGitInvocation[] = [];
  let failNextFetch = false;
  async function execute(invocation: GithubGitInvocation) {
    invocations.push(invocation);
    const network = invocation.args.includes('fetch') || invocation.args.includes('ls-remote');
    if (failNextFetch && invocation.args.includes('fetch')) {
      failNextFetch = false;
      throw new Error(`Git diagnostic containing ${token}`);
    }
    // Redirect only transport operations to the fixture; persisted origin stays canonical.
    const args = network
      ? invocation.args.map((argument) => (argument === url ? source : argument))
      : invocation.args;
    const env = { ...invocation.environment };
    const count = Number(env.GIT_CONFIG_COUNT);
    env.GIT_CONFIG_COUNT = String(count + 1);
    env[`GIT_CONFIG_KEY_${count}`] = 'protocol.file.allow';
    env[`GIT_CONFIG_VALUE_${count}`] = 'always';
    const result = await exec('git', args, {
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: invocation.timeoutMs,
    });
    return result.stdout;
  }
  const github = createGithubCodeAccess({
    environment: () => ({
      ...process.env,
      BRAIN_GITHUB_TOKEN: token,
      GIT_TRACE: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.evil.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://github.com/',
      GIT_ASKPASS: 'untrusted-program',
    }),
    execute,
  });
  return {
    root,
    source,
    sourceGit,
    commit,
    project,
    invocations,
    github,
    failFetch: () => {
      failNextFetch = true;
    },
  };
}

test('GitHub remote validation rejects arbitrary hosts, credentials and revision injection', async () => {
  assert.equal(
    githubRepositoryUrl('github.com/Example/my-project'),
    'https://github.com/Example/my-project.git',
  );
  assert.equal(githubRepositoryUrl('github.com/example/source.git'), url);
  for (const value of [
    'https://github.com/example/source',
    'github.com.evil/example/source',
    'github.com/user:password@example/source',
    'github.com/example/source?x=1',
    'github.com/example/../source',
    'github.com/example/..',
    'github.com/example/.git',
    'github.com/example/source\n',
    'github.com/-example/source',
  ]) {
    assert.throws(() => githubRepositoryUrl(value), /GitHub/);
  }
  const github = createGithubCodeAccess({
    execute: async () => {
      throw new Error('Must not execute');
    },
  });
  const project = { repositoryRemote: remote, repoPath: '/not-used' } as Project;
  await assert.rejects(
    github.prepareGithubRevision(project, '--upload-pack=bad'),
    /complete commit SHA/,
  );
  assert.equal(
    await github.prepareGithubRevision({ repoPath: '/legacy' } as Project, 'legacy-ref'),
    'legacy-ref',
  );
});

test('GitHub revisions use a bare immutable cache and reuse already fetched commits', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.github.prepareGithubRevision(f.project, f.commit), f.commit);
  const cacheGit = fixtureGit(f.project.repoPath);
  assert.equal(await cacheGit('rev-parse', '--is-bare-repository'), 'true');
  assert.equal(await cacheGit('show', `${f.commit}:main.ts`), 'export const version = 1;');
  assert.ok(!(await readdir(f.project.repoPath)).includes('main.ts'));
  assert.equal(await cacheGit('config', '--get', 'remote.origin.url'), url);
  await writeFile(resolve(f.source, 'main.ts'), 'export const version = 2;\n');
  await f.sourceGit('add', '.');
  await f.sourceGit('commit', '-m', 'Later change');
  assert.equal(await f.github.prepareGithubRevision(f.project, f.commit), f.commit);
  assert.equal(f.invocations.filter((invocation) => invocation.args.includes('fetch')).length, 1);
  assert.equal(await cacheGit('show', `${f.commit}:main.ts`), 'export const version = 1;');
});

test('GitHub default branch is resolved to an immutable SHA on every fresh capture', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.github.checkGithubAccess(remote), { commit: f.commit });
  assert.equal(await f.github.prepareGithubRevision(f.project), f.commit);
  await writeFile(resolve(f.source, 'main.ts'), 'export const version = 2;\n');
  await f.sourceGit('add', '.');
  await f.sourceGit('commit', '-m', 'Later change');
  const latest = await f.sourceGit('rev-parse', 'HEAD');
  assert.equal(await f.github.prepareGithubRevision(f.project), latest);
  assert.equal(await fixtureGit(f.project.repoPath)('rev-parse', 'HEAD'), latest);
});

test('GitHub credentials stay ephemeral and injected Git configuration is removed', async (t) => {
  const f = await fixture(t);
  await f.github.prepareGithubRevision(f.project, f.commit);
  const serializedArguments = JSON.stringify(f.invocations.map((invocation) => invocation.args));
  const encodedToken = Buffer.from(`x-access-token:${token}`).toString('base64');
  assert.ok(!serializedArguments.includes(token));
  assert.ok(!serializedArguments.includes(encodedToken));
  const configuration = await readFile(resolve(f.project.repoPath, 'config'), 'utf8');
  assert.ok(!configuration.includes(token));
  assert.ok(!configuration.includes(encodedToken));
  assert.doesNotMatch(configuration, /extraHeader|Authorization/i);
  for (const invocation of f.invocations) {
    assert.equal(invocation.environment.GIT_TRACE, undefined);
    assert.equal(invocation.environment.GIT_ASKPASS, undefined);
    assert.equal(invocation.environment.BRAIN_GITHUB_TOKEN, undefined);
    assert.equal(invocation.environment.GIT_TERMINAL_PROMPT, '0');
    assert.doesNotMatch(JSON.stringify(invocation.environment), /url\.evil|untrusted-program/);
    const values = Object.values(invocation.environment);
    if (invocation.args.includes('fetch')) {
      assert.ok(values.includes(`http.${url}.extraHeader`));
      assert.ok(values.includes(`Authorization: Basic ${encodedToken}`));
      assert.equal(invocation.timeoutMs, brainConfig.git.fetchTimeoutMs);
    } else {
      assert.ok(!values.some((value) => value?.includes(encodedToken)));
    }
  }
});

test('concurrent captures serialize cache writes and only fetch a missing revision once', async (t) => {
  const f = await fixture(t);
  const commits = await Promise.all([
    f.github.prepareGithubRevision(f.project, f.commit),
    f.github.prepareGithubRevision(f.project, f.commit),
    f.github.prepareGithubRevision(f.project, f.commit),
  ]);
  assert.deepEqual(commits, [f.commit, f.commit, f.commit]);
  assert.equal(f.invocations.filter((invocation) => invocation.args.includes('fetch')).length, 1);
});

test('GitHub failures hide transport diagnostics and allow the next capture to retry', async (t) => {
  const f = await fixture(t);
  f.failFetch();
  await assert.rejects(f.github.prepareGithubRevision(f.project, f.commit), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /push the baseline commit/);
    assert.ok(!error.message.includes(token));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(await f.github.prepareGithubRevision(f.project, f.commit), f.commit);
  const inaccessible = createGithubCodeAccess({
    execute: async () => {
      throw new Error(`Authorization: ${token}`);
    },
  });
  await assert.rejects(inaccessible.checkGithubAccess(remote), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /BRAIN_GITHUB_TOKEN has read access/);
    assert.ok(!error.message.includes(token));
    return true;
  });
});

test('managed caches cannot silently reuse objects from a different registered repository', async (t) => {
  const f = await fixture(t);
  await f.github.prepareGithubRevision(f.project, f.commit);
  const before = f.invocations.filter((invocation) => invocation.args.includes('fetch')).length;
  await assert.rejects(
    f.github.prepareGithubRevision(
      { ...f.project, repositoryRemote: 'github.com/example/other' },
      f.commit,
    ),
    /could not be retrieved/,
  );
  assert.equal(
    f.invocations.filter((invocation) => invocation.args.includes('fetch')).length,
    before,
  );
});

test('owned GitHub caches recover when initialization was interrupted before origin configuration', async (t) => {
  const f = await fixture(t);
  await mkdir(f.project.repoPath);
  await writeFile(resolve(f.project.repoPath, 'brain-origin.json'), JSON.stringify({ url }));
  await mkdir(resolve(f.project.repoPath, 'objects'));
  assert.equal(await f.github.prepareGithubRevision(f.project, f.commit), f.commit);
  const cacheGit = fixtureGit(f.project.repoPath);
  await cacheGit('config', '--unset', 'remote.origin.url');
  assert.equal(await f.github.prepareGithubRevision(f.project, f.commit), f.commit);
  assert.equal(await cacheGit('config', '--get', 'remote.origin.url'), url);
  assert.equal(f.invocations.filter((invocation) => invocation.args.includes('fetch')).length, 1);
});

test('unknown partial directories are never adopted as GitHub caches', async (t) => {
  const f = await fixture(t);
  await mkdir(f.project.repoPath);
  const sentinel = resolve(f.project.repoPath, 'keep.txt');
  await writeFile(sentinel, 'Preserve unrelated files.');
  await assert.rejects(
    f.github.prepareGithubRevision(f.project, f.commit),
    /could not be retrieved/,
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'Preserve unrelated files.');
  assert.ok(!(await readdir(f.project.repoPath)).includes('brain-origin.json'));
});

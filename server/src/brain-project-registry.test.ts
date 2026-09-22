import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AccessStore } from './access/store.js';
import { registerAccessRoutes } from './access/routes.js';
import { BrainAgents } from './brain/analysis/service.js';
import type { Project } from './brain/analysis/types.js';
import { MemoryService } from './brain/memory/service.js';
import { createBrainMcp } from './brain/mcp.js';
import { ProjectRegistry } from './brain/project-registry.js';
import type { Source } from './brain/sources.js';
import { fixtureGit } from './brain/testing/git.js';

type LegacyProject = Omit<Project, 'repoPath'> & { repoPath: string };

async function fixture(t: TestContext, legacy: LegacyProject[] = []) {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-project-registry-'));
  const projectsPath = resolve(root, 'projects.json');
  await writeFile(projectsPath, JSON.stringify(legacy));
  const access = new AccessStore(resolve(root, 'access.db'));
  await access.init();
  const cleanup: Array<() => Promise<unknown> | void> = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) {
      await close();
    }
    await access.close();
    await rm(root, { recursive: true, force: true });
  });
  let failAccess = false;
  let checks = 0;
  const registry = new ProjectRegistry(access, projectsPath, resolve(root, 'cache'), async () => {
    checks += 1;
    if (failAccess) {
      throw new Error('Synthetic private transport diagnostic');
    }
    return { commit: 'a'.repeat(40) };
  });
  return {
    root,
    projectsPath,
    access,
    registry,
    cleanup: (close: () => Promise<unknown> | void) => cleanup.push(close),
    failAccess: (fail: boolean) => {
      failAccess = fail;
    },
    checks: () => checks,
  };
}

const legacy: LegacyProject = {
  id: 'historic-dashboard',
  name: 'Historical dashboard',
  scope: 'Preserve approved historical scope.',
  repoPath: '.',
  codePaths: ['code.ts'],
  specs: [{ kind: 'git', path: 'spec.md' }],
};

test('one-time migration preserves historical identity and registers existing unlinked repositories', async (t) => {
  const f = await fixture(t, [legacy]);
  const linked = await f.access.saveRepository(
    {
      name: 'Dashboard alias',
      remote: 'github.com/company/dashboard',
      enabled: true,
      brainProjectId: legacy.id,
    },
    'fixture',
  );
  const unlinked = await f.access.saveRepository(
    { name: 'Another repository', remote: 'github.com/company/another', enabled: true },
    'fixture',
  );
  await f.registry.init();
  const projects = await f.registry.projects();
  const historical = projects.find((project) => project.id === legacy.id)!;
  assert.deepEqual(historical, { ...legacy, repoPath: f.root });
  assert.equal(
    f.registry.repositories().find((repository) => repository.id === linked.id)!.brainProjectId,
    legacy.id,
  );
  const migrated = f.registry.repositories().find((repository) => repository.id === unlinked.id)!;
  assert.ok(migrated.brainProjectId);
  assert.notEqual(migrated.brainProjectId, legacy.id);
  assert.equal(
    projects.find((project) => project.id === migrated.brainProjectId)!.repositoryRemote,
    unlinked.remote,
  );
  assert.deepEqual(migrated.brainCodePaths, ['**']);
  const importedBytes = await readFile(f.projectsPath, 'utf8');
  assert.equal(
    importedBytes,
    JSON.stringify([legacy]),
    'migration must not rewrite approved source configuration',
  );
  await writeFile(f.projectsPath, 'This legacy file is no longer authoritative.');
  await f.access.close();
  const reopenedAccess = new AccessStore(resolve(f.root, 'access.db'));
  await reopenedAccess.init();
  f.cleanup(() => reopenedAccess.close());
  const restarted = new ProjectRegistry(reopenedAccess, f.projectsPath, resolve(f.root, 'cache'));
  await restarted.init();
  assert.deepEqual(await restarted.projects(), projects);
  assert.equal(
    restarted.repositories().find((repository) => repository.id === unlinked.id)!.brainProjectId,
    migrated.brainProjectId,
  );
});

test('repository edits preserve imported code scope, specification approvals and local checkout', async (t) => {
  const f = await fixture(t, [legacy]);
  await f.registry.init();
  const linked = await f.registry.save(
    {
      name: 'Dashboard alias',
      remote: 'github.com/company/dashboard',
      enabled: true,
      brainProjectId: legacy.id,
    },
    'fixture',
  );
  await f.registry.save(
    { name: 'Renamed Projects row', remote: linked.remote, enabled: true },
    'fixture',
    linked.id,
  );
  assert.deepEqual((await f.registry.projects())[0], { ...legacy, repoPath: f.root });
  await f.registry.save(
    {
      name: 'Renamed Projects row',
      remote: linked.remote,
      enabled: true,
      brainScope: 'Explicitly revised scope.',
      brainCodePaths: ['code.ts', 'extra/'],
    },
    'fixture',
    linked.id,
  );
  const changed = (await f.registry.projects())[0];
  assert.equal(changed.id, legacy.id);
  assert.equal(changed.scope, 'Explicitly revised scope.');
  assert.deepEqual(changed.codePaths, ['code.ts', 'extra/']);
  assert.deepEqual(changed.specs, legacy.specs);
  assert.equal(changed.repoPath, f.root);
  await assert.rejects(
    f.registry.save(
      { name: 'Unexpected remap', remote: 'github.com/company/different', enabled: true },
      'fixture',
      linked.id,
    ),
    /historical Brain project/,
  );
});

test('failed repository writes roll back new Brain projects and retain existing identities', async (t) => {
  const f = await fixture(t);
  await f.registry.init();
  const first = await f.registry.save(
    { name: 'First', remote: 'github.com/company/first', enabled: true },
    'fixture',
  );
  const second = await f.registry.save(
    { name: 'Second', remote: 'github.com/company/second', enabled: true },
    'fixture',
  );
  const original = await f.registry.projects();
  const repositories = f.registry.repositories();
  await assert.rejects(
    f.registry.save({ name: 'Duplicate', remote: first.remote, enabled: true }, 'fixture'),
    /already registered/,
  );
  assert.deepEqual(await f.registry.projects(), original);
  await assert.rejects(
    f.registry.save(
      { name: 'Duplicate update', remote: first.remote, enabled: true },
      'fixture',
      second.id,
    ),
    /already registered/,
  );
  await assert.rejects(
    f.registry.save(
      {
        name: 'Wrong identity',
        remote: first.remote,
        enabled: true,
        brainProjectId: second.brainProjectId,
      },
      'fixture',
      first.id,
    ),
    /keeps its Brain identity/,
  );
  await assert.rejects(
    f.registry.save(
      {
        name: 'Wrong scope',
        remote: 'github.com/company/third',
        enabled: true,
        brainCodePaths: ['../outside.ts'],
      },
      'fixture',
    ),
    /not allowed/,
  );
  assert.deepEqual(await f.registry.projects(), original);
  assert.deepEqual(f.registry.repositories(), repositories);
});

test('readiness reflects code access, reference synchronization and changed repository configuration', async (t) => {
  const f = await fixture(t);
  await f.registry.init();
  let referencesReady = false;
  f.registry.setReferenceStatus(() => ({
    ready: referencesReady,
    message: 'Synchronize approved references.',
  }));
  const added = await f.registry.save(
    { name: 'Source', remote: 'github.com/company/source', enabled: true },
    'fixture',
  );
  assert.equal(added.brainStatus.state, 'unverified');
  assert.equal(f.checks(), 0, 'listing and saving projects must not contact GitHub');
  assert.equal((await f.registry.check(added.id)).brainStatus.state, 'needs_references');
  referencesReady = true;
  assert.equal(f.registry.repositories()[0].brainStatus.state, 'ready');
  f.failAccess(true);
  const failed = await f.registry.check(added.id);
  assert.equal(failed.brainStatus.state, 'needs_access');
  assert.doesNotMatch(failed.brainStatus.message, /Synthetic|private transport/);
  f.failAccess(false);
  assert.equal((await f.registry.check(added.id)).brainStatus.state, 'ready');
  const changed = await f.registry.save(
    { name: 'Source', remote: 'github.com/company/renamed', enabled: true },
    'fixture',
    added.id,
  );
  assert.equal(changed.brainProjectId, added.brainProjectId);
  assert.equal(changed.brainStatus.state, 'unverified');
  const disabled = await f.registry.save(
    { name: changed.name, remote: changed.remote, enabled: false },
    'fixture',
    added.id,
  );
  assert.equal(disabled.brainStatus.state, 'disabled');
  const count = f.checks();
  assert.equal((await f.registry.check(added.id)).brainStatus.state, 'disabled');
  assert.equal(f.checks(), count);
});

test('a new Projects POST is immediately visible to Brain, Memory and an MCP context request', async (t) => {
  const f = await fixture(t);
  await f.registry.init();
  const git = fixtureGit(f.root);
  await git('init');
  await writeFile(resolve(f.root, 'code.ts'), 'export const codeOnly = true;\n');
  await git('add', 'code.ts');
  await git('commit', '-m', 'Known GitHub baseline fixture');
  const baseline = await git('rev-parse', 'HEAD');
  const indexed = new Map<string, string>();
  const memory = new MemoryService({
    dbPath: resolve(f.root, 'memory.db'),
    projectsPath: resolve(f.root, 'missing-legacy-file.json'),
    loadProjects: () => f.registry.projects(),
    schedule: false,
    notion: {
      state: () => ({ configured: true, connected: true, status: 'connected' }),
      fetchPage: async (pageId) => ({
        pageId,
        title: 'Approved policy',
        content: 'Use approved references for every change.',
        properties: {},
        url: `https://www.notion.so/${pageId}`,
        raw: 'Approved policy',
      }),
    },
    cognee: {
      status: async () => ({ configured: true, available: true }),
      index: async (source: Source, name: string) => {
        indexed.set(name, source.content);
        return { datasetId: name };
      },
      search: async (_query, datasets) =>
        datasets.map((datasetId) => ({
          datasetId,
          chunkId: datasetId,
          text: indexed.get(datasetId)!,
        })),
      graph: async () => ({ nodes: [], edges: [], truncated: false }),
    },
  });
  f.cleanup(() => memory.close());
  await memory.init();
  f.registry.setReferenceStatus((id) => memory.readiness(id));
  let modelCalls = 0;
  const agents = new BrainAgents({
    dbPath: resolve(f.root, 'analyses.db'),
    projectsPath: resolve(f.root, 'missing-legacy-file.json'),
    loadProjects: () => f.registry.projects(),
    model: 'test',
    memory,
    call: async () => {
      modelCalls += 1;
      throw new Error('A context request must not call a model.');
    },
  });
  f.cleanup(() => agents.close());
  await agents.init();
  assert.equal((await agents.state()).projects.length, 0);
  const previousAdmin = process.env.BRAIN_ADMIN_TOKEN;
  process.env.BRAIN_ADMIN_TOKEN = 'registry-admin-test';
  f.cleanup(() => {
    if (previousAdmin === undefined) delete process.env.BRAIN_ADMIN_TOKEN;
    else process.env.BRAIN_ADMIN_TOKEN = previousAdmin;
  });
  const app = Fastify();
  f.cleanup(() => app.close());
  registerAccessRoutes(app, f.access, f.registry);
  const headers = { 'x-brain-admin-token': 'registry-admin-test' };
  const response = await app.inject({
    method: 'POST',
    url: '/api/brain/access/repositories',
    headers,
    payload: {
      name: 'New source',
      remote: 'https://github.com/company/new-source.git',
      enabled: true,
      brainScope: 'Preserve approved behavior.',
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const added = response.json<{ id: string; brainProjectId: string; remote: string }>();
  const listed = (await agents.state()).projects;
  assert.equal(listed[0].id, added.brainProjectId);
  assert.equal(listed[0].repositoryRemote, 'github.com/company/new-source');
  assert.deepEqual(listed[0].codePaths, ['**']);
  assert.equal((await memory.state()).projects[0].id, added.brainProjectId);

  // Seed an already fetched bare cache to exercise real capture without external networking.
  const project = (await f.registry.projects())[0];
  await mkdir(project.repoPath, { recursive: true });
  const cacheGit = fixtureGit(project.repoPath);
  await cacheGit('init', '--bare');
  await cacheGit('fetch', f.root, `${baseline}:refs/heads/main`);
  await cacheGit('config', 'remote.origin.url', 'https://github.com/company/new-source.git');
  const reference = await memory.register({
    pageId: 'a'.repeat(32),
    projectIds: [added.brainProjectId],
    shared: false,
    mandatory: true,
    approval: 'approved',
  });
  await memory.wait();
  assert.equal((await f.registry.check(added.id)).brainStatus.state, 'ready');
  const server = createBrainMcp(agents);
  const client = new Client({ name: 'registry-test', version: '1.0.0' });
  f.cleanup(() => server.close());
  f.cleanup(() => client.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const discovery = await client.callTool({ name: 'brain_list_projects', arguments: {} });
  assert.match(JSON.stringify(discovery.structuredContent), new RegExp(added.brainProjectId));
  const context = await client.callTool({
    name: 'brain_get_project_context',
    arguments: {
      projectId: added.brainProjectId,
      feature: 'Review local changes',
      commit: baseline,
    },
  });
  assert.equal(context.isError, undefined, JSON.stringify(context));
  assert.match(
    JSON.stringify(context.structuredContent),
    /Use approved references for every change/,
  );
  assert.equal(modelCalls, 0);
  assert.ok(
    [...indexed.values()].every((content) => !content.includes('codeOnly')),
    'application code must not be semantically indexed',
  );

  const disabled = await app.inject({
    method: 'PUT',
    url: `/api/brain/access/repositories/${added.id}`,
    headers,
    payload: { name: 'Renamed source', remote: added.remote, enabled: false },
  });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json().brainProjectId, added.brainProjectId);
  assert.equal(disabled.json().brainScope, 'Preserve approved behavior.');
  assert.equal((await agents.state()).projects[0].enabled, false);
  const blocked = await client.callTool({
    name: 'brain_get_project_context',
    arguments: { projectId: added.brainProjectId, feature: 'Blocked review', commit: baseline },
  });
  assert.equal(blocked.isError, true);
  assert.match(JSON.stringify(blocked.content), /disabled/);
  await assert.rejects(
    agents.start(added.brainProjectId, baseline, undefined, 'Blocked review'),
    /disabled/,
  );
  assert.equal(modelCalls, 0);
  assert.equal(
    (await memory.state()).sources.find((source) => source.id === reference.id)!.approval,
    'approved',
  );
  assert.equal((await memory.state()).projects[0].id, added.brainProjectId);
});

test('disabling a historical project retains its approved Git Memory registration', async (t) => {
  const f = await fixture(t, [legacy]);
  await f.registry.init();
  const row = await f.registry.save(
    {
      name: 'Historical source',
      remote: 'github.com/company/historical',
      brainProjectId: legacy.id,
      enabled: true,
    },
    'fixture',
  );
  const memory = new MemoryService({
    dbPath: resolve(f.root, 'memory.db'),
    projectsPath: f.projectsPath,
    loadProjects: () => f.registry.projects(),
    schedule: false,
    notion: {
      state: () => ({ configured: false, connected: false, status: 'disconnected' }),
      fetchPage: async () => {
        throw new Error('No Notion request expected.');
      },
    },
    cognee: {
      status: async () => ({ configured: true, available: true }),
      index: async () => ({ datasetId: 'unused' }),
      search: async () => [],
      graph: async () => ({ nodes: [], edges: [], truncated: false }),
    },
  });
  f.cleanup(() => memory.close());
  await memory.init();
  const original = memory.store.sources()[0];
  assert.equal(original.approval, 'approved');
  await f.registry.save({ name: row.name, remote: row.remote, enabled: false }, 'fixture', row.id);
  await memory.registerProjects();
  assert.deepEqual(memory.store.sources()[0], original);
  assert.equal((await f.registry.projects())[0].enabled, false);
});

test('historical repository aliases can be offboarded individually without disabling an active shared Brain identity', async (t) => {
  const f = await fixture(t, [legacy]);
  for (const name of ['first-alias', 'second-alias']) {
    await f.access.saveRepository(
      {
        name,
        remote: `github.com/company/${name}`,
        enabled: true,
        brainProjectId: legacy.id,
      },
      'legacy-fixture',
    );
  }
  await f.registry.init();
  const [first, second] = f.access.repositories();
  assert.equal(first.brainProjectId, legacy.id);
  assert.equal(second.brainProjectId, legacy.id);
  const git = fixtureGit(f.root);
  await git('init');
  await writeFile(resolve(f.root, 'code.ts'), 'export const preserved = true;');
  await writeFile(resolve(f.root, 'spec.md'), 'Preserve approved behavior.');
  await git('add', 'code.ts', 'spec.md');
  await git('commit', '-m', 'Historical reference fixture');
  f.registry.setReferenceStatus(() => ({ ready: true, message: 'Approved reference available.' }));
  assert.equal((await f.registry.check(first.id)).brainStatus.state, 'ready');
  await f.registry.save(
    { name: 'Offboarded alias', remote: first.remote, enabled: false },
    'administrator',
    first.id,
  );
  assert.equal((await f.registry.projects())[0].enabled, undefined);
  assert.equal(f.registry.projectStatus(legacy.id)!.state, 'ready');
  assert.equal(
    f.registry.repositories().find((row) => row.id === first.id)!.brainStatus.state,
    'disabled',
  );
  assert.equal(
    f.registry.repositories().find((row) => row.id === second.id)!.brainStatus.state,
    'ready',
  );
  await assert.rejects(
    f.registry.save(
      {
        name: 'New alias',
        remote: 'github.com/company/new-alias',
        brainProjectId: legacy.id,
        enabled: true,
      },
      'administrator',
    ),
    /already linked/,
  );
  await f.registry.save(
    { name: second.name, remote: second.remote, enabled: false },
    'administrator',
    second.id,
  );
  assert.equal((await f.registry.projects())[0].enabled, false);
  assert.equal(f.registry.projectStatus(legacy.id)!.state, 'disabled');
  await f.registry.save(
    { name: first.name, remote: first.remote, enabled: true },
    'administrator',
    first.id,
  );
  assert.equal((await f.registry.projects())[0].enabled, undefined);
  assert.equal(f.registry.projectStatus(legacy.id)!.state, 'ready');
  const restored = (await f.registry.projects())[0];
  assert.equal(restored.id, legacy.id);
  assert.equal(restored.scope, legacy.scope);
  assert.deepEqual(restored.specs, legacy.specs);
});

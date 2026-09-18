import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { brainConfig } from './brain/config.js';
import { MemoryService } from './brain/memory/service.js';
import { registerMemoryRoutes } from './brain/memory/routes.js';
import { parseNotionPage } from './brain/notion/page.js';
import { addCurrentMemory, buildProjectGraph } from './brain/graph.js';
import type { Project } from './brain/analysis/types.js';
import type { SourcePolicy } from './brain/memory/types.js';
import type { Source } from './brain/sources.js';

const rootId = 'a'.repeat(32);
const childId = 'b'.repeat(32);
const siblingId = 'c'.repeat(32);
const nestedId = 'd'.repeat(32);
const newId = 'e'.repeat(32);
const policy: SourcePolicy = {
  projectIds: ['dashboard'],
  shared: false,
  mandatory: false,
  approval: 'draft',
  includeSubpages: true,
  autoApproveSubpages: false,
};
const reference = (id: string) => `<page url="https://www.notion.so/${id}">Child ${id[0]}</page>`;
function response(id: string, content: string, parent?: string, truncated = false) {
  const ancestor = parent
    ? `<ancestor-path><parent-page url="https://www.notion.so/${parent}" title="Parent"/></ancestor-path>`
    : '';
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          text: `<page url="https://www.notion.so/${id}">${ancestor}<properties>{"title":"Page ${id[0]}"}</properties><content>\n${content}</content></page>`,
          truncated,
        }),
      },
    ],
  };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(resolve(tmpdir(), 'brain-subpages-'));
  const projectsPath = resolve(directory, 'projects.json');
  const project: Project = {
    id: 'dashboard',
    name: 'Dashboard',
    scope: 'Exports',
    repoPath: directory,
    codePaths: ['code.ts'],
    specs: [],
  };
  await writeFile(projectsPath, JSON.stringify([project, { ...project, id: 'other' }]));
  const pages = new Map([
    [rootId, response(rootId, `${reference(childId)}\n${reference(siblingId)}`)],
    [childId, response(childId, `Preserve the export date.\n${reference(nestedId)}`, rootId)],
    [siblingId, response(siblingId, 'Preserve the export author.', rootId)],
    [nestedId, response(nestedId, 'Use UTC timestamps.', childId)],
  ]);
  const indexed = new Map<string, Source>();
  const calls: Source[] = [];
  let beforeIndex: ((source: Source) => Promise<void>) | undefined;
  const options = {
    dbPath: resolve(directory, 'brain.db'),
    projectsPath,
    schedule: false,
    notion: {
      state: () => ({ configured: true, connected: true, status: 'connected' as const }),
      fetchPage: async (id: string) =>
        parseNotionPage(id, pages.get(id), brainConfig.notionMcp.maxPageCharacters),
    },
    cognee: {
      status: async () => ({ configured: true, available: true }),
      index: async (source: Source, name: string) => {
        await beforeIndex?.(source);
        calls.push(source);
        indexed.set(name, source);
        return { datasetId: name };
      },
      search: async (_query: string, datasets: string[]) =>
        datasets.map((datasetId) => ({
          datasetId,
          chunkId: datasetId,
          text: indexed.get(datasetId)!.content,
        })),
      graph: async () => ({ nodes: [], edges: [], truncated: false }),
    },
  };
  let service = new MemoryService(options);
  await service.init();
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get service() {
      return service;
    },
    pages,
    calls,
    project,
    source: (id: string) => service.store.source(`notion:${id}`)!,
    register: (autoApproveSubpages = false) =>
      service.register({ ...policy, pageId: rootId, autoApproveSubpages }),
    beforeIndex: (callback: (source: Source) => Promise<void>) => {
      beforeIndex = callback;
    },
    async restart() {
      await service.close();
      service = new MemoryService(options);
      await service.init();
    },
  };
}

test('Notion discovers page blocks and parent metadata without following mentions, text links or code', () => {
  const content = [
    reference(childId),
    `\t${reference(childId)}`,
    `[Link](https://www.notion.so/${siblingId})`,
    `<mention-page url="https://www.notion.so/${siblingId}"/>`,
    '\\' + reference(siblingId),
    '```xml',
    reference(siblingId),
    '```',
    `<database url="https://www.notion.so/${siblingId}">Database</database>`,
  ].join('\n');
  const page = parseNotionPage(rootId, response(rootId, content, nestedId), 10_000);
  assert.equal(page.parentPageId, nestedId);
  assert.deepEqual(
    page.childPages?.map((child) => child.pageId),
    [childId],
  );
  assert.equal(page.content, content);
  assert.equal(page.childrenComplete, true);
  assert.equal(
    parseNotionPage(rootId, response(rootId, content, undefined, true), 10_000).childrenComplete,
    false,
  );
  assert.equal(
    parseNotionPage(rootId, response(rootId, '<unknown url="block"/>'), 10_000).childrenComplete,
    false,
  );
});

test('recursive discovery defaults to drafts and an administrator can approve current subpages together', async (t) => {
  const f = await fixture(t);
  const app = Fastify();
  registerMemoryRoutes(app, f.service, async (request, reply) => {
    if (request.headers.authorization !== 'Bearer admin') {
      return reply.code(403).send({ error: 'Administrator required.' });
    }
  });
  t.after(() => app.close());
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/brain/memory/sources',
    headers: { authorization: 'Bearer admin' },
    payload: { ...policy, pageId: rootId, includeSubpages: false, autoApproveSubpages: true },
  });
  assert.equal(invalid.statusCode, 400);
  const added = await app.inject({
    method: 'POST',
    url: '/api/brain/memory/sources',
    headers: { authorization: 'Bearer admin' },
    payload: { ...policy, pageId: rootId },
  });
  assert.equal(added.statusCode, 201);
  await f.service.wait();
  assert.equal(f.service.store.sources().length, 4);
  assert.equal(f.calls.length, 0);
  for (const id of [rootId, childId, siblingId, nestedId]) {
    assert.equal(f.source(id).approval, 'draft');
    assert.ok(f.source(id).currentSourceId);
    assert.deepEqual(f.source(id).projectIds, ['dashboard']);
  }
  assert.equal(f.source(nestedId).parentSourceId, `notion:${childId}`);
  const url = `/api/brain/memory/sources/notion:${rootId}/approve-subpages`;
  assert.equal((await app.inject({ method: 'POST', url })).statusCode, 403);
  const approved = await app.inject({
    method: 'POST',
    url,
    headers: { authorization: 'Bearer admin' },
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().approved, 3);
  await f.service.wait();
  assert.equal(f.calls.length, 3);
  assert.equal(f.source(rootId).approval, 'draft');
  const graph = await addCurrentMemory(
    buildProjectGraph({
      id: 'dashboard',
      name: 'Dashboard',
      scope: 'Exports',
      current: false,
      run: undefined,
    }),
    f.service,
  );
  assert.equal(graph.edges.filter((edge) => edge.label === 'contains subpage').length, 3);
});

test('automatic approval includes nested and future pages, persists across restart and reuses unchanged indexes', async (t) => {
  const f = await fixture(t);
  await f.register(true);
  const retrieved = await f.service.retrieve(f.project, 'export');
  assert.equal(retrieved.sources.length, 3, 'Retrieval waits for newly discovered descendants too');
  assert.equal(f.calls.length, 3);
  assert.ok([childId, siblingId, nestedId].every((id) => f.source(id).status === 'ready'));
  assert.equal(
    f.source(rootId).approval,
    'draft',
    'A container does not need to become a specification',
  );
  await f.restart();
  assert.equal(f.source(rootId).autoApproveSubpages, true);
  f.pages.set(
    rootId,
    response(rootId, `${reference(childId)}\n${reference(siblingId)}\n${reference(newId)}`),
  );
  f.pages.set(newId, response(newId, 'New approved requirement.', rootId));
  await f.service.queueAll();
  await f.service.wait();
  assert.equal(f.calls.length, 4);
  assert.equal(f.source(newId).approval, 'approved');
  await f.service.update(`notion:${rootId}`, { ...policy, autoApproveSubpages: false });
  await f.service.wait();
  assert.equal(
    f.source(childId).approval,
    'approved',
    'Disabling auto approval preserves existing approvals',
  );
});

test('removed branches preserve evidence and explicit withdrawals survive automatic approval', async (t) => {
  const f = await fixture(t);
  await f.register(true);
  await f.service.wait();
  const captureId = f.source(nestedId).currentSourceId!;
  await f.service.update(`notion:${siblingId}`, {
    ...policy,
    approval: 'withdrawn',
    autoApproveSubpages: true,
  });
  f.pages.set(rootId, response(rootId, reference(siblingId)));
  await f.service.queue(`notion:${rootId}`);
  await f.service.wait();
  assert.equal(f.source(childId).approvalBeforeRemoval, 'approved');
  assert.equal(f.source(nestedId).approval, 'withdrawn');
  assert.ok(f.service.store.capture(captureId));
  f.pages.set(rootId, response(rootId, `${reference(childId)}\n${reference(siblingId)}`));
  await f.service.queue(`notion:${rootId}`);
  await f.service.wait();
  assert.equal(f.source(nestedId).approval, 'approved');
  assert.equal(f.source(siblingId).approval, 'withdrawn');
  await f.service.update(`notion:${rootId}`, { ...policy, includeSubpages: false });
  await f.service.wait();
  assert.equal(f.service.applicable('dashboard').length, 0);
  await f.service.update(`notion:${rootId}`, {
    ...policy,
    autoApproveSubpages: true,
    projectIds: ['other'],
  });
  await f.service.wait();
  assert.equal(f.source(childId).approval, 'approved');
  assert.deepEqual(f.source(nestedId).projectIds, ['other']);
  assert.equal(f.source(siblingId).approval, 'withdrawn');
  assert.equal(f.service.applicable('dashboard').length, 0);
  await assert.rejects(
    f.service.update(`notion:${childId}`, { ...policy, autoApproveSubpages: true }),
    /inherit/,
  );
});

test('incomplete discovery does not remove existing pages and foreign parent metadata cannot be indexed', async (t) => {
  const f = await fixture(t);
  await f.register(true);
  await f.service.wait();
  f.pages.set(rootId, response(rootId, reference(childId), undefined, true));
  await f.service.queue(`notion:${rootId}`);
  await f.service.wait();
  assert.match(f.source(rootId).error!, /incomplete/);
  assert.equal(f.source(siblingId).approval, 'approved');
  await assert.rejects(f.service.retrieve(f.project, 'export'), /discovery is incomplete/);
  f.pages.set(
    rootId,
    response(rootId, `${reference(childId)}\n${reference(siblingId)}\n${reference(newId)}`),
  );
  f.pages.set(newId, response(newId, 'Foreign project requirement.', nestedId));
  await f.service.queue(`notion:${rootId}`);
  await f.service.wait();
  assert.equal(f.source(newId).status, 'failed');
  assert.match(f.source(newId).error!, /verified child/);
  assert.ok(f.calls.every((source) => !source.content.includes('Foreign project')));
});

test('branch withdrawal during indexing cannot publish an in-flight child', async (t) => {
  const f = await fixture(t);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.beforeIndex(async (source) => {
    if (source.path === `${childId}.md`) {
      enter();
      await gate;
    }
  });
  await f.register(true);
  await entered;
  try {
    await f.service.update(`notion:${rootId}`, {
      ...policy,
      approval: 'withdrawn',
      autoApproveSubpages: true,
    });
  } finally {
    release();
  }
  await f.service.wait();
  assert.equal(f.source(childId).status, 'withdrawn');
  assert.equal(f.service.applicable('dashboard').length, 0);
  assert.equal(f.source(nestedId), undefined, 'Stale discovery cannot add grandchildren');
});

test('discovery fails visibly on source limits, cycles and conflicting project scope', async (t) => {
  const f = await fixture(t);
  const previousLimit = brainConfig.synchronization.maxSources;
  brainConfig.synchronization.maxSources = 2;
  try {
    await f.register(true);
    await f.service.wait();
    assert.match(f.source(rootId).error!, /source limit/);
    assert.equal(f.service.store.sources().length, 1);
  } finally {
    brainConfig.synchronization.maxSources = previousLimit;
  }
  f.pages.set(rootId, response(rootId, reference(rootId)));
  await f.service.queue(`notion:${rootId}`);
  await f.service.wait();
  assert.match(f.source(rootId).error!, /cycle/);
  await f.service.register({
    ...policy,
    pageId: siblingId,
    projectIds: ['other'],
    includeSubpages: false,
  });
  await f.service.wait();
  f.pages.set(rootId, response(rootId, reference(siblingId)));
  await f.service.queue(`notion:${rootId}`);
  await f.service.wait();
  assert.match(f.source(rootId).error!, /another project scope/);
  assert.deepEqual(f.source(siblingId).projectIds, ['other']);
  assert.equal(f.calls.length, 0);
});

test('moving a subpage within a project works in either sync order and preserves history and withdrawals', async (t) => {
  for (const order of [
    [childId, siblingId],
    [siblingId, childId],
  ]) {
    const f = await fixture(t);
    await f.register(true);
    await f.service.wait();
    const previousCapture = f.source(nestedId).currentSourceId!;
    f.pages.set(childId, response(childId, 'Preserve the export date.', rootId));
    f.pages.set(siblingId, response(siblingId, reference(nestedId), rootId));
    f.pages.set(nestedId, response(nestedId, 'Use UTC timestamps.', siblingId));
    for (const id of order) {
      await f.service.queue(`notion:${id}`);
      await f.service.wait();
    }
    assert.equal(f.source(nestedId).parentSourceId, `notion:${siblingId}`);
    assert.equal(f.source(nestedId).status, 'ready');
    assert.equal(f.source(nestedId).approval, 'approved');
    assert.ok(f.service.store.capture(previousCapture));

    await f.service.update(`notion:${nestedId}`, {
      ...policy,
      approval: 'withdrawn',
      autoApproveSubpages: true,
    });
    f.pages.set(childId, response(childId, reference(nestedId), rootId));
    f.pages.set(siblingId, response(siblingId, 'Preserve the export author.', rootId));
    f.pages.set(nestedId, response(nestedId, 'Use UTC timestamps.', childId));
    await f.service.queue(`notion:${rootId}`);
    await f.service.wait();
    assert.equal(f.source(nestedId).parentSourceId, `notion:${childId}`);
    assert.equal(f.source(nestedId).approval, 'withdrawn');
  }
});

test('a move requires a verified parent and cannot overwrite a concurrent withdrawal', async (t) => {
  const f = await fixture(t);
  await f.register(true);
  await f.service.wait();
  f.pages.set(siblingId, response(siblingId, reference(nestedId), rootId));
  await f.service.queue(`notion:${siblingId}`);
  await f.service.wait();
  assert.match(f.source(siblingId).error!, /not a verified child/);
  assert.equal(f.source(nestedId).parentSourceId, `notion:${childId}`);

  f.pages.set(nestedId, response(nestedId, 'Use UTC timestamps.', siblingId));
  const fetchPage = f.service.options.notion.fetchPage;
  t.mock.method(f.service.options.notion, 'fetchPage', async (id: string) => {
    if (id === nestedId) {
      await f.service.update(`notion:${nestedId}`, {
        ...policy,
        approval: 'withdrawn',
        autoApproveSubpages: true,
      });
    }
    return fetchPage(id);
  });
  await f.service.queue(`notion:${siblingId}`);
  await f.service.wait();
  assert.match(f.source(siblingId).error!, /settings changed/);
  assert.equal(f.source(nestedId).parentSourceId, `notion:${childId}`);
  assert.equal(f.source(nestedId).approval, 'withdrawn');
});

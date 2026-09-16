import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import Sqlite from 'better-sqlite3';
import { MemoryService } from './brain/memory/service.js';
import { makeCapture } from './brain/memory/capture.js';
import type { SourceRegistration } from './brain/memory/types.js';
import type { CogneeClient } from './brain/cognee/client.js';
import type { Project } from './brain/analysis/types.js';

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-memory-'));
  const projectsPath = resolve(root, 'projects.json');
  const projects: Project[] = ['dashboard', 'mobile'].map((id) => ({
    id,
    name: id,
    scope: 'Selected feature',
    repoPath: root,
    specs: [],
    codePaths: ['feature.ts'],
  }));
  await writeFile(projectsPath, JSON.stringify(projects));
  const pages = new Map<string, string>();
  const indexed = new Map<string, string>();
  const indexCalls: string[] = [];
  const searched: string[][] = [];
  let failIndex = false;
  let invalidHit = false;
  const cognee: Pick<CogneeClient, 'status' | 'index' | 'search' | 'graph'> = {
    async status() {
      return { configured: true, available: true };
    },
    async index(source, name) {
      indexCalls.push(name);
      if (failIndex) {
        throw new Error('Simulated indexing failure');
      }
      indexed.set(name, source.content);
      return { datasetId: name };
    },
    async search(_query, datasets) {
      searched.push(datasets);
      return datasets.map((datasetId) => ({
        datasetId: invalidHit ? 'unrelated-dataset' : datasetId,
        chunkId: datasetId,
        text: indexed.get(datasetId)!,
      }));
    },
    async graph() {
      return { nodes: [], edges: [], truncated: false };
    },
  };
  const options = {
    dbPath: resolve(root, 'brain.db'),
    projectsPath,
    schedule: false,
    cognee,
    notion: {
      state() {
        return { configured: true, connected: true, status: 'connected' as const };
      },
      async fetchPage(pageId: string) {
        if (!pages.has(pageId)) {
          throw new Error('Page unavailable');
        }
        return {
          pageId,
          title: pageId,
          content: pages.get(pageId)!,
          url: 'https://www.notion.so/' + pageId,
          properties: { title: pageId },
          raw: '',
        };
      },
    },
  };
  let service = new MemoryService(options);
  await service.init();
  return {
    root,
    projects,
    pages,
    indexed,
    indexCalls,
    searched,
    get service() {
      return service;
    },
    setFail(value: boolean) {
      failIndex = value;
    },
    setInvalidHit(value: boolean) {
      invalidHit = value;
    },
    async restart() {
      await service.close();
      service = new MemoryService(options);
      await service.init();
    },
    async cleanup() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const policy = {
  projectIds: ['dashboard'],
  shared: false,
  mandatory: true,
  approval: 'approved' as const,
};

test('Draft approval creates a published immutable capture; unchanged sync and restart do not reindex', async () => {
  const f = await fixture();
  try {
    const pageId = 'a'.repeat(32);
    f.pages.set(pageId, '# Spécification\nConserver la source originale.');
    const source = await f.service.register({ ...policy, pageId, approval: 'draft' });
    await f.service.wait();
    const draft = f.service.store.capture(f.service.store.source(source.id)!.currentSourceId!)!;
    assert.equal(draft.status, 'draft');
    assert.equal(f.indexCalls.length, 0);
    await f.service.update(source.id, policy);
    await f.service.wait();
    const approved = f.service.store.capture(f.service.store.source(source.id)!.currentSourceId!)!;
    assert.notEqual(approved.id, draft.id);
    assert.equal(approved.status, 'published');
    assert.equal(approved.content, f.pages.get(pageId));
    assert.equal(f.service.store.capture(draft.id)!.status, 'draft');
    assert.equal(f.indexCalls.length, 1);
    f.service.queue(source.id);
    await f.service.wait();
    await f.restart();
    f.service.queue(source.id);
    await f.service.wait();
    assert.equal(f.indexCalls.length, 1);
    const result = await f.service.retrieve(f.projects[0], 'source');
    assert.deepEqual(result.sourceIds, [approved.id]);
    assert.equal(result.memoryVersion, f.service.version('dashboard'));
  } finally {
    await f.cleanup();
  }
});

test('Twenty-document corpus selects only approved project and shared datasets; withdrawal preserves history', async () => {
  const f = await fixture();
  try {
    const registrations = [];
    for (let index = 0; index < 20; index++) {
      const pageId = index.toString(16).padStart(32, '0');
      f.pages.set(pageId, 'Requirement ' + index);
      registrations.push(
        await f.service.register({
          ...policy,
          pageId,
          projectIds: [index % 2 ? 'mobile' : 'dashboard'],
          shared: index === 19,
          approval: index === 18 ? 'draft' : 'approved',
        }),
      );
    }
    await f.service.wait();
    const first = await f.service.retrieve(f.projects[0], 'feature');
    assert.equal(first.sources.length, 10);
    assert.ok(first.sources.some((source) => source.content === 'Requirement 19'));
    assert.ok(
      first.sources.every(
        (source) =>
          Number(source.content.split(' ')[1]) % 2 === 0 || source.content === 'Requirement 19',
      ),
    );
    assert.ok(!first.sources.some((source) => source.content === 'Requirement 18'));
    const priorId = f.service.store.source(registrations[0].id)!.currentSourceId!;
    await f.service.update(registrations[0].id, { ...policy, approval: 'withdrawn' });
    const after = await f.service.retrieve(f.projects[0], 'feature');
    assert.ok(!after.sourceIds.includes(priorId));
    assert.notEqual(first.memoryVersion, after.memoryVersion);
    assert.equal(f.service.store.capture(priorId)!.content, 'Requirement 0');
    await f.service.update(registrations[2].id, { ...policy, projectIds: ['mobile'] });
    await f.service.wait();
    const moved = await f.service.retrieve(f.projects[0], 'feature');
    assert.ok(!moved.sources.some((source) => source.content === 'Requirement 2'));
  } finally {
    await f.cleanup();
  }
});

test('Changed and inaccessible sources cannot silently reuse stale evidence', async () => {
  const f = await fixture();
  try {
    const pageId = 'b'.repeat(32);
    f.pages.set(pageId, 'Original requirement');
    const registration = await f.service.register({ ...policy, pageId });
    await f.service.wait();
    const original = f.service.store.source(registration.id)!;
    f.pages.set(pageId, 'Changed requirement');
    f.setFail(true);
    f.service.queue(registration.id);
    await f.service.wait();
    assert.equal(f.service.store.source(registration.id)!.status, 'failed');
    assert.equal(
      f.service.store.source(registration.id)!.currentSourceId,
      original.currentSourceId,
    );
    await assert.rejects(
      f.service.retrieve(f.projects[0], 'requirement'),
      /not fully synchronized/,
    );
    f.setFail(false);
    f.service.queue(registration.id);
    await f.service.wait();
    assert.notEqual(
      f.service.store.source(registration.id)!.currentSourceId,
      original.currentSourceId,
    );
    assert.equal(
      f.service.store.capture(original.currentSourceId!)!.content,
      'Original requirement',
    );
    f.pages.delete(pageId);
    f.service.queue(registration.id);
    await f.service.wait();
    await assert.rejects(
      f.service.retrieve(f.projects[0], 'requirement'),
      /not fully synchronized/,
    );
  } finally {
    await f.cleanup();
  }
});

test('Retrieval fails closed on unscoped citations and missing applicable sources', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.retrieve(f.projects[0], 'none'), /No approved sources/);
    const pageId = 'c'.repeat(32);
    f.pages.set(pageId, 'A real requirement');
    await f.service.register({ ...policy, pageId });
    await f.service.wait();
    f.setInvalidHit(true);
    await assert.rejects(f.service.retrieve(f.projects[0], 'requirement'), /could not be verified/);
  } finally {
    await f.cleanup();
  }
});

test('Git retrieval uses the supplied analysis commit and never substitutes another current revision', async () => {
  const f = await fixture();
  try {
    const project = { ...f.projects[0], specs: [{ kind: 'git' as const, path: 'SPEC.md' }] };
    await writeFile(resolve(f.root, 'projects.json'), JSON.stringify([project]));
    await f.service.registerProjects();
    const registration = f.service.applicable('dashboard')[0];
    const snapshot = makeCapture(
      registration,
      'Requirement from the analyzed commit',
      {},
      '1'.repeat(40),
    );
    snapshot.revision = '1'.repeat(40);
    const current = makeCapture(
      registration,
      'Different requirement on current HEAD',
      {},
      '2'.repeat(40),
    );
    f.service.store.saveCapture(current);
    f.service.store.saveSource({
      ...registration,
      status: 'ready',
      currentSourceId: current.id,
      datasetId: 'head-dataset',
    });
    const result = await f.service.retrieve(project, 'feature', [snapshot]);
    assert.equal(result.sources[0].content, snapshot.content);
    assert.ok(!result.datasets.includes('head-dataset'));
    await assert.rejects(f.service.retrieve(project, 'feature'), /did not capture/);
  } finally {
    await f.cleanup();
  }
});

test('Webhook event persistence deduplicates enqueue and interrupted jobs resume after restart', async () => {
  const f = await fixture();
  try {
    const pageId = 'd'.repeat(32);
    f.pages.set(pageId, 'Requirement');
    const registration = await f.service.register({ ...policy, pageId, approval: 'draft' });
    await f.service.wait();
    let count = 0;
    assert.equal(
      f.service.store.recordEvent('delivery-1', () => {
        count++;
      }),
      true,
    );
    assert.equal(
      f.service.store.recordEvent('delivery-1', () => {
        count++;
      }),
      false,
    );
    assert.equal(count, 1);
    const job = {
      id: 'interrupted',
      sourceId: registration.id,
      status: 'running' as const,
      requestedAt: new Date().toISOString(),
      attempts: 1,
    };
    f.service.store.saveJob(job);
    await f.restart();
    assert.equal(f.service.store.jobs().find((value) => value.id === job.id)!.status, 'queued');
    assert.equal(
      f.service.store.recordEvent('delivery-1', () => {
        count++;
      }),
      false,
    );
    f.service.queue(registration.id);
    await f.service.wait();
    assert.equal(f.service.store.jobs().find((value) => value.id === job.id)!.status, 'succeeded');
  } finally {
    await f.cleanup();
  }
});

test('Legacy captures remain readable without loading the removed demo workflow', async () => {
  const f = await fixture();
  try {
    const registration: SourceRegistration = {
      id: 'old',
      kind: 'notion',
      title: 'Original',
      ...policy,
      status: 'ready',
    };
    const source = makeCapture(registration, 'Original historical text');
    const db = new Sqlite(resolve(f.root, 'brain.db'));
    db.exec('CREATE TABLE brain_records (kind TEXT, id TEXT, data TEXT)');
    db.prepare('INSERT INTO brain_records VALUES (?,?,?)').run(
      'source',
      source.id,
      JSON.stringify(source),
    );
    db.close();
    assert.deepEqual(f.service.store.capture(source.id), JSON.parse(JSON.stringify(source)));
  } finally {
    await f.cleanup();
  }
});

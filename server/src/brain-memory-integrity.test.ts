import { fixtureGit } from './brain/testing/git.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Project } from './brain/analysis/types.js';
import { brainConfig } from './brain/config.js';
import { makeCapture } from './brain/memory/capture.js';
import { MemoryService } from './brain/memory/service.js';
import type { SourceRegistration, SyncJob } from './brain/memory/types.js';
import { makeSource, type Source } from './brain/sources.js';

const pageId = 'a'.repeat(32);
const policy = {
  projectIds: ['dashboard'],
  shared: false,
  mandatory: true,
  approval: 'approved' as const,
};

function gate() {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    pause: async () => {
      entered();
      await released;
    },
  };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-memory-integrity-'));
  const project: Project = {
    id: 'dashboard',
    name: 'Dashboard',
    scope: 'Selected feature',
    repoPath: root,
    specs: [],
    codePaths: ['feature.ts'],
  };
  const projectsPath = resolve(root, 'projects.json');
  await writeFile(projectsPath, JSON.stringify([project]));
  const pages = new Map([[pageId, 'Initial approved requirement.']]);
  const indexCalls: string[] = [];
  const indexed = new Map<string, string>();
  const chunks = new Map<string, string[]>();
  let failIndex = false;
  let beforeIndex: (() => Promise<void>) | undefined;
  let beforeRead: (() => Promise<void>) | undefined;
  let beforeSearch: (() => Promise<void>) | undefined;
  const options = {
    dbPath: resolve(root, 'memory.db'),
    projectsPath,
    schedule: false,
    notion: {
      state: () => ({ configured: true, connected: true, status: 'connected' as const }),
      fetchPage: async (id: string) => {
        const content = pages.get(id)!;
        const pause = beforeRead;
        beforeRead = undefined;
        await pause?.();
        return {
          pageId: id,
          title: 'Specification',
          content,
          properties: { title: 'Specification' },
          url: `https://www.notion.so/${id}`,
          raw: `<content>${content}</content>`,
        };
      },
    },
    cognee: {
      status: async () => ({ configured: true, available: true }),
      index: async (source: Source, name: string) => {
        indexCalls.push(name);
        const pause = beforeIndex;
        beforeIndex = undefined;
        await pause?.();
        if (failIndex) {
          throw new Error('Index temporarily unavailable.');
        }
        indexed.set(name, source.content);
        return { datasetId: name };
      },
      search: async (_query: string, datasets: string[]) => {
        const pause = beforeSearch;
        beforeSearch = undefined;
        await pause?.();
        return datasets.flatMap((datasetId) =>
          (chunks.get(datasetId) ?? [indexed.get(datasetId)!]).map((text, index) => ({
            datasetId,
            chunkId: `${datasetId}:${index}`,
            text,
          })),
        );
      },
      graph: async () => ({ nodes: [], edges: [], truncated: false }),
    },
  };
  let service = new MemoryService(options);
  await service.init();
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    get service() {
      return service;
    },
    project,
    root,
    projectsPath,
    pages,
    indexCalls,
    indexed,
    chunks,
    pauseIndex: (pause: () => Promise<void>) => {
      beforeIndex = pause;
    },
    pauseRead: (pause: () => Promise<void>) => {
      beforeRead = pause;
    },
    pauseSearch: (pause: () => Promise<void>) => {
      beforeSearch = pause;
    },
    failIndex: (value: boolean) => {
      failIndex = value;
    },
    async restart() {
      await service.close();
      service = new MemoryService(options);
      await service.init();
    },
    async register() {
      const source = await service.register({ ...policy, pageId });
      await service.wait();
      return service.store.source(source.id)!;
    },
  };
}

test('index generations rebuild once and a failed new generation cannot reuse the previous index', async (t) => {
  const previousRevision = brainConfig.cognee.indexRevision;
  t.after(() => {
    brainConfig.cognee.indexRevision = previousRevision;
  });
  const f = await fixture(t);
  const original = await f.register();
  const oldVersion = f.service.version(f.project.id);
  const originalCapture = f.service.store.capture(original.currentSourceId!)!;
  brainConfig.cognee.indexRevision = `${previousRevision}-integrity-test`;
  f.failIndex(true);
  await f.restart();
  assert.equal(f.service.store.source(original.id)!.status, 'pending');
  await assert.rejects(f.service.retrieve(f.project, 'requirement'), /not fully synchronized/);
  assert.equal(f.service.store.source(original.id)!.status, 'failed');
  assert.equal(f.service.store.source(original.id)!.datasetId, original.datasetId);
  assert.deepEqual(f.service.store.capture(original.currentSourceId!), originalCapture);
  f.failIndex(false);
  const rebuilt = await f.service.retrieve(f.project, 'requirement');
  assert.notEqual(rebuilt.datasets[0], original.datasetId);
  assert.deepEqual(rebuilt.sourceIds, [original.currentSourceId]);
  assert.notEqual(rebuilt.memoryVersion, oldVersion);
  const callCount = f.indexCalls.length;
  await f.restart();
  await f.service.retrieve(f.project, 'requirement');
  assert.equal(f.indexCalls.length, callCount);
});

test('withdrawal during indexing cannot publish the completed dataset or replace historical evidence', async (t) => {
  const f = await fixture(t);
  const original = await f.register();
  const pause = gate();
  f.pages.set(pageId, 'Changed requirement that was withdrawn during indexing.');
  f.pauseIndex(pause.pause);
  await f.service.queue(original.id);
  await pause.started;
  await f.service.update(original.id, { ...policy, approval: 'withdrawn' });
  pause.release();
  await f.service.wait();
  const withdrawn = f.service.store.source(original.id)!;
  assert.equal(withdrawn.status, 'withdrawn');
  assert.equal(withdrawn.approval, 'withdrawn');
  assert.equal(withdrawn.currentSourceId, original.currentSourceId);
  assert.equal(
    f.service.store.capture(original.currentSourceId!)!.content,
    'Initial approved requirement.',
  );
  await assert.rejects(f.service.retrieve(f.project, 'requirement'), /No approved sources/);
  const calls = f.indexCalls.length;
  await f.service.update(original.id, policy);
  await f.service.wait();
  assert.equal(f.indexCalls.length, calls);
  const current = f.service.store.source(original.id)!;
  assert.equal(current.status, 'ready');
  assert.equal(f.service.store.capture(current.currentSourceId!)!.content, f.pages.get(pageId));
});

test('a review withdrawn while retrieval is pending cannot enter returned evidence', async (t) => {
  const f = await fixture(t);
  await f.register();
  const review: SourceRegistration = {
    id: 'review:dashboard:fixture',
    kind: 'review',
    title: 'Scoped human decision',
    ...policy,
    mandatory: false,
    status: 'pending',
    reviewContent: 'A decision limited to an earlier commit.',
  };
  await f.service.store.saveSource(review);
  await f.service.queue(review.id);
  await f.service.wait();
  const specVersion = f.service.version(f.project.id);
  const pause = gate();
  f.pauseSearch(pause.pause);
  const result = f.service.retrieve(f.project, 'requirement');
  const rejected = assert.rejects(result, /approval or scope changed/);
  await pause.started;
  await f.service.update(review.id, { ...policy, mandatory: false, approval: 'withdrawn' });
  pause.release();
  await rejected;
  assert.equal(f.service.version(f.project.id), specVersion);
  const current = await f.service.retrieve(f.project, 'requirement');
  assert.ok(current.sources.every((source) => source.kind !== 'review'));
});

test('event recording rolls back both the delivery marker and queued jobs on enqueue failure', async (t) => {
  const f = await fixture(t);
  const source = await f.register();
  const job: SyncJob = {
    id: 'rolled-back-job',
    sourceId: source.id,
    status: 'queued',
    requestedAt: new Date().toISOString(),
    attempts: 0,
  };
  await assert.rejects(
    async () =>
      await f.service.store.recordEvent('transaction-test', async () => {
        await f.service.store.saveJob(job);
        throw new Error('Queue persistence failed.');
      }),
    /Queue persistence failed/,
  );
  assert.ok(!f.service.store.jobs().some((candidate) => candidate.id === job.id));
  await f.restart();
  assert.equal(
    await f.service.store.recordEvent('transaction-test', async () => {
      await f.service.store.saveJob(job);
    }),
    true,
  );
  assert.equal(
    await f.service.store.recordEvent('transaction-test', () => {
      assert.fail('Duplicate event must not enqueue again.');
    }),
    false,
  );
  await f.service.queue(source.id);
  await f.service.wait();
  assert.equal(
    f.service.store.jobs().find((candidate) => candidate.id === job.id)!.status,
    'succeeded',
  );
});

test('UTF-8 capture limits and immutable origin metadata survive subsequent edits', async (t) => {
  const f = await fixture(t);
  const registration: SourceRegistration = {
    id: `notion:${pageId}`,
    pageId,
    kind: 'notion',
    title: 'Source',
    ...policy,
    status: 'ready',
  };
  const tooLarge = 'é'.repeat(Math.floor(brainConfig.analysis.maxSourceBytes / 2) + 1);
  assert.ok(tooLarge.length < brainConfig.analysis.maxSourceBytes);
  assert.throws(() => makeCapture(registration, tooLarge), /too large/);
  assert.throws(() => makeCapture(registration, 'binary\0content'), /binary/);
  const properties = { title: 'Source', Statut: 'Publié' };
  const original = makeCapture(
    registration,
    'Original content.',
    properties,
    '2026-09-16T10:00:00Z',
    '<content>Original content.</content>',
  );
  await f.service.store.saveCapture(original);
  properties.Statut = 'Brouillon';
  const changed = makeCapture(
    registration,
    'Changed content.',
    properties,
    '2026-09-17T10:00:00Z',
    '<content>Changed content.</content>',
  );
  await f.service.store.saveCapture(changed);
  assert.notEqual(changed.id, original.id);
  const historical = f.service.store.capture(original.id)!;
  assert.equal(historical.origin!.properties.Statut, 'Publié');
  assert.equal(historical.origin!.revision, '2026-09-16T10:00:00Z');
  assert.equal(historical.origin!.raw, '<content>Original content.</content>');
});

test('bursts during a source read coalesce and the final capture uses the latest content', async (t) => {
  const f = await fixture(t);
  const source = await f.register();
  const pause = gate();
  f.pages.set(pageId, 'Intermediate content.');
  f.pauseRead(pause.pause);
  const active = (await f.service.queue(source.id))!;
  await pause.started;
  f.pages.set(pageId, 'Latest content after the burst.');
  const queued = (await f.service.queue(source.id))!;
  assert.notEqual(queued.id, active.id);
  assert.equal((await f.service.queue(source.id))!.id, queued.id);
  assert.equal((await f.service.queue(source.id))!.id, queued.id);
  pause.release();
  await f.service.wait();
  assert.equal(f.service.store.jobs().filter((job) => job.sourceId === source.id).length, 3);
  const retrieved = await f.service.retrieve(f.project, 'requirement');
  assert.equal(retrieved.sources[0].content, 'Latest content after the burst.');
});

test('Git synchronization minimizes index content and reuses it across commits until index configuration changes', async (t) => {
  const previousRevision = brainConfig.cognee.indexRevision;
  t.after(() => {
    brainConfig.cognee.indexRevision = previousRevision;
  });
  const f = await fixture(t);
  const git = fixtureGit(f.root);
  await git('init');
  const secret = `sk-${'a'.repeat(30)}`;
  const raw = `# Specification\r\nOwner: Fixture owner\r\nToken: ${secret}\r\n-----BEGIN PRIVATE KEY-----\r\nfixture-only-key\r\n-----END PRIVATE KEY-----\r\nKeep summaries generic.\r\n`;
  await writeFile(resolve(f.root, 'SPEC.md'), raw);
  await git('add', 'SPEC.md');
  await git('commit', '-m', 'Add fixture specification');
  f.project.specs = [{ kind: 'git', path: 'SPEC.md' }];
  await writeFile(f.projectsPath, JSON.stringify([f.project]));
  await f.service.registerProjects();
  const registration = f.service.applicable(f.project.id)[0];
  await f.service.queue(registration.id);
  await f.service.wait();
  const original = f.service.store.source(registration.id)!;
  const originalCapture = f.service.store.capture(original.currentSourceId!)!;
  const minimized = makeSource('code', 'SPEC.md', raw).content;
  assert.equal(f.indexed.get(original.datasetId!), minimized);
  assert.ok(!minimized.includes(secret));
  assert.ok(!minimized.includes('fixture-only-key'));
  assert.ok(!minimized.includes('Fixture owner'));
  assert.equal(originalCapture.lines, raw.split('\n').length);

  await writeFile(resolve(f.root, 'feature.ts'), 'export const feature = true;\n');
  await git('add', 'feature.ts');
  await git('commit', '-m', 'Change code without changing the specification');
  await f.service.queue(registration.id);
  await f.service.wait();
  const current = f.service.store.source(registration.id)!;
  const currentCapture = f.service.store.capture(current.currentSourceId!)!;
  assert.notEqual(current.currentSourceId, original.currentSourceId);
  assert.notEqual(currentCapture.origin!.revision, originalCapture.origin!.revision);
  assert.equal(current.datasetId, original.datasetId);
  assert.equal(f.indexCalls.length, 1);
  assert.deepEqual(f.service.store.capture(originalCapture.id), originalCapture);
  await f.restart();
  await f.service.queue(registration.id);
  await f.service.wait();
  assert.equal(f.indexCalls.length, 1);
  const supplied = makeSource('code', 'SPEC.md', raw, currentCapture.origin!.revision);
  const retrieved = await f.service.retrieve(f.project, 'generic summaries', [supplied]);
  assert.equal(retrieved.sources[0].id, currentCapture.id);
  assert.equal(retrieved.datasets[0], original.datasetId);
  assert.equal(f.indexCalls.length, 1);

  brainConfig.cognee.indexRevision = `${previousRevision}-changed-git-index`;
  await f.restart();
  await f.service.queue(registration.id);
  await f.service.wait();
  assert.equal(f.indexCalls.length, 2);
  assert.notEqual(f.service.store.source(registration.id)!.datasetId, original.datasetId);
});

test('ready project retrieval uses cached Git evidence without waiting for another project indexing', async (t) => {
  const f = await fixture(t);
  await f.register();
  f.project.specs = [{ kind: 'git', path: 'SPEC.md' }];
  const otherProject = { ...f.project, id: 'other', specs: [] };
  await writeFile(f.projectsPath, JSON.stringify([f.project, otherProject]));
  const gitSource = makeSource('code', 'SPEC.md', 'Keep this project scoped.', 'a'.repeat(40));
  await f.service.retrieve(f.project, 'requirement', [gitSource]);
  const calls = f.indexCalls.length;
  const otherPage = 'b'.repeat(32);
  f.pages.set(otherPage, 'A source from another project.');
  const pause = gate();
  f.pauseIndex(pause.pause);
  await f.service.register({ ...policy, pageId: otherPage, projectIds: [otherProject.id] });
  await pause.started;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const retrieval = f.service.retrieve(f.project, 'requirement', [gitSource]);
  try {
    const result = await Promise.race([
      retrieval,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error('Retrieval waited for unrelated indexing.')),
          1000,
        );
      }),
    ]);
    assert.ok(result.sources.every((source) => !source.content.includes('another project')));
    assert.equal(f.indexCalls.length, calls + 1);
  } finally {
    clearTimeout(deadline);
    pause.release();
    await retrieval;
    await f.service.wait();
  }
});

test('optional retrieval merges verified chunks while retaining full captures and original line references', async (t) => {
  const f = await fixture(t);
  const secondPageId = 'c'.repeat(32);
  const document = (label: string) =>
    [
      '# Large source',
      'Unrelated content '.repeat(4500),
      `${label}: first retrieved line.`,
      `${label}: overlapping retrieved line.`,
      `${label}: final retrieved line.`,
      'Other unrelated content.',
    ].join('\n');
  const firstText = document('First');
  const secondText = document('Second');
  assert.ok(Buffer.byteLength(firstText + secondText) > brainConfig.analysis.maxSourceBytes);
  f.pages.set(pageId, firstText);
  f.pages.set(secondPageId, secondText);
  const first = await f.service.register({ ...policy, pageId, mandatory: false });
  const second = await f.service.register({ ...policy, pageId: secondPageId, mandatory: false });
  await f.service.wait();
  for (const registration of [first, second]) {
    const current = f.service.store.source(registration.id)!;
    const lines = f.service.store.capture(current.currentSourceId!)!.content.split('\n');
    f.chunks.set(current.datasetId!, [
      lines.slice(2, 4).join('\n'),
      `${lines.slice(3, 5).join('\n')}\n`,
    ]);
  }
  const retrieved = await f.service.retrieve(f.project, 'retrieved line');
  assert.equal(retrieved.sources.length, 2);
  assert.deepEqual(
    new Set(retrieved.sources.map((source) => source.content)),
    new Set([firstText, secondText]),
  );
  assert.equal(retrieved.excerpts.length, 2);
  for (const excerpt of retrieved.excerpts) {
    assert.equal(excerpt.startLine, 3);
    assert.equal(excerpt.endLine, 5);
    const capture = f.service.store.capture(excerpt.sourceId)!;
    assert.match(capture.content.split('\n')[excerpt.startLine - 1], /first retrieved line/);
    assert.match(capture.content.split('\n')[excerpt.endLine - 1], /final retrieved line/);
  }
  await f.service.update(first.id, policy);
  await f.service.wait();
  const withMandatory = await f.service.retrieve(f.project, 'retrieved line');
  const firstId = f.service.store.source(first.id)!.currentSourceId!;
  assert.deepEqual(
    withMandatory.excerpts.find((excerpt) => excerpt.sourceId === firstId),
    {
      sourceId: firstId,
      startLine: 1,
      endLine: firstText.split('\n').length,
    },
  );
  await f.service.update(second.id, policy);
  await f.service.wait();
  await assert.rejects(
    f.service.retrieve(f.project, 'retrieved line'),
    /exceeds the analysis budget/,
  );
});

test('legacy raw Git indexes become pending while identical safe captures reuse their old binding', async (t) => {
  const f = await fixture(t);
  f.project.specs = [{ kind: 'git', path: 'SPEC.md' }];
  await writeFile(f.projectsPath, JSON.stringify([f.project]));
  await f.service.registerProjects();
  const registration = f.service.applicable(f.project.id)[0];
  const commit = 'a'.repeat(40);
  const raw = `Keep this requirement.\nOwner: Fixture owner\n`;
  const safeCapture = makeCapture(registration, raw, {}, commit);
  const oldCapture = { ...safeCapture, id: 'legacy-raw-capture', content: raw };
  await f.service.store.saveCapture(oldCapture);
  await f.service.store.saveSource({
    ...registration,
    status: 'ready',
    currentSourceId: oldCapture.id,
    datasetId: 'legacy-raw-dataset',
    indexVersion: f.service.indexVersion,
  });
  await f.restart();
  assert.equal(f.service.store.source(registration.id)!.status, 'pending');
  assert.equal(f.service.store.capture(oldCapture.id)!.content, raw);
  assert.equal(f.indexCalls.length, 0);

  await f.service.store.saveCapture(safeCapture);
  await f.service.store.saveDataset(
    `${safeCapture.id}:${f.service.indexVersion}`,
    'legacy-safe-dataset',
  );
  f.indexed.set('legacy-safe-dataset', safeCapture.content);
  const supplied = makeSource('code', 'SPEC.md', raw, commit);
  const retrieved = await f.service.retrieve(f.project, 'requirement', [supplied]);
  assert.deepEqual(retrieved.datasets, ['legacy-safe-dataset']);
  assert.equal(retrieved.sources[0].content, safeCapture.content);
  assert.equal(f.indexCalls.length, 0);
});

test('retrieval resumes after its required synchronization while a later unrelated job remains active', async (t) => {
  const f = await fixture(t);
  const original = await f.register();
  const otherProject = { ...f.project, id: 'other' };
  await writeFile(f.projectsPath, JSON.stringify([f.project, otherProject]));
  f.pages.set(pageId, 'Updated requirement.');
  const requiredPause = gate();
  f.pauseIndex(requiredPause.pause);
  await f.service.queue(original.id);
  await requiredPause.started;
  const otherPage = 'd'.repeat(32);
  f.pages.set(otherPage, 'A different project requirement.');
  const unrelatedPause = gate();
  f.pauseIndex(unrelatedPause.pause);
  await f.service.register({ ...policy, pageId: otherPage, projectIds: [otherProject.id] });
  const retrieval = f.service.retrieve(f.project, 'updated requirement');
  requiredPause.release();
  await unrelatedPause.started;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      retrieval,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error('Retrieval waited after its source was ready.')),
          1000,
        );
      }),
    ]);
    assert.equal(result.sources[0].content, 'Updated requirement.');
    assert.equal(f.service.store.jobs().filter((job) => job.sourceId === original.id).length, 2);
  } finally {
    clearTimeout(deadline);
    unrelatedPause.release();
    await retrieval;
    await f.service.wait();
  }
});

test('work queued as the worker finishes is picked up without another synchronization trigger', async (t) => {
  const f = await fixture(t);
  const original = await f.register();
  const saveJob = f.service.store.saveJob.bind(f.service.store);
  let queuedAtCompletion = false;
  f.service.store.saveJob = async (job) => {
    await saveJob(job);
    if (!queuedAtCompletion && job.sourceId === original.id && job.status === 'succeeded') {
      queuedAtCompletion = true;
      // Queue after drain observes no more work, before its finalizer releases the worker.
      queueMicrotask(() => queueMicrotask(() => f.service.queue(original.id)));
    }
  };
  await f.service.queue(original.id);
  await f.service.wait();
  const jobs = f.service.store.jobs().filter((job) => job.sourceId === original.id);
  assert.equal(jobs.length, 3);
  assert.ok(jobs.every((job) => job.status === 'succeeded'));
});

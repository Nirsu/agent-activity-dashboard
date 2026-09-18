import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { BrainStorage } from './brain/persistence.js';
import { MemoryService } from './brain/memory/service.js';
import { closePostgresPool } from './persistence/postgres.js';
import type { SourceRegistration } from './brain/memory/types.js';

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
    async pause() {
      entered();
      await released;
    },
  };
}

for (const backend of ['sqlite', 'postgres'] as const) {
  test(
    `${backend}: independent writes survive rollback and withdrawals win over pending synchronization writes`,
    {
      skip: backend === 'postgres' && !process.env.TEST_DATABASE_URL,
    },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'brain-write-races-'));
      const previousUrl = process.env.DATABASE_URL;
      const schema = `brain_races_${randomUUID().replaceAll('-', '')}`;
      const admin =
        backend === 'postgres'
          ? new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
          : undefined;
      let storage: BrainStorage | undefined;
      let service: MemoryService | undefined;
      try {
        process.env.DATABASE_URL = '';
        if (admin) {
          await admin.query(`CREATE SCHEMA ${schema}`);
          const url = new URL(process.env.TEST_DATABASE_URL!);
          url.searchParams.set('options', `-c search_path=${schema}`);
          process.env.DATABASE_URL = url.toString();
        }
        storage = new BrainStorage(join(directory, 'transactions.db'), ['brain_agent_runs'], 1);
        await storage.init();
        const paused = gate();
        const rollback = assert.rejects(
          storage.transaction(async () => {
            await storage!.put('brain_agent_runs', 'inside', { id: 'inside' });
            await paused.pause();
            throw new Error('Expected rollback');
          }),
          /Expected rollback/,
        );
        await paused.started;
        let acknowledged = false;
        const independent = storage
          .put('brain_agent_runs', 'outside', { id: 'outside' })
          .then(() => {
            acknowledged = true;
          });
        try {
          await Promise.resolve();
          assert.equal(acknowledged, false, 'a separate writer must wait for the transaction');
        } finally {
          paused.release();
        }
        await rollback;
        await independent;
        assert.equal(storage.get('brain_agent_runs', 'inside'), undefined);
        assert.deepEqual(storage.get('brain_agent_runs', 'outside'), { id: 'outside' });
        await storage.close();
        storage = undefined;

        const projectsPath = join(directory, 'projects.json');
        await writeFile(
          projectsPath,
          JSON.stringify([
            {
              id: 'project',
              name: 'Fixture',
              scope: 'Fixture',
              repoPath: directory,
              codePaths: ['feature.ts'],
              specs: [],
            },
          ]),
        );
        let reads = 0;
        let indexes = 0;
        service = new MemoryService({
          dbPath: join(directory, 'memory.db'),
          projectsPath,
          schedule: false,
          notion: {
            state: () => ({ configured: true, connected: true, status: 'connected' }),
            fetchPage: async (pageId) => {
              reads++;
              return {
                pageId,
                title: 'Fixture',
                content: 'Approved reference',
                raw: 'Approved reference',
                properties: {},
                url: `https://www.notion.so/${pageId}`,
              };
            },
          },
          cognee: {
            status: async () => ({ configured: true, available: true }),
            index: async () => {
              indexes++;
              return { datasetId: 'fixture-index' };
            },
            search: async () => [],
            graph: async () => ({ nodes: [], edges: [], truncated: false }),
          },
        });
        await service.init();
        const source: SourceRegistration = {
          id: 'fixture',
          kind: 'notion',
          pageId: 'a'.repeat(32),
          title: 'Fixture',
          projectIds: ['project'],
          shared: false,
          mandatory: true,
          approval: 'approved',
          status: 'pending',
        };
        await service.store.saveSource(source);
        const starting = gate();
        const saveJob = service.store.saveJob.bind(service.store);
        service.store.saveJob = async (job) => {
          await saveJob(job);
          if (job.status === 'running') {
            await starting.pause();
          }
        };
        await service.queue(source.id);
        await starting.started;
        try {
          await service.update(source.id, { ...source, approval: 'withdrawn' });
          assert.equal(service.store.source(source.id)!.approval, 'withdrawn');
        } finally {
          starting.release();
        }
        await service.wait();
        assert.equal(service.store.source(source.id)!.approval, 'withdrawn');
        assert.equal(service.store.source(source.id)!.status, 'withdrawn');
        assert.equal(reads, 0, 'withdrawal before capture prevents fetching the source');
        assert.equal(indexes, 0);
        if (admin) {
          const row = await admin.query(
            `SELECT data FROM ${schema}.brain_memory_sources WHERE id=$1`,
            [source.id],
          );
          assert.equal(row.rows[0].data.approval, 'withdrawn');
        }
        const publishing = gate();
        const saveSource = service.store.saveSource.bind(service.store);
        service.store.saveSource = async (value) => {
          if (value.id === source.id && value.status === 'ready') {
            await publishing.pause();
          }
          await saveSource(value);
        };
        await service.update(source.id, { ...source, approval: 'approved' });
        await publishing.started;
        const withdrawal = service.update(source.id, { ...source, approval: 'withdrawn' });
        publishing.release();
        await withdrawal;
        await service.wait();
        assert.equal(service.store.source(source.id)!.approval, 'withdrawn');
        assert.equal(service.store.source(source.id)!.status, 'withdrawn');
      } finally {
        await storage?.close();
        await service?.close();
        await closePostgresPool();
        if (previousUrl === undefined) {
          delete process.env.DATABASE_URL;
        } else {
          process.env.DATABASE_URL = previousUrl;
        }
        if (admin) {
          await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
          await admin.end();
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

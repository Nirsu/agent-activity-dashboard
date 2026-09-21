import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, access, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import Sqlite from 'better-sqlite3';
import { closePostgresPool, getPostgresPool } from './persistence/postgres.js';
import { MemoryStore } from './brain/memory/store.js';
import { BrainStorage } from './brain/persistence.js';
import { BrainAgents } from './brain/analysis/service.js';
import { migrateSqliteBrain } from './brain/migrate.js';
import type { AnalysisRun } from './brain/analysis/types.js';
import type { SourceRegistration, SyncJob } from './brain/memory/types.js';
import { fixtureGit } from './brain/testing/git.js';

test(
  'PostgreSQL Brain persists before publication, locks workers, rolls back and imports SQLite safely',
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async () => {
    const originalUrl = process.env.DATABASE_URL;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `brain_test_${randomUUID().replaceAll('-', '')}`;
    const directory = await mkdtemp(resolve(tmpdir(), 'brain-pg-'));
    const noSqlitePath = resolve(directory, 'must-not-exist.db');
    const projectsPath = resolve(directory, 'projects.json');
    await writeFile(projectsPath, '[]');
    let memory: MemoryStore | undefined;
    let analyses: BrainStorage | undefined;
    let agents: BrainAgents | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      process.env.DATABASE_URL = url.toString();
      const source: SourceRegistration = {
        id: 'source-1',
        kind: 'notion',
        title: 'Published',
        projectIds: ['project'],
        shared: false,
        mandatory: true,
        approval: 'approved',
        status: 'ready',
      };
      memory = new MemoryStore(noSqlitePath);
      await memory.init();
      await memory.saveSource(source);
      await memory.saveDataset('obsolete-index', 'dataset-1');
      await assert.rejects(
        memory.transaction(async () => {
          await memory!.removeDataset('obsolete-index');
          throw new Error('Rollback index removal');
        }),
        /Rollback index removal/,
      );
      assert.equal(memory.dataset('obsolete-index'), 'dataset-1');
      await memory.removeDataset('obsolete-index');
      assert.equal(memory.dataset('obsolete-index'), undefined);
      assert.equal(
        (await getPostgresPool()!.query('SELECT count(*) FROM brain_memory_datasets')).rows[0]
          .count,
        '0',
      );
      assert.equal(
        (
          await getPostgresPool()!.query('SELECT data FROM brain_memory_sources WHERE id=$1', [
            source.id,
          ])
        ).rows[0].data.title,
        'Published',
      );
      const contender = new MemoryStore(noSqlitePath);
      await assert.rejects(contender.init(), /Another Brain worker/);
      await contender.close();
      await getPostgresPool()!.query(
        "ALTER TABLE brain_memory_sources ADD CONSTRAINT reject_test CHECK (data->>'title' <> 'Rejected')",
      );
      await assert.rejects(memory.saveSource({ ...source, title: 'Rejected' }) as Promise<void>);
      assert.equal(memory.source(source.id)!.title, 'Published');
      const job: SyncJob = {
        id: 'job-1',
        sourceId: source.id,
        status: 'queued',
        requestedAt: new Date().toISOString(),
        attempts: 0,
      };
      await assert.rejects(
        memory.recordEvent('event-1', async () => {
          await memory!.saveJob(job);
          throw new Error('Rollback queue');
        }),
        /Rollback queue/,
      );
      assert.equal(memory.jobs().length, 0);
      assert.equal(
        (await getPostgresPool()!.query('SELECT count(*) FROM brain_memory_jobs')).rows[0].count,
        '0',
      );
      assert.equal(
        await memory.recordEvent('event-1', async () => {
          await memory!.saveJob(job);
        }),
        true,
      );
      assert.equal(
        await memory.recordEvent('event-1', () => {
          assert.fail('Duplicate');
        }),
        false,
      );
      await memory.close();
      memory = new MemoryStore(noSqlitePath);
      await memory.init();
      assert.equal(memory.source(source.id)!.title, 'Published');
      assert.equal(memory.jobs()[0].id, job.id);

      analyses = new BrainStorage(noSqlitePath, ['brain_agent_runs', 'brain_activity_events'], 1);
      await analyses.init();
      const run: AnalysisRun = {
        id: 'interrupted-run',
        projectId: 'project',
        projectName: 'Project',
        scope: 'Scope',
        projectVersion: 'v1',
        status: 'running',
        stage: 'Reading project specifications',
        startedAt: new Date().toISOString(),
        model: 'fixture',
        events: [],
        usage: { inputTokens: 12, outputTokens: 3 },
        sources: [],
        requirements: [],
        findings: [],
        changedFiles: [],
        correlation: { workItemId: 'work-1' },
      };
      await analyses.put('brain_agent_runs', run.id, run);
      await analyses.close();
      analyses = undefined;
      agents = new BrainAgents({ dbPath: noSqlitePath, projectsPath });
      await agents.init();
      assert.equal((await agents.detail(run.id)).status, 'interrupted');
      assert.equal((await agents.overview()).runs[0].workItemId, 'work-1');
      const other = new BrainAgents({ dbPath: noSqlitePath, projectsPath });
      await assert.rejects(other.init(), /Another Brain worker/);
      await other.close();
      await assert.rejects(access(noSqlitePath));

      await agents.close();
      agents = undefined;
      const git = fixtureGit(directory);
      await git('init');
      await writeFile(resolve(directory, 'rules.md'), 'A fixture requirement.');
      await writeFile(resolve(directory, 'feature.ts'), 'export const fixture = true;');
      await git('add', 'rules.md', 'feature.ts');
      await git('commit', '-m', 'Fixture');
      const commit = await git('rev-parse', 'HEAD');
      await writeFile(
        projectsPath,
        JSON.stringify([
          {
            id: 'project',
            name: 'Project',
            scope: 'Fixture',
            repoPath: directory,
            codePaths: ['feature.ts'],
            specs: [{ kind: 'git', path: 'rules.md' }],
          },
        ]),
      );
      agents = new BrainAgents({
        dbPath: noSqlitePath,
        projectsPath,
        model: 'fixture',
        call: async () => ({
          value: { summary: 'No applicable requirements', requirements: [] },
          inputTokens: 7,
          outputTokens: 3,
        }),
        memory: {
          version: () => 'v1',
          contextVersion: () => 'v1',
          recordReview: async () => {},
          retrieve: async (_project, query, sources = []) => ({
            sources,
            excerpts: sources.map((item) => ({
              sourceId: item.id,
              startLine: 1,
              endLine: item.lines,
            })),
            datasets: [],
            sourceIds: sources.map((item) => item.id),
            retrievedAt: new Date().toISOString(),
            query,
            memoryVersion: 'v1',
            contextVersion: 'v1',
          }),
        },
      });
      await agents.init();
      const finished = await agents.start('project', commit, undefined, 'Fixture', undefined, {
        workItemId: 'work-pg',
      });
      await agents.wait();
      const storedRun = (
        await getPostgresPool()!.query('SELECT data FROM brain_agent_runs WHERE id=$1', [
          finished.id,
        ])
      ).rows[0].data as AnalysisRun;
      assert.equal(storedRun.status, 'succeeded');
      assert.equal(storedRun.usage.inputTokens, 7);
      assert.equal(storedRun.calls![0].role, 'reader');
      assert.equal(storedRun.correlation!.workItemId, 'work-pg');
      assert.equal(
        (
          await getPostgresPool()!.query(
            "SELECT count(*) FROM brain_activity_events WHERE data->'event'->>'id'=$1",
            [`${finished.id}:call:1:completed`],
          )
        ).rows[0].count,
        '1',
      );

      const legacyPath = resolve(directory, 'legacy.db');
      const legacy = new Sqlite(legacyPath);
      legacy.exec('CREATE TABLE brain_memory_sources (id TEXT PRIMARY KEY,data TEXT NOT NULL)');
      legacy
        .prepare('INSERT INTO brain_memory_sources VALUES (?,?)')
        .run('legacy-source', JSON.stringify({ ...source, id: 'legacy-source' }));
      legacy.close();
      await assert.rejects(migrateSqliteBrain(legacyPath), /Stop the Brain server/);
      await agents.close();
      agents = undefined;
      await memory.close();
      memory = undefined;
      assert.equal((await migrateSqliteBrain(legacyPath)).imported, 1);
      const second = await migrateSqliteBrain(legacyPath);
      assert.equal(second.imported, 0);
      assert.equal(second.skipped, 1);
      const readonly = new Sqlite(legacyPath, { readonly: true });
      assert.equal(
        (
          readonly.prepare('SELECT count(*) AS count FROM brain_memory_sources').get() as {
            count: number;
          }
        ).count,
        1,
      );
      readonly.close();
    } finally {
      await agents?.close();
      await analyses?.close();
      await memory?.close();
      await closePostgresPool();
      if (originalUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalUrl;
      }
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

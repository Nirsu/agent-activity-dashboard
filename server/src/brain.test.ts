import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import Sqlite from 'better-sqlite3';
import { BrainService, registerBrain } from './brain.js';

const exec = promisify(execFile);
const doctrine =
  '# Socle technique cible\nStatut: Publié\n\n| BFF | NestJS |\n| Base de données | PostgreSQL |\n| Extranet web | React avec Vite |\n';

test('Brain: real Git snapshot, rule activation, evidence, durable arbitration and failed refresh', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-pilot-'));
  const repoPath = resolve(root, 'repo');
  const notionPath = resolve(root, 'notion');
  const dbPath = resolve(root, 'brain.db');
  await mkdir(resolve(repoPath, 'server'), { recursive: true });
  await mkdir(resolve(repoPath, 'ui'), { recursive: true });
  await mkdir(notionPath);
  const git = async (...args: string[]) =>
    exec('git', ['-C', repoPath, ...args], { windowsHide: true });
  await git('init');
  await writeFile(
    resolve(repoPath, 'server/package.json'),
    JSON.stringify({ dependencies: { fastify: '5', 'better-sqlite3': '11' } }, null, 2),
  );
  await writeFile(
    resolve(repoPath, 'ui/package.json'),
    JSON.stringify({ dependencies: { react: '18' }, devDependencies: { vite: '6' } }, null, 2),
  );
  await git('add', '.');
  await git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'fixture',
  );
  await writeFile(resolve(notionPath, 'socle.md'), doctrine);
  await writeFile(
    resolve(notionPath, 'draft.md'),
    '# Plan non arbitré\nStatut: À rédiger\nUtiliser MongoDB.\n',
  );
  for (const folder of ['equipe-a', 'equipe-b']) {
    await mkdir(resolve(notionPath, folder));
    await writeFile(
      resolve(notionPath, folder, 'notes.md'),
      '# Notes\nStatut: Brouillon\nÀ préciser.\n',
    );
  }
  const options = { repoPath, notionPath, dbPath };
  let brain = new BrainService(options);
  await brain.init();
  try {
    brain.start('import');
    assert.throws(() => brain.start('import'), /already running/);
    await brain.wait();
    let state = brain.state();
    assert.equal(state.runs[0].status, 'succeeded');
    assert.equal(state.sources.length, 6);
    assert.equal(new Set(state.sources.map((s) => s.id)).size, 6);
    assert.deepEqual(
      state.sources
        .filter((s) => s.title === 'Notes')
        .map((s) => s.path)
        .sort(),
      ['equipe-a/notes.md', 'equipe-b/notes.md'],
    );
    assert.equal(state.rules.length, 3);
    assert.equal(state.rules.filter((r) => r.active).length, 0);
    assert.equal(state.sources.find((s) => s.title === 'Plan non arbitré')?.status, 'draft');
    assert.ok(brain.search('PostgreSQL')[0].matches[0].quote.includes('PostgreSQL'));
    const firstCommit = state.snapshot!.commit;
    // Working tree changes must not be mistaken for the imported commit.
    await writeFile(
      resolve(repoPath, 'server/package.json'),
      '{"dependencies":{"@nestjs/core":"11"}}',
    );
    for (const rule of state.rules) {
      brain.activate(rule.id, true, 'Test scope explicitly accepted.');
    }
    brain.start('compare');
    await brain.wait();
    state = brain.state();
    assert.deepEqual(state.findings.map((f) => f.outcome).sort(), [
      'aligned',
      'difference',
      'difference',
    ]);
    for (const finding of state.findings) {
      for (const c of [finding.decision, ...finding.evidence]) {
        assert.equal(brain.source(c.sourceId).content.split('\n')[c.line - 1], c.quote);
      }
    }
    const finding = state.findings.find((f) => f.outcome === 'difference')!;
    const rule = state.rules.find((r) => r.id === finding.ruleId)!;
    brain.activate(rule.id, false, 'Scope needs review.');
    assert.equal(brain.state().comparisonReady, false);
    assert.equal(
      brain.state().findings.some((f) => f.current),
      false,
    );
    assert.throws(
      () => brain.review(finding.id, 'confirmed', 'This finding belongs to the previous scope.'),
      /Historical/,
    );
    brain.activate(rule.id, true, 'Test scope explicitly accepted.');
    assert.equal(brain.state().comparisonReady, true);
    const review = brain.review(finding.id, 'exception', 'Scope exception for the local pilot.');
    assert.throws(
      () => brain.review(finding.id, 'confirmed', 'Another concurrent decision.'),
      /changed/,
    );
    assert.throws(() => brain.review(finding.id, 'invalid', 'Detailed justification.'), /Invalid/);
    brain.start('compare');
    await brain.wait();
    assert.equal(brain.state().findings.length, 3);
    assert.equal(brain.state().findings.find((f) => f.id === finding.id)!.reviews[0].id, review.id);
    await brain.close();
    brain = new BrainService(options);
    await brain.init();
    assert.equal(
      brain.state().findings.find((f) => f.id === finding.id)!.reviews[0].note,
      review.note,
    );
    await rename(notionPath, `${notionPath}-moved`);
    brain.start('import');
    await brain.wait();
    assert.equal(brain.state().runs[0].status, 'failed');
    assert.equal(brain.state().snapshot!.commit, firstCommit);
    assert.equal(
      brain.state().findings.find((f) => f.id === finding.id)!.reviews[0].decision,
      'exception',
    );
    await rename(`${notionPath}-moved`, notionPath);
    await writeFile(resolve(repoPath, 'server/package.json'), 'invalid json');
    await git('add', '.');
    await git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'invalid manifest',
    );
    brain.start('import');
    await brain.wait();
    brain.start('compare');
    await brain.wait();
    state = brain.state();
    assert.equal(state.findings.filter((f) => f.current && f.outcome === 'insufficient').length, 2);
    assert.equal(state.findings.find((f) => f.id === finding.id)!.current, false);
    assert.throws(
      () =>
        brain.review(finding.id, 'confirmed', 'Previous commit has now been replaced.', review.id),
      /Historical/,
    );
    assert.equal(state.findings.find((f) => f.id === finding.id)!.reviews[0].decision, 'exception');
    await rename(resolve(notionPath, 'socle.md'), resolve(notionPath, 'equipe-a/socle.md'));
    brain.start('import');
    await brain.wait();
    assert.equal(brain.state().rules.length, 3);
    assert.ok(
      brain
        .state()
        .rules.every(
          (r) => !r.active && brain.source(r.source.sourceId).path === 'equipe-a/socle.md',
        ),
    );
    assert.equal(brain.state().findings.find((f) => f.id === finding.id)!.reviews[0].id, review.id);
    for (const rule of brain.state().rules) {
      brain.activate(rule.id, true, 'Source moved and scope revalidated.');
    }
    brain.start('compare');
    await brain.wait();
    assert.ok(
      brain
        .state()
        .findings.filter((f) => f.current)
        .every((f) => brain.source(f.decision.sourceId).path === 'equipe-a/socle.md'),
    );
    assert.equal(brain.state().findings.find((f) => f.id === finding.id)!.reviews[0].id, review.id);
    await writeFile(
      resolve(notionPath, 'equipe-a/socle.md'),
      doctrine.replace('Statut: Publié', 'Statut: Brouillon'),
    );
    brain.start('import');
    await brain.wait();
    assert.equal(brain.state().rules.length, 0);
    assert.throws(
      () => brain.activate(state.rules[0].id, true, 'Previous document revision.'),
      /replaced/,
    );
  } finally {
    await brain.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Brain routes reject foreign origins and malformed actions; interrupted runs remain explicit', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-routes-'));
  const dbPath = resolve(root, 'brain.db');
  const service = new BrainService({ dbPath });
  const app = Fastify();
  await registerBrain(app, service);
  try {
    assert.equal(
      (await app.inject({ url: '/api/brain', remoteAddress: '192.168.1.10' })).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: '/api/brain/agents', remoteAddress: '192.168.1.10' })).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/brain/analyses',
          headers: { origin: 'https://foreign.invalid' },
          payload: { projectId: 'dashboard' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/brain/analyses',
          payload: { projectId: 'dashboard', commit: '--exec=command' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/brain',
          headers: { host: 'foreign.invalid', origin: 'http://foreign.invalid' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: '/api/brain', headers: { origin: 'https://foreign.invalid' } }))
        .statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: '/api/brain', headers: { origin: 'http://localhost:9999' } }))
        .statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: '/api/brain', headers: { origin: 'http://localhost:5173' } }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/brain/runs',
          payload: { kind: 'execute-shell' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/brain/runs', payload: { kind: 'compare' } }))
        .statusCode,
      400,
    );
    assert.equal((await app.inject({ url: '/api/brain/search' })).statusCode, 400);
    assert.equal((await app.inject({ url: '/api/brain/sources/missing' })).statusCode, 404);
  } finally {
    await app.close();
  }
  const db = new Sqlite(dbPath);
  db.prepare('INSERT INTO brain_records VALUES (?,?,?)').run(
    'run',
    'interrupted',
    JSON.stringify({
      id: 'interrupted',
      kind: 'import',
      status: 'running',
      startedAt: new Date().toISOString(),
      events: [],
    }),
  );
  db.close();
  const restarted = new BrainService({ dbPath });
  await restarted.init();
  try {
    assert.equal(restarted.state().runs[0].status, 'interrupted');
    assert.equal(restarted.state().activeRun, null);
  } finally {
    await restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

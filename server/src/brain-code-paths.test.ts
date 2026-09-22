import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { CodeReader } from './brain/analysis/code-reader.js';
import { captureProjectSources } from './brain/analysis/projects.js';
import { applySubmittedFiles, validateSubmittedFiles } from './brain/analysis/submissions.js';
import type { AnalysisRun, Project } from './brain/analysis/types.js';
import { brainConfig } from './brain/config.js';
import { fixtureGit } from './brain/testing/git.js';

async function fixture(t: TestContext, codePaths = ['**']) {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-code-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = {
    'spec.md': 'SCOPE_MATCH approved requirement',
    'root.ts': 'export const root = "SCOPE_MATCH";',
    'literal[1].ts': 'export const literal = "SCOPE_MATCH";',
    'literal1.ts': 'export const other = "SCOPE_MATCH";',
    'src/main.ts': 'export const main = "BASELINE_ONLY";',
    'src/related.ts': 'export const related = "SCOPE_MATCH";',
    'src/removed.ts': 'export const removed = "BASELINE_ONLY";',
    'src/.env': 'SCOPE_MATCH PRIVATE_SENTINEL',
    'src/credentials.json': 'SCOPE_MATCH PRIVATE_SENTINEL',
    'dist/bundle.js': 'SCOPE_MATCH GENERATED_SENTINEL',
    'src/node_modules/dependency.js': 'SCOPE_MATCH GENERATED_SENTINEL',
    '.github/config.yml': 'public: true',
  };
  for (const [path, text] of Object.entries(content)) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), text);
  }
  const git = fixtureGit(root);
  await git('init');
  await git('add', '.');
  await git('commit', '-m', 'Code scope baseline');
  const commit = await git('rev-parse', 'HEAD');
  const project: Project = {
    id: 'test',
    name: 'Test',
    scope: 'Repository code scope',
    repoPath: root,
    codePaths,
    specs: [{ kind: 'git', path: 'spec.md' }],
  };
  const run = { commit, changedFiles: [], sources: [] } as unknown as AnalysisRun;
  const files = await captureProjectSources(run, project);
  return { root, git, project, run, files, commit };
}

test('default all-code scope searches and reads unchanged code without exposing excluded paths', async (t) => {
  const f = await fixture(t);
  const reader = new CodeReader(f.run, f.project, [
    ...f.files,
    'src/.env',
    'dist/bundle.js',
    'spec.md',
  ]);
  assert.ok(
    reader.files.includes('.github/config.yml'),
    'ordinary dot-directories remain available',
  );
  assert.ok(reader.files.includes('root.ts'), 'root code is included by the all-code scope');
  assert.ok(reader.files.includes('src/related.ts'), 'nested related code is included');
  await writeFile(resolve(f.root, 'src/related.ts'), 'LOCAL_WORKTREE_SENTINEL');
  await reader.requests([{ action: 'search', query: 'SCOPE_MATCH' }]);
  assert.deepEqual(
    reader.context.searches[0].matches.map((match) => match.path),
    ['literal1.ts', 'literal[1].ts', 'root.ts', 'src/related.ts'],
  );
  assert.equal(reader.context.searches[0].truncated, false);
  assert.equal(reader.sources.length, 0, 'a search cannot manufacture citation evidence');
  await reader.requests([{ action: 'read', path: 'src/related.ts', startLine: 1, endLine: 1 }]);
  assert.equal(reader.sources[0].revision, f.commit);
  assert.equal(reader.sources[0].content, 'export const related = "SCOPE_MATCH";');
  for (const path of [
    'src/.env',
    'src/credentials.json',
    'dist/bundle.js',
    'src/node_modules/dependency.js',
    'spec.md',
  ]) {
    assert.ok(!reader.files.includes(path));
    await assert.rejects(
      reader.requests([{ action: 'read', path, startLine: 1, endLine: 1 }]),
      /scope|snapshot/,
    );
  }
  assert.doesNotMatch(
    JSON.stringify({ context: reader.context, sources: reader.sources }),
    /PRIVATE_SENTINEL|GENERATED_SENTINEL|LOCAL_WORKTREE_SENTINEL/,
  );
});

test('explicit scopes use literal paths and do not grep sensitive files within an allowed directory', async (t) => {
  const f = await fixture(t, ['src/', 'literal[1].ts']);
  // If an entire directory were passed to grep, this excluded line would exceed its output budget.
  await writeFile(
    resolve(f.root, 'src/.env'),
    `SCOPE_MATCH ${'x'.repeat(brainConfig.git.maxBufferBytes)}`,
  );
  await f.git('add', '.');
  await f.git('commit', '-m', 'Large excluded content');
  f.run.commit = await f.git('rev-parse', 'HEAD');
  const files = await captureProjectSources(f.run, f.project);
  const reader = new CodeReader(f.run, f.project, [...files, 'root.ts']);
  await reader.requests([{ action: 'search', query: 'SCOPE_MATCH' }]);
  assert.deepEqual(
    reader.context.searches[0].matches.map((match) => match.path),
    ['literal[1].ts', 'src/related.ts'],
  );
  await assert.rejects(
    reader.requests([{ action: 'read', path: 'root.ts', startLine: 1, endLine: 1 }]),
    /snapshot/,
  );
  assert.equal(reader.context.searches[0].truncated, false);
});

test('all-code search combines unchanged Git code with local overlays and never falls back to replaced baseline content', async (t) => {
  const f = await fixture(t);
  const submitted = validateSubmittedFiles(
    [
      { path: 'src/main.ts', content: 'export const main = "LOCAL_MATCH";' },
      { path: 'src/added.ts', content: 'export const added = "LOCAL_MATCH";' },
      { path: 'src/removed.ts', content: null },
    ],
    f.project,
  );
  applySubmittedFiles(f.run, f.project, submitted);
  const reader = new CodeReader(f.run, f.project, f.files, submitted);
  await reader.requests([
    { action: 'search', query: 'BASELINE_ONLY' },
    { action: 'search', query: 'LOCAL_MATCH' },
    { action: 'search', query: 'related' },
  ]);
  assert.deepEqual(reader.context.searches[0].matches, []);
  assert.deepEqual(
    reader.context.searches[1].matches.map((match) => match.path),
    ['src/added.ts', 'src/main.ts'],
  );
  assert.deepEqual(
    reader.context.searches[2].matches.map((match) => match.path),
    ['src/related.ts'],
  );
  await reader.requests([
    { action: 'read', path: 'src/main.ts', startLine: 1, endLine: 1 },
    { action: 'read', path: 'src/added.ts', startLine: 1, endLine: 1 },
  ]);
  assert.ok(reader.sources.every((source) => source.revision === f.run.submission!.id));
  assert.ok(reader.sources.every((source) => source.content.includes('LOCAL_MATCH')));
  await assert.rejects(
    reader.requests([{ action: 'read', path: 'src/removed.ts', startLine: 1, endLine: 1 }]),
    /deleted/,
  );

  const scopedProject = { ...f.project, codePaths: ['src/main.ts'] };
  const scopedReader = new CodeReader(f.run, scopedProject, f.files, submitted);
  await scopedReader.requests([{ action: 'search', query: 'SCOPE_MATCH' }]);
  assert.deepEqual(
    scopedReader.context.searches[0].matches,
    [],
    'an empty baseline catalog never runs an unscoped grep',
  );
  assert.equal(await f.git('status', '--porcelain'), '', 'the overlay never changes the checkout');
});

test('search continues across bounded file batches and reports truncated results at the global match limit', async (t) => {
  const f = await fixture(t, ['batch/']);
  await mkdir(resolve(f.root, 'batch'));
  const count =
    Math.max(brainConfig.projects.maxCodePaths, brainConfig.codeRetrieval.maxSearchMatches) + 2;
  for (let index = 0; index < count; index += 1) {
    const text = `BATCH_MATCH ${index}${index === count - 1 ? ' LAST_BATCH' : ''}`;
    await writeFile(resolve(f.root, `batch/${String(index).padStart(3, '0')}.ts`), text);
  }
  await f.git('add', '.');
  await f.git('commit', '-m', 'Batched code');
  f.run.commit = await f.git('rev-parse', 'HEAD');
  const files = await captureProjectSources(f.run, f.project);
  const reader = new CodeReader(f.run, f.project, files);
  await reader.requests([
    { action: 'search', query: 'LAST_BATCH' },
    { action: 'search', query: 'BATCH_MATCH' },
  ]);
  assert.equal(reader.context.searches[0].matches.length, 1);
  assert.equal(reader.context.searches[0].truncated, false);
  assert.equal(
    reader.context.searches[1].matches.length,
    brainConfig.codeRetrieval.maxSearchMatches,
  );
  assert.equal(reader.context.searches[1].truncated, true);
  assert.equal(f.run.codeRetrieval!.searches[1].truncated, true);
});

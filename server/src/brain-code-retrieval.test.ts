import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fixtureGit } from './brain/testing/git.js';
import { captureProjectSources } from './brain/analysis/projects.js';
import { CodeReader } from './brain/analysis/code-reader.js';
import { applySubmittedFiles, validateSubmittedFiles } from './brain/analysis/submissions.js';
import { parseComparisonChecks } from './brain/analysis/validation.js';
import type { AnalysisRun, Project, Requirement } from './brain/analysis/types.js';
import { brainConfig } from './brain/config.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-code-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'src'));
  await writeFile(resolve(root, 'spec.md'), 'Use the shared sanitizer.');
  await writeFile(resolve(root, 'src/main.ts'), 'import { sanitize } from "./helper";');
  await writeFile(
    resolve(root, 'src/helper.ts'),
    Array.from({ length: 210 }, (_, i) =>
      i === 179 ? 'export const sanitize = () => "original";' : `// Context line ${i + 1}`,
    ).join('\n'),
  );
  await writeFile(resolve(root, 'src/.env'), 'PRIVATE_SENTINEL');
  await writeFile(resolve(root, 'outside.ts'), 'PRIVATE_SENTINEL');
  const git = fixtureGit(root);
  await git('init');
  await git('add', '.');
  await git('commit', '-m', 'Baseline');
  const commit = await git('rev-parse', 'HEAD');
  const project: Project = {
    id: 'test',
    name: 'Test',
    scope: 'Sanitization',
    repoPath: root,
    codePaths: ['src/'],
    specs: [{ kind: 'git', path: 'spec.md' }],
  };
  const run = { commit, changedFiles: [], sources: [] } as unknown as AnalysisRun;
  const files = await captureProjectSources(run, project);
  return { root, git, project, run, files, commit };
}

test('code search and reads stay at the pinned commit and only expose requested lines', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    f.run.sources.map((source) => source.path),
    ['spec.md'],
  );
  const reader = new CodeReader(f.run, f.project, f.files);
  assert.equal(reader.sources.length, 0);
  await writeFile(resolve(f.root, 'src/helper.ts'), 'export const sanitize = "NEW_HEAD";');
  await f.git('add', '.');
  await f.git('commit', '-m', 'Newer code');
  await writeFile(resolve(f.root, 'src/helper.ts'), 'UNCOMMITTED_SENTINEL');
  await reader.requests([{ action: 'search', query: 'export const sanitize' }]);
  assert.deepEqual(reader.context.searches[0].matches, [
    { path: 'src/helper.ts', line: 180, text: 'export const sanitize = () => "original";' },
  ]);
  assert.equal(
    reader.sources.length,
    0,
    'search results are navigation hints, not citation evidence',
  );
  await reader.requests([{ action: 'read', path: 'src/helper.ts', startLine: 175, endLine: 185 }]);
  const source = reader.sources[0];
  assert.equal(source.revision, f.commit);
  assert.doesNotMatch(source.content, /NEW_HEAD|UNCOMMITTED_SENTINEL/);
  const requirements = [{ id: 'R1' }] as Requirement[];
  const check = (line: number) => [
    {
      requirementId: 'R1',
      outcome: 'aligned',
      explanation: 'Evidence',
      evidence: [
        { sourceId: source.id, line, endLine: line, quote: source.content.split('\n')[line - 1] },
      ],
    },
  ];
  assert.equal(
    parseComparisonChecks(
      check(180),
      reader.sources,
      requirements,
      f.run.codeRetrieval!.excerpts,
    )[0].outcome,
    'aligned',
  );
  assert.throws(
    () =>
      parseComparisonChecks(check(1), reader.sources, requirements, f.run.codeRetrieval!.excerpts),
    /not included/,
  );
  await reader.requests([{ action: 'read', path: 'src/helper.ts', startLine: 180, endLine: 190 }]);
  assert.deepEqual(f.run.codeRetrieval!.excerpts, [
    { sourceId: source.id, startLine: 175, endLine: 190 },
  ]);
});

test('search sanitizes complete files before returning multiline secret matches', async (t) => {
  const f = await fixture(t);
  const content = [
    'export const example = `',
    '-----BEGIN PRIVATE KEY-----',
    'MATCH_SYNTHETIC_KEY_MATERIAL',
    '-----END PRIVATE KEY-----',
    '`;',
    'export const MATCH_VISIBLE = true;',
  ].join('\r\n');
  await writeFile(resolve(f.root, 'src/example.ts'), content);
  await f.git('add', '.');
  await f.git('commit', '-m', 'Synthetic multiline fixture');
  f.run.commit = await f.git('rev-parse', 'HEAD');
  const files = await captureProjectSources(f.run, f.project);
  for (const submitted of [
    [],
    validateSubmittedFiles([{ path: 'src/example.ts', content }], f.project),
  ]) {
    const run = { commit: f.run.commit, sources: [], changedFiles: [] } as unknown as AnalysisRun;
    applySubmittedFiles(run, f.project, submitted);
    const reader = new CodeReader(run, f.project, files, submitted);
    await reader.requests([{ action: 'search', query: 'MATCH_' }]);
    assert.deepEqual(reader.context.searches[0].matches, [
      { path: 'src/example.ts', line: 6, text: 'export const MATCH_VISIBLE = true;' },
    ]);
    assert.doesNotMatch(JSON.stringify(reader.context), /MATCH_SYNTHETIC_KEY_MATERIAL/);
    assert.equal(reader.sources.length, 0, 'search hints must not become citation evidence');
  }
});

test('workstation tokens are redacted from Git reads, searches and submitted overlays', async (t) => {
  const f = await fixture(t);
  const token = `hb_11111111-1111-4111-8111-111111111111.${'a'.repeat(42)}_`;
  const content = `const connection = '${token}';\r\nexport const visible = true;`;
  await writeFile(resolve(f.root, 'src/example.ts'), content);
  await f.git('add', '.');
  await f.git('commit', '-m', 'Synthetic token fixture');
  const commit = await f.git('rev-parse', 'HEAD');
  for (const submitted of [
    [],
    validateSubmittedFiles([{ path: 'src/example.ts', content }], f.project),
  ]) {
    const run = { commit, sources: [], changedFiles: [] } as unknown as AnalysisRun;
    const files = await captureProjectSources(run, f.project);
    if (submitted.length) applySubmittedFiles(run, f.project, submitted);
    const reader = new CodeReader(run, f.project, files, submitted);
    await reader.requests([
      { action: 'search', query: 'connection' },
      { action: 'read', path: 'src/example.ts', startLine: 1, endLine: 2 },
    ]);
    assert.ok(!JSON.stringify({ run, context: reader.context }).includes(token));
    assert.equal(
      reader.context.searches[0].matches[0].text,
      "const connection = '[secret redacted]';",
    );
    assert.equal(reader.sources[0].lines, 2);
  }
});

test('code retrieval respects scope, excludes unsafe paths and limits ranges and requests', async (t) => {
  const f = await fixture(t);
  const reader = new CodeReader(f.run, f.project, f.files);
  await reader.requests([{ action: 'search', query: 'PRIVATE_SENTINEL' }]);
  assert.deepEqual(reader.context.searches[0].matches, []);
  for (const path of ['src/.env', 'outside.ts', 'spec.md', '../outside.ts', 'src/missing.ts']) {
    await assert.rejects(
      reader.requests([{ action: 'read', path, startLine: 1, endLine: 1 }]),
      /scope|path|snapshot/,
    );
  }
  for (const [startLine, endLine] of [
    [0, 1],
    [2, 1],
    [1, brainConfig.codeRetrieval.maxLinesPerRead + 1],
    [500, 501],
  ]) {
    await assert.rejects(
      reader.requests([{ action: 'read', path: 'src/main.ts', startLine, endLine }]),
      /range|beyond/,
    );
  }
  await assert.rejects(
    reader.requests(
      Array.from({ length: brainConfig.codeRetrieval.maxRequestsPerRound + 1 }, () => ({
        action: 'search',
        query: 'a',
      })),
    ),
    /List/,
  );
  await assert.rejects(reader.requests([{ action: 'search', query: 'one\ntwo' }]), /literal line/);
});

test('submitted code replaces baseline search results, deletions stay absent and new files can be read', async (t) => {
  const f = await fixture(t);
  const submitted = validateSubmittedFiles(
    [
      { path: 'src/helper.ts', content: 'export const sanitize = () => "submitted";' },
      { path: 'src/main.ts', content: null },
      { path: 'src/new.ts', content: 'sanitize("new");' },
    ],
    f.project,
  );
  applySubmittedFiles(f.run, f.project, submitted);
  const reader = new CodeReader(f.run, f.project, f.files, submitted);
  await reader.requests([{ action: 'search', query: 'sanitize' }]);
  assert.deepEqual(
    reader.context.searches[0].matches.map((match) => match.path),
    ['src/helper.ts', 'src/new.ts'],
  );
  assert.doesNotMatch(JSON.stringify(reader.context.searches), /original/);
  await assert.rejects(
    reader.requests([{ action: 'read', path: 'src/main.ts', startLine: 1, endLine: 2 }]),
    /deleted/,
  );
  await reader.requests([{ action: 'read', path: 'src/new.ts', startLine: 1, endLine: 2 }]);
  assert.equal(reader.sources[0].revision, f.run.submission!.id);
  assert.equal(
    await f.git('status', '--porcelain'),
    '',
    'retrieval must never write to the checkout',
  );
});

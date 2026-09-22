import assert from 'node:assert/strict';
import test from 'node:test';
import { brainConfig } from './brain/config.js';
import { makeSource } from './brain/sources.js';
import {
  applySubmittedFiles,
  submissionInfo,
  validateSubmittedFiles,
} from './brain/analysis/submissions.js';
import type { AnalysisRun, Project } from './brain/analysis/types.js';

const project: Project = {
  id: 'dashboard',
  name: 'Dashboard',
  scope: 'Hooks',
  repoPath: '.',
  codePaths: ['hooks/'],
  specs: [{ kind: 'git', path: 'hooks/SPEC.md' }],
};

test('submitted code rejects unsafe paths, duplicates, binaries, excessive size and specification edits', () => {
  for (const path of [
    '../hooks/a.js',
    '/hooks/a.js',
    'hooks/../a.js',
    'hooks/.env',
    'hooks/credentials.json',
    'hooks/SPEC.md',
    'other/a.js',
    'hooks\\a.js',
  ]) {
    assert.throws(
      () => validateSubmittedFiles([{ path, content: 'x' }], project),
      /path|paths|scope/,
    );
  }
  for (const files of [
    [],
    [{ path: 'hooks/a.js', content: 42 }],
    [{ path: 'hooks/a.js', content: 'a\0b' }],
    [{ path: 'hooks/a.js', content: 'x'.repeat(brainConfig.submission.maxFileBytes + 1) }],
    [
      { path: 'hooks/a.js', content: 'x' },
      { path: 'hooks/a.js', content: null },
    ],
  ])
    assert.throws(() => validateSubmittedFiles(files, project));
});

test('snapshot limits count UTF-8 bytes before redaction and count deletions as files', () => {
  const original = { ...brainConfig.submission };
  Object.assign(brainConfig.submission, { maxFiles: 3, maxBytes: 8, maxFileBytes: 6 });
  try {
    const accepted = [
      { path: 'hooks/a.js', content: 'ééé' },
      { path: 'hooks/b.js', content: 'é' },
      { path: 'hooks/deleted.js', content: null },
    ];
    assert.equal(validateSubmittedFiles(accepted, project).length, 3);
    assert.throws(
      () => validateSubmittedFiles([{ path: 'hooks/a.js', content: 'éééé' }], project),
      /8 UTF-8 bytes.*6 bytes per file.*submission.maxFileBytes/,
    );
    assert.throws(
      () =>
        validateSubmittedFiles(
          [
            { path: 'hooks/a.js', content: 'ééé' },
            { path: 'hooks/b.js', content: 'éé' },
          ],
          project,
        ),
      /10 UTF-8 bytes.*8 bytes.*submission.maxBytes/,
    );
    assert.throws(
      () =>
        validateSubmittedFiles(
          [...accepted, { path: 'hooks/also-deleted.js', content: null }],
          project,
        ),
      /4 files.*3 files.*submission.maxFiles/,
    );
    assert.throws(
      () =>
        validateSubmittedFiles([{ path: 'hooks/a.js', content: `sk-${'a'.repeat(40)}` }], project),
      /43 UTF-8 bytes.*6 bytes per file/,
    );
  } finally {
    Object.assign(brainConfig.submission, original);
  }
});

test('an overlay preserves specifications and unchanged context while recording new files, deletions and masked content', () => {
  const baseline = 'a'.repeat(40);
  const specification = makeSource('code', 'hooks/SPEC.md', 'Approved rule', baseline);
  specification.status = 'published';
  const unchanged = makeSource('code', 'hooks/context.js', 'unchanged', baseline);
  const run = {
    commit: baseline,
    changedFiles: [],
    sources: [specification, unchanged, makeSource('code', 'hooks/removed.js', 'old', baseline)],
  } as unknown as AnalysisRun;
  const secret = 'sk-' + 'x'.repeat(30);
  const files = validateSubmittedFiles(
    [
      { path: 'hooks/removed.js', content: null },
      { path: 'hooks/new.js', content: `const test = '${secret}';` },
    ],
    project,
  );
  const reversed = validateSubmittedFiles([...files].reverse(), project);
  assert.deepEqual(submissionInfo(baseline, files), submissionInfo(baseline, reversed));
  applySubmittedFiles(run, project, files);
  assert.equal(
    run.sources.find((source) => source.path === 'hooks/SPEC.md'),
    specification,
  );
  assert.equal(
    run.sources.find((source) => source.path === 'hooks/context.js'),
    unchanged,
  );
  assert.equal(
    run.sources.some((source) => source.path === 'hooks/removed.js'),
    false,
  );
  const added = run.sources.find((source) => source.path === 'hooks/new.js')!;
  assert.match(added.content, /secret redacted/);
  assert.doesNotMatch(JSON.stringify(run), new RegExp(secret));
  assert.equal(added.origin?.properties.captureMode, 'agent-submitted');
  assert.equal(added.revision, run.submission?.id);
  assert.deepEqual(run.changedFiles, ['hooks/new.js', 'hooks/removed.js']);
  assert.equal(run.submission?.baselineCommit, baseline);
});

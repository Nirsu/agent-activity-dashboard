import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { captureChange } from './brain-submit.mjs';

const executeFile = promisify(execFile);
const brainConfig = createRequire(import.meta.url)('../server/src/brain/config.json');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'brain-submit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(directory, 'empty-gitconfig'),
    GIT_AUTHOR_NAME: 'Brain test',
    GIT_AUTHOR_EMAIL: 'brain@example.test',
    GIT_COMMITTER_NAME: 'Brain test',
    GIT_COMMITTER_EMAIL: 'brain@example.test',
    GIT_CONFIG_COUNT: '0',
  };
  const git = async (...args) =>
    (
      await executeFile('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args], {
        env,
        windowsHide: true,
      })
    ).stdout.trim();
  await git('init', '--template=');
  await git('config', 'core.autocrlf', 'false');
  await git('remote', 'add', 'origin', 'https://github.com/example/project.git');
  await writeFile(join(repo, '.gitignore'), 'ignored/\n');
  await writeFile(join(repo, 'README.md'), 'Approved baseline requirements.\n');
  for (const name of ['committed', 'staged', 'dirty', 'deleted', 'renamed', 'unchanged']) {
    await writeFile(join(repo, 'src', `${name}.txt`), `${name} baseline\n`);
  }
  await git('add', '.');
  await git('commit', '-m', 'Published baseline');
  const baselineCommit = await git('rev-parse', 'HEAD');
  const project = {
    id: 'example',
    codePaths: ['src/'],
    specificationPaths: ['README.md'],
    repositoryRemote: 'https://github.com/example/project',
  };
  const options = { repo, project, baselineCommit, feature: 'Review the current implementation' };
  return { directory, repo, git, options };
}

test('captures unpushed commits and final staged, dirty, untracked, deleted and renamed files', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'src/committed.txt'), 'Unpushed implementation\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'Local unpublished implementation');
  await writeFile(join(f.repo, 'src/staged.txt'), 'Staged intermediate\n');
  await f.git('add', 'src/staged.txt');
  await writeFile(join(f.repo, 'src/staged.txt'), 'Final after staging\n');
  await writeFile(join(f.repo, 'src/dirty.txt'), 'Unstaged implementation\n');
  await writeFile(join(f.repo, 'src/new.txt'), 'Untracked implementation\n');
  await rm(join(f.repo, 'src/deleted.txt'));
  await rename(join(f.repo, 'src/renamed.txt'), join(f.repo, 'src/new-name.txt'));
  const result = await captureChange(f.options);
  assert.deepEqual(result, {
    projectId: 'example',
    baselineCommit: f.options.baselineCommit,
    feature: f.options.feature,
    files: [
      { path: 'src/committed.txt', content: 'Unpushed implementation\n' },
      { path: 'src/deleted.txt', content: null },
      { path: 'src/dirty.txt', content: 'Unstaged implementation\n' },
      { path: 'src/new-name.txt', content: 'renamed baseline\n' },
      { path: 'src/new.txt', content: 'Untracked implementation\n' },
      { path: 'src/renamed.txt', content: null },
      { path: 'src/staged.txt', content: 'Final after staging\n' },
    ],
  });
});

test('all-code scope still excludes specifications, generated and sensitive paths with diagnostics', async (t) => {
  const f = await fixture(t);
  const warnings = [];
  await writeFile(join(f.repo, 'README.md'), 'Unapproved specification change\n');
  await writeFile(join(f.repo, '.env.local'), 'PRIVATE_SENTINEL');
  await mkdir(join(f.repo, 'dist'));
  await writeFile(join(f.repo, 'dist/output.js'), 'GENERATED_SENTINEL');
  await mkdir(join(f.repo, 'ignored'));
  await writeFile(join(f.repo, 'ignored/output.js'), 'IGNORED_SENTINEL');
  await writeFile(join(f.repo, 'root.ts'), 'export const answer = 42;\n');
  const options = {
    ...f.options,
    project: { ...f.options.project, codePaths: ['**'] },
    warn: (message) => warnings.push(message),
  };
  await assert.rejects(captureChange(options), /Changed files were excluded/);
  const result = await captureChange({ ...options, allowOutOfScope: true });
  assert.deepEqual(result.files, [{ path: 'root.ts', content: 'export const answer = 42;\n' }]);
  assert.ok(warnings.some((message) => message.includes('reference specification')));
  assert.ok(warnings.some((message) => message.includes('.env.local')));
  assert.ok(warnings.some((message) => message.includes('dist/output.js')));
  assert.ok(!JSON.stringify(result).includes('SENTINEL'));
});

test('out-of-scope changes are never silently dropped', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'root.ts'), 'Not in configured scope');
  await writeFile(join(f.repo, 'src/new.ts'), 'Within configured scope');
  const warnings = [];
  await assert.rejects(
    captureChange({ ...f.options, warn: (message) => warnings.push(message) }),
    /excluded/,
  );
  assert.match(warnings.join('\n'), /root\.ts.*outside the registered code scope/);
});

test('rejects binary, invalid UTF-8 and known embedded credentials before producing JSON', async (t) => {
  const f = await fixture(t);
  const path = join(f.repo, 'src/new.ts');
  await writeFile(path, Buffer.from([0, 1, 2]));
  await assert.rejects(captureChange(f.options), /Binary/);
  await writeFile(path, Buffer.from([0xff, 0xfe]));
  await assert.rejects(captureChange(f.options), /not UTF-8/);
  await writeFile(path, `const token = "${'ghp_'}${'A'.repeat(36)}";`);
  await assert.rejects(captureChange(f.options), /known credential pattern/);
});

test('rejects symbolic links without reading their targets', async (t) => {
  const f = await fixture(t);
  const target = join(f.directory, 'outside');
  await mkdir(target);
  await writeFile(join(target, 'private.txt'), 'OUTSIDE_SENTINEL');
  // Directory junctions work on Windows without developer-mode symlink privileges.
  await symlink(
    target,
    join(f.repo, 'src/link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(captureChange(f.options), /Symbolic links/);
});

test('requires fresh project scope, matching origin and an ancestral full baseline SHA', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'src/new.ts'), 'content');
  await assert.rejects(
    captureChange({ ...f.options, baselineCommit: 'HEAD' }),
    /explicit full baseline/,
  );
  await assert.rejects(
    captureChange({ ...f.options, project: { id: 'example', codePaths: ['**'] } }),
    /fresh brain_list_projects/,
  );
  await assert.rejects(
    captureChange({
      ...f.options,
      project: { ...f.options.project, repositoryRemote: 'https://github.com/other/project' },
    }),
    /origin does not match/,
  );
  await f.git('checkout', '--orphan', 'unrelated');
  await f.git('add', '.');
  await f.git('commit', '-m', 'Unrelated initial commit');
  await assert.rejects(captureChange(f.options), /ancestor/);
});

test('refuses incomplete working copies and empty submissions', async (t) => {
  const f = await fixture(t);
  await assert.rejects(captureChange(f.options), /No changed code files/);
  await f.git('update-index', '--assume-unchanged', 'src/dirty.txt');
  await writeFile(join(f.repo, 'src/dirty.txt'), 'Hidden change');
  await assert.rejects(captureChange(f.options), /assume-unchanged/);
});

test('CLI writes an exact MCP payload outside the repository and never starts an analysis', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'src/new.ts'), 'new implementation\n');
  const config = join(f.directory, 'project.json');
  await writeFile(config, JSON.stringify(f.options.project));
  const script = fileURLToPath(new URL('./brain-submit.mjs', import.meta.url));
  const args = [
    script,
    '--project-config',
    config,
    '--baseline',
    f.options.baselineCommit,
    '--feature',
    f.options.feature,
    '--repo',
    f.repo,
  ];
  const result = await executeFile(process.execPath, args);
  assert.deepEqual(JSON.parse(result.stdout), await captureChange(f.options));
  assert.equal(result.stderr, '');
  const output = join(f.directory, 'submission.json');
  const written = await executeFile(process.execPath, [...args, '--output', output]);
  assert.equal(written.stdout, '');
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), JSON.parse(result.stdout));
  await assert.rejects(
    executeFile(process.execPath, [...args, '--output', join(f.repo, 'payload.json')]),
    (error) => {
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /outside the repository/);
      return true;
    },
  );
});

test('captures more than 60 changed files and a complete snapshot larger than 500 KB', async (t) => {
  const f = await fixture(t);
  const content = 'Changed code context\n'.repeat(500);
  await Promise.all(
    Array.from({ length: 61 }, (_, index) =>
      writeFile(join(f.repo, 'src', `change-${index}.txt`), content),
    ),
  );
  const result = await captureChange(f.options);
  assert.equal(result.files.length, 61);
  assert.ok(
    result.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0) > 500_000,
  );
  assert.ok(result.files.every((file) => file.content === content));
});

test('counts deletions at the exact submission file limit and never truncates an oversized change', async (t) => {
  const f = await fixture(t);
  await Promise.all(
    Array.from({ length: brainConfig.submission.maxFiles - 1 }, (_, index) =>
      writeFile(join(f.repo, 'src', `change-${index}.txt`), ''),
    ),
  );
  await rm(join(f.repo, 'src/deleted.txt'));
  const result = await captureChange(f.options);
  assert.equal(result.files.length, brainConfig.submission.maxFiles);
  assert.deepEqual(
    result.files.find((file) => file.path === 'src/deleted.txt'),
    {
      path: 'src/deleted.txt',
      content: null,
    },
  );
  await writeFile(join(f.repo, 'src/one-too-many.txt'), '');
  await assert.rejects(
    captureChange(f.options),
    new RegExp(
      `contains ${brainConfig.submission.maxFiles + 1} files; the submission limit is ${brainConfig.submission.maxFiles} files`,
    ),
  );
});

function textWithUtf8Bytes(bytes) {
  return 'é'.repeat(Math.floor(bytes / 2)) + (bytes % 2 ? 'x' : '');
}

test('enforces the per-file limit in UTF-8 bytes and produces no partial CLI payload', async (t) => {
  const f = await fixture(t);
  const content = textWithUtf8Bytes(brainConfig.submission.maxFileBytes);
  const path = join(f.repo, 'src/large.txt');
  await writeFile(path, content);
  assert.equal((await captureChange(f.options)).files[0].content, content);
  await writeFile(path, `${content}é`);
  const expected = new RegExp(
    `contains ${brainConfig.submission.maxFileBytes + 2} UTF-8 bytes; the per-file limit is ${brainConfig.submission.maxFileBytes} bytes`,
  );
  await assert.rejects(captureChange(f.options), expected);

  const config = join(f.directory, 'project.json');
  await writeFile(config, JSON.stringify(f.options.project));
  await assert.rejects(
    executeFile(process.execPath, [
      fileURLToPath(new URL('./brain-submit.mjs', import.meta.url)),
      '--project-config',
      config,
      '--baseline',
      f.options.baselineCommit,
      '--feature',
      f.options.feature,
      '--repo',
      f.repo,
    ]),
    (error) => {
      assert.equal(error.stdout, '');
      assert.match(error.stderr, expected);
      assert.doesNotMatch(error.stderr, /Narrow|omit|truncate/);
      return true;
    },
  );
});

test('enforces the exact total UTF-8 byte limit without trimming files', async (t) => {
  const f = await fixture(t);
  let remaining = brainConfig.submission.maxBytes;
  let index = 0;
  while (remaining > 0) {
    const bytes = Math.min(remaining, brainConfig.submission.maxFileBytes);
    await writeFile(join(f.repo, 'src', `large-${index}.txt`), textWithUtf8Bytes(bytes));
    remaining -= bytes;
    index += 1;
  }
  const result = await captureChange(f.options);
  assert.equal(result.files.length, index);
  assert.equal(
    result.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    brainConfig.submission.maxBytes,
  );
  await writeFile(join(f.repo, 'src/overflow.txt'), 'x');
  await assert.rejects(
    captureChange(f.options),
    new RegExp(
      `at least ${brainConfig.submission.maxBytes + 1} UTF-8 bytes; the submission limit is ${brainConfig.submission.maxBytes} bytes`,
    ),
  );
});

test('the MCP envelope fits a full snapshot with worst-case JSON escaping', async (t) => {
  const f = await fixture(t);
  let remaining = brainConfig.submission.maxBytes;
  let index = 0;
  while (remaining > 0) {
    const bytes = Math.min(remaining, brainConfig.submission.maxFileBytes);
    await writeFile(join(f.repo, 'src', `escaped-${index}.txt`), '\u0001'.repeat(bytes));
    remaining -= bytes;
    index += 1;
  }
  const payload = await captureChange(f.options);
  const requestBytes = Buffer.byteLength(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'brain_submit_change', arguments: payload },
    }),
  );
  assert.equal(payload.files.length, index);
  assert.equal(
    payload.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    brainConfig.submission.maxBytes,
  );
  assert.ok(requestBytes > brainConfig.submission.maxBytes * 6);
  assert.ok(requestBytes <= brainConfig.mcp.maxRequestBytes);
});

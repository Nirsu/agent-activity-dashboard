import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { configureProjects } from './projects.mjs';
import { readPolicy, repositoryAt } from './project-policy.mjs';
import { ProjectFilter } from './relay.mjs';
import { setup } from './setup.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'harmonie-workspace-projects-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'workspace');
  const secondWorkspace = join(directory, 'second-workspace');
  const selected = join(workspace, 'selected');
  const other = join(workspace, 'other');
  for (const path of [selected, other, secondWorkspace]) {
    await mkdir(path, { recursive: true });
  }
  for (const path of [selected, other]) {
    execFileSync('git', ['init', '--quiet'], { cwd: path, windowsHide: true });
  }
  const configPath = join(directory, 'telemetry.json');
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      dashboardUrl: 'https://dashboard.example.test',
      relayPort: 14318,
      projects: [repositoryAt(selected).path],
    }),
  );
  return { directory, workspace, secondWorkspace, selected, other, configPath };
}

function linkedWorktree(f) {
  const options = { cwd: f.selected, windowsHide: true };
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], options);
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'Fixture',
    ],
    options,
  );
  const worktree = join(f.directory, 'feature-checkout');
  execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'feature/AAD-42', worktree], options);
  return worktree;
}

test('workspace CLI binds canonical paths, lists them, replaces the target and unbinds', async (t) => {
  const f = await fixture(t);
  const script = fileURLToPath(new URL('./projects.mjs', import.meta.url));
  function run(...args) {
    const result = spawnSync(process.execPath, [script, '--config', f.configPath, ...args], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  const bindings = [
    { workspace: await realpath(f.workspace), repository: repositoryAt(f.selected).path },
  ];
  assert.deepEqual(
    run('--bind-workspace', join(f.workspace, '.'), '--repository', f.selected).workspaceBindings,
    bindings,
  );
  const before = await readFile(f.configPath, 'utf8');
  assert.deepEqual(run('--list').workspaceBindings, bindings);
  run('--bind-workspace', f.workspace, '--repository', f.selected);
  assert.equal(await readFile(f.configPath, 'utf8'), before, 'same binding is repeatable');
  const replaced = run(
    '--allow',
    f.other,
    '--bind-workspace',
    f.workspace,
    '--repository',
    f.other,
  );
  assert.deepEqual(replaced.workspaceBindings, [
    { workspace: await realpath(f.workspace), repository: repositoryAt(f.other).path },
  ]);
  assert.deepEqual(run('--unbind-workspace', f.workspace).workspaceBindings ?? [], []);
});

test('invalid workspace bindings leave the private configuration unchanged', async (t) => {
  const f = await fixture(t);
  const file = join(f.directory, 'plain-file');
  await writeFile(file, 'fixture');
  const before = await readFile(f.configPath, 'utf8');
  for (const [options, message] of [
    [{ bindWorkspace: f.workspace }, /together/],
    [{ repository: f.selected }, /together/],
    [{ bindWorkspace: f.workspace, repository: f.other }, /selected Git repository/],
    [{ bindWorkspace: f.workspace, repository: f.directory }, /selected Git repository/],
    [{ bindWorkspace: f.selected, repository: f.selected }, /outside a Git repository/],
    [{ bindWorkspace: join(f.directory, 'missing'), repository: f.selected }, /existing directory/],
    [{ bindWorkspace: file, repository: f.selected }, /existing directory/],
  ]) {
    await assert.rejects(configureProjects({ configPath: f.configPath, ...options }), message);
    assert.equal(await readFile(f.configPath, 'utf8'), before);
  }
});

test('workspace bindings preserve the explicitly selected worktree and its activity branch', async (t) => {
  const f = await fixture(t);
  const worktree = linkedWorktree(f);
  const result = await configureProjects({
    configPath: f.configPath,
    allow: [worktree],
    bindWorkspace: f.workspace,
    repository: worktree,
  });
  const canonicalWorktree = repositoryAt(worktree).path;
  assert.deepEqual(result.projects, [repositoryAt(f.selected).path, canonicalWorktree]);
  assert.deepEqual(result.workspaceBindings, [
    { workspace: await realpath(f.workspace), repository: canonicalWorktree },
  ]);
  const filter = new ProjectFilter();
  const activity = filter.activity(
    {
      provider: 'codex',
      session_id: 'worktree-session',
      event: 'SessionStart',
      cwd: f.workspace,
    },
    readPolicy(f.configPath),
  );
  assert.equal(activity.branch, 'feature/AAD-42');
  assert.equal(activity.repo, basename(worktree));
  assert.equal(activity.cwd, f.workspace);
  assert.equal(filter.sessions.get('codex:worktree-session').project, canonicalWorktree);
});

test('workspace bindings reject an unselected checkout instead of substituting its selected main repository', async (t) => {
  const f = await fixture(t);
  const worktree = linkedWorktree(f);
  const before = await readFile(f.configPath, 'utf8');
  await assert.rejects(
    configureProjects({
      configPath: f.configPath,
      bindWorkspace: f.workspace,
      repository: worktree,
    }),
    /Use --allow to select this exact checkout first/,
  );
  assert.equal(await readFile(f.configPath, 'utf8'), before);
});

test('bindings can be removed after folder deletion and are removed with their target', async (t) => {
  const f = await fixture(t);
  await configureProjects({
    configPath: f.configPath,
    bindWorkspace: f.workspace,
    repository: f.selected,
  });
  await configureProjects({
    configPath: f.configPath,
    bindWorkspace: f.secondWorkspace,
    repository: f.selected,
  });
  await rm(f.secondWorkspace, { recursive: true });
  const remaining = await configureProjects({
    configPath: f.configPath,
    unbindWorkspace: [f.secondWorkspace],
  });
  assert.equal(remaining.workspaceBindings.length, 1);
  assert.equal(remaining.workspaceBindings[0].workspace, await realpath(f.workspace));
  const removed = await configureProjects({ configPath: f.configPath, remove: [f.selected] });
  assert.deepEqual(removed.projects, []);
  assert.deepEqual(removed.workspaceBindings ?? [], []);
});

test('setup preserves explicit workspace bindings when updating an installed bridge', async (t) => {
  const f = await fixture(t);
  const home = join(f.directory, 'home');
  const options = {
    home,
    codexHome: join(home, '.codex'),
    claudeHome: join(home, '.claude'),
    nodePath: process.execPath,
    projects: [f.selected],
    apply: true,
  };
  await setup(options);
  const configPath = join(home, '.config', 'harmonie-agents', 'telemetry.json');
  const bound = await configureProjects({
    configPath,
    bindWorkspace: f.workspace,
    repository: f.selected,
  });
  await setup({ ...options, url: 'https://updated.example.test' });
  const updated = readPolicy(configPath);
  assert.equal(updated.dashboardUrl, 'https://updated.example.test');
  assert.deepEqual(updated.workspaceBindings, bound.workspaceBindings);
});

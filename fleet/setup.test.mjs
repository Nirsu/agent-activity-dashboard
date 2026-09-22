import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { setup, validateUrl, codexTelemetry } from './setup.mjs';

test('setup always configures workstation tokens for both clients and updates Brain entries idempotently', async (t) => {
  const paths = await fixture(t);
  await setup({ ...paths, apply: true });
  assert.match(
    await readFile(join(paths.codexHome, 'config.toml'), 'utf8'),
    /bearer_token_env_var = "HARMONIE_TOKEN"/,
  );
  await setup({ ...paths, url: 'https://agents.example.test', apply: true });
  const codex = await readFile(join(paths.codexHome, 'config.toml'), 'utf8');
  assert.match(codex, /bearer_token_env_var = "HARMONIE_TOKEN"/);
  assert.match(codex, /https:\/\/agents.example.test\/api\/brain\/mcp/);
  const claudePath = join(paths.home, '.claude.json');
  const claude = JSON.parse(await readFile(claudePath, 'utf8'));
  assert.deepEqual(claude.mcpServers['harmony-brain'], {
    type: 'http',
    url: 'https://agents.example.test/api/brain/mcp',
    headers: { Authorization: 'Bearer ${HARMONIE_TOKEN}' },
  });
  const rerun = await setup({
    ...paths,
    url: 'https://agents.example.test',
    apply: true,
  });
  assert.equal(rerun.changedFiles.length, 0);
});

test('setup replaces an existing Brain credential reference without duplicating TOML keys', async (t) => {
  const paths = await fixture(t);
  await writeFile(
    join(paths.codexHome, 'config.toml'),
    '[mcp_servers.harmony-brain]\nenabled = true\nurl = "https://old.example.test/api/brain/mcp"\nbearer_token_env_var = "OBSOLETE_AGENT_CREDENTIAL"',
  );
  await writeFile(
    join(paths.home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        'harmony-brain': {
          type: 'http',
          url: 'https://old.example.test/api/brain/mcp',
          headers: { Authorization: 'obsolete-value' },
        },
        other: { type: 'http', url: 'https://other.example.test' },
      },
    }),
  );
  await setup({ ...paths, apply: true });
  const codex = await readFile(join(paths.codexHome, 'config.toml'), 'utf8');
  assert.equal(codex.match(/^url = /gm).length, 1);
  assert.equal(codex.match(/^bearer_token_env_var = /gm).length, 1);
  assert.match(codex, /enabled = true/);
  assert.doesNotMatch(codex, /OBSOLETE_AGENT_CREDENTIAL|old.example.test/);
  const claude = JSON.parse(await readFile(join(paths.home, '.claude.json'), 'utf8'));
  assert.equal(
    claude.mcpServers['harmony-brain'].headers.Authorization,
    'Bearer ${HARMONIE_TOKEN}',
  );
  assert.equal(claude.mcpServers.other.url, 'https://other.example.test');
  assert.deepEqual((await setup({ ...paths, apply: true })).changedFiles, []);
});

test('installed bridges preserve parent and child identities without forwarding content', async (t) => {
  const paths = await fixture(t);
  await setup({ ...paths, apply: true });
  for (const provider of ['codex', 'claude']) {
    const wrapper = join(paths.home, '.config', 'harmonie-agents', `${provider}-hook.mjs`);
    for (const name of ['SubagentStart', 'SubagentStop']) {
      const result = spawnSync(process.execPath, [wrapper], {
        encoding: 'utf8',
        env: { ...process.env, AAD_DRY_RUN: '1' },
        input: JSON.stringify({
          hook_event_name: name,
          session_id: 'root',
          agent_id: 'child',
          agent_type: 'explorer',
          prompt: 'SECRET',
          tool_input: { command: 'SECRET' },
          last_assistant_message: 'SECRET',
          transcript_path: 'SECRET',
        }),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /SECRET/);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.parent_session_id, 'root');
      assert.equal(payload.session_id, provider === 'codex' ? 'child' : 'root/agent:child');
      assert.equal(payload.session_role, 'subagent');
      assert.equal(payload.event, name === 'SubagentStart' ? 'subagent_start' : 'subagent_stop');
    }
    const settingsPath =
      provider === 'codex'
        ? join(paths.codexHome, 'hooks.json')
        : join(paths.claudeHome, 'settings.json');
    const config = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.equal(config.hooks.SubagentStart.length, 1);
    assert.equal(config.hooks.SubagentStop.length, 1);
  }
});

test('installs Codex Interrupt only and translates cancellation to stop', async (t) => {
  const paths = await fixture(t);
  await setup({ ...paths, apply: true });
  const codex = JSON.parse(await readFile(join(paths.codexHome, 'hooks.json'), 'utf8'));
  const claude = JSON.parse(await readFile(join(paths.claudeHome, 'settings.json'), 'utf8'));
  assert.equal(codex.hooks.Interrupt.length, 1);
  assert.equal(claude.hooks.Interrupt, undefined);
  const result = spawnSync(
    process.execPath,
    [join(paths.home, '.config', 'harmonie-agents', 'codex-hook.mjs')],
    {
      encoding: 'utf8',
      env: { ...process.env, AAD_DRY_RUN: '1' },
      input: JSON.stringify({
        hook_event_name: 'Interrupt',
        session_id: 'cancelled',
        turn_id: 'turn',
        cwd: paths.home,
      }),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).event, 'stop');
  assert.deepEqual((await setup({ ...paths, apply: true })).changedFiles, []);
});

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'harmonie setup '));
  t.after(() => rm(home, { recursive: true, force: true }));
  const codexHome = join(home, '.codex');
  const claudeHome = join(home, '.claude');
  await mkdir(codexHome);
  await mkdir(claudeHome);
  return { home, codexHome, claudeHome, nodePath: process.execPath, platform: process.platform };
}

test('setup preserves existing hooks, credentials and comments, backs up and is idempotent', async (t) => {
  const paths = await fixture(t);
  const original = '# Keep this comment\nmodel = "existing-model"\n';
  await writeFile(join(paths.codexHome, 'config.toml'), original);
  const sharedHandler = { type: 'command', command: 'echo existing' };
  const otherWrapper = { type: 'command', command: 'node /another/codex-hook.mjs' };
  await writeFile(
    join(paths.codexHome, 'hooks.json'),
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [sharedHandler, otherWrapper] }] },
    }),
  );
  await writeFile(
    join(paths.claudeHome, 'settings.json'),
    JSON.stringify({
      permissions: { deny: ['Read(.env)'] },
      env: { KEEP_ME: 'yes' },
      hooks: { Stop: [{ hooks: [sharedHandler] }] },
    }),
  );
  await writeFile(
    join(paths.home, '.claude.json'),
    JSON.stringify({
      existingPreference: true,
      mcpServers: { other: { type: 'http', url: 'https://example.test' } },
    }),
  );
  const preview = await setup(paths);
  assert.equal(preview.applied, false);
  assert.equal(await readFile(join(paths.codexHome, 'config.toml'), 'utf8'), original);
  const result = await setup({ ...paths, apply: true });
  assert.ok(result.backups.length >= 4);
  assert.ok((await readFile(join(paths.codexHome, 'config.toml'), 'utf8')).startsWith(original));
  const hooks = JSON.parse(await readFile(join(paths.codexHome, 'hooks.json'), 'utf8')).hooks;
  assert.deepEqual(hooks.PreToolUse[0].hooks, [sharedHandler, otherWrapper]);
  assert.equal(hooks.PreToolUse.length, 2);
  const settings = JSON.parse(await readFile(join(paths.claudeHome, 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions.deny, ['Read(.env)']);
  assert.equal(settings.env.KEEP_ME, 'yes');
  assert.equal(settings.env.OTEL_LOG_USER_PROMPTS, '0');
  assert.equal(settings.env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json');
  assert.equal(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:14318');
  assert.equal(settings.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, 'http://127.0.0.1:14318/v1/logs');
  assert.match(
    await readFile(join(paths.codexHome, 'config.toml'), 'utf8'),
    /127\.0\.0\.1:14318\/v1\/logs/,
  );
  assert.deepEqual(
    result.projects,
    [],
    'new installations send nothing until a repository is selected',
  );
  assert.equal(result.relayUrl, 'http://127.0.0.1:14318');
  const wrapper = await readFile(
    join(paths.home, '.config', 'harmonie-agents', 'codex-hook.mjs'),
    'utf8',
  );
  assert.match(wrapper, /process.env.AAD_URL = "http:\/\/127.0.0.1:14318"/);
  assert.equal(settings.hooks.Stop.length, 2);
  const config = JSON.parse(await readFile(join(paths.home, '.claude.json'), 'utf8'));
  assert.equal(config.existingPreference, true);
  assert.equal(config.mcpServers.other.url, 'https://example.test');
  assert.equal(config.mcpServers['harmony-brain'].url, 'http://127.0.0.1:4318/api/brain/mcp');
  assert.deepEqual((await setup({ ...paths, apply: true })).changedFiles, []);
  const clientFormatted = JSON.stringify(config);
  await writeFile(join(paths.home, '.claude.json'), clientFormatted);
  assert.deepEqual((await setup({ ...paths, apply: true })).changedFiles, []);
  assert.equal(await readFile(join(paths.home, '.claude.json'), 'utf8'), clientFormatted);
});

test('malformed settings and unmanaged OTel cause no writes', async (t) => {
  const paths = await fixture(t);
  const file = join(paths.claudeHome, 'settings.json');
  await writeFile(file, '{broken');
  await assert.rejects(setup({ ...paths, apply: true }), /Invalid JSON/);
  await assert.rejects(readFile(join(paths.codexHome, 'hooks.json')), { code: 'ENOENT' });
  await writeFile(file, '{}');
  await writeFile(join(paths.codexHome, 'config.toml'), '[otel]\nexporter = "none"\n');
  await assert.rejects(setup({ ...paths, apply: true }), /unmanaged OTel/);
  await assert.rejects(readFile(join(paths.codexHome, 'hooks.json')), { code: 'ENOENT' });
});

test('managed OTel can change collector without moving unrelated config or duplicating tables', () => {
  const original = '# before\nmodel = "example"\n';
  const first =
    codexTelemetry(original, 'http://localhost:4318') + '\n# after\n[another]\nflag = true\n';
  const second = codexTelemetry(first, 'https://agents.example.test');
  assert.ok(second.startsWith(original));
  assert.ok(second.endsWith('\n# after\n[another]\nflag = true\n'));
  assert.equal(second.match(/^\[otel\]/gm).length, 1);
  assert.doesNotMatch(second, /exporter = "otlp-http"/);
  assert.match(second, /https:\/\/agents.example.test\/v1\/logs/);
  assert.equal(codexTelemetry(second, 'https://agents.example.test'), second);
});

test('setup validates destinations and Windows commands quote absolute paths with spaces', async (t) => {
  for (const url of [
    'http://remote.example',
    'https://user:secret@example.test',
    'https://example.test/path',
    'https://example.test/?secret=1',
  ]) {
    assert.throws(() => validateUrl(url));
  }
  assert.equal(validateUrl('https://agents.example.test/'), 'https://agents.example.test');
  const paths = await fixture(t);
  await setup({
    ...paths,
    platform: 'win32',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    apply: true,
  });
  const hooks = JSON.parse(await readFile(join(paths.codexHome, 'hooks.json'), 'utf8')).hooks;
  assert.match(
    hooks.Stop[0].hooks[0].command,
    /^& "C:\/Program Files\/nodejs\/node.exe" ".*codex-hook.mjs"$/,
  );
  const claude = JSON.parse(await readFile(join(paths.claudeHome, 'settings.json'), 'utf8'));
  assert.match(
    claude.hooks.Stop[0].hooks[0].command,
    /^"C:\/Program Files\/nodejs\/node.exe" ".*claude-hook.mjs"$/,
  );
});

test(
  'Windows Codex hooks execute through PowerShell with spaced paths',
  {
    skip: process.platform !== 'win32',
  },
  async (t) => {
    const paths = await fixture(t);
    await setup({ ...paths, clients: ['codex'], apply: true });
    const settings = JSON.parse(await readFile(join(paths.codexHome, 'hooks.json'), 'utf8'));
    const command = settings.hooks.SessionStart[0].hooks[0].command;
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      env: { ...process.env, AAD_DRY_RUN: '1' },
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'powershell-session',
        cwd: paths.home,
        prompt: 'SECRET',
      }),
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /SECRET/);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.provider, 'codex');
    assert.equal(payload.event, 'session_start');
    assert.equal(payload.session_id, 'powershell-session');
    assert.equal(payload.cwd, paths.home);
  },
);

test('setup opts in selected repositories, keeps them on rerun and rejects invalid selections before writing', async (t) => {
  const paths = await fixture(t);
  const project = join(paths.home, 'project');
  await mkdir(project);
  execFileSync('git', ['init', '--quiet'], { cwd: project });
  const result = await setup({
    ...paths,
    projects: [project],
    url: 'https://dashboard.example.test',
    relayPort: 14319,
    apply: true,
  });
  assert.equal(result.projects.length, 1);
  assert.equal(result.relayUrl, 'http://127.0.0.1:14319');
  assert.deepEqual((await setup({ ...paths, apply: true })).changedFiles, []);
  const before = await readFile(result.policyPath, 'utf8');
  await assert.rejects(
    setup({ ...paths, projects: [join(paths.home, 'absent')], apply: true }),
    /Git repository/,
  );
  assert.equal(await readFile(result.policyPath, 'utf8'), before);
  await assert.rejects(
    setup({ ...paths, url: 'http://127.0.0.1:14319', apply: true }),
    /different ports/,
  );
});

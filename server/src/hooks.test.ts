import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(here, '../../hooks/hook.js');

for (const toolName of ['Bash', 'exec_command', 'write_stdin', 'shell_command']) {
  for (const hookEvent of ['PreToolUse', 'PostToolUse']) {
    test(`Codex ${hookEvent} for ${toolName} emits only a safe terminal summary`, () => {
      const privateCommand = 'deploy --token super-secret';
      const result = spawnSync(process.execPath, [hookPath], {
        cwd: resolve(here, '../..'),
        encoding: 'utf8',
        env: {
          ...process.env,
          AAD_PROVIDER: 'codex',
          AAD_CLIENT: 'cli',
          AAD_DRY_RUN: '1',
          AAD_USER: '',
        },
        input: JSON.stringify({
          hook_event_name: hookEvent,
          session_id: 'codex-session',
          cwd: resolve(here, '../..'),
          tool_name: toolName,
          command: privateCommand,
          tool_input: { command: privateCommand, arguments: ['private argument'] },
          tool_output: 'private output',
          tool_response: { stdout: 'private stdout', stderr: 'private stderr' },
          prompt: 'private prompt',
        }),
      });

      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.event, hookEvent === 'PreToolUse' ? 'pre_tool' : 'post_tool');
      assert.equal(payload.provider, 'codex');
      assert.equal(payload.client, 'cli');
      assert.equal(payload.tool_name, 'Terminal command');
      assert.equal(payload.user, undefined);
      for (const field of ['command', 'tool_input', 'tool_output', 'tool_response', 'prompt']) {
        assert.equal(Object.hasOwn(payload, field), false, field);
      }
      assert.doesNotMatch(result.stdout, /super-secret|private |deploy --token/);
      assert.equal(result.stderr, '');
    });
  }
}

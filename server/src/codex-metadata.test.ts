import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openCodexMetadata } from './codex-metadata.js';
import type { AgentEvent } from './types.js';

test('local Codex adapter selects only structural metadata, distinguishes guardian and preserves explicit telemetry', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'aad-codex-metadata-'));
  const path = join(directory, 'state.sqlite');
  const db = new Database(path);
  db.exec(
    'CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, cwd TEXT, git_branch TEXT, preview TEXT)',
  );
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)');
  insert.run('root', 'vscode', '/dev/project', 'feature', 'PRIVATE PROMPT');
  insert.run(
    'check',
    '{"subagent":{"other":"guardian"}}',
    '/dev/project',
    'feature',
    'PRIVATE PROMPT',
  );
  insert.run(
    'child',
    '{"subagent":{"thread_spawn":{"parent_thread_id":"root","agent_role":"explorer"}}}',
    '/dev/project',
    'feature',
    'PRIVATE PROMPT',
  );
  db.close();
  const reader = openCodexMetadata(path);
  t.after(() => {
    reader.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(reader.available, true);
  const event = (sessionId: string): AgentEvent => ({
    id: sessionId,
    ts: Date.now(),
    kind: 'api_request',
    provider: 'codex',
    sessionId,
    sessionRole: 'unknown',
  });
  const root = reader.enrich(event('root'));
  assert.equal(root.sessionRole, 'main');
  assert.equal(root.repo, 'project');
  assert.doesNotMatch(JSON.stringify(root), /PRIVATE/);
  assert.equal(reader.enrich(event('check')).sessionRole, 'internal');
  assert.equal(reader.enrich(event('child')).parentSessionId, 'root');
  assert.equal(
    reader.enrich({ ...event('root'), sessionRole: 'subagent', parentSessionId: 'explicit' })
      .parentSessionId,
    'explicit',
  );
  assert.equal(reader.enrich({ ...event('root'), provider: 'claude' }).sessionRole, 'unknown');
  assert.equal(reader.enrich(event('missing')).sessionRole, 'unknown');
  const disabled = openCodexMetadata(join(directory, 'missing.sqlite'));
  assert.equal(disabled.available, false);
  const unchanged = event('root');
  assert.deepEqual(disabled.enrich(unchanged), unchanged);
});

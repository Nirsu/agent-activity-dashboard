import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import type { SessionState } from './types.js';

test('late ticket resolution preserves changed account memberships and renamed teams', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'team-live-update-'));
  Object.assign(process.env, {
    DATA_DIR: directory,
    DB_PATH: resolve(directory, 'history.db'),
    HISTORY_BACKEND: 'sqlite',
    DATABASE_URL: '',
    BRAIN_DB_PATH: resolve(directory, 'brain.db'),
    BRAIN_PROJECTS_PATH: resolve(directory, 'projects.json'),
    BRAIN_SYNC_ENABLED: '0',
    VIEWER_TOKEN: '',
    COST_LEDGER: '0',
    CODEX_METADATA_DB: '',
    BRAIN_ADMIN_TOKEN: 'team-live-test-admin',
    JIRA_BASE_URL: 'https://jira.example.test',
    JIRA_EMAIL: 'fixture@example.test',
    JIRA_API_TOKEN: 'fixture-token',
    LOG_LEVEL: 'silent',
  });
  await writeFile(process.env.BRAIN_PROJECTS_PATH!, '[]');
  const originalFetch = globalThis.fetch;
  let finishTicket!: (response: Response) => void;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://jira.example.test/rest/api/3/issue/TEAM-1?fields=summary');
    return new Promise<Response>((resolveResponse) => {
      finishTicket = resolveResponse;
    });
  };
  const { buildApp } = await import('./index.js');
  const app = await buildApp();
  const headers = { 'x-brain-admin-token': 'team-live-test-admin' };
  const post = async (url: string, payload: Record<string, unknown>) => {
    const response = await app.inject({ method: 'POST', url, headers, payload });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const currentSession = async (): Promise<SessionState> => {
    const response = await app.inject('/api/state');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().sessions.length, 1);
    return response.json().sessions[0];
  };
  try {
    const previous = await post('/api/brain/access/teams', { name: 'Previous team' });
    const next = await post('/api/brain/access/teams', { name: 'Next team' });
    const input = {
      name: 'Developer',
      email: 'developer@example.test',
      teamIds: [previous.id],
      enabled: true,
    };
    const account = await post('/api/brain/access/accounts', input);
    const issued = await post('/api/brain/access/tokens', {
      accountId: account.id,
      label: 'Workstation',
    });
    const activity = await app.inject({
      method: 'POST',
      url: '/activity',
      headers: { authorization: `Bearer ${issued.secret}` },
      payload: {
        event: 'prompt_submit',
        provider: 'codex',
        session_id: 'active-task',
        ticket: 'TEAM-1',
      },
    });
    assert.equal(activity.statusCode, 200, activity.body);
    assert.ok(finishTicket, 'the ticket request is still pending');
    const update = await app.inject({
      method: 'PUT',
      url: `/api/brain/access/accounts/${account.id}`,
      headers,
      payload: { ...input, teamIds: [next.id] },
    });
    assert.equal(update.statusCode, 200, update.body);
    const rename = await app.inject({
      method: 'PUT',
      url: `/api/brain/access/teams/${next.id}`,
      headers,
      payload: { name: 'Current team' },
    });
    assert.equal(rename.statusCode, 200, rename.body);
    const expected = [{ id: next.id, name: 'Current team' }];
    assert.deepEqual((await currentSession()).teams, expected);
    finishTicket(new Response(JSON.stringify({ fields: { summary: 'Resolved ticket' } })));
    let session = await currentSession();
    for (let attempt = 0; attempt < 20 && session.ticketTitle !== 'Resolved ticket'; attempt++) {
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      session = await currentSession();
    }
    assert.equal(session.ticketTitle, 'Resolved ticket', 'the delayed callback has run');
    assert.deepEqual(session.teams, expected);
    assert.equal(session.teamId, 'Current team');
  } finally {
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

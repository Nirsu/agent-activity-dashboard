#!/usr/bin/env node

const baseUrl = (process.env.AAD_URL ?? 'http://127.0.0.1:18418').replace(/\/$/, '');
const token = process.env.HARMONIE_TOKEN;
if (!token) {
  throw new Error('Set HARMONIE_TOKEN to a workstation token issued in Accounts.');
}
const destination = new URL(baseUrl);
if (
  destination.username ||
  destination.password ||
  destination.search ||
  destination.hash ||
  destination.pathname !== '/' ||
  !(
    destination.protocol === 'https:' ||
    (destination.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname))
  )
) {
  throw new Error('AAD_URL must be an HTTPS origin or HTTP on localhost, without URL credentials.');
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    redirect: 'error',
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  }
}

const sessions = [
  {
    event: 'session_start',
    session_id: 'demo-codex',
    session_role: 'main',
    provider: 'codex',
    client: 'vscode',
    user: 'demo-codex-user',
    team_id: 'mobile',
    repo: 'ios-app',
    branch: 'feature/ABC-512-docker',
    ticket: 'ABC-512',
    cwd: '/workspace/ios-app',
  },
  {
    event: 'prompt_submit',
    session_id: 'demo-codex',
    provider: 'codex',
    client: 'vscode',
    team_id: 'mobile',
    repo: 'ios-app',
    branch: 'feature/ABC-512-docker',
    ticket: 'ABC-512',
  },
  {
    event: 'pre_tool',
    session_id: 'demo-codex',
    provider: 'codex',
    client: 'vscode',
    team_id: 'mobile',
    repo: 'ios-app',
    branch: 'feature/ABC-512-docker',
    ticket: 'ABC-512',
    tool_name: 'File edit',
  },
  {
    event: 'session_start',
    session_id: 'demo-claude',
    session_role: 'main',
    provider: 'claude',
    client: 'cli',
    user: 'demo-claude-user',
    team_id: 'platform',
    repo: 'api',
    branch: 'feature/ABC-513-telemetry',
    ticket: 'ABC-513',
    cwd: '/workspace/api',
  },
  {
    event: 'prompt_submit',
    session_id: 'demo-claude',
    provider: 'claude',
    client: 'cli',
    team_id: 'platform',
    repo: 'api',
    branch: 'feature/ABC-513-telemetry',
    ticket: 'ABC-513',
  },
];

for (const event of sessions) await post('/activity', event);

await post('/v1/logs', {
  resourceLogs: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'codex_vscode' } },
          { key: 'team.id', value: { stringValue: 'mobile' } },
        ],
      },
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: String(Date.now() * 1_000_000),
              attributes: [
                { key: 'event.name', value: { stringValue: 'codex.api_request' } },
                { key: 'conversation.id', value: { stringValue: 'demo-codex' } },
                { key: 'model', value: { stringValue: 'gpt-demo' } },
                { key: 'success', value: { boolValue: true } },
                { key: 'input_token_count', value: { intValue: '240' } },
                { key: 'output_token_count', value: { intValue: '60' } },
                { key: 'duration_ms', value: { intValue: '880' } },
              ],
            },
          ],
        },
      ],
    },
  ],
});

console.log(`Seeded Claude and Codex demo sessions at ${baseUrl}`);

#!/usr/bin/env node
// Claude Code / Codex hook -> Agent Activity Dashboard bridge.
//
// Reads the hook JSON on stdin, adds local git context (repo/branch/ticket),
// and POSTs a lifecycle event to the local project-filtering relay.
//
// NEVER forwards prompt or tool content — only structural context. This script
// must never block a tool call: it swallows all errors and always exits 0.
//
// Install: see hooks/README.md. The subtype is derived from the hook event name
// (or an optional argv[2] override).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DASHBOARD_URL = process.env.AAD_URL ?? 'http://127.0.0.1:14318';
const TIMEOUT_MS = 1200;

const SUBTYPE_BY_EVENT = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'prompt_submit',
  PreToolUse: 'pre_tool',
  PostToolUse: 'post_tool',
  Stop: 'stop',
  SessionEnd: 'session_end',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Interrupt: 'stop',
};

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function parseResourceAttrs() {
  const raw = process.env.OTEL_RESOURCE_ATTRIBUTES ?? '';
  const out = {};
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=');
    if (k && v) out[k.trim()] = v.trim();
  }
  return out;
}

function ticketFromBranch(branch) {
  const m = branch && branch.match(/[A-Z][A-Z0-9]+-\d+/);
  return m ? m[0] : undefined;
}

function clientName(provider) {
  const configured = process.env.AAD_CLIENT;
  if (configured === 'cli' || configured === 'desktop' || configured === 'vscode')
    return configured;
  const terminal = (process.env.TERM_PROGRAM ?? '').toLowerCase();
  if (terminal.includes('vscode')) return 'vscode';
  return provider === 'codex' ? 'unknown' : 'cli';
}

// Tool arguments can contain source, prompts, secrets, and shell commands.
// Reduce the tool identifier itself to a safe activity summary.
function safeToolSummary(toolName) {
  if (!toolName || typeof toolName !== 'string') return undefined;
  if (
    toolName === 'Bash' ||
    toolName === 'exec_command' ||
    toolName === 'shell_command' ||
    toolName === 'write_stdin'
  ) {
    return 'Terminal command';
  }
  if (toolName === 'apply_patch' || toolName === 'Edit' || toolName === 'Write') {
    return 'File edit';
  }
  if (toolName.startsWith('mcp__')) {
    const integration = toolName
      .split('__')[1]
      ?.replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 32);
    return integration ? `Integration: ${integration}` : 'Integration';
  }
  return toolName.replace(/[^a-zA-Z0-9 _.-]/g, '').slice(0, 64) || 'Tool';
}

async function main() {
  const input = readInput();
  const subtype = process.argv[2] || SUBTYPE_BY_EVENT[input.hook_event_name];
  if (!subtype || !input.session_id) process.exit(0);

  const cwd = input.cwd || process.cwd();
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || undefined;
  const topLevel = git(cwd, ['rev-parse', '--show-toplevel']);
  const repo = topLevel ? topLevel.split('/').pop() : undefined;
  const attrs = parseResourceAttrs();
  const provider = process.env.AAD_PROVIDER === 'codex' ? 'codex' : 'claude';
  const childId =
    typeof input.agent_id === 'string' && /^[a-zA-Z0-9_.-]{1,160}$/.test(input.agent_id)
      ? input.agent_id
      : undefined;
  const isChildLifecycle =
    input.hook_event_name === 'SubagentStart' || input.hook_event_name === 'SubagentStop';
  if (isChildLifecycle && !childId) return;
  const isChild = Boolean(childId && (provider === 'claude' || isChildLifecycle));
  const sessionId = isChild
    ? provider === 'codex'
      ? childId
      : `${input.session_id}/agent:${childId}`
    : input.session_id;
  const agentType =
    typeof input.agent_type === 'string'
      ? input.agent_type.replace(/[^a-zA-Z0-9 _.:/-]/g, '').slice(0, 80)
      : undefined;

  const payload = {
    event_id: randomUUID(),
    event: subtype,
    session_id: sessionId,
    parent_session_id: isChild ? input.session_id : undefined,
    session_role: isChild
      ? 'subagent'
      : input.hook_event_name === 'SessionStart'
        ? 'main'
        : undefined,
    agent_type: isChild ? agentType : undefined,
    prompt_id:
      typeof (input.prompt_id ?? input.turn_id) === 'string'
        ? (input.prompt_id ?? input.turn_id).slice(0, 200)
        : undefined,
    // A custom alias is opt-in. Otherwise the server derives a pseudonym from
    // the session id; never transmit OS usernames or Git email by default.
    user: process.env.AAD_USER || undefined,
    provider,
    client: clientName(provider),
    team_id: attrs['team.id'],
    department: attrs['department'],
    repo,
    branch,
    ticket: process.env.AAD_TICKET || ticketFromBranch(branch),
    project_id: process.env.AAD_PROJECT_ID || undefined,
    work_item_id:
      process.env.AAD_WORK_ITEM_ID || process.env.AAD_TICKET || ticketFromBranch(branch),
    run_id: process.env.AAD_RUN_ID || undefined,
    parent_run_id: process.env.AAD_PARENT_RUN_ID || undefined,
    cwd,
    // Only a sanitized tool summary is sent; tool_input is never read.
    tool_name: safeToolSummary(input.tool_name),
  };

  if (process.env.AAD_DRY_RUN === '1') {
    process.stdout.write(JSON.stringify(payload));
    return;
  }

  const headers = { 'content-type': 'application/json' };
  if (process.env.AAD_TOKEN) headers['authorization'] = `Bearer ${process.env.AAD_TOKEN}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    await fetch(`${DASHBOARD_URL}/activity`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch {
    /* dashboard down — ignore, never block the coding agent */
  } finally {
    clearTimeout(t);
  }
  process.exit(0);
}

main();

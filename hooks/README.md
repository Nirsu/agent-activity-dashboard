# Hooks — Claude Code and Codex context bridge

Claude Code's telemetry doesn't know the **ticket**, the **branch**, or which
tool is running **right now** (OTel only emits `tool_result` *after* a tool
finishes). These hooks fill that gap: they POST structural context to the local
relay's `/activity` endpoint, which forwards only selected repositories.

`hook.js` handles the shared events plus Codex interruption and derives the type from
`hook_event_name`:

| Event | Effect on the session card |
|---|---|
| `SessionStart` | create the card, attach repo/branch/ticket/cwd |
| `UserPromptSubmit` | status → **thinking**, start a new turn |
| `PreToolUse` | status → **tool**, show the current tool name |
| `PostToolUse` | status → **thinking** (tool finished) |
| `Stop` | status → **idle** (turn finished) |
| `Interrupt` (Codex only) | status → **idle** (turn cancelled) |
| `SessionEnd` | remove the card |
| `SubagentStart` | attach the child to its parent and mark it working |
| `SubagentStop` | keep the child in its parent's detail, marked finished |

## Privacy

`hook.js` forwards **only** `session_id`, provider/client, repo, branch, ticket,
cwd, structural correlation IDs, parent/child IDs and agent type, an optional custom
alias, team/department, and a sanitized tool summary.
It never reads or sends prompt text, raw commands, or tool input/output. It
always exits 0, so it cannot block an agent action.

## Claude Code install

For both clients, prefer the [repeatable developer setup](../fleet/SETUP.md):
`npm run agents:setup -- --apply`, select repositories, then start
`npm run agents:relay`. This already installs the hooks for both clients: do not
also merge manual snippets, which would install duplicate handlers.

For a manually provisioned relay, install the Claude hooks as follows:

1. Merge [`settings.snippet.json`](./settings.snippet.json) into your Claude Code
   settings (`~/.claude/settings.json` for all projects, or a project's
   `.claude/settings.json`). Adjust the absolute path if you cloned elsewhere.
2. Restart the `claude` session (hooks load at startup).

## Codex install

Codex telemetry settings must be user-level; project-local OTel configuration
is ignored. For a local POC:

1. Merge [`codex-config.snippet.toml`](./codex-config.snippet.toml) into
   `~/.codex/config.toml`. Keep `log_user_prompt = false`.
2. Keep `hook.js` and `codex-hook.js` together at a stable machine path.
3. Merge [`codex-hooks.snippet.json`](./codex-hooks.snippet.json) into
   `~/.codex/hooks.json` and replace the quoted placeholder script path.
   The `codex-hook.js` wrapper selects the provider without POSIX-only shell syntax.
4. Export `AAD_URL=http://127.0.0.1:14318`; optionally set `AAD_CLIENT` to
   `cli`, `desktop`, or `vscode`, and `AAD_USER` to a chosen display alias.
5. Start a new Codex session and review/trust the hooks with `/hooks`.

Codex batches OTel export, so hooks provide the immediate live state while OTel
adds structured API, approval, result, model, and usage events.
Both providers use the same normalized event model. The optional same-machine
Codex adapter reads only structural origin and Git metadata from its local index;
see [its scope and limits](../TELEMETRY.md#main-tasks-and-subagents). Neither path reads
client conversation transcripts. An unavailable
dashboard must not interrupt the developer's agent.

## Config (env, optional)

| Var | Default | Meaning |
|---|---|---|
| `AAD_URL` | `http://127.0.0.1:14318` | local project-filtering relay URL; installed wrappers enforce it |
| `AAD_USER` | generated pseudonym | optional custom display alias |
| `AAD_PROVIDER` | `claude` | set to `codex` for Codex hooks |
| `AAD_CLIENT` | inferred or `unknown` | `cli`, `desktop`, or `vscode` |
| `OTEL_RESOURCE_ATTRIBUTES` | — | `team.id` / `department` reused as the stream tag |
| `AAD_PROJECT_ID` | — | Brain project ID for cross-feature correlation |
| `AAD_TICKET` | branch-derived | explicit Jira ticket key |
| `AAD_WORK_ITEM_ID` | ticket | stable work item ID when it differs from the Jira key |
| `AAD_RUN_ID` | — | parent workflow execution identifier |
| `AAD_PARENT_RUN_ID` | — | parent execution for delegated work |

For **Codex desktop on Windows**, use an absolute Node executable and script
path with forward slashes in JSON, for example:
`\"C:/Program Files/nodejs/node.exe\" \"C:/work/dashboard/hooks/codex-hook.js\"`.
Set `AAD_CLIENT=desktop` in the environment before launching desktop. Restart
the client after changing OTel configuration. Running the dashboard does not modify
client configuration; the explicit `agents:setup -- --apply` command installs it.

For **Claude Code CLI**, enable both logs and metrics. The accounting source
is the `claude_code.cost.usage` / `claude_code.token.usage` metrics, avoiding
double-counting the same usage in logs. Configure OTLP HTTP JSON to the local relay
and keep prompt/tool content logging disabled. See [TELEMETRY.md](../TELEMETRY.md).

## Ticket detection

The ticket key is parsed from the branch name with `/[A-Z][A-Z0-9]+-\d+/`
(e.g. `feature/ABC-412-signup` → `ABC-412`). The title is resolved server-side
via Jira when credentials are configured; otherwise the bare key is shown.

## Test a hook by hand

The repository must be selected and the local relay running. See
[developer project selection](../fleet/SETUP.md#choose-the-repositories-to-monitor).

```bash
echo '{"hook_event_name":"SessionStart","session_id":"test-1","cwd":"'"$PWD"'"}' \
  | node hooks/hook.js
# → an idle task for this repo should appear under Recent inactive tasks
```

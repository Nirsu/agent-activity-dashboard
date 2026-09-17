# Hooks — Claude Code and Codex context bridge

Claude Code's telemetry doesn't know the **ticket**, the **branch**, or which
tool is running **right now** (OTel only emits `tool_result` *after* a tool
finishes). These hooks fill that gap: they POST structural context to the
dashboard's `/activity` endpoint on each lifecycle event.

`hook.js` handles all six events for both providers and derives the type from
`hook_event_name`:

| Event | Effect on the session card |
|---|---|
| `SessionStart` | create the card, attach repo/branch/ticket/cwd |
| `UserPromptSubmit` | status → **thinking**, start a new turn |
| `PreToolUse` | status → **tool**, show the current tool name |
| `PostToolUse` | status → **thinking** (tool finished) |
| `Stop` | status → **idle** (turn finished) |
| `SessionEnd` | remove the card |

## Privacy

`hook.js` forwards **only** `session_id`, provider/client, repo, branch, ticket,
cwd, an optional custom alias, team/department, and a sanitized tool summary.
It never reads or sends prompt text, raw commands, or tool input/output. It
always exits 0, so it cannot block an agent action.

## Claude Code install

1. Make sure the dashboard server is running (`npm run dev:server`).
2. Merge [`settings.snippet.json`](./settings.snippet.json) into your Claude Code
   settings (`~/.claude/settings.json` for all projects, or a project's
   `.claude/settings.json`). Adjust the absolute path if you cloned elsewhere.
3. Restart the `claude` session (hooks load at startup).

## Codex install

Codex telemetry settings must be user-level; project-local OTel configuration
is ignored. For a local POC:

1. Merge [`codex-config.snippet.toml`](./codex-config.snippet.toml) into
   `~/.codex/config.toml`. Keep `log_user_prompt = false`.
2. Copy `hook.js` to a stable machine path.
3. Merge [`codex-hooks.snippet.json`](./codex-hooks.snippet.json) into
   `~/.codex/hooks.json`, replace the placeholder script path, and keep
   `AAD_PROVIDER=codex` in each command.
4. Export `AAD_URL=http://localhost:4318`; optionally set `AAD_CLIENT` to
   `cli`, `desktop`, or `vscode`, and `AAD_USER` to a chosen display alias.
5. Start a new Codex session and review/trust the hooks with `/hooks`.

Codex batches OTel export, so hooks provide the immediate live state while OTel
adds structured API, approval, result, model, and usage events.
Both providers use the same normalized event model. Do not scrape private agent
transcripts or local databases as an alternative ingestion channel. An unavailable
dashboard must not interrupt the developer's agent.

## Config (env, optional)

| Var | Default | Meaning |
|---|---|---|
| `AAD_URL` | `http://localhost:4318` | dashboard base URL |
| `AAD_USER` | generated pseudonym | optional custom display alias |
| `AAD_PROVIDER` | `claude` | set to `codex` for Codex hooks |
| `AAD_CLIENT` | inferred or `unknown` | `cli`, `desktop`, or `vscode` |
| `OTEL_RESOURCE_ATTRIBUTES` | — | `team.id` / `department` reused as the stream tag |

## Ticket detection

The ticket key is parsed from the branch name with `/[A-Z][A-Z0-9]+-\d+/`
(e.g. `feature/ABC-412-signup` → `ABC-412`). The title is resolved server-side
via Jira when credentials are configured; otherwise the bare key is shown.

## Test a hook by hand

```bash
echo '{"hook_event_name":"SessionStart","session_id":"test-1","cwd":"'"$PWD"'"}' \
  | node hooks/hook.js
# → a card for this repo should appear on the dashboard
```

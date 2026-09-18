# Developer setup

Install Node.js 20 or later and the clients you use. Run this once per developer
account and machine, not once per repository. The dashboard must be reachable.

```sh
npm run agents:setup -- --url http://127.0.0.1:4318
npm run agents:setup -- --url http://127.0.0.1:4318 --apply
npm run agents:projects -- --allow /absolute/path/to/project
npm run agents:relay
```

The first command previews file paths. The second installs Codex and Claude Code
hooks, telemetry settings and a user-level Harmony Brain MCP connection. Telemetry
goes through a loopback-only project filter on port 14318; Brain MCP connects to the
dashboard directly. New installations start with an empty selection and send no
agent activity until a repository is allowed. Select
one client with `--clients codex` or `--clients claude`; use `--codex-client cli`
for Codex CLI instead of desktop. Optional `--team stream-name` groups hook events.
For a shared service, replace localhost with its HTTPS origin and configure the
ingest/viewer authentication supplied by your administrator. Localhost always
means the developer's own machine, not another developer's dashboard.

The installer copies the bridge to `~/.config/harmonie-agents/` and uses an absolute
Node path, including on Windows. Existing unrelated settings and hooks are kept;
changed files receive sibling `.bak.*` backups. Rerunning the same setup makes no
changes and preserves the selected projects and dashboard URL. An existing unmanaged Codex OTel section stops the installation so its
collector configuration can be merged deliberately. Existing Brain MCP entries
are preserved, so verify their URL if changing servers. Moving Node requires a
setup rerun. No credentials are printed or bundled into repository files.

Restart the clients after setup. In Codex, inspect and trust the exact installed
hooks through `/hooks` in the CLI before opening a fresh desktop task. New or
modified hooks require review; setup does not bypass that requirement. Claude
must also trust the working folder and have a signed-in account. Settings can be
overridden by project or organization configuration; inspect the client's active
settings when events are missing. Remove old repository-specific dashboard hooks
when replacing them with this user-level setup to avoid duplicate events.

Check a fresh task in the board: session start, prompt, tool activity and idle
after completion. OTel usage arrives in batches and depends on the client version.
Costs may remain unavailable until exact model rates are configured. A manual
hook smoke test proves transport only, not client activation or model accounting.
The bridge sends structural metadata and safe tool summaries, not prompt text.

## Choose the repositories to monitor

Each developer keeps a private selection in
`~/.config/harmonie-agents/telemetry.json`. It is not committed to a repository.
Select repositories during installation with repeatable `--project` arguments,
or manage the selection afterwards:

```sh
npm run agents:projects -- --list
npm run agents:projects -- --allow /absolute/path/to/project
npm run agents:projects -- --remove /absolute/path/to/project
```

On Windows, quote paths containing spaces, for example
`npm run agents:projects -- --allow "C:/work/Harmonie/project"`.
Changes apply to the running relay without restarting Codex or Claude. An empty
list forwards nothing. A missing or invalid configuration also forwards nothing.
Git worktrees of a selected repository are included. A different clone, a nested
repository or another repository with the same name requires its own selection.
Do not select a parent directory expecting all its repositories to be enabled.

Keep `npm run agents:relay` running on each developer's machine. It needs only Node
and Git, and can also run from the installed `~/.config/harmonie-agents/relay.mjs`
without keeping this checkout. Use `--relay-port` during setup if 14318 is occupied.
Restart the relay and clients after changing that port. For a shared authenticated
dashboard, provide its ingest token as `AAD_TOKEN` in the relay's environment;
MCP authentication remains separate. IT can manage this relay as a per-user service.

The relay authorizes a session from a lifecycle hook's working directory. It
filters OTLP batches per session and provider; unlinked or unidentified exports
are dropped locally. Keep hooks trusted and session IDs enabled in Claude metrics.
After restarting the relay, a new hook must identify each session before its
telemetry can resume. Events already dropped are not replayed by the relay.

When upgrading from direct collection, rerun setup, review the changed hooks and
restart **all** running Codex/Claude clients. Older processes can retain their
previous direct endpoint until restarted. Remove legacy project hooks and shell
environment overrides pointing directly to the dashboard. Existing dashboard
history is preserved; changing the selection does not erase earlier observations.

Setup includes `SubagentStart` and `SubagentStop` for both clients. Rerun setup
after upgrading the bridge, then review the added Codex hooks and restart clients.
The Board shows active main tasks first; opening a task reveals its linked agents.
See [session classification and the optional local Codex adapter](../TELEMETRY.md#main-tasks-and-subagents)
for versions that omit origin or parent metadata.

## Repository instructions

Merge [the workflow snippet](AGENTS.brain.snippet.md) into each participating
repository's `AGENTS.md` and import that file from `CLAUDE.md` with `@AGENTS.md`.
Register the project's paths and approved specifications in Brain first. These
instructions tell agents when to use Brain; the MCP descriptions explain how to
call it. Instructions are a workflow convention, not an enforced CI gate.

The current dashboard registration covers only `hooks/hook.js`, not the entire
application. Do not claim a full-project review from that limited registration.

For a larger rollout, IT can distribute the same client configuration and bridge
with endpoint management. Developers still need client authentication and the
applicable trust setup. Each repository retains its own reviewed Brain policy.

## After deploying the shared dashboard

The server hosts the Board, PostgreSQL and Brain. Each developer's machine runs
Codex and/or Claude Code plus the small local relay. Developers do not run a
dashboard, PostgreSQL, Cognee or a model API service locally.

There are two separate registrations:

| Registration               | Owner                                 | Purpose                                                                              |
| -------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------ |
| Brain project              | Administrator, once per project       | Stable project ID, allowed code paths, approved references and a server Git checkout |
| Local repository selection | Developer, once per clone and machine | Consent to forward that clone's agent activity through the relay                     |

Registering a project in Brain does not authorize reading a developer's machine.
Selecting a local clone does not register specifications or launch an analysis.
The deployed browser cannot discover or select local folders; selection currently
uses the local command below. There is no remote project-selection UI or central
enforcement of the developer's allowlist in this pilot.

1. The administrator supplies the shared HTTPS URL, `INGEST_TOKEN` for the relay
   and the separate `VIEWER_TOKEN` for Brain clients. Register the Brain project
   and make its baseline Git commits available in the server checkout.
2. Distribute this repository's setup bundle. Each developer installs once,
   substituting the real URL and an existing local clone:

   ```sh
   npm run agents:setup -- --url https://agents.example.com --project /absolute/path/to/project --apply
   ```

3. Supply `AAD_TOKEN` to the relay from the developer's secure environment and
   configure the Brain MCP connection with the viewer credential as described in
   [Brain MCP authentication](../BRAIN-MCP.md#shared-claude-code-authentication).
   The installer's default MCP connection contains only a URL; a protected
   deployment also requires this authentication step. Existing MCP definitions
   are preserved, so check their URL when moving from localhost to the server.
4. Start the installed relay and configure it as a per-user startup service with
   your deployment tooling. The installer does not register an OS startup task.
   Restart the agent clients and review the new or changed Codex hooks.

After installation the setup checkout is no longer needed to manage projects.
On Windows, the developer can run these commands from any terminal:

```powershell
node "$env:USERPROFILE/.config/harmonie-agents/projects.mjs" --allow "C:/work/Harmonie/project"
node "$env:USERPROFILE/.config/harmonie-agents/projects.mjs" --list
node "$env:USERPROFILE/.config/harmonie-agents/projects.mjs" --remove "C:/work/Harmonie/project"
node "$env:USERPROFILE/.config/harmonie-agents/relay.mjs"
```

On macOS/Linux, the same installed scripts live under
`$HOME/.config/harmonie-agents/`. Adding/removing a clone takes effect in the
running relay for both providers. Every developer has their own selection;
one person's paths do not enable anyone else's clone.

Developer identity is separate from repository selection. The current server
pseudonymizes the identity reported by the client; when none is supplied, it uses
a session-based label. Hooks can report `AAD_USER`, while native telemetry can
report a different account identity. The pilot does not reconcile these into a
single developer account across Codex and Claude. Do not interpret session labels
as a reliable developer headcount. Durable per-developer reporting requires a
shared identity convention or an authenticated onboarding integration.

For day-to-day work, hooks report session/tool state and native telemetry adds
tokens and estimated cost. The repo/branch, branch-derived ticket, tool summary
and session identity identify the work without uploading prompts or code through
telemetry. To link a Brain analysis, the agent passes the discovered project ID,
work item and origin session ID in the MCP call.

The repository's `AGENTS.md` / `CLAUDE.md` workflow instructs the agent to retrieve
Brain context before implementation, submit relevant changed files after local
checks, and poll the result. A resumed task or a change of scope may require fresh
context; unchanged code should not trigger duplicate analyses. This is not an
analysis on every keystroke or tool event. Human decisions stay in Brain. These
instructions are an agent convention; a mandatory review gate or external
notifications require separate CI/notification integration.

Verify one selected and one unselected repository with each client, then one
Brain submission from a registered scope. The selected task should appear in
Live sessions; its Brain run should appear under Brain analyses with the supplied
correlation IDs. The unselected task must not contribute events or usage.

References: [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Codex telemetry](https://learn.chatgpt.com/docs/config-file/config-advanced),
[Claude hooks](https://code.claude.com/docs/en/hooks),
[Claude telemetry](https://code.claude.com/docs/en/monitoring-usage),
[Claude memory](https://code.claude.com/docs/en/memory).

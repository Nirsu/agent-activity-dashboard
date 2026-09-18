# Codex desktop and Claude Code CLI pilot

The board consumes lifecycle hooks and privacy-safe OTLP HTTP JSON. Hooks show
current work; OTel reports usage asynchronously. It never reads client transcripts.
An optional local Codex index adapter reads only origin and Git context, as described below.

## Main tasks and subagents

The board highlights active main tasks. Clicking a task opens its linked subagents,
internal checks and their individual timelines. A main task stays active while a
linked descendant is working. Inactive tasks and unlinked sessions are collapsed.
The KPI, directory and map count main tasks, not every technical session.
Expiry retains every ancestor of a recently active descendant, including
intermediate subagents; an entirely stale family expires after the configured TTL.
Usage remains per session; the board never adds child usage to potentially
inclusive parent counters. A missing child cost is unavailable, not zero.

Parent links come from `SubagentStart`/`SubagentStop` hooks or explicit telemetry
metadata. Codex uses the child thread ID; Claude uses a child key within its parent
session. Stopped subagents remain available in the detail until expiry. Late usage
and tool events do not reactivate them; a new subagent start does. No link is
inferred from an account, timestamp, prompt count or token total. Legacy servers
without role metadata use prompt counts only as a compatibility fallback.

For a local dashboard on the same machine as Codex, set `CODEX_METADATA_DB` to
the existing Codex `state_5.sqlite` path in the ignored `.env`. This optional
read-only adapter queries `source`, `cwd` and `git_branch` for session IDs already
received. It never selects conversation titles, previews, messages, transcripts
or usage counters. This fills missing source metadata in some desktop exports,
including the `guardian` approval reviewer. Codex's index is not a stable public
interface: an incompatible schema disables the adapter; `/healthz` reports its
availability. Unknown sessions remain in Other sessions rather than being counted
as main work. Do not mount developer home directories on a shared server; use
the client hooks there. Internal sessions without a reported parent remain unlinked.

## Client configuration

Use the repeatable installer in [fleet/SETUP.md](fleet/SETUP.md):
`npm run agents:setup -- --url http://127.0.0.1:4318 --apply`.
It preserves unrelated client configuration, backs up changed files, and installs
both clients without duplicating hooks. The manual configuration follows below.

Select the repositories to monitor with `npm run agents:projects -- --allow <path>`
and start `npm run agents:relay`. The default selection is empty. Both hooks and
OTLP exports go to the local relay at `http://127.0.0.1:14318`, which forwards only
sessions identified by hooks in selected Git repositories. Filtering happens before
the dashboard receives, persists or counts the events. See
[project selection](fleet/SETUP.md#choose-the-repositories-to-monitor) for removal,
worktrees, authentication, migration and relay restart behavior.

Codex ignores project-local `otel` settings, so a `.codex/config.toml` in an individual
repository cannot implement this filter. See the
[official advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced).

Codex: merge [the OTel snippet](hooks/codex-config.snippet.toml) into the user-level
`~/.codex/config.toml` and [the hook snippet](hooks/codex-hooks.snippet.json) into
`~/.codex/hooks.json`, preserving existing configuration. Use the portable wrapper
and Windows path example in [hooks/README.md](hooks/README.md). Keep
`log_user_prompt=false`. Restart Codex desktop and start a fresh task.

Claude Code CLI: set these in the environment launching `claude`, and install
[the Claude hooks](hooks/settings.snippet.json) with an absolute script path:

```text
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318
OTEL_LOG_USER_PROMPTS=0
OTEL_LOG_TOOL_DETAILS=0
OTEL_METRICS_INCLUDE_SESSION_ID=true
```

Both delta and cumulative Claude metric exports are supported. Do not change the
temporality mid-session. Set `AAD_TOKEN` in the relay environment to the dashboard's
`INGEST_TOKEN` if used. Add `team.id` / `department` to `OTEL_RESOURCE_ATTRIBUTES`
for streams, and the `AAD_PROJECT_ID`, `AAD_TICKET` and `AAD_WORK_ITEM_ID` hook
variables to link work. Unlinked usage is retained and reported as unattributed.

## What the counters mean

Claude logs plus metrics are counted once, from the metrics. Codex
`response.completed` events carry usage through SSE or WebSocket logs when that
client version emits it. Transport-only events do not imply known token usage.
Tested protocol fixtures are not certification of every installed client version.
If a later observation for the same request supplies missing usage, it completes
the existing record without a second charge. Explicit zero is preserved, and the
original day/work attribution survives delayed exports and server restarts.

Derived Codex costs are corrected when a later observation adds cached-input
usage, including after restart. Reported costs, including explicit zero, are
preserved. Old records without cost provenance are kept unchanged because the
server cannot safely infer whether their amount was reported or derived.

Prompt counts reconcile hooks with native prompt events in the same provider and
session. Shared prompt IDs take precedence. When an ID is missing, one hook and
one native event within five seconds of event time are paired; this fallback is
best-effort when events are missing. Events from the same source or with different
known prompt IDs remain distinct. Live and historical counts use the same rule.
The live hour is independent of the recent-event display buffer and is restored
from persisted prompt events at startup.

Inactive session context and accounting caches expire with `RETENTION_DAYS`
(60 days by default), independently of the much shorter live-card TTL. Exports
older than that window are ignored before counting, so pruning deduplication
state cannot make old events count again. Within retention, late exports and
request aliases remain deduplicated. This is a time bound, not a fixed memory
budget; size the retention period for fleet traffic. Brain captures and analysis
evidence have a separate lifecycle.
If a cumulative counter resumes after its baseline expired and reports a start
time before retention, its first sample establishes a new baseline without a
charge; subsequent deltas resume accounting. The missing interval cannot be
reconstructed. Clients omitting counter start times should restart their session
after such a gap so a lifetime total is not mistaken for new consumption.

The native Claude USD metric is an estimate. Codex and Brain can use
`MODEL_PRICING_JSON` with exact model IDs and operator-maintained rates in USD per
million tokens. Cached input is priced separately and never added to input twice.
Reasoning tokens are part of output and are not added a second time. Keep the
effective date and source of every rate in the pilot records. No pricing catalogue
means **Cost unavailable**, not $0. This is estimated API-equivalent consumption,
not a bill or a subscription allocation. Do not use provider quota percentages as
task cost.

## Acceptance on the installed clients

For each client, use a new task with a unique work item and a short normal action.
Verify the provider, client, work item, active tool and stop state in the board.
Wait for the telemetry export and inspect tokens; cost may remain unavailable.
Restart the dashboard and verify a replay does not increase the stored totals.
Verify two clients with the same raw session ID remain separate. Record client
versions and whether lifecycle, usage, model and cost were available.

The implementation tests use synthetic OTLP and model results, including actual
PostgreSQL. They do not make paid model requests or validate a particular installed
client. No client user configuration is changed by `db:start`.

Provider references:
[Codex advanced configuration](https://developers.openai.com/codex/config-advanced/),
[Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage).

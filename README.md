# Agent Activity Dashboard

## Harmony Brain and the live board

The **Harmony Brain** tab connects approved project references, Notion sources,
Cognee memory search, and persistent human reviews. The **Project analyses** view
runs actual model calls once configured, with project-specific specifications,
Git revisions and submitted changes. See
[project setup and commit reviews](BRAIN-AGENTS.md). Without API access, it
explicitly remains unavailable; it does not fabricate AI results.

The Board highlights active main tasks. Open a task to inspect its linked subagents
and timeline; inactive and unlinked sessions remain collapsed. Brain analyses have
their own progress and usage list. Coding telemetry and Brain indexing are separate:
indexing may call models, and its costs are not included in the Board's analysis costs.

Real-time, local Mission Control showing **what Claude Code and Codex agents are
doing** during the build phase — which provider and client are active, on which
ticket, which safe tool summary is running, and how much usage it represents.

> Observability of **agents** (quality, security, cost) — not surveillance of people.
> Prompt content is never logged. Default view is aggregated by stream.

The board focuses on agent activity, usage and analysis results. Human workflow
and delivery comparisons are handled by external services.

Originally built for a POC on developer Macs. The Node application runs on
Windows, macOS and Linux; Docker uses Linux containers. Live state uses an in-memory ring buffer;
privacy-safe history is retained for 190 rolling days by default. `DATABASE_URL`
selects PostgreSQL; SQLite remains available when it is unset or explicitly empty.
See [PostgreSQL setup and migration](POSTGRES.md) and
[Codex desktop / Claude Code CLI telemetry](TELEMETRY.md).

## Usage trends

Trends supports Today, 7 days, 14 days, This month, 30 days, 90 days, and custom
date ranges of up to 90 days. Dates follow the displayed server time zone.
Single-day charts use hourly buckets; longer selections use days or, beyond
45 days, weeks. Switch between cost, tokens and prompts, or explore cost and
token breakdowns by provider, model and team.

Headline sessions are unique across the selected period. Comparisons use the
preceding calendar window of the same length, ending at the same local clock
position for an ongoing period. This month therefore compares with the preceding
equally long window, rather than the entire previous month. Percent changes are
withheld when the relevant measurements or historical coverage are incomplete.

`RETENTION_DAYS` remains configurable. The 190-day default accommodates two
90-day windows; existing environment overrides still apply. Increasing retention
does not restore deleted observations. Trends shows available-history limits and
keeps unavailable costs and tokens distinct from measured zero usage.

---

## Two data sources

1. **OpenTelemetry (native to Claude Code and Codex).** Both agents can export
   structured logs and metrics to `/v1/logs` and `/v1/metrics`.
2. **Lifecycle hooks (local context).** Ticket, branch, and immediate tool state
   are posted to `/activity`. Hooks send only structural metadata and sanitized
   tool summaries.

Both sources pass through a local relay that forwards only explicitly selected
Git repositories. Install it once per developer and choose projects with
`npm run agents:projects -- --allow /path/to/project`. Installed hooks start the
relay automatically; it queues filtered events locally during dashboard outages
and retries delivery. New installations send nothing until a repository is selected.
See [developer setup and project selection](fleet/SETUP.md).

## Architecture

```
Claude Code ──OTLP http/json──►┐
Codex ────────OTLP http/json──►│
                               │   server/  (Fastify + TS)
hooks (SessionStart, …) ──────►┤   ├─ POST /v1/logs      (OTLP ingest)
                               │   ├─ POST /v1/metrics
                               │   ├─ POST /activity     (hooks)
                               │   ├─ ring buffer (500 live events)
                               │   ├─ PostgreSQL / SQLite history (190 days)
                               │   └─ WebSocket /live
                               └──────────────────► ui/  (React + Vite)
```

## Quick start

Prerequisites: Node 22 and Git on the PATH. For **Harmony Brain**, use the same
commands on Windows, macOS and Linux:

```text
npm ci
npm run db:start
npm run build
npm run brain
```

Open [Harmony Brain](http://127.0.0.1:5173/#brain). Logs stay in the terminal;
Ctrl+C stops both the API and UI. No OS-specific launcher is needed.
`db:start` requires Docker Desktop and starts local PostgreSQL. For SQLite, omit
that command and set `DATABASE_URL` to an explicitly empty value if local PostgreSQL
settings already exist. See [Brain setup](BRAIN-AGENTS.md) for service configuration
and the Docker source mounts, and [migration instructions](POSTGRES.md) for existing data.

For development with automatic reload, use two terminals:

```bash
# 1. install (npm workspaces installs server + ui)
npm install

# 2. run the ingestion server (http://localhost:4318, ws on same port)
npm run dev:server

# 3. run the UI (http://localhost:5173)
npm run dev:ui

```

The optional agent telemetry setup is separate from starting the app:
issue a workstation token in **Accounts** and provide it as `HARMONIE_TOKEN` to
the environment launching the clients and relay. It is required for telemetry
and Brain MCP, including on localhost; see [Accounts](ACCOUNTS.md).
`source ./otel-env.sh` is a Bash/Zsh helper for macOS/Linux. On Windows, configure
the equivalent environment variables in the agent's environment; this helper
is not required to start the dashboard or Brain.

Then install the hooks (see [`hooks/README.md`](./hooks/README.md)) so the
dashboard gets ticket/branch context and precise live tool status. The same
guide includes user-level Codex OTel and hook setup.

## Local Docker

The basic dashboard uses SQLite in Docker and runs behind one same-origin proxy on the local-only default
port `18418`. Configure distinct random `VIEWER_TOKEN` and `BRAIN_ADMIN_TOKEN`
values in `.env` first; container traffic goes through the proxy and requires
browser authentication even when the published port is local:

```bash
docker compose up --build -d
```

Open [Accounts](http://127.0.0.1:18418/#accounts) in a browser. Enter `VIEWER_TOKEN`
in **Dashboard token** and `BRAIN_ADMIN_TOKEN` in **Administrator token** to unlock
administration. Native localhost development without Docker can still bootstrap
Accounts without those browser credentials.

Override the port by setting `AAD_PORT=19000` in `.env` before starting Compose.
SQLite history and the cost ledger live in the `aad-data` named volume and
survive container restarts. `docker compose down` stops the stack without
deleting that data; adding `--volumes` deletes it.

Create an account and workstation token in **Accounts**, then provide the issued
token as `HARMONIE_TOKEN` in the terminal environment. `npm run demo:seed` adds one
Claude and one Codex session to the live board for local evaluation using this
credential. It sends only synthetic metadata.

For agents using this Docker dashboard, run
`npm run agents:setup -- --url http://127.0.0.1:18418 --apply`, select repositories
and start the relay. Client OTLP exports and hooks still target the local relay
on port 14318; its upstream destination is the Docker dashboard.

The separate `compose.postgres.yaml` starts a database for the host application;
it does not reconfigure `compose.yaml`. For the full Brain container setup, follow
[BRAIN-AGENTS.md](BRAIN-AGENTS.md) and its Cognee overlay.

## Verifying the pipeline

Before wiring the real endpoint, confirm Claude Code emits telemetry at all:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=console      # prints events to the claude terminal
claude
```

You should see `claude_code.session.count` at session start and
`claude_code.user_prompt` when you submit a prompt. If nothing appears, run
`claude --debug` and check for OTel export errors. Once confirmed, switch
`OTEL_LOGS_EXPORTER=otlp` and `source ./otel-env.sh`.

## Privacy & compliance (non-negotiable)

- **Coding prompt content is not retained by telemetry.** Keep
  `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_CONTENT` and `OTEL_LOG_RAW_API_BODIES`
  disabled (`0`). Codex must keep `otel.log_user_prompt = false`.
  The ingestion parser selects structural fields and discards raw prompt/tool
  content. Brain analyses separately receive the submitted code and approved
  references needed for their explicitly requested review.
- **Raw commands and tool data are never logged.** Hooks send summaries such as
  `Terminal command` or `File edit`; they do not send arguments or output.
- **Default view is aggregated by stream** (`team.id`), not nominative.
- **Retention:** detailed normalized history is capped at **60 rolling days**.
- **RH/RGPD:** a tool displaying named developers' activity is a processing of
  employees' personal data → CSE information-consultation and entry in the
  register of processing activities are required **before** any deployment
  beyond the POC.

## Layout

| Path | What |
|---|---|
| `server/` | Fastify OTLP ingest + live store + PostgreSQL/SQLite history + WebSocket |
| `ui/` | React + Vite live dashboard |
| `hooks/` | Claude Code/Codex hook bridge and setup snippets |
| `Dockerfile`, `compose.yaml` | local two-container deployment on port 18418 |
| `otel-env.sh` | the `CLAUDE_CODE_ENABLE_TELEMETRY` export block |

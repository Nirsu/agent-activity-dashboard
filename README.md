# Agent Activity Dashboard

## Harmony Brain — local demo

The **Harmony Brain** tab adds a local source memory, three explicit comparison rules,
and persistent human-review forms. This demo uses deterministic extraction and checks;
it makes no AI calls. See [the presentation walkthrough](DEMO-BRAIN.md) for setup,
the five-minute demo, and its limits.

The **Analyses par projet** view adds actual model calls once configured, with
project-specific specifications, Git revisions and human review. See
[agent setup and the first real test](BRAIN-AGENTS.md). Without API access, it
explicitly remains unavailable; it does not fabricate AI results.

Real-time, local Mission Control showing **what Claude Code and Codex agents are
doing** during the build phase — which provider and client are active, on which
ticket, which safe tool summary is running, and how much usage it represents.

> Observability of **agents** (quality, security, cost) — not surveillance of people.
> Prompt content is never logged. Default view is aggregated by stream.

Originally built for a POC on developer Macs. The Node application runs on
Windows, macOS and Linux; Docker uses Linux containers. Live state uses an in-memory ring buffer;
privacy-safe history is retained in SQLite for 60 rolling days by default.

---

## Two data sources

1. **OpenTelemetry (native to Claude Code and Codex).** Both agents can export
   structured logs and metrics to `/v1/logs` and `/v1/metrics`.
2. **Lifecycle hooks (local context).** Ticket, branch, and immediate tool state
   are posted to `/activity`. Hooks send only structural metadata and sanitized
   tool summaries.

## Architecture

```
Claude Code ──OTLP http/json──►┐
Codex ────────OTLP http/json──►│
                               │   server/  (Fastify + TS)
hooks (SessionStart, …) ──────►┤   ├─ POST /v1/logs      (OTLP ingest)
                               │   ├─ POST /v1/metrics
                               │   ├─ POST /activity     (hooks)
                               │   ├─ ring buffer (500 live events)
                               │   ├─ SQLite history (60 days)
                               │   └─ WebSocket /live
                               └──────────────────► ui/  (React + Vite)
```

## Quick start

Prerequisites: Node 22 and Git on the PATH. For **Harmony Brain**, use the same
commands on Windows, macOS and Linux:

```text
npm ci
npm run build
npm run brain
```

Open [Harmony Brain](http://127.0.0.1:5173/#brain). Logs stay in the terminal;
Ctrl+C stops both the API and UI. No OS-specific launcher is needed.
See [Brain setup](DEMO-BRAIN.md) for local exports and the Docker source mounts.

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
`source ./otel-env.sh` is a Bash/Zsh helper for macOS/Linux. On Windows, configure
the equivalent environment variables in the agent's environment; this helper
is not required to start the dashboard or Brain.

Then install the hooks (see [`hooks/README.md`](./hooks/README.md)) so the
dashboard gets ticket/branch context and precise live tool status. The same
guide includes user-level Codex OTel and hook setup.

## Local Docker

The complete POC runs behind one same-origin proxy on the local-only default
port `18418`:

```bash
docker compose up --build -d
npm run demo:seed
```

Open [the dashboard](http://127.0.0.1:18418) in a browser.

Override the port by setting `AAD_PORT=19000` in `.env` before starting Compose.
SQLite history and the cost ledger live in the `aad-data` named volume and
survive container restarts. `docker compose down` stops the stack without
deleting that data; adding `--volumes` deletes it.

`npm run demo:seed` adds one Claude and one Codex session to the live board for
local evaluation. It sends only synthetic metadata.

For local agent ingestion, use `http://127.0.0.1:18418` as `AAD_URL` and the
OTLP base URL.

### Connect GitHub and Jira delivery data

Open the dashboard and select **Connect delivery data** in the delivery
baseline panel. From there you can:

- enter read-only GitHub.com and Atlassian Cloud credentials;
- test both connections before saving;
- choose repositories, Jira projects, anonymization, and a history start date;
- run the import and follow its progress; and
- review dated successful and failed imports.

Credentials are encrypted before they are written to the `aad-data` Docker
volume. Set a unique `CREDENTIAL_ENCRYPTION_KEY` in the local `.env` file; if
that key is lost or changed, previously saved credentials cannot be decrypted.
Tokens and the anonymization salt are never returned by the API or written to
run history.

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

- **Prompt content is never logged.** `OTEL_LOG_USER_PROMPTS`,
  `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES` are **never** set. The
  server neither receives nor stores prompt text. Codex must keep
  `otel.log_user_prompt = false`.
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
| `server/` | Fastify OTLP ingest + live store + SQLite history + WebSocket |
| `ui/` | React + Vite live dashboard |
| `hooks/` | Claude Code/Codex hook bridge and setup snippets |
| `Dockerfile`, `compose.yaml` | local two-container deployment on port 18418 |
| `otel-env.sh` | the `CLAUDE_CODE_ENABLE_TELEMETRY` export block |

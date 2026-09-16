# Project AI analyses

## What is connected

The server runs three roles: [reader](server/prompts/reader.md),
[comparison](server/prompts/comparison.md), then [arbitration preparation](server/prompts/arbitration.md).
The [orchestration contract](server/prompts/orchestrator.md) describes the order
enforced by the code. It is not a fourth model call. No additional agent framework
is required; structured responses use OpenAI Responses.

Sources and model outputs are treated as data, never as commands. Every citation
must match a snapshot line exactly. A refusal, incomplete response, or fabricated
citation stops processing. This check validates citation provenance, not the
correctness of the reasoning.

## First test: the dashboard and its own specifications

1. Copy `brain.projects.example.json` to `brain.projects.json` if that file does not exist.
   A local copy has been prepared on this machine. Git ignores this file.
2. The `dashboard` project uses its **README at the analyzed commit** as its specification.
   The initial test, **Dashboard — safe hook summaries**, reads only `hooks/hook.js`
   as code. It checks that lifecycle hooks send sanitized tool summaries without
   raw commands, arguments, or tool output. The full README is supplied to the
   reader, which extracts only requirements for this feature. This is not a
   review of OpenTelemetry collection or overall privacy compliance.
3. Configure API access in `.env`, on the server only:

```dotenv
OPENAI_API_KEY=your-api-project-key
BRAIN_MODEL=your-authorized-model-id
```

4. Run `npm run build`, stop the previous instance, then run `npm run brain`.
5. Open `http://127.0.0.1:5173/#brain/agents`, check the project and scope, and
   start the AI analysis. The button remains disabled while access is missing.
6. Check the extracted requirements, citations, and proposed questions.
   Review a difference manually, then reload to verify that the history persists.

Never paste the key into a chat, source document, or project configuration file.
Configuration only means "configured"; the first call verifies that the key,
model, and quota are actually usable. Brain uses direct OpenAI API calls.
No OAuth connector or local model is connected yet.

## Business access: API or OAuth?

The simplest starting point is a dedicated company API project with billing
configured, a service account, access limited to the required capabilities, and
the key stored in server secrets. Brain user authentication is a separate concern.

Hermes and OpenClaw document OAuth connections tied to certain subscriptions.
These integrations are specific to those tools and providers; their credentials
are not directly interchangeable with keys for the Responses API used here.
OpenClaw also recommends an API key for an always-on server. A machine identity
with short-lived tokens is another business option: OpenAI documents workload
identity federation. Its integration depends on the chosen hosting environment
and is not included in this pilot.

- [OpenClaw authentication](https://docs.openclaw.ai/gateway/authentication)
- [Hermes providers](https://hermes-agent.nousresearch.com/docs/integrations/providers)
- [OpenAI API production practices](https://developers.openai.com/api/docs/guides/production-best-practices)
- [Workload identity federation](https://developers.openai.com/api/docs/guides/workload-identity-federation)

## Register another project

Each entry in `brain.projects.json` contains:

- `id`, `name`, `scope`: identity and explicitly accepted scope.
- `repoPath`: a Git checkout available on the server.
- `specs`: the exact list of reference sources for this project. `kind: "git"`
  refers to a repository file at the requested commit; `kind: "notion"` refers to
  a local export containing the original metadata `Statut: Publié`.
  An export does not verify the current publication status in Notion.
- `codePaths`: exact paths or directory prefixes ending in `/`.
  No globs, automatic disk scans, or reading another project's files.

For a small feature test, set `scope` to the behavior being checked and list only
the files needed to trace it in `codePaths`. These settings are read for each new
analysis; refresh the interface after changing them. Existing runs keep their
original scope and snapshots. Sources are read at a Git commit, not from
uncommitted working files.

Configuration paths are relative to the JSON file. For example, a Notion export
belonging to the dashboard can be added with
`{"kind":"notion","path":"../save_notion/dashboard/specification.md"}`.
Mobile app and website documents belong only in their respective projects.

With `compose.brain.yaml`, the server reads `brain.projects.json` from the
repository mounted at `/sources/repo`. The example's `repoPath: "."` therefore
also works in Docker. Use `/sources/notion/...` paths in this configuration for
Notion exports from the Docker mount. `BRAIN_MODEL`, `BRAIN_REQUEST_TIMEOUT_MS`,
and `OPENAI_API_KEY` are passed from the Compose environment;
the prompts are included in the image.

## A development agent calls Brain

After producing a commit, the agent or CI calls the server with the project ID
and commit SHA. The server selects the registered specifications itself.

```text
npm run brain:check -- dashboard
npm run brain:check -- dashboard COMMIT_SHA BASE_SHA
```

These commands use the HEAD SHA when no commit is provided. A client in another
repository can call the Node script directly using its absolute path; HEAD is
then resolved from the client's current working directory. For a deployed Brain,
set `BRAIN_URL=https://brain.example.com` and `BRAIN_ACCESS_TOKEN` in the agent/CI
environment, not in command arguments. In this pilot, the token matches the
server's `VIEWER_TOKEN`. There are no separate per-project permissions or
individual caller accounts yet.

The script sends a `POST /api/brain/analyses`:

```json
{ "projectId": "dashboard", "commit": "FULL_SHA", "baseCommit": "OPTIONAL_FULL_SHA" }
```

`baseCommit` is optional. When provided, only changed files within the allowed
scope are read at the target commit. Deletions appear in `changedFiles`; missing
code becomes insufficient evidence. Git specifications are read at the target
commit. If they change in the same PR, their approval needs review: this pilot
does not check branch protections. The script returns a summary of findings;
its exit code indicates technical completion, never project compliance.

**The commit must already exist in the server's checkout.** The pilot does not
run `git fetch`, checkout, or push, and does not listen for GitHub webhooks yet.
CI or deployment must synchronize the checkout. The agent's uncommitted changes
are not examined. This HTTP call does not require a Brain MCP server.

## Deferred: document disclosure checks (outside the MVP)

Decision: defer this feature to keep the pilot simple. Do not implement document
classification, provider disclosure rules, or approval workflows in the current
MVP. Revisit the idea when planning broader use; the following notes preserve
design considerations, not current requirements.

Before sharing a source with a model provider, the calling agent should ask Brain
whether that document revision may be sent for the requested purpose. Brain should
return `allowed`, `needs_review`, or `blocked`, with an actionable reason and the
permitted destination. Apply the same check inside Brain immediately before each
provider request; a client-side check alone cannot enforce the policy.

Base the decision on team-managed document classifications, the caller's read and
disclosure permissions, and approved providers/accounts. Document text and model
output cannot grant permissions. Unknown classifications require review. Excerpts
and summaries inherit the source restrictions. An approval is scoped to the exact
sources/revisions, recipient and purpose, with an expiry; source or policy changes
require a fresh check. Reading a document does not imply permission to send it.

Classifications may be controlled Notion properties or a document's structured
header, read locally before any external model call. For example, a trusted
`confidentiality: internal` field can require approval for external sharing.
Free-text warnings or conflicting metadata can trigger review, but a declaration
inside a document cannot override company policy or grant broader access. An
external classifier cannot inspect an unapproved document: that inspection would
already disclose it. Any automated content screening must run in an approved
environment and may escalate uncertainty, never silently relax restrictions.

The pilot currently has project source allowlists and a shared access token, but
no document confidentiality policy or per-caller disclosure checks. Reassess this
scope before expanding to private corpora or shared deployment. The local tooling's
approval prompt is not a feature enforced by the deployed Brain server.

## Memory, costs, and test limits

- The `brain_agent_runs` table lives in `server/data/brain.db` (or `BRAIN_DB_PATH`).
  Snapshots and results are linked to their project and commit; the previous
  fixed scenario remains in `brain_records`. Previous reviews are not overwritten.
- One AI analysis at a time, at most three calls, and at most
  5,000 output tokens per call. Usage returned by the provider is retained; no
  monetary cost is invented. These limits are not a monthly spending cap or a free-tier guarantee.
  Reported tokens are retained even if a response is incomplete, refused, or
  fails output validation. A connection failure before usage is received cannot
  establish whether the provider billed the request.
- Each model call has a maximum duration of 5 minutes by default. Configure
  `BRAIN_REQUEST_TIMEOUT_MS` in the server environment (1000–1800000 milliseconds)
  and restart to change it. For example, `600000` allows 10 minutes per call.
  This is a ceiling, not a fixed wait: responses are processed as soon as they
  arrive. `brain:check` allows three such calls plus one minute of overhead;
  the browser keeps polling while the analysis is running. Increasing the
  timeout does not fix provider outages or guarantee successful responses.
  Set `BRAIN_REQUEST_TIMEOUT_MS=0` for a test without a response deadline.
  This disables both the model response timers and the client's overall polling
  deadline. Connection failures and provider-side limits can still end a request.
  A stalled request stays running until it fails or the server is stopped.
- At most 60 sources and 120 KB of combined content; larger inputs are rejected
  without silent truncation. Up to 12 requirements per analysis: this pilot is
  not exhaustive.
- Excerpts are sent to OpenAI using `store: false`. This is not a promise of zero
  retention. Agents have no execution or write tools. They share the server
  process, without dedicated network isolation.
- No Teams notifications or automatic corrections. A human makes the final
  decision; the displayed identity remains that of an unverified session.
- No fallback to demonstration rules when an AI analysis fails.

## Operational settings

Edit [server/src/brain/config.json](server/src/brain/config.json) to change the
non-secret Brain settings. Names ending in `Ms` use milliseconds; `Bytes` use bytes;
`Characters` use string lengths. The current values preserve the existing defaults.

- `git`: subprocess timeout and output buffer limits. The analysis buffer defaults
  to 2,000,000 bytes; the earlier fixed demo retains its 2 MiB buffer.
- `analysis`, `projects`, `demo`: source, model output, project and import limits.
  `maxRequirements` also updates the reader prompt and response validation.
- `memory`, `search`, `review`: history, search and form limits. The browser and
  server use the same review and search settings.
- `ui`, `client`, `launcher`: polling, HTTP client timeout and graceful shutdown.

This file is bundled into the browser, so keep credentials in the server's `.env`.
Existing environment overrides still take priority, including
`BRAIN_REQUEST_TIMEOUT_MS=0` for unlimited model calls and `BRAIN_UI_PORT` for the
local preview port. The Git timeout is separate from the model request timeout.

After editing this file, run `npm run build`, stop the running instance, then run
`npm run brain` and reload the browser. The compiled server receives a copy of the
JSON, including in Docker; rebuild the images when deploying changed settings.
The numbers in the limits section above describe the shipped defaults.

## Verification

`npm test` covers technical cases with a substituted model **only in tests**.
These results do not demonstrate a real model's quality. A real test still needs
to run after API access is configured, through the interface or `brain:check`.

## Code organization

The HTTP entry points remain in `server/src/brain.ts` and
`server/src/brain-agents.ts`. They register routes and delegate to ordinary
TypeScript modules:

- `server/src/brain/sources.ts`: source snapshots and line-preserving preparation.
- `server/src/brain/analysis/projects.ts`: project configuration and Git/Notion capture.
- `server/src/brain/analysis/openai.ts`: Responses transport, deadlines, and provider errors.
- `server/src/brain/analysis/schemas.ts` and `validation.ts`: output contracts and exact citation checks.
- `server/src/brain/analysis/service.ts`: sequential orchestration, persistence, and human reviews.
- `server/src/brain/demo/`: the local demonstration, with separate capture, exact rules, and service modules.

In the UI, `Brain.tsx` and `BrainAgents.tsx` compose the pages. The `components/brain/`
directory contains the data hooks, API client, shared types, and named sections for
setup, results, sources, and reviews. `BrainSourceViewer.tsx` owns the document dialog
and its reading/source modes. The HTTP contracts and stored records are unchanged.

Use these portable npm commands from the repository root:

```text
npm run format:brain
npm run format:brain:check
npm test
npm run test:brain-reader
npm run build
npm run test:brain-launcher
```

The formatter targets Brain code and its authored documentation. It excludes the
README used as a specification, imported Notion exports, secrets, and runtime data.

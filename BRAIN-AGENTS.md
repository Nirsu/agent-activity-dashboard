# Harmony Brain: live project memory and analyses

Notion and registered Git specifications are the reference sources. Brain stores
immutable captures, project scope, analyses, and human decisions. Cognee supplies
the derived search index and extracted graph. Developer agents call Brain over HTTP;
they do not need Notion, Cognee, or model-provider credentials.

## Start locally

Use Node.js and Docker with Compose on Windows, macOS, or Linux. Project commands
do not depend on PowerShell or a native Python installation.

1. Install dependencies with `npm ci` and copy `.env.example` to `.env` if needed.
2. Configure `OPENAI_API_KEY`, `BRAIN_MODEL`, `COGNEE_API_URL`, `COGNEE_PASSWORD`,
   `COGNEE_JWT_SECRET`, and `CREDENTIAL_ENCRYPTION_KEY`. Generate independent secrets,
   for example with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
   Never paste them into a source document or chat. See [Cognee setup](COGNEE.md).
3. Copy `brain.projects.example.json` to `brain.projects.json` if it does not exist.
   Preserve an existing configuration. Both `.env` and `brain.projects.json` are ignored by Git.
4. Start Cognee, build the application, then start Brain:

```bash
docker compose -f compose.cognee.yaml up -d cognee
npm run build
npm run brain
```

5. Open `http://127.0.0.1:5173/#brain/settings`, connect Notion, and check Cognee.
6. In Memory, register a Notion page, choose its project or shared scope, and review
   its approval. A readable test page is not automatically an approved specification.
7. Synchronize and wait for an approved source to become ready. Then open Project analyses,
   describe a narrow feature change, and launch its analysis.

The portable launcher is `scripts/start-brain.mjs`. It binds the API and preview to
loopback and shuts both down on Ctrl+C. Provider configuration does not prove that
the account has working billing or model access; the real call establishes that.
The original source-of-truth documents are never rewritten during import.

## Sources and project configuration

Each entry in `brain.projects.json` contains:

- `id`, `name`, `scope`: project identity and the accepted feature boundary.
- `repoPath`: a complete Git checkout available on the Brain server; relative paths
  resolve from this JSON file's location.
- `codePaths`: exact repository paths or prefixes ending in `/`. No globbing,
  automatic whole-repository analysis, or reading another project's files.
- `specs`: optional authoritative Git files, such as `{"kind":"git","path":"README.md"}`.
  An empty list is valid when the project's specifications are registered in Memory.

Register Notion pages through Memory, not through local export paths in this file.
The selected page is captured through the durable MCP connection. Its scope, approval,
mandatory status, capture revision, and synchronization/indexing state remain visible.
Child pages and database rows are not silently made part of the corpus: register the
specific pages that the project should use.

Approved shared sources apply to every registered project; approved project sources
apply only to their selected projects. Mandatory sources are included explicitly
in full alongside semantically retrieved passages from optional sources. These excerpts
keep their original line numbers; Brain preserves the complete immutable captures for
source inspection and history. Withdrawn or inaccessible current sources
cannot silently stand in for fresh evidence. Older analyses keep their captured proof.
Recorded human decisions keep their project and original analysis/commit context;
they do not rewrite the authoritative specification.

Git specifications are captured from the registered checkout. Analysis code is read
at the requested immutable commit. The analysis records the source/index generation
actually used, rather than claiming that a later source edit was already checked.

## A developer agent or CI calls Brain

The first remote acquisition contract is a registered server checkout plus full head
and optional base commit SHAs. The server cannot read a path on a developer's computer.
CI/deployment must make these commits available in the registered checkout first.
Brain does not execute `git fetch`, checkout, push, or arbitrary patches from an agent.

```bash
npm run brain:check -- dashboard
npm run brain:check -- dashboard FULL_HEAD_SHA FULL_BASE_SHA "Check sanitized hook summaries"
```

Without a head SHA, the client resolves HEAD in its own current working directory.
An agent in another repository can invoke the Node script by its absolute path.
Set `BRAIN_URL=https://brain.example.com` and `BRAIN_ACCESS_TOKEN` in that agent's
environment. The token currently matches the server's `VIEWER_TOKEN`; it is not
the administrator token. Do not pass tokens as command-line arguments.

The client submits:

```json
{
  "projectId": "dashboard",
  "commit": "FULL_HEAD_SHA",
  "baseCommit": "FULL_BASE_SHA",
  "feature": "Check sanitized hook summaries"
}
```

`POST /api/brain/analyses` returns HTTP 202 with a run ID. Poll
`GET /api/brain/analyses/{id}` for stages and results. With a base SHA, Brain requires
it to be an ancestor of the head and reads only changed allowed code files. Deletions
remain recorded as changed files; missing evidence does not imply approval.

The result includes cited findings, limitations, captured source/index references,
and human-review history. `brain:check` prints the citations, requirement count,
coverage, and whether review is needed. When no requirements apply, it reports
`coverage: "no_conclusion"`, preserves the reader's explanation, and requests review.
An empty findings list never establishes that the code matches the specifications.
Its exit code indicates technical completion,
never automatic project compliance. A successful analysis is not an authorization
to merge or deploy. No Brain MCP server is required for this HTTP contract.

## Analysis roles and human review

The server executes the [reader](server/prompts/reader.md),
[comparison](server/prompts/comparison.md), then
[arbitration preparation](server/prompts/arbitration.md). The
[orchestration contract](server/prompts/orchestrator.md) describes the code-enforced
order; it is not an extra model call. Structured responses use OpenAI Responses.

Retrieved passages must match the immutable Brain capture. Model citations must
match a captured line actually supplied to that role. Invalid citations, provider errors, refusals,
and incomplete responses stop the run. These checks establish provenance, not the
correctness of reasoning. Sources and model outputs remain data, never executable
instructions. The model has no shell, Notion-write, or repository-write tools.

Differences and insufficient evidence lead to a review dossier. A human records
the decision; Brain preserves prior review entries. The pilot does not implement
Teams notifications, automatic corrections, Microsoft sign-in, individual reviewer
identity verification, or document-disclosure classification.

## Notion OAuth and administrator access

Settings offers Connect, Reconnect, Disconnect, and Test connection. OAuth credentials
are encrypted in the server's persistent data directory. The server refreshes expiring
tokens, serializes refresh operations, and saves rotated credentials atomically.
Revoked or invalid authorization requires a new human login. Moving to the company's
connection means reconnecting and verifying page access and project mappings.

Set `BRAIN_NOTION_REDIRECT_URL` to the exact callback reachable by the authorizing
browser. Local default: `http://127.0.0.1:4318/api/brain/connections/notion/callback`.
Behind the Docker UI proxy it must use that proxy's externally reachable origin.
For a server, use `https://brain.example.com/api/brain/connections/notion/callback`.
Changing the callback requires reconnection.

Shared deployments require separate `VIEWER_TOKEN` and `BRAIN_ADMIN_TOKEN` values.
The latter protects source/connection management and is entered in Brain Settings.
An agent only needs the viewer token. The private local launcher permits trusted
loopback administration without these tokens. This pilot separates administration
from normal API access; it does not provide per-person or per-project authorization.

## Container deployment

The Brain overlay removes the old Notion-export mount. It mounts a complete Git
checkout read-only, passes server secrets, uses the internal `http://cognee:8000`
address, and waits for Cognee's health check. Configure the `.env` tokens and public
OAuth callback before starting the combined stack:

```bash
docker compose -p agent-activity-dashboard -f compose.yaml -f compose.cognee.yaml -f compose.brain.yaml up -d --build
```

Keep the existing deployment's Compose project name when upgrading so its named
Brain data volume remains attached. The example pins the original project name.
The separate local Cognee pilot uses project name `harmony-brain`; its volumes do
not automatically move to a combined deployment. Stop the old listener before binding
the same port, and explicitly migrate/restore the matching volumes or rebuild the
derived index. Preserve Brain's independent captures and analysis history.

Cognee's host port remains loopback-only. Provide HTTPS and a trusted reverse proxy
for the externally reachable dashboard/API; this Compose overlay does not provision
a domain or TLS certificate. For multiple repositories, mount each complete checkout
at a server path listed in `brain.projects.json`. A Windows/macOS linked worktree
whose `.git` points outside its mount is not a portable server checkout.

## Synchronization and graph

Sync now queues durable work. The local default periodically rechecks registered
sources; `BRAIN_SYNC_MODE=webhook` uses signed events plus periodic reconciliation.
Intervals and retry limits are in `server/src/brain/config.json`.

Webhook routes are `/api/brain/webhooks/notion` and `/api/brain/webhooks/github`.
Configure `BRAIN_NOTION_WEBHOOK_VERIFICATION_TOKEN` or
`BRAIN_GITHUB_WEBHOOK_SECRET` separately. GitHub also needs
`BRAIN_GITHUB_WEBHOOK_PROJECTS`, a JSON map such as
`{"your-org/dashboard":["dashboard"]}`. Notifications request a fresh read; they
do not start a paid analysis of every project. The checkout still needs to be updated
by CI before Git synchronization can capture the new commit.

Notion MCP OAuth does not create a webhook subscription. Configure an approved Notion
integration, accessible HTTPS endpoint, page access, and verification token through
Notion administration separately. The receiver does not accept an incoming unauthenticated
verification token as trusted configuration. Polling works without webhook enrollment.

Open `/#brain/graph` for current project/shared memory, recorded citations, findings,
reviews, and explicitly labeled extracted concepts. Zoom, filters, keyboard selection,
and captured-source navigation remain available. Only approved, ready datasets contribute
extracted entities. Historical analyses keep their original evidence. A Cognee outage
leaves recorded links visible with a warning rather than fabricating replacement relations.

## Settings, limits, and verification

All adjustable non-secret Brain limits are in `server/src/brain/config.json`;
credentials and environment-specific URLs remain in `.env` or deployment secrets.
The shared JSON is bundled in the browser and must never contain credentials.

One analysis runs at a time. Model calls use `BRAIN_REQUEST_TIMEOUT_MS`; `0` disables
the response deadline. Git operations and individual Cognee HTTP calls retain their
own timeouts. Provider-side outages and quotas can still fail a request. Client polling
does not abandon an unlimited indexing/model run, and server shutdown cancels waiting work.

Cognee indexing requires generation and embeddings in addition to the analysis calls.
Unchanged source/index generations are reused. Changing embedding dimensions/model,
the extraction model, or the explicit index revision creates a new derived generation;
old analysis captures remain unchanged. See [Cognee operations](COGNEE.md).
The configured wallet is not a spending cap enforced by this application.

```bash
npm run format:brain:check
npm test
```

`npm test` builds and tests the server, builds the UI, runs every Brain UI suite,
then checks the portable launcher and developer client. It uses temporary data and
substituted providers, without paid API calls. For focused changes, use
`npm run test:brain-ui` or one of its individual reader, graph, memory, and analysis
commands. The standalone launcher test requires the application to be built first.

Automated tests use substituted providers and do not demonstrate model quality.
Before wider use, verify the real Notion-to-Cognee-to-analysis flow, exact citations,
cross-project isolation, withdrawal and edit handling, retrieval after restart,
credential renewal, and a backup restore. The private single-worker pilot is not a
multi-tenant deployment certification. Source-of-truth files and historical evidence
are preserved when retired demonstration code and temporary commands are removed.

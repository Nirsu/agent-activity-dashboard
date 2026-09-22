# Harmony Brain: live project memory and analyses

Notion and registered Git specifications are the reference sources. Brain stores
immutable captures, project scope, analyses, and human decisions. Cognee supplies
the derived search index and extracted graph. Developer agents call Brain over HTTP;
they do not need Notion, Cognee, or model-provider credentials.

Use this guide for Brain setup and operation. The [README](README.md) introduces
the dashboard, telemetry and storage options.

## Start locally

Use Node.js and Docker with Compose on Windows, macOS, or Linux. Project commands
do not depend on PowerShell or a native Python installation.

1. Install dependencies with `npm ci` and copy `.env.example` to `.env` if needed.
2. Configure `OPENAI_API_KEY`, `BRAIN_MODEL`, `COGNEE_API_URL`, `COGNEE_PASSWORD`,
   `COGNEE_JWT_SECRET`, and `CREDENTIAL_ENCRYPTION_KEY`. Generate independent secrets,
   for example with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
   Never paste them into a source document or chat. See [Cognee setup](COGNEE.md).
3. Preserve any existing `brain.projects.json`; legacy registrations are imported
   once into the shared project registry. For a new GitHub project, add its name and
   remote in **Projects** after startup. Public repositories need no GitHub token;
   private repositories require the server `BRAIN_GITHUB_TOKEN` described below.
   Both `.env` and `brain.projects.json` are ignored by Git.
4. Start Cognee, build the application, then start Brain:

```bash
docker compose -f compose.cognee.yaml up -d cognee
npm run build
npm run brain
```

5. Open `http://127.0.0.1:5173/#brain/settings`, connect Notion, and check Cognee.
6. In Memory, register a Notion page, choose its project or shared scope, and review
   its approval. Enable **Include subpages** to discover nested pages. Enable
   **Automatically approve all subpages** to approve and index existing and future
   descendants; otherwise they start as drafts. The root's own approval is separate.
7. Synchronize and wait for an approved source to become ready. In Project analyses,
   select the project and open **Run a manual analysis**. Leave the commit empty
   to review the project's default GitHub branch or legacy server HEAD, or enter a full commit SHA. Add a base
   commit to focus on changes since that revision. The feature description is optional.
8. In **Accounts**, create a developer and issue a workstation token. Provide it
   as `HARMONIE_TOKEN` to the environment launching that workstation's coding clients
   and relay, then follow [developer setup](fleet/SETUP.md). Telemetry and MCP always
   require this token, including with a local server. Browser administration on
   trusted localhost remains available to create the first account.

The portable launcher is `scripts/start-brain.mjs`. It binds the API and preview to
loopback and shuts both down on Ctrl+C. Provider configuration does not prove that
the account has working billing or model access; the real call establishes that.
The original source-of-truth documents are never rewritten during import.

## Sources and project configuration

**Projects** is the shared registry for activity and Brain. Adding a GitHub
repository creates a stable Brain project automatically; no second registration
or manual clone is needed. Configure the review scope and allowed paths there,
then use **Check access** to inspect code access and reference readiness. Registration
does not start an analysis. Missing credentials, unpublished commits or missing
approved references still need resolution before a review can succeed.

Configure `BRAIN_GITHUB_TOKEN` only on the Brain server for private repositories.
Use a fine-grained token with **Contents: read** access limited to the selected
repositories. Public repositories work without it. Git objects are acquired on
demand in `BRAIN_GITHUB_CACHE_PATH`, defaulting to `DATA_DIR/brain-repositories`.
The cache is not a Cognee index; code remains searched and read as needed at a fixed
SHA. Server Git operations do not push, execute repository files or mutate the
developer's checkout. GitHub is the automatic remote provider for this version.

Existing `brain.projects.json` entries are imported once into persisted storage
and keep their IDs, local checkout paths, scope, specifications and history. They
continue using their local server Git checkout. Existing activity-only repository
records also gain Brain registrations during migration. Later Projects edits go
to the shared registry, rather than writing the legacy JSON file. Existing local
registrations can be linked when adding a repository to Projects.

The legacy import format contains:

- `id`, `name`, `scope`: project identity and the accepted feature boundary.
- `repoPath`: a complete Git checkout available on the Brain server; relative paths
  resolve from this JSON file's location.
- `codePaths`: exact repository paths or prefixes ending in `/`; `**` means all
  supported code files. Other globs are unsupported. Sensitive/generated paths and
  registered Git specifications remain excluded even with `**`.
- `specs`: optional authoritative Git files, such as `{"kind":"git","path":"README.md"}`.
  An empty list is valid when the project's specifications are registered in Memory.

The bundled `dashboard` registration covers Harmony Brain and the Agent Activity
Dashboard across server, UI, hooks, tooling and deployment. It uses the README
and approved memory as references. Both the local configuration and the example
use this project scope; there is no hook-only demonstration registration.
Keep the project ID stable when adjusting its scope to preserve source associations
and history. Previous analyses retain their original scope and become historical
when the project configuration changes.

Register Notion pages through Memory, not through local export paths in this file.
The selected page is captured through the durable MCP connection. Its scope, approval,
mandatory status, capture revision, and synchronization/indexing state remain visible.
Recursive discovery is an explicit root-page setting. Descendants inherit its project
scope and keep separate captures and citations. Existing drafts can also be approved
with **Approve current subpages** without enabling automatic approval for future pages.
Database rows and ordinary linked pages require explicit registration.
See [subpage approval and synchronization](NOTION-MCP.md#subpage-approval).

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
Application code and tests are never indexed in Cognee. During comparison, Brain
starts with a few bounded code excerpts, prioritizing changed files, then permits
literal searches and line-range reads inside the registered paths. Every read uses
the same commit plus any submitted overlay. Unchanged dependencies and tests can be
read when needed; files outside the registered scope remain inaccessible.
Search hits guide navigation and cannot serve as citations until their passages
have been read. The analysis retains its captures and the exact ranges supplied.
The `submission` settings bound complete snapshots independently: by default,
500 changed files, 2,000,000 UTF-8 bytes per file and 10,000,000 UTF-8 bytes in total.
Deletions count toward the file limit. The model's evidence budget remains separate
(`analysis.maxSources`, `analysis.maxSourceBytes` and `analysis.maxInputCharacters`).
Submitting multiple files does not send their full contents to the model.
`mcp.maxRequestBytes` allows a 64,000,000-byte JSON envelope, including worst-case
escaping and metadata. Discovery exposes these upload limits as `submissionLimits`;
see [submission capacity and oversized changes](BRAIN-MCP.md#submission-capacity).

## A developer agent or CI calls Brain

For direct use from a coding conversation, [Brain MCP](BRAIN-MCP.md) exposes
project discovery, reference retrieval, commit review and before-commit code
submissions at `/api/brain/mcp`. It reuses this same analysis pipeline. Submitted
files form an immutable overlay on a known Git baseline; specifications stay
server-controlled and the registered checkout is never modified.

For projects created in Projects, Brain acquires the requested GitHub commit and
optional base commit into its managed cache. No manual server clone is required.
Imported local projects retain their existing checkout acquisition contract. The
server cannot read a path on a developer's computer or retrieve unpublished local
commits from GitHub. For local commits and uncommitted work, use
`scripts/brain-submit.mjs` to capture the complete current change against a published
baseline and send it through `brain_submit_change`; see
[local capture](BRAIN-MCP.md#capture-a-local-change). Related unchanged files remain
available from that baseline for on-demand inspection.

```bash
npm run brain:check -- dashboard
npm run brain:check -- dashboard FULL_HEAD_SHA FULL_BASE_SHA "Review changes against the project references"
```

Without a head SHA, the client resolves HEAD in its own current working directory.
An agent in another repository can invoke the Node script by its absolute path.
Set `BRAIN_URL=https://brain.example.com` and the issued `HARMONIE_TOKEN` in that
agent's environment. The same token authenticates the workstation's telemetry and
Brain MCP. Do not pass tokens as command-line arguments.

The client submits:

```json
{
  "projectId": "dashboard",
  "commit": "FULL_HEAD_SHA",
  "baseCommit": "FULL_BASE_SHA",
  "feature": "Review changes against the project references"
}
```

The client calls `brain_start_analysis` over MCP, receives a run ID, then polls
`brain_get_analysis` for stages and results. With a base SHA, Brain requires
it to be an ancestor of the head and prioritizes changed allowed code files.
Related unchanged code and tests remain available as context. To review one commit's
changes, use its first parent as the base; for a merge, choose the comparison parent
explicitly. With no base, Brain reviews the project at the selected revision, which
also supports an initial commit. Deletions remain recorded as changed files;
missing evidence does not imply approval.

The result includes cited findings, limitations, captured source/index references,
and human-review history. `brain:check` prints the citations, requirement count,
coverage, and whether review is needed. When no requirements apply, it reports
`coverage: "no_conclusion"`, preserves the reader's explanation, and requests review.
An empty findings list never establishes that the code matches the specifications.
Its exit code indicates technical completion,
never automatic project compliance. A successful analysis is not an authorization
to merge or deploy. The client uses the Brain server's `/api/brain/mcp` endpoint.

## Analysis roles and human review

The server executes the [reader](server/prompts/reader.md),
[comparison](server/prompts/comparison.md), then
[arbitration preparation](server/prompts/arbitration.md). Orchestration is enforced
by server code, with three roles and a bounded retrieval loop during comparison:

1. Validate the registered project and revision; capture approved references and
   list allowed code paths. Apply submitted code only as an immutable overlay on the baseline.
2. Load the three prompts and record their hash. Run each role in order, validating
   its structured output, IDs and exact citations before continuing.
   Comparison can request additional code before returning its checks. The
   `codeRetrieval` settings in `server/src/brain/config.json` bound reads, search
   results and additional calls. Each comparison round records its own usage and
   has the configured per-request timeout. With the defaults, an analysis makes
   at most eight model calls; reaching the retrieval limit does not imply approval.
3. Recheck source approval and scope before each call and before completion. Stop
   on the first failure without retrying through another provider.
4. Store the evidence, model usage, progress and results in PostgreSQL when
   `DATABASE_URL` is configured, or SQLite otherwise. An administrator
   records human decisions; each revision is retained and queued as scoped context,
   never as a replacement specification. Generated fields use English; quotes retain
   their source language. No agent executes code or changes a source.

Retrieved passages must match the immutable Brain capture. Model citations must
match a complete captured line range actually supplied to that role. Invalid citations, provider errors, refusals,
and incomplete responses stop the run. These checks establish provenance, not the
correctness of reasoning. Sources and model outputs remain data, never executable
instructions. The model has no shell, Notion-write, or repository-write tools.

Differences and insufficient evidence lead to a review dossier. A human records
the decision; Brain preserves prior review entries. The pilot does not implement
Teams notifications, automatic corrections, Microsoft sign-in, individual reviewer
identity verification, or document-disclosure classification.

## Connections and administrator access

Use [Notion setup](NOTION-MCP.md#connect-brain-to-notion) for OAuth authorization,
the public callback URL, credential renewal and moving to a company connection.

Shared deployments require separate `VIEWER_TOKEN` and `BRAIN_ADMIN_TOKEN` values.
The latter protects source/connection management and is entered in Brain Settings.
The viewer credential is for dashboard browsers. The private local launcher permits
trusted loopback administration without these browser credentials.
[Accounts](ACCOUNTS.md) issues individual workstation tokens for MCP and telemetry;
these are required on local and shared servers. Active accounts share registered
Brain projects. Browser and administrator credentials cannot authenticate agent
requests, and workstation credentials cannot administer Brain.

## Container deployment

The Brain overlay retains the existing read-only checkout mount for legacy local
registrations. New GitHub projects use the server's persistent data volume for
their managed Git caches. It passes server secrets, uses the internal `http://cognee:8000`
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
a domain or TLS certificate. GitHub projects added in Projects need no additional
repository bind mounts. An imported local registration still needs its complete
Git checkout mounted at its preserved server path. A Windows/macOS linked worktree
whose `.git` points outside its mount is not a portable server checkout. Keep the
server data volume when upgrading to preserve the project registry and caches.

## Synchronization and graph

Sync now queues durable work. The local default periodically rechecks registered
sources; `BRAIN_SYNC_MODE=webhook` uses signed events plus periodic reconciliation.
Intervals and retry limits are in `server/src/brain/config.json`.

See [synchronization and optional webhooks](NOTION-MCP.md#synchronization-and-optional-webhooks)
for Notion subscriptions, GitHub mappings and signature verification. Polling works
without webhook enrollment. Notifications request a fresh read, not an analysis.

Open `/#brain/graph` for current project/shared knowledge sources and their page hierarchy.
Enable **Show extracted concepts** to inspect Cognee relationships. **Latest analysis**
shows captured code, citations, findings and reviews separately. Zoom, filters, keyboard selection,
and captured-source navigation remain available. Only approved, ready datasets contribute
extracted entities. Historical analyses keep their original evidence. A Cognee outage
leaves recorded links visible with a warning when extracted concepts are requested.
See [index maintenance](COGNEE.md#remove-obsolete-index-generations) to prune old derived datasets.

## Settings, limits, and verification

All adjustable non-secret Brain limits are in `server/src/brain/config.json`;
credentials and environment-specific URLs remain in `.env` or deployment secrets.
The shared JSON is bundled in the browser and must never contain credentials.

Keep upload capacity separate from the cost and context budget of a review. Larger
snapshots are persisted as complete overlays and read on demand; model evidence
limits still bound each analysis. When adjusting upload settings, update the
portable capture helper's shared configuration and the MCP reverse-proxy body
limit as well. The bundled Docker build renders Nginx's MCP limit from the same
JSON while retaining the existing limits on other endpoints. Restart the API after
a configuration change and rebuild deployment
images when their bundled configuration changes. A proxy rejection can occur
before Brain receives the request; `HTTP 413` is not a code-review finding.

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
then checks the portable launcher, local submission capture and developer client. It uses temporary data and
substituted providers, without paid API calls. For focused changes, use
`npm run test:brain-ui` or one of its individual reader, graph, memory, and analysis
commands. The standalone launcher test requires the application to be built first.
Provider transport tests exercise `OpenAIClient` directly; integration tests cover
pipeline order, failure propagation and stored evidence. Temporary Git repositories
ignore personal Git configuration, signing and templates.

Automated tests use substituted providers and do not demonstrate model quality.
Before wider use, verify the real Notion-to-Cognee-to-analysis flow, exact citations,
cross-project isolation, withdrawal and edit handling, retrieval after restart,
credential renewal, and a backup restore. The private single-worker pilot is not a
multi-tenant deployment certification. Source-of-truth files and historical evidence
are preserved when retired demonstration code and temporary commands are removed.

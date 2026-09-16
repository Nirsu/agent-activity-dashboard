# Harmony Brain: Notion and Cognee integration plan

Status: implemented as a private, single-instance pilot on 16 September 2026. Deployment and broader corpus evaluation remain separate release gates.

## Implementation verification

- Durable Notion OAuth is connected to the selected workspace; the connection survived a Brain restart. The original test page was captured and remains a draft awaiting approval because it contains no dashboard requirements.
- Publication policy for this pilot is explicit approval in Brain, as chosen by the user. Notion properties remain preserved metadata; no inferred publication status is used.
- Cognee 1.5.4 indexed the dashboard README in approximately 31 seconds. A real reader/comparison/arbitration run on the safe-hook-summary feature completed in approximately 22 seconds and used verified source citations.
- Analysis `6c5ceb9b-c16c-42a1-b114-d62ec12e1008` recorded 7,691 input and 1,913 output tokens. This excludes Cognee indexing and embedding usage; it is not a dollar-cost report.
- Cognee retained the dataset after restart. Reusing its completed index took 69 ms without an add/cognify call; a scoped search returned an exact original passage in 2.613 seconds. Its graph contained 47 nodes and 98 edges.
- Automated fixtures cover twenty documents across two projects and a shared scope, withdrawal, source changes, failure recovery, immutable evidence, scoped retrieval, OAuth rotation, and signed webhook handling. This is not yet a retrieval-quality benchmark on twenty real company documents.
- Local-export ingestion, the ephemeral Notion command, fixed demonstration rules, and demo tabs have been retired. Existing source documents and stored analysis/review history remain untouched.

The next content step is to register actual Notion specifications and approve them in Memory. The next deployment steps are company-owned credentials, HTTPS callbacks, webhook subscriptions, and an operations-owned backup/restore exercise. Setup and operating instructions are in `BRAIN-AGENTS.md`, `NOTION-MCP.md`, and `COGNEE.md`.

## Decisions carried forward

- Notion and the relevant Git repositories remain the authoritative sources.
- Brain owns project scope, captured source versions, analysis runs, citations, and human decisions.
- Evaluate Cognee as the single retrieval and knowledge-graph engine. Do not add Graphiti or require Obsidian.
- Keep one explicitly shared corpus and one corpus per project. A source being readable does not make it applicable or approved.
- Development agents call Brain. They do not need a direct connection to Notion or Cognee.
- Start with a small feature diff. Indexing an entire repository is not a prerequisite.
- Preserve original source content and its language. Treat document instructions as data, never as instructions to the ingestion service.
- Use portable containers and npm commands; no PowerShell-specific runtime dependency.

## Current implementation

The application already has a TypeScript/Fastify API, a React dashboard, Docker packaging,
SQLite analysis records, three ordered model roles, human reviews, and a graph of recorded references.

Brain owns the durable Notion MCP connection, registered source policies, immutable captures,
and synchronization jobs. Cognee owns the derived index. The dashboard's configured analysis
uses its Git README and a narrow hook-file scope. Notion pages are registered explicitly;
linked child pages are not silently included.

The HTTP analysis endpoint accepts `projectId`, `commit`, optional `baseCommit`, and
an optional feature description. It reads a configured server-side checkout. CI must
make those commits available first; automatic fetch and arbitrary patch uploads are
not implemented. A deployed server cannot read a developer's local path.

## Implemented architecture

```mermaid
flowchart TD
    N[Notion MCP] --> S[Brain source synchronization]
    G[Selected Git specifications] --> S
    S --> V[Versioned source captures]
    V --> C[Cognee index and retrieval]
    A[Development agent: project and change] --> B[Brain orchestrator]
    B --> C
    C --> E[Retrieved evidence verified against captures]
    E --> R[Reader, comparison and arbitration]
    B --> R
    R --> H[Human review]
    H --> M[Brain analysis and decision history]
    V --> U[Dashboard sources and graph]
    C --> U
    M --> U
```

Cognee stores a derived index that can be rebuilt. The captured originals and review
history remain independently available. A generated relation never becomes an approved
requirement merely because it exists in the graph.

## Deployment recommendation

### Development and the first private pilot

The provided Compose service pins Cognee to a tested version/digest and keeps its system
and document storage in persistent volumes. Brain communicates with it over HTTP;
the existing application remains TypeScript.

The local pilot can use the embedded stores supported by that pinned Cognee release,
with one ingestion worker. Publish any development API port only on loopback. When both
services run in Compose, use the internal service address. There is no need for Cognee's
separate UI, MCP server, Redis, or a native Python installation on every developer machine.

The pinned image includes AMD64 and ARM64 manifests. Check engine availability and
resources on each deployment host. [Official minimal Compose guide](https://github.com/topoteretes/cognee/blob/main/docs/minimal-docker-compose.md)

### Moving to a Linux server

Reuse the same pinned application images and Compose base, with deployment-specific
secrets, hostnames, storage, and HTTPS configuration. The company has one central Brain
and Cognee instance for the pilot; each developer does not install a private production memory.

A small single-instance pilot can retain the tested embedded storage arrangement. Before
multiple ingestion workers or materially different user permissions, validate the storage
and isolation model. PostgreSQL plus pgvector and a supported graph backend is a candidate,
not an already approved migration. Test backup/restore and re-indexing; changing environment
variables is not a data migration. No Kubernetes requirement is introduced.

Do not assume the OSS PostgreSQL graph adapter is production-ready: Cognee labels that
adapter as a demo and documents a separate licensed production adapter. Dataset isolation
also depends on the chosen backend. [Graph stores](https://docs.cognee.ai/setup-configuration/graph-stores),
[permissions](https://docs.cognee.ai/setup-configuration/permissions)

Native installation remains possible, and a managed Cognee service is an alternative if
the company prefers outsourced operations. This plan selects self-hosted Docker to fit
the existing project and future Linux deployment.

## Completed implementation

- Persistent Notion OAuth, encrypted credentials, renewal, and administrator controls are described in [Notion setup](NOTION-MCP.md).
- Registered project/shared sources use explicit approval, immutable captures, a durable single-worker queue, and versioned indexes. Unchanged generations are reused; failed or withdrawn generations do not become current evidence. See [Cognee operations](COGNEE.md).
- Scoped retrieval feeds the three existing analysis roles. Mandatory specifications are supplied in full; optional specifications use retrieved excerpts with original line numbers. Citations must match a supplied line, full captures remain preserved, and historical human decisions stay contextual. See [the agent contract](BRAIN-AGENTS.md#a-developer-agent-or-ci-calls-brain).
- Memory, Settings, project analyses, and the graph expose source status and distinguish recorded evidence from extracted relations. The graph never grants publication or project approval.
- Manual sync, polling, and signed Notion/GitHub receivers share the durable queue. Webhooks request a fresh read, not a paid analysis. Provider subscriptions remain deployment work; MCP OAuth does not create them. See [webhook setup](NOTION-MCP.md#synchronization-and-optional-webhooks).
- Local-export ingestion, demo rules/routes/tabs, temporary capture commands, and the export mount are removed. The portable launcher is `scripts/start-brain.mjs`. Original documents, historical captures, analyses, and review revisions remain preserved.

The automated checks and the small real pilot are summarized above. They do not replace
the broader evaluation and operational verification below.

## Evaluation and release gates

Before broader use, evaluate approximately twenty approved real documents across two
projects and a shared scope. Compare Cognee with a simple text-search baseline on the
same question set. Measure relevant-source retrieval, exact citation recovery,
project isolation, version correctness, response time, and provider usage. Include a document
that changes, one that is withdrawn, an unrelated project, and a question with no evidence.

Require zero cross-project or withdrawn-source leakage in these fixtures and exact traceability
for every cited passage. Determine acceptable latency and cost from the measured corpus.
Indexing needs generation and embedding models and may add provider charges; use explicit
models and avoid repeatedly rebuilding unchanged content. [Provider configuration](https://docs.cognee.ai/setup-configuration/llm-providers)

Before team deployment, validate access boundaries, concurrent requests, durable job recovery,
credential rotation, HTTPS, private service networking, and a backup restore. Keep SQLite and
single-worker limits explicit; select a more concurrent backend when the measured load requires it.

## Configuration and company prerequisites

Adjustable batch sizes, retry limits, freshness intervals, and retrieval limits belong in the
existing shared nonsecret Brain configuration. Environment-specific URLs, page mappings,
tokens, and encryption secrets remain server-side. Do not expose secrets through the UI's JSON import.

Remaining company and deployment inputs:

- A company-owned Notion identity or approved connection owner, plus access to selected sources.
- Approved project/shared source mappings; agree a Notion publication property only if replacing the current explicit Brain approval policy.
- A small second project corpus for the isolation test; the first remains the dashboard.
- A server hostname and HTTPS callback for deployment; webhook integration ownership separately.
- An approved generation/embedding provider configuration and a bounded evaluation budget.
- A decision on whether all team members may access the same corpus or need distinct document permissions.
- An owner for persistence, backups, dependency updates, and any optional commercial storage choice.

Next content validation: the dashboard reads a real approved Notion specification,
indexes it in containerized Cognee, retrieves a cited passage for a small feature change,
and preserves that evidence across a restart and a later document edit.

# Cognee service for Harmony Brain

Cognee is a derived search index. Brain keeps source captures, publication decisions,
analysis citations, and human reviews independently. Deleting a Cognee index does not
delete those records or modify Notion.

## Start the private service

Use Docker Desktop on Windows/macOS or Docker Engine with Compose on Linux. No native
Python installation is required. The pinned Cognee 1.5.4 image includes Linux AMD64 and
ARM64 manifests, so Apple Silicon uses a native image.

Set these values in the repository's ignored `.env` file:

```dotenv
COGNEE_API_URL=http://127.0.0.1:8000
COGNEE_PORT=8000
COGNEE_USERNAME=brain@example.com
COGNEE_PASSWORD=<a generated secret>
COGNEE_JWT_SECRET=<a different generated secret>
OPENAI_API_KEY=<the existing OpenAI project key>
BRAIN_MODEL=gpt-5.6-luna
COGNEE_EMBEDDING_MODEL=openai/text-embedding-3-small
COGNEE_EMBEDDING_DIMENSIONS=1536
```

The username is a private service login, not a mailbox to which Brain sends messages.
Use a syntactically valid email domain; Cognee rejects reserved `.test` domains.
Changing the bootstrap password after the user already exists does not rotate that
user's password; rotate it through Cognee's user administration before updating Brain.

If port 8000 is occupied, change both the port and the URL, for example to 8001.
The current development machine uses 8001. Start from the repository root:

```bash
docker compose -f compose.cognee.yaml up -d cognee
docker compose -f compose.cognee.yaml ps
```

This starts only Cognee. Brain runs separately and connects using `COGNEE_API_URL`.
When Brain also runs in Compose, put both services on the same private Docker network
and use `http://cognee:8000`; localhost inside the Brain container means Brain itself.
The provided `compose.brain.yaml` overlay configures that internal URL and health
dependency. See [combined deployment](BRAIN-AGENTS.md#container-deployment) for the
three-file command and preserving existing named volumes.
Never publish Cognee directly to the public internet. The included port binding is
restricted to host loopback, and all document endpoints require service authentication.

The model defaults to `openai/` followed by `BRAIN_MODEL`. `COGNEE_LLM_MODEL` can override
that value explicitly. The embedding model is deliberately explicit: changing its
dimensions or changing the indexing model requires new derived index generations.
Brain records the indexing configuration fingerprint separately from captured source
identity. Keep the server and Cognee model environment values consistent; the Docker
overlay passes the same values to both. Bump `cognee.indexRevision` in Brain's shared
configuration after changing the pinned image or extraction pipeline configuration.
`COGNEE_API_TOKEN` can replace the username/password login when a service token has
been provisioned. Tokens and provider keys stay on the server.

## Isolation and indexing contract

`ENABLE_BACKEND_ACCESS_CONTROL=true` is required even for this private pilot. In the
pinned release, disabling it selects shared graph/vector stores and dataset arguments
do not provide retrieval isolation. Brain fails closed on unscoped search responses.

Each immutable source capture has its own deterministic dataset name. Brain chooses
the allowed current project/shared dataset IDs before every retrieval. The client:

1. Creates or reuses that dataset and uploads the original plain text unchanged.
2. Starts `cognify` in the background and polls that dataset's pipeline status.
3. Returns success only after `DATASET_PROCESSING_COMPLETED`.
4. Uses `CHUNKS`, `only_context=true`, and `verbose=true` to retrieve original chunk
   payloads. It never asks Cognee to write an answer.
5. Returns the dataset ID and chunk ID with each passage. Brain maps the dataset back
   to its immutable source and verifies the passage against the captured text.

An unchanged completed dataset is reused. A failed job is not exposed as a current
index. A restarted Brain can poll an already-running dataset instead of launching
duplicate extraction. An interrupted Cognee job may need operator retry after checking
its private logs; an in-flight state is never treated as success.

Graph node IDs include the dataset ID to avoid merging equal entity IDs across
projects or revisions. Graph nodes and edges retain their source dataset provenance.
These are model-extracted relationships, not approved requirements. Graph size limits
are explicit and a truncated result is marked as such.

Transport limits, polling intervals, retrieval counts, and display limits live in
`server/src/brain/config.json`. An indexing timeout of zero means Brain continues
polling until completion or an explicit failure; individual HTTP calls remain bounded.

## Persistence and operation

Two named volumes preserve `/cognee-storage/system` and `/cognee-storage/data`.
The service uses SQLite, LanceDB, and Cognee's embedded Kuzu/Ladybug graph adapter,
with one dataset processing slot. The image itself runs one HTTP worker. Resource
limits are adjustable through `COGNEE_CPUS` and `COGNEE_MEMORY_LIMIT`.

```bash
docker compose -f compose.cognee.yaml restart cognee
docker compose -f compose.cognee.yaml logs --tail 100 cognee
docker compose -f compose.cognee.yaml stop cognee
```

Restarting/recreating the container preserves the named volumes. Do not use `down -v`
unless you intentionally want to remove the derived index. Back up both volumes
together while the service is stopped, alongside Brain's independent data directory.
Validate a restore before depending on a deployment backup.

Generation and embeddings use the configured OpenAI project budget. No generation
occurs just by starting the service or checking connection health. Synchronization of
new/changed approved documents does incur model calls; repeated unchanged syncs reuse
the existing index. Retrieval incurs query embeddings, but no answer-generation call.

## Pinned API and verification

Image: `cognee/cognee:1.5.4` at multiarchitecture digest
`sha256:68b755bebae2a19f482069b5efcbe8e4bdf717a68f6afb6fef80c3c352c37015`.
The client targets these versioned upstream endpoints:

- `POST /api/v1/auth/login`, `GET /api/v1/auth/me`
- `POST /api/v1/datasets`, `GET /api/v1/datasets/status?dataset=...`
- `POST /api/v1/add`, `POST /api/v1/cognify`
- `POST /api/v1/search`, `GET /api/v1/datasets/{id}/graph`

Run `npm test` for fake-provider contract checks covering pending/failed indexing,
exact text preservation, idempotent reuse, explicit scope, authentication renewal,
and graph provenance. Those tests do not spend provider credits. Real indexing,
isolation, and post-restart retrieval must additionally be checked against the running
container and approved source corpus; unit tests alone do not prove those properties.

### Development verification, 16 September 2026

The authorized dashboard README was indexed in the real pinned container. After
restarting that container, service authentication still worked and the same dataset
and document remained present (one of each). Reusing the completed index took 69 ms
and called only dataset creation/reuse and status endpoints; the verification blocked
the add/cognify routes to prevent accidental re-indexing.

A scoped search for `safe hook summaries` returned one chunk in 2.613 seconds. Its
text matched the immutable Brain capture exactly. The graph returned 47 nodes and
98 edges, all attributed to that same dataset, with no truncation. This search used
a query embedding; it did not call the analysis roles or generate a Cognee answer.
These measurements cover the small local corpus and container restart, not a backup
restore or concurrent team workload.

References: [pinned API source](https://github.com/topoteretes/cognee/tree/v1.5.4/cognee/api/v1),
[dataset isolation implementation](https://github.com/topoteretes/cognee/blob/v1.5.4/cognee/modules/search/methods/search.py),
[upstream Docker image](https://github.com/topoteretes/cognee/blob/v1.5.4/Dockerfile),
[OpenAI embedding model](https://developers.openai.com/api/docs/models/text-embedding-3-small).

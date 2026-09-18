# PostgreSQL pilot

The dashboard can store normalized activity, usage, cumulative checkpoints,
Brain analyses, memory captures, sync jobs and webhook deduplication in PostgreSQL.
`DATABASE_URL` selects PostgreSQL. Connection failure does not silently fall back
to SQLite. Encrypted Notion OAuth credentials and Cognee's own storage remain
separate; this is not a migration of every local file.

## Start locally

```sh
npm install
npm run db:start
npm run build
npm run dev:server
npm run dev:ui
```

Docker Desktop must be running. The dedicated PostgreSQL 18 container listens on
`127.0.0.1:55432` and uses a persistent named volume. `db:start` generates random
credentials once in the ignored `.env.postgres.local`. Never commit or share it.
The app loads `.env`, then `.env.postgres.local`, without replacing existing
environment variables. An existing `DATABASE_URL` takes priority.
`npm run db:status` shows health; `npm run db:stop` stops without deleting data.
`GET /healthz` reports the selected history backend and ingestion health, returning
HTTP 503 after an ingestion persistence failure so container probes detect it.

Run one application worker for this pilot. Brain holds PostgreSQL advisory locks
for its read cache and jobs; a second worker fails at startup. PostgreSQL enables
durable concurrent database access, but the current in-memory live board and
Brain worker are not yet a multi-instance application.

## Preserve existing SQLite history

Stop the dashboard before migration. Finish existing coding sessions and start
new sessions afterwards: legacy cumulative counters had no model/series identity
and cannot safely be resumed as modern counters. Modern counters retain their
checkpoints exactly. Back up the SQLite files, including live WAL/SHM companions
if the old process has not fully closed, and the credential encryption key.

```sh
npm run build --workspace server
npm run db:migrate:history -- server/data/history.db harmonie-local-history
npm run db:migrate:brain -- server/data/brain.db
```

Both imports open the source read-only. History uses a stable source ID; keep it
unchanged on retries. Brain preserves existing IDs and never overwrites a target
record. Brain imports commit in one transaction. History imports commit each
usage/checkpoint atomically and resume safely if interrupted. Both can be rerun
without duplicate rows. The
legacy JSONL ledger is not combined with SQLite because those can represent the
same usage. Historical model-level costs cannot be reconstructed from missing
data. Do not interpret missing rows or amounts as free usage.

Check the returned counts, start the server, inspect Brain captures/analyses and
the trends, then restart once and verify the same counts. Keep the SQLite backup.
An empty PostgreSQL database is not an automatic import of the old data.

To return to the preserved SQLite state, stop the server and explicitly set
`DATABASE_URL` to an empty string before starting it. PostgreSQL writes made after
migration are not copied back automatically. Export them before any rollback that
must preserve those new records. Back up the PostgreSQL volume with `pg_dump`
using the configured credentials; a Docker volume alone is not a backup.

## Accounting guarantees and scope

- Usage is keyed by source and stable event identity. Replayed exports do not
  add cost again. A usage delta and cumulative checkpoint commit together.
- Later Codex observations fill missing token/cost fields in the same canonical
  row. Reported costs, including zero, remain unchanged; derived estimates are
  corrected when cached-input usage arrives later. The original timestamp and
  work attribution are retained, and completion survives a restart and replay.
- Claude metrics are the accounting source; its API logs provide activity.
  Codex completed-response logs provide accounting. SSE and WebSocket response
  IDs share deduplication. Models and cumulative reset epochs remain separate.
- Session IDs include the provider (`codex:` / `claude:`), and the raw ID is
  retained. Brain calls have their own run and call IDs.
- Unknown cost/tokens are nullable. Valid observed zero remains zero. Price
  estimation requires an explicit model catalogue; there are no guessed rates.
- Ingestion responds successfully only after queued writes finish. A write
  failure latches ingestion to HTTP 503 until the database is repaired and the
  server restarted. The live board can briefly reflect an uncommitted event
  during that failure; use persisted trends for reporting.
- Brain publishes persisted activity through an outbox. Its terminal call usage
  reaches the same history with stable IDs. Memory indexing/embedding costs are
  not included yet and are explicitly labelled in the board.
- JSONL is only an optional compatibility export, not the reporting authority.
  Completion records have `recordType: usage_completion` and patch a prior
  `usageId`; consumers must not sum these records as additional requests.
- Brain source policy checks and synchronization writes share a short local
  transaction. A stale synchronization cannot overwrite a withdrawn approval.
  Independent SQLite writes also wait for open transactions, so one rollback
  cannot discard another caller's acknowledged changes.

Legacy Brain analyses retain their recorded tokens in their analysis cards. They
are not backfilled as new call-level accounting events because the original
response identities and costs are missing.
The current preview may use `BRAIN_SYNC_ENABLED=0` to inspect migrated data without
automatically resuming memory synchronization. Normal startup leaves it enabled.

Detailed history follows `RETENTION_DAYS` (60 by default). Set the pilot retention
before collecting data.

## Verification

`npm test` runs the SQLite-compatible server suite, UI build and UI/launcher tests.
It explicitly clears `DATABASE_URL` so normal tests do not touch the pilot DB.
To include PostgreSQL integration tests, provide `TEST_DATABASE_URL` to the same
test command, or run `npm run db:test` to use the configured local database.
Those tests use isolated temporary schemas and remove them on exit.
They cover partial-usage completion, replay, restart, transactions, concurrent
source withdrawal, migration and Brain worker locking. Notion, Cognee and model
calls are simulated in these tests; no paid external calls are needed.

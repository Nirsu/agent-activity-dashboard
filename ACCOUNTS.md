# Accounts and workstation access

Open **Accounts** (`/#accounts`). On a shared deployment, connect the dashboard
with its viewer credential, then enter `BRAIN_ADMIN_TOKEN` to unlock this page.
Trusted localhost retains local administration. There is no SSO or password login
in this version: browser access still uses the viewer key, with an additional key
for administration.

## Enroll a developer

1. Create an account with name, email and team. Emails are administrator-assigned
   identifiers, not verified email addresses.
2. All active accounts share registered Brain projects: discovery, context,
   analysis submission and results. Manage the shared telemetry repository filter
   in **Projects**; see [PROJECTS.md](PROJECTS.md).
3. Generate a token per workstation, with a recognizable label and expiration
   (1–365 days; default 90). Copy it immediately and distribute it securely.
   The secret is shown once; only its SHA-256 digest is stored.
4. Provide `HARMONIE_TOKEN` in the environment launching the clients and relay.
   Never put the value in Git, URLs or command arguments. Run:

   ```sh
   npm run agents:setup -- --url https://agents.example.com --project /path/to/repository --individual-token --apply
   ```

5. Restart relays and clients, trust the installed hooks and MCP connection,
   then start a fresh task in a locally selected repository. Existing background
   relays retain their old environment until restarted.

The explicit installer option updates the Brain MCP connection for both clients
to use `HARMONIE_TOKEN`, preserving unrelated settings. Existing custom Codex Brain
headers require a manual merge; setup refuses that migration before writing.
One workstation token authenticates telemetry and Brain MCP. It cannot access the
dashboard, administer accounts or sources, or approve findings, even with an extra
administrator header.

## Remove access

- **Revoke a token** for a lost, replaced or compromised workstation. Subsequent
  requests fail immediately. Issue a replacement when needed.
- **Disable an account** when a developer leaves. All existing tokens are
  permanently revoked. Re-enabling the account requires new tokens.
- **Disable a repository** in Projects to stop its telemetry for everyone when the
  repository filter is enabled. This preserves its history and Brain registration.

Revoked records remain for audit; activity and analysis history are preserved.
Revocation cannot undo data already downloaded to a workstation.
There are no per-person project assignments. Old account project selections no
longer restrict access. Revoke a token or disable the account to stop its submissions.
Already accepted analyses may finish.

## Transition from shared keys

Individual tokens initially work alongside shared keys. After enrolling all
workstations, enable **Require individual workstation tokens** in Accounts.
This persisted setting rejects legacy and unauthenticated access to ingestion
and Brain MCP, while preserving browser/admin access. Per-person revocation is
not sufficient while a person can still use a shared key in transition mode.

The relay prioritizes `HARMONIE_TOKEN` over `AAD_TOKEN`. Invalid individual tokens
never fall back to shared keys. The legacy mapping remains valid only during
transition: `AAD_TOKEN=INGEST_TOKEN`, `BRAIN_ACCESS_TOKEN=VIEWER_TOKEN`.

## Identity and storage

The server overrides client-reported identity/team with the token's account and
namespaces session, event and usage identifiers per account and workstation.
Pseudonymization remains enabled by default. Accounts displays each account's
activity label for comparison with the board. MCP analyses retain authenticated
developer and workstation identifiers.

Before a planned token rotation, let the workstation relay finish sending its queue.
Restart it after changing the token. Pending events keep their original credential
binding and cannot be reassigned to a replacement token. They remain available to
that original credential until the configured queue expiry; revoked credentials
remain rejected by the server.

Accounts, token digests, policy and audit entries use PostgreSQL when configured,
otherwise `DATA_DIR/access.db`. Include them in backups. Run one application worker.
Last-used timestamps update at most once per minute. The page shows the latest 100
audit entries; older entries remain stored. Audit identifies shared-key or local
administration, not an individually authenticated administrator.

Use HTTPS for shared deployment. Keep the viewer and administrator keys separate
from workstation credentials. The `hb_` prefix is reserved for issued workstation
tokens. Remote unconfigured access fails closed.

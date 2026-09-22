# Accounts and workstation access

Open **Accounts** (`/#accounts`). On a shared deployment, connect the dashboard
with its viewer credential, then enter `BRAIN_ADMIN_TOKEN` to unlock this page.
Trusted localhost retains local administration. There is no SSO or password login
in this version: browser access still uses the viewer key, with an additional key
for administration.
Docker's proxy requires both browser credentials even when its published port is
local. Set `VIEWER_TOKEN` and `BRAIN_ADMIN_TOKEN` in `.env` before starting Compose,
then enter them in the Accounts unlock form to create the first account.

## Enroll a developer

1. Create an account with a name, email and any existing teams. Emails are administrator-assigned
   identifiers, not verified email addresses.
2. All active accounts share registered Brain projects: discovery, context,
   analysis submission and results. Manage the shared telemetry repository filter
   in **Projects**; see [PROJECTS.md](PROJECTS.md).
3. Generate a token per workstation with a recognizable label. **No expiration**
   is the default; the token remains valid until revoked or its account is disabled.
   For temporary access, choose **Expires after** and a duration of 1–365 days
   (initially 90). Existing token expiration dates stay unchanged.
   Copy the token immediately and distribute it securely.
   The secret is shown once; only its SHA-256 digest is stored.
4. Provide `HARMONIE_TOKEN` in the environment launching the clients and relay.
   Never put the value in Git, URLs or command arguments. Run:

   ```sh
   npm run agents:setup -- --url https://agents.example.com --project /path/to/repository --apply
   ```

5. Restart relays and clients, trust the installed hooks and MCP connection,
   then start a fresh task in a locally selected repository. Existing background
   relays retain their old environment until restarted.

The installer configures the Brain MCP connection for both clients
to use `HARMONIE_TOKEN`, preserving unrelated settings. Existing custom Codex Brain
headers require a manual merge; setup refuses that migration before writing.
One workstation token authenticates telemetry and Brain MCP. It cannot access the
dashboard, administer accounts or sources, or approve findings, even with an extra
administrator header.

## Manage teams

Create teams in **Accounts**, then select one or more in each developer's account.
Accounts can also have no team. Team names are shared choices rather than free-text
account fields; duplicate names differing only by case or surrounding whitespace
are rejected. Rename a team to correct its name for every member. Remove all members
before deleting a team.

Existing free-text teams are migrated on startup, preserving account and token IDs.
Trends groups legacy team names under their migrated IDs. The correspondence is
persisted across renames and deletion, so reusing a name does not transfer old costs.
Installations already using managed teams capture their existing names once on upgrade;
names lost through earlier renames cannot be recovered automatically.
Membership changes and team renames update live sessions immediately, without a
new token or client restart. The Board shows a shared task in each assigned team,
while global activity and usage totals count it once. Historical team costs use
the memberships recorded when activity was received and can overlap across teams.
Teams organize activity; they do not change access to registered Brain projects.

## Remove access

- **Revoke a token** for a lost, replaced or compromised workstation. Subsequent
  requests fail immediately. Issue a replacement when needed.
- **Disable an account** when a developer leaves. All existing tokens are
  permanently revoked. Re-enabling the account requires new tokens.
- **Disable a repository** in Projects to stop its telemetry for everyone when the
  repository filter is enabled, and to block new Brain context and analysis requests.
  This preserves its history, approved references and Brain identity. Already accepted
  analyses may finish.

Revoked records remain for audit; activity and analysis history are preserved.
Revocation cannot undo data already downloaded to a workstation.
There are no per-person project assignments. Old account project selections no
longer restrict access. Revoke a token or disable the account to stop its submissions.
Already accepted analyses may finish.

## Required workstation authentication

Every workstation uses its own issued token, including with a local dashboard.
The server requires it for activity, OTLP ingestion, repository-policy discovery
and Brain MCP. Requests without a valid active token are rejected; browser and
administrator credentials cannot authenticate these agent endpoints.

Set `HARMONIE_TOKEN` before launching the relay and coding clients, then restart
them after changing the value. There is no authentication toggle to configure in
Accounts. Browser viewing and local administration remain independent so an
administrator can create the first account and issue its token.

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

Accounts, teams, token digests, repository policy and audit entries use PostgreSQL when configured,
otherwise `DATA_DIR/access.db`. Include them in backups. Run one application worker.
Last-used timestamps update at most once per minute. The page shows the latest 100
audit entries; older entries remain stored. Audit identifies shared-key or local
administration, not an individually authenticated administrator.

Use HTTPS for shared deployment. Keep the viewer and administrator keys separate
from workstation credentials. The `hb_` prefix is reserved for issued workstation
tokens. Remote unconfigured access fails closed.

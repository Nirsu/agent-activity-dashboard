# Notion connection and source synchronization

## Connect Brain to Notion

Brain connects directly to the official hosted MCP endpoint,
`https://mcp.notion.com/mcp`. Development agents call Brain; they do not each need
a Notion connection. A Notion connector installed in a coding assistant does not
configure this server connection.

1. Configure a randomly generated `CREDENTIAL_ENCRYPTION_KEY` of at least 32
   characters in the server environment. Keep this key with the deployment's
   secrets and back it up separately from the encrypted credentials.
2. Set `BRAIN_NOTION_REDIRECT_URL` for the running server. Local development uses
   `http://127.0.0.1:4318/api/brain/connections/notion/callback`. A deployed server
   needs its public HTTPS callback at the same path. Redirect URLs cannot contain
   embedded credentials, query parameters, or fragments.
3. Open **Brain → Settings → Connections → Notion** and choose **Connect**.
   Authorize the intended Notion account and workspace in the browser. If the
   workspace restricts external clients, its administrator must approve Brain.
4. Return to Settings and use **Test connection** with an accessible page.
5. In **Memory**, add the page ID or Notion URL, select its projects or explicitly
   shared scope, and review its approval status. Reading a page does not make it
   an authoritative specification. Only approved sources enter retrieval.
6. Choose **Sync now** and inspect the captured revision and indexing result
   before starting an analysis. Cognee indexing and later analysis can make paid
   provider calls; testing the Notion connection itself makes no model call.

The initial connection test page is
[Test Harmonie Brain](https://app.notion.com/p/harmonie-mutuelle/Test-Harmonie-Brain-3dddeff1b90780b7baedffb10c08a0d3).
It is not automatically promoted to a dashboard specification.

## Persistence and access

- Registration, OAuth tokens, token rotation, and pending PKCE authorization are
  stored encrypted at `<DATA_DIR>/brain/notion/credentials.json`. Writes replace
  the file atomically. Keep the data directory private and persistent.
- Token refresh happens on the server before expiration or after a rejected
  access token. One connection serializes its requests so concurrent reads do
  not reuse a rotated refresh token. Revocation requires **Reconnect**; a network
  failure does not erase a working grant.
- An authorization callback has an expiring, single-use state. Its result never
  prints the authorization code or tokens. The browser callback needs no Brain
  bearer token; administrative actions require Brain administrator access.
- **Disconnect** removes the credentials held by Brain. To revoke the upstream
  authorization as well, remove the connection in Notion.
- Brain invokes only `notion-fetch` and the optional `notion-get-self` identity
  tool. This restricts Brain's behavior; it does not claim the OAuth grant itself
  is read-only or restricted to one page.
- Enable **Include subpages** on a registered root page to discover nested Notion
  page blocks. Each subpage keeps its own capture, citations, and parent relation.
  Project/shared scope follows the root. Ordinary links, page mentions, database
  rows, attachments, and embedded documents are outside this discovery scope.
  A source capture retains the original content and metadata, including their language.
- Changing the encryption key without migration makes existing credentials
  unreadable. Restore the original key or explicitly disconnect and reconnect.
- When switching to a company account, reconnect with that identity and verify
  its document access. Review page IDs and project mappings if the workspace
  changes. Existing captures and analysis evidence remain available.

Adjustable request timeouts, authorization duration, and refresh lead time are
in the shared `notionMcp` configuration. Secrets and the deployment callback stay
in the server environment. The model analysis timeout is a separate setting.

## Subpage approval

Subpage discovery is off by default. Without **Automatically approve all subpages**,
new subpages are captured as drafts. Review them individually, or use **Approve current
subpages** to approve the existing draft descendants together without changing future policy.

Enabling automatic approval approves existing and future discovered subpages and queues
their Cognee indexing. The root can remain a draft container; its own approval is separate.
Explicitly withdrawn pages stay excluded. Turning off automatic approval keeps existing
approvals, while new pages return to draft. Descendants are optional references by default;
their **Always include when approved** setting can be changed individually.

Manual sync and periodic reconciliation discover newly added descendants. Unchanged content
reuses its index. Removing a child from its parent, withdrawing a branch, or disabling discovery
excludes the affected descendants from future analyses while preserving captured evidence.
Rediscovery restores automatically excluded pages, but never an explicit manual withdrawal.
Subpages inherit project changes from the root; independently registered pages in a conflicting
scope cause a visible synchronization error instead of being silently reassigned.
A page moved between registered parents in the same scope is reattached after Notion confirms
its new parent. Captures and explicit withdrawals are preserved, regardless of parent sync order.

Discovery uses the existing durable queue, source limit, and Notion connection. An inaccessible
child, an unverifiable parent, or a truncated response is reported as an incomplete synchronization.
No model is used to discover the hierarchy; indexing approved content can incur provider charges.

## Synchronization and optional webhooks

Manual synchronization and periodic reconciliation use the same durable queue.
Webhooks only request a fresh source read; they never submit a paid analysis,
approve a document, change its project scope, or trust event content as a new
source version. Events may arrive out of order, so the worker reads the current
source. Duplicate delivery IDs are recorded durably with the queued work.

### Notion

The MCP OAuth grant does not create a Notion webhook subscription. For deployment
you separately need a controlled Notion connection, access to the selected pages,
an event subscription, and an externally reachable HTTPS endpoint:

```text
POST https://brain.example.com/api/brain/webhooks/notion
BRAIN_NOTION_WEBHOOK_VERIFICATION_TOKEN=<approved subscription verification token>
```

Notion initially sends an unsigned `verification_token` to verify a subscription.
Complete this one-time exchange through an operator-controlled bootstrap receiver,
then configure the verified token in Brain and enable delivery to the endpoint.
The endpoint URL must remain the same when replacing that temporary receiver;
Notion does not allow changing the URL of an already verified subscription.
Brain deliberately does not enroll a token supplied in an unauthenticated request.
It rejects such handshakes and does not log their bodies.

Subscribe to the relevant page events: `page.content_updated`,
`page.properties_updated`, `page.created`, `page.deleted`, `page.undeleted`, and
`page.moved`. Brain verifies `X-Notion-Signature` with HMAC-SHA256 over the exact
received bytes. Registered pages, including discovered subpages, can be queued.
A newly created page is found on the next parent synchronization; an unknown event
does not expand the registered project scope. Withdrawn sources remain withdrawn.

### GitHub

Configure a GitHub webhook with the **push** event, JSON delivery, and a random
secret. Use the deployment endpoint and an explicit repository-to-project map:

```text
POST https://brain.example.com/api/brain/webhooks/github
BRAIN_GITHUB_WEBHOOK_SECRET=<random webhook secret>
BRAIN_GITHUB_WEBHOOK_PROJECTS={"company/dashboard":["dashboard"]}
```

Brain validates `X-Hub-Signature-256` over the raw body and uses
`X-GitHub-Delivery` for durable deduplication. An unmapped repository, unregistered
project source, or unrelated event cannot queue another project's documents.
The map names existing Brain projects; it does not register projects or clone a
repository. Git synchronization reads the configured server-side checkout, so
the deployment must update that checkout to the intended authoritative revision.

Both webhook endpoints authenticate with their signatures instead of a viewer
token. Keep their signing secrets server-side. A missing secret disables the
endpoint. Changing subscriptions or rotating a secret requires updating the
matching server setting. Preserve periodic reconciliation to recover missed
events and subscription outages.

## Verification

The server test suite covers encrypted credentials and restart recovery, PKCE
state and callback replay, rotating refresh under concurrency, revoked grants,
administrator boundaries, raw-body webhook signatures, durable event
deduplication, and source/project filtering. Run `npm test` from the repository.
These tests use fake external responses and do not establish live workspace
access. Verify **Test connection**, a successful synchronization, and evidence
from an actual analysis separately after deployment.

## References

- [Build a Notion MCP client](https://developers.notion.com/guides/mcp/build-mcp-client)
- [Supported MCP tools](https://developers.notion.com/guides/mcp/mcp-supported-tools)
- [Notion page blocks and mentions](https://developers.notion.com/guides/data-apis/enhanced-markdown#page-and-database-references)
- [Notion webhook setup and signature validation](https://developers.notion.com/reference/webhooks)
- [Notion event types and delivery](https://developers.notion.com/reference/webhooks-events-delivery)
- [GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)

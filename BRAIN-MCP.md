# Brain MCP: a developer workflow

Use a workstation token from **Accounts** as `HARMONIE_TOKEN` and install with
`npm run agents:setup -- --apply`. This credential is required for both telemetry
and Brain MCP, including on localhost. All active accounts share registered Brain
projects. See [Accounts](ACCOUNTS.md) for enrollment and revocation.

Brain exposes Streamable HTTP MCP at `/api/brain/mcp`, using the same project
registry, approved memory, analysis engine and review history as the dashboard.
There is no second orchestrator or model running in the developer's MCP client.

## Connect a local Codex conversation

Start the existing services as described in [BRAIN-AGENTS.md](BRAIN-AGENTS.md).
Create an account and workstation token in **Accounts**, make `HARMONIE_TOKEN`
available to the process launching Codex, and keep Brain running while the
developer agent uses its tools. Never put the token value in command arguments.

```bash
codex mcp add harmony-brain --url http://127.0.0.1:4318/api/brain/mcp --bearer-token-env-var HARMONIE_TOKEN
codex mcp get harmony-brain
```

Restart Codex and open a new conversation in the repository. No Notion, Cognee,
OpenAI, viewer or administrator credentials belong in the developer's MCP configuration.

Codex also supports a project-scoped `.codex/config.toml` in a trusted project:

```toml
[mcp_servers.harmony-brain]
url = "http://127.0.0.1:4318/api/brain/mcp"
bearer_token_env_var = "HARMONIE_TOKEN"
```

Use either the CLI registration or the project configuration, not duplicate
registrations. If the tools are missing, reload MCP connections or restart the
client, then open a new conversation. See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp).

For a shared deployment, use the HTTPS origin with the same workstation credential:

```bash
codex mcp add harmony-brain --url https://brain.example.com/api/brain/mcp --bearer-token-env-var HARMONIE_TOKEN
```

Issued workstation tokens identify developers and can be revoked independently.
They grant no browser or administrator access.

## Claude Code authentication

For Codex, use the authenticated registration above, or add
`bearer_token_env_var = "HARMONIE_TOKEN"` to the existing
`[mcp_servers.harmony-brain]` entry with the shared HTTPS URL. Make the environment
variable available to the process launching Codex desktop as well as the CLI.

For Claude Code, a project-scoped `.mcp.json` can reference the same environment
variable without storing a token in Git:

```json
{
  "mcpServers": {
    "harmony-brain": {
      "type": "http",
      "url": "https://agents.example.com/api/brain/mcp",
      "headers": { "Authorization": "Bearer ${HARMONIE_TOKEN}" }
    }
  }
}
```

The installer already configures an authenticated user-level connection. If using
this project-scoped example instead, merge it with existing MCP configuration and
remove the user entry for this name with
`claude mcp remove --scope user harmony-brain` when choosing this project-scoped
configuration; check `/mcp` for the effective URL and authentication. Do not keep
a conflicting local definition. Set `HARMONIE_TOKEN` in the environment that
launches Claude, restart it and approve the project's MCP configuration.
See [Claude MCP scopes and environment expansion](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson).

The relay and MCP client use the same `HARMONIE_TOKEN` environment variable.
Installing hooks or selecting a local repository does not issue a credential or
grant Brain administration.

## Tools

| Tool                        | Purpose                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `brain_list_projects`       | Discover availability, project IDs, allowed code paths, excluded specification paths and scope.                                            |
| `brain_get_project_context` | Retrieve applicable approved project/shared references for a feature. Git references are captured at the requested commit, or server HEAD. |
| `brain_submit_change`       | Submit local code before commit or push, without changing the server checkout.                                                             |
| `brain_start_analysis`      | Review an existing commit, optionally limited by a base commit.                                                                            |
| `brain_get_analysis`        | Poll progress and read findings, citations, limitations and human decisions.                                                               |

Context retrieval can refresh captures and derived indexes. The two analysis
tools start real provider calls, record a run and return its ID immediately.
Poll `brain_get_analysis` at the returned interval instead of starting duplicate
analyses. There is no MCP tool to approve findings, edit references or change
project scope. Human decisions remain in the review interface.

## Before-commit workflow

1. Discover the project. Check that its allowed paths and approved references
   actually cover the intended feature.
2. Read context with the feature description and an explicit full baseline commit
   SHA published to the registered GitHub repository, or already present in an
   imported local Brain checkout. Brain retrieves published GitHub revisions on
   demand. If local HEAD includes unpushed commits, use an earlier published
   ancestor as the baseline and include those local commits in the submitted files.
3. Implement the feature and run relevant local tests. Preserve unrelated edits.
4. Inspect the complete difference from that baseline, including local commits,
   staged edits, unstaged edits, untracked files and deletions. Submit the
   **complete current contents** of every differing file in the allowed scope.
   The capture helper below prepares this payload. Use `content: null` for a deletion and relative paths
   with `/`. Do not send a patch, an absolute path, secrets, generated files or
   specifications. A rename is a deletion plus a new file.
5. Brain overlays these files on the baseline in memory. Unchanged allowed files
   are read on demand when comparison needs additional context. Application code
   is never indexed in Cognee. Registered Git specifications stay at the baseline; approved
   Notion and shared references come from memory. The overlay receives a stable
   snapshot ID and is preserved with the analysis. It is never checked out or
   executed. A server Git cache is source storage, not a semantic code index.
6. Poll the result. Correct actionable code differences, rerun local tests and
   resubmit the current contents. Escalate ambiguities and accepted exceptions to
   a human. Never change a specification merely to make an analysis pass.

Brain cannot discover omitted local edits or attest that an agent's supplied
files match its disk. A snapshot result therefore applies only to the submitted
files plus baseline context. A final commit review can bind the result to a Git
revision. Successful model calls, no findings and zero applicable requirements
never authorize a merge or deployment.

## Capture a local change

Save the exact matching project object returned by `brain_list_projects` as a JSON
file outside the repository. It must contain `id`, `codePaths` and
`specificationPaths`; keep `repositoryRemote` when returned. Do not invent scope
or copy a stale project configuration. Select a full published ancestor SHA that
Brain can retrieve; the helper deliberately does not infer that local HEAD or a
possibly stale remote-tracking branch is published.

From any working directory, run the portable Node helper by its absolute path:

```bash
node /path/to/agent-activity-dashboard/scripts/brain-submit.mjs --project-config /tmp/brain-project.json --repo /path/to/project --baseline FULL_PUBLISHED_SHA --feature "Review the current implementation" --output /tmp/brain-submission.json
```

Use Windows paths when running on Windows. From the dashboard checkout, the same
command is available as `npm run brain:submit -- ...`. The helper does not contact
Brain, GitHub or a model. It writes the exact `brain_submit_change` argument object;
the coding agent sends that JSON through MCP and polls the returned analysis ID.
Without `--output`, stdout contains only the payload. With `--output`, the target
must be outside the repository, its directory must exist, and an existing file is
never overwritten. This prevents the payload from becoming submitted source.

Capture uses the final working copy against the baseline, including changes already
committed locally and all staged, unstaged, untracked, renamed or deleted files.
Git-ignored untracked files are excluded. Stop editing during capture. The helper
checks for concurrent changes and rejects unresolved conflicts, sparse or hidden
index entries, symlinks, binary/non-UTF-8 files and oversized payloads. Its credential
pattern check is a safeguard, not a general secret scanner: inspect the resulting
code payload locally before sending it.

Changed specifications, generated/sensitive paths and files outside the registered
scope are reported on stderr and block output by default. After reviewing those
diagnostics, `--allow-out-of-scope` acknowledges the exclusions; they remain printed
and must be reported as review limitations. It never makes those files eligible
for upload. Register approved requirements through the human-controlled Memory
workflow instead of sending them as changed code.

The helper captures file contents; it does not represent permission bits, Git
submodule state or working-copy history as executable changes. A published commit
review remains the way to tie findings to a verified Git revision.

## Submission capacity

`brain_list_projects` returns the server's current `submissionLimits` alongside
the project list. Check those values before capturing a large change; keep the
capture helper and server configuration in sync. The defaults in
`server/src/brain/config.json` are:

| Limit                     | Default                | Purpose                                                    |
| ------------------------- | ---------------------- | ---------------------------------------------------------- |
| `submission.maxFiles`     | 500 files              | Complete changed-file list, including deletions.           |
| `submission.maxFileBytes` | 2,000,000 UTF-8 bytes  | Each non-deleted file's complete contents.                 |
| `submission.maxBytes`     | 10,000,000 UTF-8 bytes | Combined file contents in one immutable snapshot.          |
| `mcp.maxRequestBytes`     | 64,000,000 bytes       | Encoded JSON MCP request, including metadata and escaping. |

Source bytes and request bytes differ: one source byte can require six bytes
when JSON escapes a control character. The request ceiling accommodates that
worst case for a full snapshot. Paths and other metadata also count toward the
request limit. Non-ASCII text is counted as UTF-8 bytes, not JavaScript characters.
The capture helper rejects oversized changes before producing any payload; it
does not trim files or omit the rest of a change.

These are upload and storage limits. They do not enlarge the model's context:
Brain reads selected excerpts on demand under the separate `analysis` and
`codeRetrieval` budgets. A large snapshot makes the complete change available
for inspection; it does not establish exhaustive review coverage.

If a complete change exceeds a limit, report its measured size and the configured
ceiling. Adjust the shared capacity settings and deployment proxy together when
appropriate, then restart/rebuild the affected services and refresh discovery.
Do not narrow the registered scope, drop changed files, or send successive partial
snapshots to imply a complete review. For published work, a commit review can use
the server's immutable Git access without uploading the working-copy snapshot.
An external reverse proxy must permit `mcp.maxRequestBytes` on `/api/brain/mcp`;
other endpoints keep their existing limits. The bundled Docker dashboard renders
its Nginx MCP limit from the shared JSON at build time; rebuild the image after
changing that configuration.

## Review the project or a change

The `dashboard` project covers Harmony Brain and the Agent Activity Dashboard:
server, UI, hooks, developer tooling and deployment. Its registered README and
approved project/shared memory provide the reference requirements. The display
name is Harmony Brain & Agent Activity Dashboard; the stable ID remains
`dashboard` to retain source associations and analysis history.

For a project review, use `brain_start_analysis` at the desired commit without a
base commit. For changes between revisions, supply both head and base commits.
To focus on one commit's changes, use its first parent as the base (or select
another parent explicitly for a merge). An initial commit has no parent: review
that revision without a base. Use `brain_submit_change` for uncommitted code.
The feature description should describe the actual review, not a demonstration
scenario. Broad reviews remain bounded by available references and evidence.

Example prompt:

> Review the project's current behavior against its approved references.
> Preserve unrelated changes. Connect to the `harmony-brain` MCP, call
> `brain_list_projects`, and retrieve context for project `dashboard` using the
> full published baseline SHA. Run the relevant local checks. If there are local
> commits or working-copy changes in scope, use `brain_submit_change` with that
> baseline SHA and every differing allowed file's full contents; otherwise use
> `brain_start_analysis` on the published commit.
> Poll `brain_get_analysis` and report the analysis ID, commit or snapshot ID,
> local test results, checked requirements and any remaining human decisions.
> Do not approve your own exceptions or claim that the whole project is compliant.

Approved references define the obligations Brain can independently compare.
Historical analyses from an earlier project configuration retain their original
scope and evidence; they do not become reviews of the expanded project.
Model findings remain judgments, not executable tests.

## Verification

`npm test` covers the MCP handshake and tool calls using the official SDK client,
the shared analysis pipeline with a deterministic model stub, input validation,
source provenance and access restrictions. It does not measure model accuracy.
Live model evaluations must be reported separately from these automated tests.

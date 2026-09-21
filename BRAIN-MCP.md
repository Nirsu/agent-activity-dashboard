# Brain MCP: a developer workflow

For managed developer accounts, use a workstation token from **Accounts** as
`HARMONIE_TOKEN` and install with `agents:setup -- --individual-token --apply`.
It authenticates both telemetry and Brain MCP for all registered projects. See [Accounts](ACCOUNTS.md)
for enrollment, revocation and migration. Shared viewer credentials below are the
legacy alternative, accepted only while individual tokens are not required.

Brain exposes Streamable HTTP MCP at `/api/brain/mcp`, using the same project
registry, approved memory, analysis engine and review history as the dashboard.
There is no second orchestrator or model running in the developer's MCP client.

## Connect a local Codex conversation

Start the existing services as described in [BRAIN-AGENTS.md](BRAIN-AGENTS.md).
Keep Brain running while the developer agent uses its tools.

```bash
codex mcp add harmony-brain --url http://127.0.0.1:4318/api/brain/mcp
codex mcp get harmony-brain
```

Open a new conversation in the repository. The local pilot permits access only
from loopback when no viewer token is configured. No Notion, Cognee or OpenAI
credentials belong in the developer's conversation or MCP configuration.

Codex also supports a project-scoped `.codex/config.toml` in a trusted project:

```toml
[mcp_servers.harmony-brain]
url = "http://127.0.0.1:4318/api/brain/mcp"
```

Use either the CLI registration or the project configuration, not duplicate
registrations. If the tools are missing, reload MCP connections or restart the
client, then open a new conversation. See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp).

For a shared deployment, use the HTTPS origin and a viewer token supplied through
the client's environment:

```bash
codex mcp add harmony-brain --url https://brain.example.com/api/brain/mcp --bearer-token-env-var BRAIN_ACCESS_TOKEN
```

`BRAIN_ACCESS_TOKEN` must match the server's `VIEWER_TOKEN`. Never give a coding
agent `BRAIN_ADMIN_TOKEN`. This legacy shared credential has no individual identity
and cannot be revoked per person. Issued workstation tokens identify developers
and can be revoked independently. All active developers share registered projects.

## Shared Claude Code authentication

For Codex, use the authenticated registration above, or add
`bearer_token_env_var = "BRAIN_ACCESS_TOKEN"` to the existing
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
      "headers": { "Authorization": "Bearer ${BRAIN_ACCESS_TOKEN}" }
    }
  }
}
```

Merge this entry with the repository's existing MCP configuration. Remove the
installer's unauthenticated user entry for this name with
`claude mcp remove --scope user harmony-brain` when choosing this project-scoped
configuration; check `/mcp` for the effective URL and authentication. Do not keep
a conflicting local definition. Set `BRAIN_ACCESS_TOKEN` in the environment that
launches Claude, restart it and approve the project's MCP configuration.
See [Claude MCP scopes and environment expansion](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson).

The relay's `AAD_TOKEN` is the server's ingest credential. Brain's
`BRAIN_ACCESS_TOKEN` is the viewer credential. Installing hooks or allowing a
repository does not configure MCP authentication or grant Brain administration.

## Tools

| Tool                        | Purpose                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `brain_list_projects`       | Discover availability, project IDs, allowed code paths and scope.                                                                          |
| `brain_get_project_context` | Retrieve applicable approved project/shared references for a feature. Git references are captured at the requested commit, or server HEAD. |
| `brain_submit_change`       | Submit modified code before commit, without changing the server checkout.                                                                  |
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
2. Read context with the feature description and the full local baseline commit
   SHA. That commit must already exist in Brain's registered repository. Linked
   worktrees of that repository share Git objects; a different machine must make
   its baseline available through the repository/CI workflow first.
3. Implement the feature and run relevant local tests. Preserve unrelated edits.
4. Inspect the Git diff, including staged edits, unstaged edits, untracked files
   and deletions. Submit the **complete current contents** of every changed file
   in the allowed scope. Use `content: null` for a deletion and relative paths
   with `/`. Do not send a patch, an absolute path, secrets, generated files or
   specifications. A rename is a deletion plus a new file.
5. Brain overlays these files on the baseline in memory. Unchanged allowed files
   are read on demand when comparison needs additional context. Application code
   is never indexed in Cognee. Registered Git specifications stay at the baseline; approved
   Notion and shared references come from memory. The overlay receives a stable
   snapshot ID and is preserved with the analysis. It is never checked out or
   executed.
6. Poll the result. Correct actionable code differences, rerun local tests and
   resubmit the current contents. Escalate ambiguities and accepted exceptions to
   a human. Never change a specification merely to make an analysis pass.

Brain cannot discover omitted local edits or attest that an agent's supplied
files match its disk. A snapshot result therefore applies only to the submitted
files plus baseline context. A final commit review can bind the result to a Git
revision. Successful model calls, no findings and zero applicable requirements
never authorize a merge or deployment.

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
> full local HEAD SHA. Run the relevant local checks. If there are working-copy changes in
> scope, use `brain_submit_change` with that baseline SHA and every changed allowed
> file's full contents; otherwise use `brain_start_analysis` on the commit.
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

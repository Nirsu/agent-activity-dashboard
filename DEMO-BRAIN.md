# Harmony Brain — local demonstration

This guide describes the fixed demonstration scenario. For AI agents and
project-specific scopes, see [BRAIN-AGENTS.md](BRAIN-AGENTS.md).

## Open the demo

[Open Harmony Brain](http://127.0.0.1:5173/#brain).

Prerequisites: Node 22 and Git on PATH. From the repository root, the same commands work in a Windows, macOS, or Linux terminal:

```text
npm ci
npm run build
npm run brain
```

After the first installation, `npm run brain` is enough; run `npm run build` again after changing code. The Node launcher starts the server and interface through one foreground command. Logs appear in the terminal and **Ctrl+C** stops both services. No PowerShell, Bash, fixed Node installation path, or detached process is required.

The default addresses are `127.0.0.1:4318` and `127.0.0.1:5173`. An occupied port causes startup to fail: stop the previous instance before restarting. Markdown exports must be available in `../save_notion`. Existing data remains in `server/data/`.

## Docker / Linux server

Deployment uses the existing Dockerfile: Node for the API, Nginx for compiled files and the proxy. The local launcher and Vite preview are not used on the server.

In `.env`, set `CREDENTIAL_ENCRYPTION_KEY` (existing Docker configuration) and a `VIEWER_TOKEN`. Then run:

```text
docker compose -f compose.yaml -f compose.brain.yaml up --build -d
```

The interface is at `http://127.0.0.1:18418/#brain`. The existing dashboard access token is required for API calls; it does not provide an individual identity for reviews. Sources are mounted read-only: the current repository with its `.git` directory, and `../save_notion`. For other locations, set `BRAIN_REPO_MOUNT` and `BRAIN_NOTION_MOUNT` in `.env`. Use a full Git copy, not a worktree linked to a path outside the mount. The container user must be able to read these directories.

Git is installed in the server image. Brain memory persists in the `aad-data` volume alongside other data. For a shared server, keep a single API instance and put access behind the HTTPS proxy and authentication chosen for deployment.

## Presentation message

"We have an initial loop that connects a decision to code, makes evidence inspectable, and preserves human review. The demonstration uses fixed rules; AI agents will extend reading and comparison."

## Five-minute walkthrough

1. **Memory — one minute.** Show the four Notion exports and nine files captured from the Git commit, grouped in the library. Open the published technical foundation in reading mode to show its table, then switch to source mode to inspect the original lines. The sidebar lets you switch files. The two build plans and scoping page remain marked as proposals; they do not establish any active rules. Search for "PostgreSQL", then filter published documents.
2. **Rules and scope — one minute.** Explain that the technical foundation concerns the new product. Applying it to the dashboard is a demonstration assumption. Three rules are proposed: backend framework, storage, and web interface. They require explicit activation with a rationale.
3. **Comparison — one minute.** Start the comparison. Expected result at the initial commit `f5c82db3`: two suspected differences (Fastify / NestJS, SQLite / PostgreSQL) and one match (React + Vite). These results come from the manifests and document lines; they are not prefilled results.
4. **Human review — one minute.** Open the storage technology finding. Click both evidence references to inspect their source lines. Explain that SQLite can be a legitimate choice for this local tool. Choose a decision, enter a rationale, and save. Choosing further investigation leaves the question open; choosing a code correction does not mean the code has been corrected.
5. **Traceability — one minute.** Show the history, reload the page, and find the decision again. Run another comparison: the finding and review are not duplicated. Export the Markdown report. Show the runs tab.

A backend framework test review may already exist. Its original note explicitly says "Test technique du parcours avant présentation" and leaves the finding open for investigation. It is not a business decision.

## What actually works

- Importing Notion exports and reading nine files from a fixed Git commit, excluding local uncommitted changes.
- Publishing a complete snapshot in one transaction; the last usable state remains visible if the next import fails.
- Inspectable sources, excerpts, line numbers, and revisions; text search prioritizing published documents.
- Deterministic topic classification, proposed rules derived from the published technical foundation, and explicit human activation.
- Three exact dependency comparisons. A missing or invalid manifest produces insufficient evidence.
- Findings, reviews, rationales, and runs stored in a SQLite database separate from telemetry logs.
- Preventing simultaneous analyses in this instance and deduplicating identical results.
- Historical revisions; no implicit resolution after a failed import or changed source.
- Results become historical when the active rule set changes. An old finding remains inspectable but cannot receive a new review.
- Subviews preserve their addresses (`#brain/rules`, `#brain/review`, `#brain/runs`) on reload and in back/forward navigation.

## Limits to state clearly

- **No AI calls in this fixed scenario:** reading through text extraction, fixed classification and comparisons, and template-based questions. This scenario does not demonstrate an agent's semantic understanding.
- Local exports, without Notion/GitHub synchronization or live publication-status verification. Notion snapshots are identified by a content hash.
- Three predefined rules and nine selected files; no exhaustive analysis or proof of production behavior.
- Activation tests a scope assumption. The dashboard is not identified as the business BFF or extranet.
- Local session without an account: reviewer identity is unverified. The tool displays this limit and does not claim to authenticate a human.
- Only one Brain server process may use this database; no distributed execution. At most 50 exports of 250 KB each, without following symbolic links.
- No automatic changes to Notion or code, no Brain MCP server, and no Teams notifications.
- Local masking covers some obvious patterns and the original Owner/Porteur metadata. It does not replace a secrets review before expanding the source collection.

## Local configuration

Server variables to set before startup when needed:

| Variable            | Default                | Purpose                           |
| ------------------- | ---------------------- | --------------------------------- |
| `BRAIN_REPO_PATH`   | This repository        | Local Git copy to read            |
| `BRAIN_NOTION_PATH` | `../save_notion`       | Markdown export directory         |
| `BRAIN_DB_PATH`     | `server/data/brain.db` | Persistent memory                 |
| `BRAIN_GIT_BINARY`  | `git`                  | Git path when unavailable on PATH |
| `PORT`              | `4318`                 | Local launcher API port           |
| `BRAIN_UI_PORT`     | `5173`                 | Local launcher interface port     |

These values can be set in `.env`, without OS-specific shell syntax. Relative paths resolve from the launch directory; `npm run brain` uses the repository root. The launcher always binds locally to `127.0.0.1`.

Current rules assume the paths `server/package.json` and `ui/package.json`. Changing the repository does not automatically create rules suited to another project.

## After the presentation

1. Choose an approved decision and a repository within the matching business scope.
2. Configure model API access to replace extraction and templates with bounded calls, cited evidence, and evaluation.
3. Connect the Notion API with read-only access; add authentication if the pilot is shared.
4. Evaluate real differences, false positives, and missing evidence before expanding rules or sending notifications.

## Verify the code

```text
npm run build
npm test
npm run test:brain-reader
npm run test:brain-launcher
```

Brain tests create a real temporary Git repository and cover commit stability despite local changes, citation fidelity, review persistence, review conflicts, deduplication, import failures, invalid manifests, superseded revisions, and rejected HTTP origins.

The reader uses `react-markdown` and `remark-gfm`, loaded only when opened. There is no custom Markdown parser: raw HTML is ignored and remote images are not loaded. Its tests cover tables, Notion callouts, quotations, and rendering untrusted content.

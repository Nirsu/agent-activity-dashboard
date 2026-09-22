# Projects and Brain code access

Open **Projects** (`/#projects`) with the same viewer and administrator credentials
used for Accounts. Repository authorization is shared by all developers.

1. Enter a project name and its GitHub origin URL, such as
   `https://github.com/organization/project.git` or `git@github.com:organization/project.git`.
   Do not include credentials. HTTPS and SSH URLs with the same host/path match;
   distinct SSH host aliases must use the same canonical origin on each workstation.
2. Set the Brain review scope and allowed code paths. `**` includes all supported
   code files, with sensitive files, generated directories and registered reference
   specifications excluded. Exact files and directory prefixes ending in `/` can
   narrow the scope. Existing local Brain registrations can be linked during creation.
3. Add the project. It receives a stable Brain identity automatically and appears
   in Brain project selection. Editing its name or scope preserves that identity,
   reference associations and historical analyses. Use **Check access** to verify
   code access and see whether approved references are ready.
4. Update each workstation using `npm run agents:setup -- --apply` and restart its
   relay. New installations should follow [ACCOUNTS.md](ACCOUNTS.md). Select local
   clones with `npm run agents:projects -- --allow /path/to/repository`.
5. Click **Enable repository filter**. With filtering enabled, an empty list of
   enabled repositories blocks all incoming activity. Disable a repository to
   stop collection for everyone and prevent new Brain context/analysis requests;
   enable it to resume. Existing history and reference registrations are preserved.

Filtering starts disabled to allow an orderly rollout. Adding a repository alone
does not activate filtering. Relays older than version 3 do not supply repository
identity and cannot send activity after the filter is enabled.

The relay captures the selected clone's actual Git origin when queuing each event.
It checks the shared policy before delivery, with a 30-second cache. The server
checks the current allowlist on every authenticated ingestion request,
so disabling a repository takes effect immediately for subsequent requests.
Pending events for an unauthorized repository are discarded. Temporary connection
or authentication failures retain events for retry within the configured queue limits.
Changing a clone's origin does not relabel already queued events.

Both the local selection and shared allowlist must permit collection. The server
checks the origin supplied by the relay; this is repository filtering, not proof
that an authorized developer cannot forge telemetry. History is not deleted.

## Brain code analyses

Projects is the shared registry for activity and Brain. Registration is immediate;
successful analysis also needs access to the selected Git revision and applicable
approved references. The project status distinguishes unchecked access, missing Git
access, missing references, ready and disabled states. Registration does not start
a paid analysis or approve any reference document.

For a newly added GitHub repository, Brain acquires Git objects into its managed
server cache when context or an analysis needs them. Public repositories need no
GitHub token. For private repositories, configure `BRAIN_GITHUB_TOKEN` on the server
with fine-grained **Contents: read** permission for the selected repositories.
Keep the token out of Git URLs, client configuration and the browser. A selected
commit must be published to that repository; the server cannot fetch a commit that
exists only on a developer's workstation.

Code is searched and read on demand at one immutable Git revision. Application
code is not indexed in Cognee. Local changes, including unpushed commits, can be
reviewed before publication through a submitted overlay on a published baseline;
see the portable capture helper in [Brain MCP](BRAIN-MCP.md#capture-a-local-change).
Approved project/shared references remain in Brain Memory and are required for
requirements comparison.

Existing `brain.projects.json` registrations are imported once into the shared
registry with their stable IDs, local checkout paths, code scope and Git reference
paths preserved. Existing repository records receive a Brain registration during
migration if they did not have one. Imported local projects continue using their
registered server checkout; they do not silently switch to a GitHub cache. The
legacy JSON is an import source, not a live second registry. New GitHub projects
are managed from Projects without editing JSON or mounting another repository.
Existing non-GitHub activity registrations are retained with an explicit unsupported
automatic-code-access status.

All active accounts share enabled Brain projects. There is no per-account project
selection. Disabling a project does not erase its references or recorded analyses.

Project records, Brain registrations, the global filter and audit entries use the same PostgreSQL
or SQLite access storage as accounts. They survive server restarts.

# Shared repositories

Open **Projects** (`/#projects`) with the same viewer and administrator credentials
used for Accounts. Repository authorization is shared by all developers.

1. Enter a project name and its Git origin URL, such as
   `https://github.com/organization/project.git` or `git@github.com:organization/project.git`.
   Do not include credentials. HTTPS and SSH URLs with the same host/path match;
   distinct SSH host aliases must use the same canonical origin on each workstation.
2. Optionally link an existing Brain project to attribute incoming activity to it.
3. Click **Add repository**. Repeat for the repositories you want to collect.
   For an existing repository, use **Edit repository** to change its name, Git URL
   or Brain link, then **Save repository**. Editing preserves its enabled/disabled
   status. Select **Activity only** to remove a Brain link.
4. Update each workstation using `npm run agents:setup -- --apply` and restart its
   relay. New installations should follow [ACCOUNTS.md](ACCOUNTS.md). Select local
   clones with `npm run agents:projects -- --allow /path/to/repository`.
5. Click **Enable repository filter**. With filtering enabled, an empty list of
   enabled repositories blocks all incoming activity. Disable a repository to
   stop collection for everyone; enable it to resume future collection.

Filtering starts disabled to allow an orderly rollout. Adding a repository alone
does not activate filtering. Relays older than version 3 do not supply repository
identity and cannot send activity after the filter is enabled.

The relay captures the selected clone's actual Git origin when queuing each event.
It checks the shared policy before delivery, with a 30-second cache. The server
checks the current allowlist on every ingestion request, including legacy keys,
so disabling a repository takes effect immediately for subsequent requests.
Pending events for an unauthorized repository are discarded. Temporary connection
or authentication failures retain events for retry within the configured queue limits.
Changing a clone's origin does not relabel already queued events.

Both the local selection and shared allowlist must permit collection. The server
checks the origin supplied by the relay; this is repository filtering, not proof
that an authorized developer cannot forge telemetry. History is not deleted.

## Brain code analyses

Authorizing telemetry does not clone a repository or create its specifications.
To enable analyses, register a server-side Git checkout, allowed code paths and
approved references in `brain.projects.json` (or `BRAIN_PROJECTS_PATH`), following
[BRAIN-AGENTS.md](BRAIN-AGENTS.md). Then link that Brain project in the repository form.
All active accounts can use registered Brain projects. There is no per-account
project selection; disabling telemetry does not remove access to Brain references.

Repository records, the global filter and audit entries use the same PostgreSQL
or SQLite access storage as accounts. They survive server restarts.

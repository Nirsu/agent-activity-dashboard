# Language

Write code, identifiers, comments, prompts, UI text, and authored technical documentation in English.
Preserve source-of-truth documents, imported content, exact quotations, and external field names in their original language.
Keep source-language fixtures when needed to verify parsing and faithful quotation.
Use French when discussing the work with the user unless they request otherwise.

# Brain review

Use Harmony Brain automatically for implementation work covered by a registered
Brain project. Follow `BRAIN-MCP.md`; do not wait for the user to repeat this rule.
Discover the project with `brain_list_projects` and read its approved references
with `brain_get_project_context` before changing code in its allowed scope.
After local checks, submit the actual modified file contents in that scope through
`brain_submit_change` before committing or declaring the implementation ready.
Use `brain_start_analysis` for a review of an existing commit instead. Poll the
returned analysis ID with `brain_get_analysis`; do not start duplicate analyses.
Resolve actionable findings and submit again only if the reviewed code changed.
Preserve unrelated work and leave exceptions and approvals to a human.

If Brain is unavailable, unconfigured, or does not cover the changed paths, report
that limit and continue useful local work without claiming a Brain review passed.
Do not expand project scope, send secrets, change specifications, or run a paid
analysis on an unrelated feature to satisfy this rule. The `dashboard` registration
covers Harmony Brain and the Agent Activity Dashboard, including server, UI,
hooks, developer tooling and deployment files. Discover the current allowed paths
through MCP rather than assuming a fixed single-file scope.

# Readability

Use descriptive names, explicit control-flow blocks, and one statement per line.
Keep page components focused on composition; place stateful workflows in hooks
and reusable presentation in named components when this makes them easier to read.
Separate source capture, model transport, validation, orchestration, and HTTP routes.
Keep these as ordinary modules; do not introduce a framework or generic service
layers for hypothetical future needs.

After changing Brain code, run `npm run format:brain` and the relevant tests.
`npm run format:brain:check` verifies formatting without modifying files.
Never format source-of-truth documents or imported exports.

# Brain configuration

Keep adjustable Brain timeouts, limits, and polling intervals in
`server/src/brain/config.json`. Reuse it in the server, UI, and portable scripts.
Keep environment-specific values and secrets in server environment variables.
The shared JSON is included in the browser bundle and must never contain secrets.
Protocol constants (HTTP status codes, Git formats, encoding) stay with their logic.

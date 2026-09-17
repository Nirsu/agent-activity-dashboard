# Language

Write code, identifiers, comments, prompts, UI text, and authored technical documentation in English.
Preserve source-of-truth documents, imported content, exact quotations, and external field names in their original language.
Keep source-language fixtures when needed to verify parsing and faithful quotation.
Use French when discussing the work with the user unless they request otherwise.

# Brain review

When the user requests a Brain review from a coding conversation, follow
`BRAIN-MCP.md`. Discover the project and read its references before implementation.
For a before-commit review, submit the actual modified file contents through
`brain_submit_change`, then poll `brain_get_analysis`. Preserve unrelated work,
report unsupported scope, and leave exceptions and approvals to a human.

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

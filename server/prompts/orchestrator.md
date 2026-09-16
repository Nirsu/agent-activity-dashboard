# Orchestrator contract

This file documents the server; it is not sent to a fourth model.

1. Accept a registered project ID, a commit, an optional base commit, and a feature description.
   Callers cannot freely choose paths, remote repositories, or documents.
2. Capture allowed Git files and Git specifications at the requested revision.
   Retrieve only approved project/shared sources through Cognee, including mandatory sources.
   Resolve retrieved passages to preserved captures and check freshness, scope, and size limits.
   Human reviews provide context and never become authoritative requirements.
3. Load versioned instructions and call the reader, comparison, and arbitration
   preparation agents in order. Make at most three calls, with no autonomous loop.
4. Validate types, IDs, and exact citations after each call. Recheck the selected
   source policies before each model call and before completing the analysis.
   Stop at the first failure; never invent results or substitute another provider.
5. Store the project, commit, specifications, retrieved source/index versions, instruction hash, model, usage,
   progress, evidence, and results in SQLite.
6. Require administrative access to record an explicit human decision and preserve
   every revision of that decision. Queue its scoped context for memory indexing.

Inputs are never executed. No agent pushes code, publishes to Notion, or makes a
human arbitration decision. Process only one AI analysis at a time.
Generated analysis fields are in English; source quotations retain their original language.

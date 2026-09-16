# Orchestrator contract

This file documents the server; it is not sent to a fourth model.

1. Accept a registered project ID, a commit, and an optional base commit.
   Callers cannot freely choose paths, remote repositories, or documents.
2. Capture project specifications and allowed Git files at the requested revision.
   Check limits before sending anything to the model.
3. Load versioned instructions and call the reader, comparison, and arbitration
   preparation agents in order. Make at most three calls, with no autonomous loop.
4. Validate types, IDs, and exact citations after each call.
   Stop at the first failure; never invent results or fall back to the demonstration.
5. Store the project, commit, specifications, instruction hash, model, usage,
   progress, evidence, and results in SQLite.
6. Wait for an explicit human decision and preserve every revision of that decision.

Inputs are never executed. No agent pushes code, publishes to Notion, or makes a
human arbitration decision. Process only one AI analysis at a time.
Generated analysis fields are in English; source quotations retain their original language.

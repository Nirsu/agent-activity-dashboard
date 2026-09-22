# Harmony Brain workflow

Use the `harmony-brain` MCP automatically for implementation work in this repository.
Call `brain_list_projects` to discover the matching registered project and its
allowed code paths; do not guess the project ID or broaden its scope.
Before implementation, call `brain_get_project_context` with the feature and
the full baseline commit SHA published to the registered GitHub repository or
available in its legacy Brain checkout. Brain acquires GitHub revisions on demand.

Run the relevant local checks after editing. For uncommitted or unpushed changes, call
`brain_submit_change` with that baseline and the complete current contents of
every file differing from that baseline in the allowed scope (null for deletions).
Include local commits, staged, unstaged and untracked changes. When available, use
scripts/brain-submit.mjs with the fresh project object from brain_list_projects,
an explicit baseline and feature to capture the complete payload. Review all
excluded-file diagnostics before acknowledging them. For a published commit,
use `brain_start_analysis` instead. Supply the work item and origin session IDs
when known. Poll the returned ID with `brain_get_analysis`, resolve actionable
findings, and resubmit only when the reviewed code changes.

Check discovery's `submissionLimits` before sending a large snapshot. Count full
UTF-8 file contents, deletions, and JSON envelope overhead against their separate
limits. If the complete change does not fit, report the measured size and request
an appropriate capacity change; never narrow registered scope, omit changed files
or present partial snapshots as a complete review. Upload capacity is independent
of the model's bounded on-demand evidence and does not imply exhaustive coverage.

Do not send secrets, generated files or reference specifications as changed code.
Do not approve exceptions, alter source-of-truth requirements, or interpret
technical completion as merge/deployment approval. Report the analysis ID,
reviewed scope, local checks, coverage limits and pending human decisions.
If Brain is unavailable or does not cover this feature, say so and continue
useful local work; never claim a review passed or substitute an unrelated review.

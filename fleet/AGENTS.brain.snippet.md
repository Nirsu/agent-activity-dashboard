# Harmony Brain workflow

Use the `harmony-brain` MCP automatically for implementation work in this repository.
Call `brain_list_projects` to discover the matching registered project and its
allowed code paths; do not guess the project ID or broaden its scope.
Before implementation, call `brain_get_project_context` with the feature and
the full baseline commit SHA available in Brain's checkout.

Run the relevant local checks after editing. For uncommitted changes, call
`brain_submit_change` with that baseline and the complete current contents of
every changed file in the allowed scope (null for deletions). Include staged,
unstaged and untracked changes relevant to the feature. For an existing commit,
use `brain_start_analysis` instead. Supply the work item and origin session IDs
when known. Poll the returned ID with `brain_get_analysis`, resolve actionable
findings, and resubmit only when the reviewed code changes.

Do not send secrets, generated files or reference specifications as changed code.
Do not approve exceptions, alter source-of-truth requirements, or interpret
technical completion as merge/deployment approval. Report the analysis ID,
reviewed scope, local checks, coverage limits and pending human decisions.
If Brain is unavailable or does not cover this feature, say so and continue
useful local work; never claim a review passed or substitute an unrelated review.

# Review Cycle Auto-Split Prompt for {{TASK_ID}}

GuardReason: {{GUARD_REASON}}
Counts: total_non_test_reviews={{TOTAL_NON_TEST_REVIEWS}}; failed_non_test_reviews={{FAILED_NON_TEST_REVIEWS}}; excluded_review_types={{EXCLUDED_REVIEW_TYPES}}
LatestFailedReview: {{LATEST_FAILED_REVIEW}}

## Instructions
1. Treat the current parent task as blocked by the review-cycle guard; do not continue compile, review, or full-suite gates on the parent as if the block did not exist.
2. Move the parent task into `DECOMPOSED` state through supported task controls when available, or by explicit backlog editing when no gate exists for that transition.
3. Inspect the workspace diff before starting any child task and classify it as no diff or parent work that must be preserved for child execution.
4. If the workspace contains parent diff, create a split checkpoint before child execution instead of carrying the dirty workspace into children.
5. A split checkpoint is a preservation commit, not a reviewed implementation commit and not task completion evidence. Use a clear message such as `checkpoint(split): preserve <task-id> dirty diff before decomposition`, record the checkpoint SHA in the parent notes and child-task plan, and state that child tasks must validate and finish the preserved work through normal gates.
6. After the split checkpoint, the workspace must be clean before the first child task starts. If repository policy or operator instructions prohibit checkpoint commits, stop and ask the operator to authorize either a checkpoint commit or an equivalent workflow-owned patch/checkpoint artifact that also restores a clean workspace.
7. Do not run new compile, review, full-suite, or completion gates on the parent merely to make an unfinished diff committable after this guard has fired.
8. Split the remaining parent objective into maximally small child tasks with normal numeric task IDs, not suffix IDs such as T-379-1.
9. Execute the child tasks sequentially through next-step and mandatory gates until the parent objective is fully handled.

## Constraints
- Do not create a normal implementation commit for unfinished or unreviewed work.
- A split checkpoint commit is allowed only after this guard has blocked the parent, only to preserve the exact current parent diff and clean the workspace for child tasks, and only with explicit checkpoint wording.
- Do not treat a split checkpoint as review, completion, release readiness, or permission to skip child gates.
- Do not discard, revert, stash, shrink, or reshape parent diff only to bypass the guard; preserve operator work unless the operator explicitly chooses a reset or discard path.
- Do not start a child task on an unscoped dirty workspace. Prefer a clean workspace after the split checkpoint; use staged or explicit changed-file scope only for deliberate child-owned edits made after the checkpoint.
- Do not mark the parent DONE merely because child tasks were created.
- Do not leave the parent as ordinary `BLOCKED` when decomposition is the intended path; use `DECOMPOSED` so `next-step` routes to child tasks instead of stale parent recovery.
- Preserve the original review-cycle block reason and counts in child-task notes or closeout where relevant.
- Keep test reviews excluded from the non-test review-cycle count unless workflow config changes explicitly.
- If splitting cannot proceed cleanly, stop and report the blocker to the operator.

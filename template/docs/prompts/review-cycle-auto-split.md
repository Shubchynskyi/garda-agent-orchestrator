# Review Cycle Auto-Split Prompt for {{TASK_ID}}

GuardReason: {{GUARD_REASON}}
Counts: total_non_test_reviews={{TOTAL_NON_TEST_REVIEWS}}; failed_non_test_reviews={{FAILED_NON_TEST_REVIEWS}}; excluded_review_types={{EXCLUDED_REVIEW_TYPES}}
LatestFailedReview: {{LATEST_FAILED_REVIEW}}
SuggestedChildTaskIds: {{SUGGESTED_CHILD_TASK_IDS}}
SuggestedReviewerFollowUpTaskId: {{SUGGESTED_FOLLOWUP_TASK_ID}}

## Instructions
1. Treat the current parent task as blocked by the review-cycle guard; do not continue compile, review, or full-suite gates on the parent as if the block did not exist.
2. Do not hand-edit the parent status. The guard should already have latched the parent as `SPLIT_REQUIRED`; do not rerun `next-step` on the parent to transition it to `DECOMPOSED` until the validation lane below has produced a passing compile/test baseline and ordinary linked child tasks are ready.
3. Inspect the workspace diff before starting any child task and classify it as no diff or parent work that must be preserved for child execution.
4. If the workspace contains parent diff, create a split checkpoint before child execution instead of carrying the dirty workspace into children.
5. A split checkpoint is a preservation commit, not a reviewed implementation commit and not task completion evidence. Use a clear message such as `checkpoint(split): preserve <task-id> dirty diff before decomposition`, record the checkpoint SHA in the parent notes and child-task plan, and state that child tasks must validate and finish the preserved work.
6. The first split work item must always be a repair/validation lane whose only goal is to make the preserved parent checkpoint compile and pass the configured test/full-suite command before any ordinary decomposed implementation child starts.
7. The repair/validation lane is a pre-decomposition stabilization lane, not a linked `TASK.md` child for `DECOMPOSED` routing. It must not create a normal commit, mark a task `DONE`, run completion/final closeout/release gates, or claim review evidence. Its compile/test result is advisory continuity evidence only; ordinary child tasks must rerun their own required gates later.
8. If the repair/validation lane needs file edits to make compile/tests pass, those edits remain unfinished implementation diff. Do not commit them, do not treat the workspace as a trusted clean baseline, and do not create linked child tasks yet; the first ordinary linked child must own that diff and execute through normal `next-step` review, doc-impact, full-suite, and completion gates before any implementation commit.
9. If compile/tests pass without repair edits, create ordinary linked child tasks, record the validation result in the parent notes or child-task plan, then rerun `next-step` on the parent so the gate transitions it to `DECOMPOSED`. If this parent is also backed by a strict decomposition `split-required` decision, every ordinary linked child must match the decision artifact, use a parent-derived id, exist as a `TASK.md` row, and keep profile `strict`. If repository policy or operator instructions prohibit checkpoint commits, stop and ask the operator to authorize either a checkpoint commit or an equivalent workflow-owned patch/checkpoint artifact that also restores a clean workspace.
10. Do not run new compile, review, full-suite, or completion gates on the parent merely to make an unfinished diff committable after this guard has fired.
11. Split the remaining parent objective into maximally small child tasks with parent-derived suffix task IDs. Allocate the next non-conflicting numeric suffix from `TASK.md`, starting from examples such as {{SUGGESTED_CHILD_TASK_IDS}}; do not consume unrelated global task numbers.
12. Execute the ordinary child tasks sequentially through next-step and mandatory gates only after the repair/validation lane has produced a passing compile/test result.

## Constraints
- Do not create a normal implementation commit for unfinished or unreviewed work.
- A split checkpoint commit is allowed only after this guard has blocked the parent, only to preserve the exact current parent diff and clean the workspace for child tasks, and only with explicit checkpoint wording.
- Do not treat a split checkpoint as review, completion, release readiness, or permission to skip child gates.
- Do not list the repair/validation lane as a linked child task in parent notes used for `DECOMPOSED` routing unless runtime has a first-class validation-only terminal contract.
- Do not treat a strict decomposition split as a strictness waiver; ordinary linked children for that path must remain strict-profile child tasks that match the recorded proposed-child list.
- Do not start ordinary decomposed child tasks before the repair/validation lane has produced a passing compile/test result.
- Do not use the repair/validation lane to implement additional feature scope; it may only identify or repair compile/test breakage caused by the preserved parent diff.
- Do not treat repair/validation edits as reviewed, completed, committable, or release-ready. Any file-changing repair work must be owned and completed by a later ordinary child task with normal gates.
- Do not run review/doc/completion gates inside the repair/validation lane; those belong to the later ordinary child tasks after the baseline is stable.
- Do not discard, revert, stash, shrink, or reshape parent diff only to bypass the guard; preserve operator work unless the operator explicitly chooses a reset or discard path.
- Do not start a child task on an unscoped dirty workspace. Prefer a clean workspace after the split checkpoint; use staged or explicit changed-file scope only for deliberate child-owned edits made after the checkpoint.
- Do not mark the parent DONE merely because child tasks were created.
- Do not leave the parent as ordinary `BLOCKED` when decomposition is the intended path. The supported route is `SPLIT_REQUIRED` until child tasks are linked, then gate-owned transition to `DECOMPOSED` so `next-step` routes to child tasks instead of stale parent recovery.
- Reviewer deferred follow-up tasks created from this parent should use deterministic parent-derived follow-up IDs such as {{SUGGESTED_FOLLOWUP_TASK_ID}}, choosing the next available `-F<n>` suffix from `TASK.md` when collisions exist.
- Preserve the original review-cycle block reason and counts in child-task notes or closeout where relevant.
- Keep test reviews excluded from the non-test review-cycle count unless workflow config changes explicitly.
- If splitting cannot proceed cleanly, stop and report the blocker to the operator.

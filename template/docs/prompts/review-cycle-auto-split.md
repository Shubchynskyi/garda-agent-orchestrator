# Review Cycle Auto-Split Prompt for {{TASK_ID}}

GuardReason: {{GUARD_REASON}}
Counts: total_non_test_reviews={{TOTAL_NON_TEST_REVIEWS}}; failed_non_test_reviews={{FAILED_NON_TEST_REVIEWS}}; excluded_review_types={{EXCLUDED_REVIEW_TYPES}}
LatestFailedReview: {{LATEST_FAILED_REVIEW}}
SuggestedChildTaskIds: {{SUGGESTED_CHILD_TASK_IDS}}
SuggestedReviewerFollowUpTaskId: {{SUGGESTED_FOLLOWUP_TASK_ID}}
LatchArtifact: {{LATCH_ARTIFACT}}
WipCapture: {{WIP_CAPTURE}}
CurrentState: {{CURRENT_STATE}}
WorkPackageContractPath: {{WORK_PACKAGE_CONTRACT_PATH}}
NextAction: {{NEXT_ACTION}}
NextActionCommand: {{NEXT_ACTION_COMMAND}}

## State Routes
StateRoute[no_diff]: next_action=run_validation_lane; command={{VALIDATION_LANE_COMMAND}}
StateRoute[suspended_manifest]: next_action=preview_restore; command={{RESTORE_PREVIEW_COMMAND}}
StateRoute[checkpoint]: next_action=inspect_checkpoint_scope; command={{CHECKPOINT_INSPECTION_COMMAND}}
StateRoute[restore]: next_action=restore_selected_work_package; command={{RESTORE_APPLY_COMMAND}}
StateRoute[validation_lane]: next_action=run_validation_lane; command={{VALIDATION_LANE_COMMAND}}
StateRoute[child_creation]: next_action=route_decomposed_parent; command={{CHILD_CREATION_COMMAND}}

## Instructions
1. Treat the current parent task as blocked by the review-cycle guard; do not continue compile, review, or full-suite gates on the parent as if the block did not exist.
2. Do not hand-edit the parent status. The guard should already have latched the parent as `SPLIT_REQUIRED`; do not rerun `next-step` on the parent to transition it to `DECOMPOSED` until the validation lane below has produced a passing compile/test baseline and ordinary linked child tasks are ready.
3. Follow `CurrentState`, `NextAction`, and `NextActionCommand`; they are derived from the completed latch and WIP capture result, not from a pre-capture workspace assumption.
4. For `no_diff`, the capture manifest is empty and the workspace is already clean. Do not create another checkpoint; run the validation-lane command.
5. For `suspended_manifest`: The parent implementation is suspended in the manifest and the captured paths were removed from the worktree. Preview restore before selecting work-package paths; do not create a redundant checkpoint.
6. For `checkpoint`, automatic WIP capture was unavailable. Inspect the scope first and preserve actual parent work through the repository-approved checkpoint or manifest route only when work is present; do not describe an uninspected workspace as dirty.
7. For `restore`, restore only the paths owned by the selected logical work package. Restored files are unfinished implementation, not review or completion evidence.
8. The `validation_lane` runs the configured full-suite command directly as advisory continuity evidence; do not wrap it in `run-intermediate-command`, whose command-source grammar may reject valid full-suite commands. It creates no linked child, implementation commit, review receipt, completion evidence, or release claim.
9. Before `child_creation`, write the root-cause work-package contract at `WorkPackageContractPath`. Group work by logical root cause or invariant, map every validated finding and downstream obligation to an owning package, and never create one child per finding.
10. Create ordinary linked child tasks with parent-derived suffix task IDs only after validation passes and the work-package contract is complete. Then rerun `next-step` on the parent so the gate transitions it to `DECOMPOSED`.
11. Before entering any ordinary child task, inspect the configured `workflow-config.full_suite_validation.command` against that child scope. If it still includes suspended sibling tests, retarget it through the existing audited workflow-config route before `enter-task-mode`; keep current-child tests covered, exclude suspended sibling tests, and leave an already-suitable command unchanged.
12. Do not run new compile, review, full-suite, completion, or final-closeout gates on the parent merely to make preserved work appear committable.
13. Execute ordinary child tasks sequentially through their own `next-step` and mandatory gates.

## Constraints
- Do not create a normal implementation commit for unfinished or unreviewed work.
- A split checkpoint is eligible only for `CurrentState: checkpoint`, after inspection confirms parent work and repository policy permits it; never checkpoint `no_diff` or already suspended manifest work.
- Do not treat a split checkpoint as review, completion, release readiness, or permission to skip child gates.
- Do not list the repair/validation lane as a linked child task in parent notes used for `DECOMPOSED` routing unless runtime has a first-class validation-only terminal contract.
- Do not treat a strict decomposition split as a strictness waiver; ordinary linked children for that path must remain strict-profile child tasks that match the recorded proposed-child list.
- Do not start ordinary decomposed child tasks before the repair/validation lane has produced a passing compile/test result.
- Do not use the repair/validation lane to implement additional feature scope; it may only identify or repair compile/test breakage caused by the preserved parent diff.
- Do not treat repair/validation edits as reviewed, completed, committable, or release-ready. Any file-changing repair work must be owned and completed by a later ordinary child task with normal gates.
- Do not run review/doc/completion gates inside the repair/validation lane; those belong to the later ordinary child tasks after the baseline is stable.
- Do not auto-edit workflow config, broaden a focused child test command to all project tests, skip operator approval for protected config changes, or retarget full-suite validation during an active child cycle.
- Do not discard, revert, stash, shrink, or reshape parent diff only to bypass the guard; preserve operator work unless the operator explicitly chooses a reset or discard path.
- Do not start a child task on an unscoped dirty workspace. Prefer the clean workspace produced by WIP capture or an approved checkpoint; use staged or explicit changed-file scope only for deliberate child-owned edits made afterward.
- Do not mark the parent DONE merely because child tasks were created.
- Do not leave the parent as ordinary `BLOCKED` when decomposition is the intended path. The supported route is `SPLIT_REQUIRED` until child tasks are linked, then gate-owned transition to `DECOMPOSED` so `next-step` routes to child tasks instead of stale parent recovery.
- Reviewer deferred follow-up tasks created from this parent should use deterministic parent-derived follow-up IDs such as {{SUGGESTED_FOLLOWUP_TASK_ID}}, choosing the next available `-F<n>` suffix from `TASK.md` when collisions exist.
- Preserve the original review-cycle block reason and counts in child-task notes or closeout where relevant.
- Keep test reviews excluded from the non-test review-cycle count unless workflow config changes explicitly.
- If splitting cannot proceed cleanly, stop and report the blocker to the operator.

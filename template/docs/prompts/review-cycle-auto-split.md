# Review Cycle Auto-Split Prompt for {{TASK_ID}}

GuardReason: {{GUARD_REASON}}
Counts: total_non_test_reviews={{TOTAL_NON_TEST_REVIEWS}}; failed_non_test_reviews={{FAILED_NON_TEST_REVIEWS}}; excluded_review_types={{EXCLUDED_REVIEW_TYPES}}
LatestFailedReview: {{LATEST_FAILED_REVIEW}}

## Instructions
1. Treat the current parent task as blocked by the review-cycle guard; do not continue compile, review, or full-suite gates on the parent as if the block did not exist.
2. Move the parent task into `DECOMPOSED` state through supported task controls when available, or by explicit backlog editing when no gate exists for that transition.
3. Decide whether any current committable diff should be committed only from completed and reviewed evidence; do not commit unfinished or unreviewed work.
4. Split the remaining parent objective into maximally small child tasks with normal numeric task IDs, not suffix IDs such as T-379-1.
5. Execute the child tasks sequentially through next-step and mandatory gates until the parent objective is fully handled.

## Constraints
- Do not auto-commit unfinished or unreviewed work.
- Do not mark the parent DONE merely because child tasks were created.
- Do not leave the parent as ordinary `BLOCKED` when decomposition is the intended path; use `DECOMPOSED` so `next-step` routes to child tasks instead of stale parent recovery.
- Preserve the original review-cycle block reason and counts in child-task notes or closeout where relevant.
- Keep test reviews excluded from the non-test review-cycle count unless workflow config changes explicitly.
- If splitting cannot proceed cleanly, stop and report the blocker to the operator.

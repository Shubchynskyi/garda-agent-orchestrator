# Stage Gates

## Gate 1: Task Selection
Pass criteria:
- Task exists in `TODO` before entry, and successful `enter-task-mode` reconciles it to `IN_PROGRESS`.

## Gate 2: Plan
Pass criteria:
- Plan covers scope, files, risks, and checks.

## Gate 3: Task-Mode Entry
Pass criteria:
- `node garda-agent-orchestrator/bin/garda.js gate enter-task-mode` result is pass.
- Task-mode artifact exists: `garda-agent-orchestrator/runtime/reviews/<task-id>-task-mode.json`.
- Task timeline contains `TASK_MODE_ENTERED`.

## Gate 4: Preflight Classification
Pass criteria:
- Preflight artifact exists: `garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json`.
- Path mode is declared by script output: `FAST_PATH` or `FULL_PATH`.
- Required reviews are declared by preflight output.

## Gate 5: Tests or Validation
Pass criteria:
- `FULL_PATH` runtime code: required tests defined and currently meaningful.
- `FAST_PATH` runtime code or non-runtime tasks: explicit validation checklist exists.

## Gate 6: Implementation
Pass criteria:
- Changes satisfy planned scope without unrelated edits.

## Gate 7: Checks
Pass criteria:
- Compile gate passed before review phase:
  - `node garda-agent-orchestrator/bin/garda.js gate compile-gate` result is pass.
  - Task-mode evidence is valid for the same task id.
  - Compile evidence artifact exists: `garda-agent-orchestrator/runtime/reviews/<task-id>-compile-gate.json`.
  - Task timeline contains `COMPILE_GATE_PASSED`.
  - No preflight scope drift is reported by compile gate.

## Gate 8: Independent Reviews
Pass criteria:
- Successful review-gate flow reconciles the task to `IN_REVIEW`.
- Code review verdict `REVIEW PASSED` when `required_reviews.code=true`, otherwise `NOT_REQUIRED`.
- DB review verdict `DB REVIEW PASSED` when `required_reviews.db=true`, otherwise `NOT_REQUIRED`.
- Security review verdict `SECURITY REVIEW PASSED` when `required_reviews.security=true`, otherwise `NOT_REQUIRED`.
- Refactor review verdict `REFACTOR REVIEW PASSED` when `required_reviews.refactor=true`, otherwise `NOT_REQUIRED`.
- Review artifacts satisfy `TASK.md` artifact contract.
- `node garda-agent-orchestrator/bin/garda.js gate required-reviews-check` result is pass.
- `required-reviews-check` compile-evidence check is pass for same task id.
- `required-reviews-check` task-mode check is pass for same task id.
- Review gate evidence artifact exists: `garda-agent-orchestrator/runtime/reviews/<task-id>-review-gate.json`.

## Gate 9: Documentation Finalization
Pass criteria:
- Documentation impact gate passed (`node garda-agent-orchestrator/bin/garda.js gate doc-impact-gate`).
- Documentation impact artifact exists: `garda-agent-orchestrator/runtime/reviews/<task-id>-doc-impact.json`.
- Required docs updated for impacted behavior.
- Changelog updated for runtime behavior changes.

## Gate 10: Completion
Pass criteria:
- All required gates passed.
- `node garda-agent-orchestrator/bin/garda.js gate completion-gate` result is pass.
- Timeline contains `TASK_MODE_ENTERED`.
- Timeline contains `COMPLETION_GATE_PASSED`.
- Final PASS review artifacts keep active `Findings by Severity` and `Residual Risks` empty (`none`), or record accepted non-blocking follow-up only in `Deferred Findings` with `Justification:`.
- Completion finalization reconciles the task to `DONE`.
- Artifact contract fields are valid for path mode, required verdicts, and evidence.
- User report is delivered in mandatory order: implementation summary -> conventional-style `git commit -m "<type>(<scope>): <summary>"` suggestion -> `Do you want me to commit now? (yes/no)`.

## Failure Policy
- Any failed gate blocks next gates.
- Stop in explicit `BLOCKED` workflow state when a gate cannot be satisfied now, but do not hand-edit the active `TASK.md` status cell to `BLOCKED` as a gate substitute.
- Use explicit `DECOMPOSED` state when the parent is no longer executable because remaining work was split into child tasks.
- Resume only after blocker is resolved.

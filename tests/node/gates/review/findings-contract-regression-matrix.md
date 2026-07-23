# Findings Contract Regression Matrix

This matrix records the focused regression that owns each T-979 findings-contract
obligation. It intentionally points to existing tests instead of repeating their
fixtures. T-979-44 owns the final end-to-end composition.

| Obligation | Focused regression evidence | Gap status |
|---|---|---|
| Active JSON schema and deterministic validation | `review-findings-schema.test.ts`: `review findings JSON schema models nested sections for machine validation`; `validateReviewFindingsContract returns one deterministic violation set for malformed findings and coverage` | Covered, including malformed evidence |
| Empty-findings success | `review-findings-schema.test.ts`: `validateReviewFindingsReport accepts empty findings only with complete coverage evidence`; `gates-command-review-result-normalization.test.ts`: `record-review-result materializes no-findings PASS output with substantive validation notes` | Covered |
| Multi-finding preservation | `gates-command-review-result-multiple-findings.test.ts`: `record-review-result preserves multiple verdict-free JSON findings through validation, disposition, and receipt` | Gap closed here |
| Locked profile policy and mixed dispositions | `profile-resolver.test.ts`: `resolveEffectivePolicy: balanced profile with defaults`; `review-findings-follow-up-tasks.test.ts`: `blocks mixed fix_now and follow-up dispositions before mutating TASK.md` | Covered |
| Grouped follow-up materialization | `review-findings-follow-up-tasks.test.ts`: `groups deferred items into one snapshot-bound pending child and reruns idempotently`; `next-step-review-failure-routing.test.ts`: `defers grouped follow-up materialization until every required review lane is satisfied` | Covered |
| Selective remediation and tamper rejection | `review-remediation-recovery-routing.test.ts`: `routes leaf remediation through focused validation and reruns only the current lane`; `review-remediation-validation-evidence.test.ts`: `detects command, result, baseline, delta, component, and aggregate hash tampering` | Covered |
| Explicit legacy migration | `profile-resolver.test.ts`: `resolveEffectivePolicy: legacy profile without review_finding_policy resolves fail-closed to strict`; `profile.test.ts`: `profile policy reports and materializes legacy migration without changing active task snapshots` | Covered |
| CLI and installed materialization parity | `review-follow-up-task-flow.test.ts`: `routes materialization through the exported command flow without reviewer TASK.md writes`; `templates.test.ts`: `built-in reviewer prompt and shipped findings schema match tracked templates`; `init.test.ts`: `copies support directories to live/` | Covered |

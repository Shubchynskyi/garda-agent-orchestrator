# Review Artifact Template

Use one file per review:
- `garda-agent-orchestrator/runtime/reviews/<task-id>-code-review.md`
- `garda-agent-orchestrator/runtime/reviews/<task-id>-db-review.md`
- `garda-agent-orchestrator/runtime/reviews/<task-id>-security-review.md`
- `garda-agent-orchestrator/runtime/reviews/<task-id>-refactor-review.md`
- `garda-agent-orchestrator/runtime/reviews/<task-id>-api-review.md`
- `garda-agent-orchestrator/runtime/reviews/<task-id>-test-review.md`
- `garda-agent-orchestrator/runtime/reviews/<task-id>-performance-review.md`
- `garda-agent-orchestrator/runtime/reviews/<task-id>-infra-review.md`
- `garda-agent-orchestrator/runtime/reviews/<task-id>-dependency-review.md`

Fill the review artifact as an immutable form:
- Replace placeholder lines only.
- Never add, remove, rename, reorder, or nest the required headings.
- Use canonical `None` exactly when `Findings by Severity`, `Deferred Findings`, or `Residual Risks` has no content.
- Use parser-supported severity formats only: `- High: ...` or `High:` followed by `- ...`.
- Do not use severity headings such as `### Medium`.
- Do not edit launcher, control, receipt, or review-context metadata instead of the designated reviewer output file.

Parser-valid examples (copy the shape only when applicable; do not copy example facts):
- Validation Notes example: `Reviewed src/review-parser.ts:42 and tests/review-parser.test.ts:17; checked parser-supported finding formats and rejection diagnostics.`
- Findings by Severity example: `- High: src/review-parser.ts:42 drops later findings; impact: incomplete review evidence; remediation: preserve every severity entry.`
- Deferred Findings example: `- [Low] docs/reviews.md:12 clarify reviewer wording. Next step: update docs in T-123. Justification: documentation-only follow-up is accepted after parser coverage.`
- Residual Risks example: `- Rollout risk: legacy review artifacts may still use old wording until regenerated; mitigation: parser tests cover both canonical None and supported finding formats.`

## Validation Notes
<REPLACE with 1-3 concrete sentences naming reviewed files, behavior boundaries, tests/checklists, and verification evidence; required for PASS>

## Findings by Severity
<REPLACE with canonical `None`, or parser-supported active findings using `- High: <file:line> <impact>; remediation: <required action>` / `High:` followed by `- <finding>`; do not use severity headings such as `### Medium`>

## Deferred Findings
<REPLACE with canonical `None`, or parser-supported deferred bullets like `- [Low] <summary with file evidence>. Next step: <action>. Justification: <why deferral is acceptable now>`>

## Residual Risks
<REPLACE with canonical `None`, or parser-supported residual-risk bullets like `- Rollout risk: <active open risk>; mitigation: <current mitigation>`>

## Verdict
<REPLACE with exactly one supported verdict token: `REVIEW PASSED`, `REVIEW FAILED`, `DB REVIEW PASSED`, `DB REVIEW FAILED`, `SECURITY REVIEW PASSED`, `SECURITY REVIEW FAILED`, `REFACTOR REVIEW PASSED`, `REFACTOR REVIEW FAILED`, `API REVIEW PASSED`, `API REVIEW FAILED`, `TEST REVIEW PASSED`, `TEST REVIEW FAILED`, `PERFORMANCE REVIEW PASSED`, `PERFORMANCE REVIEW FAILED`, `INFRA REVIEW PASSED`, `INFRA REVIEW FAILED`, `DEPENDENCY REVIEW PASSED`, or `DEPENDENCY REVIEW FAILED`>


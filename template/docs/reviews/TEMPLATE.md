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

## Metadata
- Task ID:
- Path Mode: `FAST_PATH | FULL_PATH`
- Preflight Artifact:
- Review Type: `CODE_REVIEW | DB_REVIEW | SECURITY_REVIEW | REFACTOR_REVIEW | API_REVIEW | TEST_REVIEW | PERFORMANCE_REVIEW | INFRA_REVIEW | DEPENDENCY_REVIEW`
- Agent Label:
- Agent ID:
- Date:

## Findings by Severity
- Critical: `none`
- High: `none`
- Medium: `none`
- Low: `none`

Use this section only for still-open findings in the current artifact. A final `... PASSED` artifact must leave every active severity bucket as `none`.

## Deferred Findings
- `none`

Use this section only when a non-blocking finding is intentionally deferred instead of fixed before `DONE`. Each deferred entry must be a bullet in this exact shape:
- `[<severity>] <summary with file evidence> | Justification: <why deferral is acceptable now>`

## Rule Checklist
| rule_id | status | evidence |
|---|---|---|

## Rule Coverage
- applicable_rule_ids:
- not_applicable_rule_ids:
- skipped_rule_reasons:

## Residual Risks
- `none`

For final `... PASSED` artifacts, keep this section `none`. Accepted follow-up risk belongs in `Deferred Findings`, not in active residual risk entries.

## Verdict
- `REVIEW PASSED | REVIEW FAILED | DB REVIEW PASSED | DB REVIEW FAILED | SECURITY REVIEW PASSED | SECURITY REVIEW FAILED | REFACTOR REVIEW PASSED | REFACTOR REVIEW FAILED | API REVIEW PASSED | API REVIEW FAILED | TEST REVIEW PASSED | TEST REVIEW FAILED | PERFORMANCE REVIEW PASSED | PERFORMANCE REVIEW FAILED | INFRA REVIEW PASSED | INFRA REVIEW FAILED | DEPENDENCY REVIEW PASSED | DEPENDENCY REVIEW FAILED`



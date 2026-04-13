# Review Trigger Matrix

## Path Mode
- `FULL_PATH` is default.
- `FAST_PATH` may be selected only by `node garda-agent-orchestrator/bin/garda.js gate classify-change`.
- If any specialized trigger below matches, `FAST_PATH` is disallowed.
- Path roots and regex trigger definitions are loaded from:
  `garda-agent-orchestrator/live/config/paths.json`.

## FAST_PATH Eligibility (UI-only minor runtime change)
All criteria must be true:
- changed files are only under configured `fast_path_roots`
- changed files match configured `fast_path_allowed_regexes`
- no auth/security/payment/token/webhook/service/repository/query/migration/SQL indicators in changed paths
  (`fast_path_sensitive_regexes`)
- changed files count is within preflight limit
- changed line count is within preflight limit

## Always Trigger Code Review
Trigger `$code-review` when changed files include runtime code-like files:
- file is under configured `runtime_roots`
- file matches configured `code_like_regexes`

## Trigger DB Review
Trigger `$db-review` if any changed file matches:
- configured DB trigger regexes (`triggers.db`) from `paths.json`
- plus service logic that changes query shape, transaction boundaries, or write/read routing

## Trigger Security Review
Trigger `$security-review` if changed files include auth, payments, or sensitive security paths:
- configured security trigger regexes (`triggers.security`) from `paths.json`
- service logic that changes authorization checks, token validation, payment authorization, or secret handling

## Trigger Refactor Review
Trigger `$refactor-review` if any condition is true:
- task title, task notes, or plan explicitly states behavior-preserving refactor intent (`refactor`, `cleanup`, `restructure`, `extract`, `rename`, `modularization`)
- preflight heuristic signals structural churn without domain trigger:
  - high rename ratio in changed files, or
  - balanced high add/delete churn across multiple runtime code files without DB/security triggers
- complexity reduction or SRP-driven decomposition is a stated objective

## Optional Specialist Review Triggers
- Optional triggers below become mandatory only when enabled in:
  `garda-agent-orchestrator/live/config/review-capabilities.json`.

### API Review
- Trigger key: `api`
- Trigger conditions:
  - configured API trigger regexes (`triggers.api`) from `paths.json`
  - API contract and interface changes

### Test Review
- Trigger key: `test`
- Trigger conditions:
  - configured test trigger regexes (`triggers.test`) from `paths.json`
  - assertion and mocking logic updates

### Performance Review
- Trigger key: `performance`
- Trigger conditions:
  - configured performance trigger regexes (`triggers.performance`) from `paths.json`
  - high query churn paths and potential unbounded operations
  - performance-sensitive backend hot paths
- Overlap with DB triggers is intentional when capability is enabled:
  DB review and performance review provide different risk lenses (data integrity vs runtime efficiency).

### Infra Review
- Trigger key: `infra`
- Trigger conditions:
  - configured infra trigger regexes (`triggers.infra`) from `paths.json`

### Dependency Review
- Trigger key: `dependency`
- Trigger conditions:
  - configured dependency trigger regexes (`triggers.dependency`) from `paths.json`




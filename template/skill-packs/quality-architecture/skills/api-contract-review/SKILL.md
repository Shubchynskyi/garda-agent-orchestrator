---
name: api-contract-review
description: >
  Reviews API and interface contracts for backward compatibility, schema correctness, and breaking-change risk.
  Use when a task touches OpenAPI/Swagger specs, protobuf/IDL definitions, GraphQL schemas, typed client contracts,
  request/response shapes, error envelopes, pagination interfaces, or versioning headers.
  Trigger phrases: api review, contract review, schema review, breaking change review.
  Do NOT use for purely internal module refactors that expose no external surface.
license: MIT
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(*)
  - Write
metadata:
  author: garda-agent-orchestrator
  version: 1.0.0
  domain: quality
  triggers: OpenAPI, Swagger, protobuf, GraphQL, typed API client, REST contract, gRPC, JSON Schema
  role: specialist
  scope: review
  output-format: review-findings
  related-skills: code-review, node-backend, dependency-review
---

# API Contract Review

## Core Workflow

1. **Identify contract surfaces.** Locate every file that defines an external or inter-service contract: OpenAPI/Swagger specs, `.proto` files, GraphQL schemas, typed request/response types, error envelopes, and generated client code.
2. **Diff against the previous version.** Compare the changed contract with its last committed state. Flag any field removal, type narrowing, required-field addition, enum value deletion, or status-code removal as a potential breaking change.
3. **Validate schema correctness.** Confirm that request and response schemas match handler/controller implementations: field names, types, nullability, default values, and collection wrappers are consistent across spec and code.
4. **Check versioning and evolution rules.** Verify that breaking changes increment the API version (URL prefix, header, or content-type parameter). Confirm additive changes (new optional fields, new enum values, new endpoints) do not require a version bump.
5. **Audit error shapes and status codes.** Ensure every error response uses a consistent envelope (`code`, `message`, and optional `details`). Verify that 4xx/5xx codes are semantically correct and that no endpoint silently returns 200 for failures.
6. **Review pagination, filtering, and idempotency.** Confirm paginated endpoints use stable cursor or offset semantics, filter parameters are validated and documented, and mutating endpoints declare idempotency keys where applicable.
7. **Cross-check integration tests.** Verify that contract-level integration or consumer-driven contract tests exist for each changed endpoint and that they assert on status codes, required fields, and error shapes.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Contract review checklist | `references/checklist.md` | Any API contract change or review |

## Mandatory Output Format

Return the generated output template, not a free-form summary. Treat it as an immutable fill-in form: replace placeholder lines only. Preserve these headings exactly and in this order; never add, remove, rename, reorder, or nest headings:
1. `## Validation Notes` - concrete reviewed API contract files, behavior, boundaries, and verification evidence; required for PASS.
2. `## Findings by Severity` - canonical `None`, or active blocking API findings with file references using parser-supported inline/list formats.
3. `## Deferred Findings` - canonical `None`, or accepted actionable API follow-ups with a concrete next step and `Justification:`.
4. `## Residual Risks` - canonical `None`, or active open API compatibility risks that remain after review.
5. `## Verdict` - exact verdict token: `API REVIEW PASSED` or `API REVIEW FAILED`.

Use only parser-supported finding formats under `## Findings by Severity`: `- High: <file:line> <impact>; remediation: <required action>` or `High:` followed by `- <finding>`. Do not use severity headings such as `### Medium`.

Parser-valid examples:
- Validation Notes: `Reviewed src/review-parser.ts:42 and tests/review-parser.test.ts:17; checked parser-supported finding formats and rejection diagnostics.`
- Findings by Severity: `- High: src/review-parser.ts:42 drops later findings; impact: incomplete review evidence; remediation: preserve every severity entry.`
- Deferred Findings: `- [Low] docs/reviews.md:12 clarify reviewer wording. Next step: update docs in T-123. Justification: documentation-only follow-up is accepted after parser coverage.`
- Residual Risks: `- Rollout risk: legacy review artifacts may still use old wording until regenerated; mitigation: parser tests cover both canonical None and supported finding formats.`

## Breaking Change Heuristics

A change is breaking if any existing correct consumer would fail or behave incorrectly after deployment. Common patterns:

- Removing or renaming a response field consumers may read.
- Changing a field from optional to required in a request body.
- Narrowing a type (e.g., `string` → `enum`, `number` → `integer`).
- Removing an enum value from a response field.
- Adding a required header or query parameter.
- Changing the semantic meaning of a status code.
- Altering pagination cursor encoding so existing cursors break.

When uncertain, treat the change as breaking and require explicit version bump or migration plan.

## Anti-Patterns

- **Spec-only review**: approving an OpenAPI, GraphQL, or protobuf diff without cross-checking the handler or controller implementation that actually serves it.
- **"Additive" change that is not additive**: new required headers, stricter enums, nullability shifts, or cursor format changes often break clients even when no endpoint is removed.
- **Error-shape drift**: preserving status codes but quietly changing error envelopes, field names, or validation payload structure in ways typed clients cannot tolerate.
- **Internal-consumer excuse**: skipping compatibility analysis because the API is "only used internally" even though internal clients still deploy on different schedules.

## Exhaustive Review Contract
- Complete the entire assigned review scope before returning a verdict. A finding at any severity does not end the review.
- Continue through every in-scope file, behavior boundary, test, and applicable checklist or rule category, then report every distinct evidence-supported finding in the same result.
- Deduplicate findings that share one root cause. For every distinct finding include severity, file and line evidence, impact, and required remediation; never invent or pad findings to reach a count.
- On remediation reviews, re-sweep the complete current assigned scope instead of checking only previously reported findings.
- Validation Notes must name the files, behavior boundaries, tests, and checklist or rule categories actually reviewed.
- Do not widen the assigned scope. This is a process-completeness requirement, not a guarantee that every latent defect will be discovered.

## Constraints

- Do not approve contract changes that lack a diff against the prior committed version.
- Do not accept undocumented nullability changes; every nullable field must be explicitly marked.
- Do not permit silent type widening in request schemas (consumers may send unexpected data).
- Do not skip error-shape review; inconsistent error envelopes are a high-severity finding.
- Treat any removal of a public field, endpoint, or enum value as a hard-fail unless gated behind a version bump or deprecation window.

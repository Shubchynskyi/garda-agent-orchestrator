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

## Constraints

- Do not approve contract changes that lack a diff against the prior committed version.
- Do not accept undocumented nullability changes; every nullable field must be explicitly marked.
- Do not permit silent type widening in request schemas (consumers may send unexpected data).
- Do not skip error-shape review; inconsistent error envelopes are a high-severity finding.
- Treat any removal of a public field, endpoint, or enum value as a hard-fail unless gated behind a version bump or deprecation window.

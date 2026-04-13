---
name: testing-strategy
description: Shapes risk-based test strategy for code changes. Use when deciding what to test, balancing test layers, improving fixture quality, targeting regressions, or controlling flakiness. Triggers — "test plan", "which tests to write", "coverage gap", "flaky", "regression". Negative trigger — routine single-unit-test additions with no strategy questions.
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
  triggers: test plan, test strategy, coverage gap, regression, flaky test, fixture, test data, contract test, integration test balance
  role: specialist
  scope: review-and-advisory
  output-format: findings-and-checklist
  related-skills: orchestration, code-review, architecture-review
---

# Testing Strategy

## Core Workflow

1. **Identify the risk surface.** List changed modules and their outbound contracts (APIs, events, persistence, UI entry points). Rank each by blast radius — a shared service adapter outranks a leaf utility.
2. **Map existing coverage.** Locate test files that exercise the changed paths. Note missing layers: if only unit tests exist for a module with external integrations, flag the gap.
3. **Select the right test layer per risk.**
   - **Contract / API tests** — for any change to a public interface, schema, or serialized format.
   - **Integration tests** — for persistence, external calls, queue interactions, or multi-module flows.
   - **Unit tests** — for pure logic, transformations, and edge-case branches.
   - **E2E / smoke tests** — only when user-facing workflows or critical paths are affected.
4. **Evaluate fixtures and test data.** Verify that existing fixtures reflect production-realistic shapes. Flag hardcoded IDs, missing nullable fields, or stale schema snapshots.
5. **Check for flakiness vectors.** Review time-dependent assertions, uncontrolled network calls, shared mutable state, test ordering dependencies, and non-deterministic data.
6. **Recommend a minimal effective test set.** Prioritize high-risk paths over exhaustive low-value coverage. State explicitly which paths do not need new tests and why.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Strategy checklist | `references/checklist.md` | Any test-strategy decision or review |

## Anti-Patterns

- **Coverage target as strategy**: treating line coverage percentage as the goal instead of asking which failures actually matter.
- **Redundant layer overlap**: asserting the same field or branch in unit, integration, and end-to-end tests without increasing defect-detection value.
- **Mock-only confidence**: using pure unit tests to "prove" correctness for integration-heavy code that actually fails at boundaries.
- **Permanent flaky quarantine**: moving unstable tests out of the main path without a plan to fix or replace the lost signal.

## Constraints

- Do not demand 100 % line coverage; optimize for defect-detection value per test.
- Do not duplicate assertions across layers — if a contract test covers a field, the unit test should not re-check serialization.
- Do not treat mocks as proof of correctness; prefer narrow real integrations when setup cost is low.
- Do not ignore flakiness; a flaky test that is skipped is worse than no test because it erodes signal trust.
- Avoid snapshot tests for volatile output; prefer structural assertions.
- Never recommend tests that depend on execution order or shared external state without explicit isolation.

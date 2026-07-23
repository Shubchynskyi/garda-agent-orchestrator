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

## Generated Findings-Only Handoff
When orchestration supplies generated role-prompt, prompt-template, reviewer-prompt, output-template, and evidence-manifest artifacts, those artifacts are the sole instruction and output-format authority. Use this skill only as the assigned review lens/checklist. Never modify source files, control artifacts, or task state, and never launch another agent; the only permitted write is the exact `ReviewOutputPath`. Return exactly one findings-only JSON object, complete the entire assigned scope and every coverage-ledger obligation, and do not add verdict, pass/fail, status, downstream disposition, or remediation fields. Any verdict-oriented text below is historical audit-only guidance and never applies to generated or other new review cycles.

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

## Mandatory Output Format

When this skill is selected for a mandatory `test` review, return the generated output template, not a free-form summary. Treat it as an immutable fill-in form: replace placeholder lines only. Preserve these required `##` headings exactly and in this order; never add, remove, rename, reorder, or nest the required `##` headings:
1. `## Validation Notes` - concrete reviewed test files, behavior, boundaries, and verification evidence; required for PASS.
2. `## Findings by Severity` - canonical `None`, or active blocking test findings with file references using parser-supported inline/list/subheading formats.
3. `## Deferred Findings` - canonical `None`, or accepted actionable test follow-ups with a concrete next step and `Justification:`.
4. `## Residual Risks` - canonical `None`, or active open testing risks that remain after review.
5. `## Verdict` - exact verdict token: `TEST REVIEW PASSED` or `TEST REVIEW FAILED`.

Use parser-supported finding formats under `## Findings by Severity`: `- High: <file:line> <impact>; remediation: <required action>`, `High:` followed by `- <finding>`, or `### High` followed by `- <finding>`. Severity subheadings are allowed only inside `## Findings by Severity`.

Parser-valid examples:
- Validation Notes: `Reviewed src/review-parser.ts:42 and tests/review-parser.test.ts:17; checked parser-supported finding formats and rejection diagnostics.`
- Findings by Severity: `- High: src/review-parser.ts:42 drops later findings; impact: incomplete review evidence; remediation: preserve every severity entry.`
- Severity subheading: `### Medium` followed by `- tests/review-parser.test.ts:17 misses hierarchy coverage; impact: nested findings can be lost; remediation: cover severity subheadings.`
- Deferred Findings: `- [Low] docs/reviews.md:12 clarify reviewer wording. Next step: update docs in T-123. Justification: documentation-only follow-up is accepted after parser coverage.`
- Residual Risks: `- Rollout risk: legacy review artifacts may still use old wording until regenerated; mitigation: parser tests cover both canonical None and supported finding formats.`

## Anti-Patterns

- **Coverage target as strategy**: treating line coverage percentage as the goal instead of asking which failures actually matter.
- **Redundant layer overlap**: asserting the same field or branch in unit, integration, and end-to-end tests without increasing defect-detection value.
- **Mock-only confidence**: using pure unit tests to "prove" correctness for integration-heavy code that actually fails at boundaries.
- **Permanent flaky quarantine**: moving unstable tests out of the main path without a plan to fix or replace the lost signal.

## Exhaustive Review Contract
- Complete the entire assigned review scope before returning a verdict. A finding at any severity does not end the review.
- Continue through every in-scope file, behavior boundary, test, and applicable checklist or rule category, then report every distinct evidence-supported finding in the same result.
- Deduplicate findings that share one root cause. For every distinct finding include severity, file and line evidence, impact, and required remediation; never invent or pad findings to reach a count.
- On remediation reviews, re-sweep the complete current assigned scope instead of checking only previously reported findings.
- Validation Notes must name the files, behavior boundaries, tests, and checklist or rule categories actually reviewed.
- Do not widen the assigned scope. This is a process-completeness requirement, not a guarantee that every latent defect will be discovered.

## Constraints

- Do not demand 100 % line coverage; optimize for defect-detection value per test.
- Do not duplicate assertions across layers — if a contract test covers a field, the unit test should not re-check serialization.
- Do not treat mocks as proof of correctness; prefer narrow real integrations when setup cost is low.
- Do not ignore flakiness; a flaky test that is skipped is worse than no test because it erodes signal trust.
- Avoid snapshot tests for volatile output; prefer structural assertions.
- Never recommend tests that depend on execution order or shared external state without explicit isolation.

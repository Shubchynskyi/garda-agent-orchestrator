---
name: db-review
description: Independent database risk review with strict pass/fail verdict. Use for requests like "DB review", "review migration", "SQL safety check", or when preflight requires db review. Do NOT use for generic code-style-only feedback.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(*)
  - Write
metadata:
  author: garda-agent-orchestrator
  version: 1.0.0
  runtime_requirement: Node.js 24 baseline for public CLI and gate commands
---

# DB Review

Use this skill for independent database risk assessment.
Prioritize correctness, performance, and data safety.

## Required Inputs
- Task goal and expected DB behavior.
- Changed files list and diff.
- Migration files and repository/query changes.
- Optional review-context artifact from orchestration: `garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-context.json`.
- Rule context package selected by orchestration and explicitly passed to reviewer:
  - token economy active + `depth=1`: only `00-core.md`, `80-task-workflow.md`, and DB-triggered rule ids/snippets for changed scope.
  - token economy active + `depth=2`: `00-core.md`, `35-strict-coding-rules.md`, `70-security.md`, `80-task-workflow.md`.
  - token economy disabled or `depth=3`: full required DB rule set for changed scope.

## Token Economy Mode
- Config source: `garda-agent-orchestrator/live/config/token-economy.json`.
- Apply this section only when `enabled=true` and effective depth is in `enabled_depths`.
- Default policy keeps `enabled_depths=[1,2]`, so `depth=3` follows full review behavior.
- If a deployment explicitly includes `3` in `enabled_depths`, keep the full review scope and allow only non-scope-reducing compaction (for example stripped examples/code blocks or compact reviewer artifacts).
- While active, this section takes precedence over any static rule-file list in `Required Inputs`.
- If orchestration provides review-context artifact, treat its `rule_pack.selected_rule_files`, `rule_pack.omitted_rule_files`, `token_economy.omitted_sections`, nested `rule_context.*`, and `scoped_diff` fallback metadata as the source of truth for compact DB review scope.
- When `rule_context.artifact_path` is present, use that markdown snapshot as the primary rule text instead of reloading raw rule files.
- Depth-aware required-rules behavior:
  - `depth=1`: evaluate required DB rules directly triggered by changed scope first; avoid unrelated rule expansion and full static rule loading.
  - `depth=2`: evaluate the full required DB checklist for changed scope.
  - other depths: follow full review behavior; if `depth=3` is explicitly enabled, only non-scope-reducing compaction may still apply.
- Compact mode contract:
  - when `compact_reviewer_output=true`, keep the same mandatory output sections and exact verdict token.
  - keep findings concise (`risk -> evidence -> required action`) and move detail overflow to residual DB risks.
  - when including failing command/test snippets, cap pasted tail output to `fail_tail_lines`.
  - review/completion gates may emit non-blocking warnings if the artifact exceeds compactness budgets or still contains stripped example markers.

## Review Workflow
1. Detect DB-impact scope using `references/db-trigger-matrix.md`.
2. Review migrations for safety, rollback implications, and compatibility.
3. Review queries for N+1, full scans, index usage risks, and lock risks.
4. Review transaction boundaries and read/write routing consistency.
5. Review data integrity, constraints, and idempotency implications.
6. Use artifact structure from `garda-agent-orchestrator/live/docs/reviews/TEMPLATE.md`.
7. Produce final DB verdict.

## Mandatory Output Format
Return the generated output template, not a free-form summary. Preserve these headings exactly and in this order:
1. `## Validation Notes` - concrete reviewed DB files, behavior, boundaries, and verification evidence; required for PASS.
2. `## Findings by Severity` - active blocking DB findings with file references, or `none`.
3. `## Deferred Findings` - accepted actionable DB follow-ups with a concrete next step and `Justification:`, or `none`.
4. `## Residual Risks` - active open DB risks that remain after review, or `none`.
5. `## Verdict` - exact verdict token: `DB REVIEW PASSED` or `DB REVIEW FAILED`.

## Hard Fail Conditions
Return `DB REVIEW FAILED` when any item is true:
- Migration safety risk can cause data loss without mitigation.
- Query path likely causes N+1 or unbounded scan on hot path.
- Required index strategy is missing for critical filter/sort path.
- Transaction semantics are ambiguous or inconsistent with data guarantees.
- Evidence is missing or non-auditable.

## Evidence Rules
- Attach file:line references for each finding.
- For performance claims, provide concrete query path and why risk exists.
- For index recommendations, specify query columns and expected index pattern.

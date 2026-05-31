---
name: code-review
description: Independent runtime code review with strict pass/fail verdict and auditable evidence. Use for requests like "code review", "review this diff", "review PR", "review before merge", or when preflight requires code review. Do NOT use for architecture brainstorming without concrete code changes.
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

# Code Review

Use this skill to produce a release-blocking technical review.
Review for defects and risks first. Keep summary secondary.

## Required Inputs
- Task goal and expected behavior.
- Changed files list.
- Diff summary or patch.
- Inspection output for changed files when available (for example IntelliJ IDEA / JetBrains inspections, Qodana, compiler warnings, or linter warnings).
- Optional review-context artifact from orchestration: `garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-context.json`.
- Rule context package selected by orchestration and explicitly passed to reviewer:
  - token economy active + `depth=1`: only `00-core.md`, `80-task-workflow.md`, and rule ids/snippets directly triggered by changed scope.
  - token economy active + `depth=2`: `00-core.md`, `35-strict-coding-rules.md`, `50-structure-and-docs.md`, `70-security.md`, `80-task-workflow.md`.
  - token economy disabled or `depth=3`: full required rule set for code review scope.

## Token Economy Mode
- Config source: `garda-agent-orchestrator/live/config/token-economy.json`.
- Apply this section only when `enabled=true` and effective depth is in `enabled_depths`.
- Default policy keeps `enabled_depths=[1,2]`, so `depth=3` follows full review behavior.
- If a deployment explicitly includes `3` in `enabled_depths`, keep the full review scope and allow only non-scope-reducing compaction (for example stripped examples/code blocks or compact reviewer artifacts).
- While active, this section takes precedence over any static rule-file list in `Required Inputs`.
- If orchestration provides review-context artifact, treat its `rule_pack.selected_rule_files`, `rule_pack.omitted_rule_files`, `token_economy.omitted_sections`, and nested `rule_context.*` metadata as the source of truth for compact review scope and omission evidence.
- When `rule_context.artifact_path` is present, use that markdown snapshot as the primary rule text instead of reloading raw rule files.
- Depth-aware required-rules behavior:
  - `depth=1`: evaluate only required rules directly triggered by changed scope; do not request full static rule bundle; list deferred required rules in `not_applicable_rule_ids` with reason `deferred_by_depth`.
  - `depth=2`: evaluate all required code-review rules for changed scope.
  - other depths: follow full review behavior; if `depth=3` is explicitly enabled, only non-scope-reducing compaction may still apply.
- Compact mode contract:
  - when `compact_reviewer_output=true`, keep the same mandatory output sections and exact verdict token.
  - keep findings concise (`risk -> evidence -> required action`) and move detail overflow to residual risks.
  - when including failing command/test snippets, cap pasted tail output to `fail_tail_lines`.
  - review/completion gates may emit non-blocking warnings if the artifact exceeds compactness budgets or still contains stripped example markers.

## Review Workflow
1. Build scope from changed files and diff.
2. Load checklist from `references/code-review-checklist.md`.
3. Validate correctness, regressions, edge cases, and security impact.
4. Validate static hygiene for changed scope: unused imports, unused variables, and unresolved changed-scope inspection warnings when tooling output is available.
5. Validate test coverage adequacy for changed behavior.
6. Validate documentation impact handling and required doc updates.
7. Validate rule compliance using rule ids and evidence.
8. Use artifact structure from `garda-agent-orchestrator/live/docs/reviews/TEMPLATE.md`.
9. Produce final verdict.

## Mandatory Output Format
Return the generated output template, not a free-form summary. Preserve these headings exactly and in this order:
1. `## Validation Notes` - concrete reviewed files, behavior, boundaries, and verification evidence; required for PASS.
2. `## Findings by Severity` - active blocking findings with file references, or `none`.
3. `## Deferred Findings` - accepted actionable follow-ups with a concrete next step and `Justification:`, or `none`.
4. `## Residual Risks` - active open risks or testing gaps that remain after review, or `none`.
5. `## Verdict` - exact verdict token: `REVIEW PASSED` or `REVIEW FAILED`.

`CODE REVIEW PASSED` and `CODE REVIEW FAILED` remain accepted legacy code-review aliases where the orchestrator supports them, but generated templates should use `REVIEW PASSED` or `REVIEW FAILED`.

## Hard Fail Conditions
Return `REVIEW FAILED` when any item is true:
- Unresolved critical or high-severity finding exists.
- Required tests are missing for runtime behavior changes.
- Rule checklist has `FAIL` without approved exception artifact.
- Rule checklist or coverage declaration is incomplete for applicable non-automated rules.
- Evidence is missing or non-auditable.

## Evidence Rules
- Use file references with line numbers when possible.
- If referencing command checks, include exact command and key output snippet.
- When available, prefer IntelliJ IDEA / JetBrains inspection, compiler, or linter evidence for changed files; unresolved changed-scope warnings require either a FAIL or explicit justification.
- If exception is used, include the exception artifact location and rule id.

## Escalation
- Escalation triggers are defined only in `garda-agent-orchestrator/live/skills/orchestration/references/review-trigger-matrix.md`.
- Do not duplicate trigger rules in this skill.

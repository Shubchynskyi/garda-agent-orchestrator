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

## Generated Findings-Only Handoff
When orchestration supplies generated role-prompt, prompt-template, reviewer-prompt, output-template, and evidence-manifest artifacts, those artifacts are the sole instruction and output-format authority. Use this skill only as the assigned review lens/checklist. Never modify source files, control artifacts, or task state, and never launch another agent; the only permitted write is the exact `ReviewOutputPath`. Return exactly one findings-only JSON object, complete the entire assigned scope and every coverage-ledger obligation, and do not add verdict, pass/fail, status, downstream disposition, or remediation fields. Any verdict-oriented text below is historical audit-only guidance and never applies to generated or other new review cycles.

Use this skill for independent database risk assessment.
Prioritize correctness, performance, and data safety.

## Required Inputs
- Task goal and expected DB behavior.
- Changed files list and diff.
- Migration files and repository/query changes.
- Optional review-context artifact from orchestration: `garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-context.json`.
- Review-only rule context selected and explicitly passed by orchestration; do not load task-lifecycle rules or commands independently.

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

## Exhaustive Review Contract
- Complete the entire assigned review scope before returning a verdict. A finding at any severity does not end the review.
- Continue through every in-scope file, behavior boundary, test, and applicable checklist or rule category, then report every distinct evidence-supported finding in the same result.
- Deduplicate findings that share one root cause. For every distinct finding include severity, file and line evidence, impact, and required remediation; never invent or pad findings to reach a count.
- On remediation reviews, re-sweep the complete current assigned scope instead of checking only previously reported findings.
- Validation Notes must name the files, behavior boundaries, tests, and checklist or rule categories actually reviewed.
- Do not widen the assigned scope. This is a process-completeness requirement, not a guarantee that every latent defect will be discovered.

## Mandatory Output Format
Return the generated output template, not a free-form summary. Treat it as an immutable fill-in form: replace placeholder lines only. Preserve these required `##` headings exactly and in this order; never add, remove, rename, reorder, or nest the required `##` headings:
1. `## Validation Notes` - concrete reviewed DB files, behavior, boundaries, and verification evidence; required for PASS.
2. `## Findings by Severity` - canonical `None`, or active blocking DB findings with file references using parser-supported inline/list/subheading formats.
3. `## Deferred Findings` - canonical `None`, or accepted actionable DB follow-ups with a concrete next step and `Justification:`.
4. `## Residual Risks` - canonical `None`, or active open DB risks that remain after review.
5. `## Verdict` - exact verdict token: `DB REVIEW PASSED` or `DB REVIEW FAILED`.

Use parser-supported finding formats under `## Findings by Severity`: `- High: <file:line> <impact>; remediation: <required action>`, `High:` followed by `- <finding>`, or `### High` followed by `- <finding>`. Severity subheadings are allowed only inside `## Findings by Severity`.

Parser-valid examples:
- Validation Notes: `Reviewed src/review-parser.ts:42 and tests/review-parser.test.ts:17; checked parser-supported finding formats and rejection diagnostics.`
- Findings by Severity: `- High: src/review-parser.ts:42 drops later findings; impact: incomplete review evidence; remediation: preserve every severity entry.`
- Severity subheading: `### Medium` followed by `- tests/review-parser.test.ts:17 misses hierarchy coverage; impact: nested findings can be lost; remediation: cover severity subheadings.`
- Deferred Findings: `- [Low] docs/reviews.md:12 clarify reviewer wording. Next step: update docs in T-123. Justification: documentation-only follow-up is accepted after parser coverage.`
- Residual Risks: `- Rollout risk: legacy review artifacts may still use old wording until regenerated; mitigation: parser tests cover both canonical None and supported finding formats.`

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

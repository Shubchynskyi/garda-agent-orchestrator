---
name: refactor-review
description: Independent refactor safety review for behavior-preserving changes with strict pass/fail verdict. Use for requests like "refactor review", "cleanup review", "restructure review", or when preflight requires refactor review. Do NOT use for feature-design discussions without behavior-preservation scope.
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

# Refactor Review

## Generated Findings-Only Handoff
When orchestration supplies generated role-prompt, prompt-template, reviewer-prompt, output-template, and evidence-manifest artifacts, those artifacts are the sole instruction and output-format authority and override legacy workflow or verdict-oriented text below. Use this skill only as the assigned review lens/checklist. Never modify source files, control artifacts, or task state, and never launch another agent; the only permitted write is the exact `ReviewOutputPath`. Return exactly one findings-only JSON object, complete the entire assigned scope and every coverage-ledger obligation, and do not add verdict, pass/fail, status, downstream disposition, or remediation fields.

Use this skill for independent refactor safety assessment.
Primary goal is behavior preservation with lower maintenance risk.

## Required Inputs
- Task goal and explicit statement that behavior should remain unchanged.
- Changed files list and diff.
- Relevant tests and verification scope.
- Inspection output for changed files when available (for example IntelliJ IDEA / JetBrains inspections, Qodana, compiler warnings, or linter warnings).
- Optional review-context artifact from orchestration: `garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-context.json`.
- Review-only rule context selected and explicitly passed by orchestration; do not load task-lifecycle rules or commands independently.

## Token Economy Mode
- Config source: `garda-agent-orchestrator/live/config/token-economy.json`.
- Apply this section only when `enabled=true` and effective depth is in `enabled_depths`.
- Default policy keeps `enabled_depths=[1,2]`, so `depth=3` follows full review behavior.
- If a deployment explicitly includes `3` in `enabled_depths`, keep the full review scope and allow only non-scope-reducing compaction (for example stripped examples/code blocks or compact reviewer artifacts).
- While active, this section takes precedence over any static rule-file list in `Required Inputs`.
- If orchestration provides review-context artifact, treat its `rule_pack.selected_rule_files`, `rule_pack.omitted_rule_files`, `token_economy.omitted_sections`, and nested `rule_context.*` metadata as the source of truth for compact refactor review scope and omission evidence.
- When `rule_context.artifact_path` is present, use that markdown snapshot as the primary rule text instead of reloading raw rule files.
- Depth-aware required-rules behavior:
  - `depth=1`: evaluate required refactor rules directly triggered by changed scope first; avoid unrelated rule expansion and full static rule loading.
  - `depth=2`: evaluate the full required refactor checklist for changed scope.
  - other depths: follow full review behavior; if `depth=3` is explicitly enabled, only non-scope-reducing compaction may still apply.
- Compact mode contract:
  - when `compact_reviewer_output=true`, keep the same mandatory output sections and exact verdict token.
  - keep findings concise (`risk -> evidence -> required action`) and move detail overflow to residual risks.
  - when including failing command/test snippets, cap pasted tail output to `fail_tail_lines`.
  - review/completion gates may emit non-blocking warnings if the artifact exceeds compactness budgets or still contains stripped example markers.

## Review Workflow
1. Detect refactor-impact scope using canonical trigger matrix:
   `garda-agent-orchestrator/live/skills/orchestration/references/review-trigger-matrix.md`.
2. Load checklist from `references/refactor-review-checklist.md`.
3. Validate behavior preservation for public contracts and user-visible flows.
4. Validate that refactor reduced complexity or coupling without hidden regressions.
5. Validate static hygiene for changed scope: unused imports, unused variables, stale helpers, and unresolved changed-scope inspection warnings when tooling output is available.
6. Validate test adequacy for refactored paths.
7. Use artifact structure from `garda-agent-orchestrator/live/docs/reviews/TEMPLATE.md`.
8. Produce final refactor verdict.

## Exhaustive Review Contract
- Complete the entire assigned review scope before returning a verdict. A finding at any severity does not end the review.
- Continue through every in-scope file, behavior boundary, test, and applicable checklist or rule category, then report every distinct evidence-supported finding in the same result.
- Deduplicate findings that share one root cause. For every distinct finding include severity, file and line evidence, impact, and required remediation; never invent or pad findings to reach a count.
- On remediation reviews, re-sweep the complete current assigned scope instead of checking only previously reported findings.
- Validation Notes must name the files, behavior boundaries, tests, and checklist or rule categories actually reviewed.
- Do not widen the assigned scope. This is a process-completeness requirement, not a guarantee that every latent defect will be discovered.

## Mandatory Output Format
Return the generated output template, not a free-form summary. Treat it as an immutable fill-in form: replace placeholder lines only. Preserve these required `##` headings exactly and in this order; never add, remove, rename, reorder, or nest the required `##` headings:
1. `## Validation Notes` - concrete reviewed refactor files, behavior, boundaries, and verification evidence; required for PASS.
2. `## Findings by Severity` - canonical `None`, or active blocking refactor findings with file references using parser-supported inline/list/subheading formats.
3. `## Deferred Findings` - canonical `None`, or accepted actionable refactor follow-ups with a concrete next step and `Justification:`.
4. `## Residual Risks` - canonical `None`, or active open behavior-preservation or rollback risks that remain after review.
5. `## Verdict` - exact verdict token: `REFACTOR REVIEW PASSED` or `REFACTOR REVIEW FAILED`.

Use parser-supported finding formats under `## Findings by Severity`: `- High: <file:line> <impact>; remediation: <required action>`, `High:` followed by `- <finding>`, or `### High` followed by `- <finding>`. Severity subheadings are allowed only inside `## Findings by Severity`.

Parser-valid examples:
- Validation Notes: `Reviewed src/review-parser.ts:42 and tests/review-parser.test.ts:17; checked parser-supported finding formats and rejection diagnostics.`
- Findings by Severity: `- High: src/review-parser.ts:42 drops later findings; impact: incomplete review evidence; remediation: preserve every severity entry.`
- Severity subheading: `### Medium` followed by `- tests/review-parser.test.ts:17 misses hierarchy coverage; impact: nested findings can be lost; remediation: cover severity subheadings.`
- Deferred Findings: `- [Low] docs/reviews.md:12 clarify reviewer wording. Next step: update docs in T-123. Justification: documentation-only follow-up is accepted after parser coverage.`
- Residual Risks: `- Rollout risk: legacy review artifacts may still use old wording until regenerated; mitigation: parser tests cover both canonical None and supported finding formats.`

## Hard Fail Conditions
Return `REFACTOR REVIEW FAILED` when any item is true:
- Public contract or behavior changed without explicit requirement update.
- Refactor introduced hidden side effects or regression risk without coverage.
- Refactor increases complexity without clear justification.
- Evidence is missing or non-auditable.

## Evidence Rules
- Use file references with line numbers for findings.
- Link each FAIL to specific behavior or contract risk.
- When available, prefer IntelliJ IDEA / JetBrains inspection, compiler, or linter evidence for changed files; unresolved changed-scope warnings require either a FAIL or explicit justification.
- Include remediation suggestions per blocking finding.

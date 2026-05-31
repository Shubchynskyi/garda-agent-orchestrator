---
name: security-review
description: Independent security risk review with strict pass/fail verdict. Use for requests like "security review", "auth review", "webhook hardening", "secret handling review", or when preflight requires security review. Do NOT use for non-security product design discussions.
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

# Security Review

Use this skill for independent security risk assessment.
Prioritize exploitability, authorization integrity, and payment safety.

## Required Inputs
- Task goal and expected secure behavior.
- Changed files list and diff.
- Auth, payment, webhook, and secret-related code changes.
- Optional review-context artifact from orchestration: `garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-context.json`.
- Rule context package selected by orchestration and explicitly passed to reviewer:
  - token economy active + `depth=1`: only `00-core.md`, `80-task-workflow.md`, and security-triggered rule ids/snippets for changed scope.
  - token economy active + `depth=2`: `00-core.md`, `35-strict-coding-rules.md`, `70-security.md`, `80-task-workflow.md`.
  - token economy disabled or `depth=3`: full required security rule set for changed scope.

## Token Economy Mode
- Config source: `garda-agent-orchestrator/live/config/token-economy.json`.
- Apply this section only when `enabled=true` and effective depth is in `enabled_depths`.
- Default policy keeps `enabled_depths=[1,2]`, so `depth=3` follows full review behavior.
- If a deployment explicitly includes `3` in `enabled_depths`, keep the full review scope and allow only non-scope-reducing compaction (for example stripped examples/code blocks or compact reviewer artifacts).
- While active, this section takes precedence over any static rule-file list in `Required Inputs`.
- If orchestration provides review-context artifact, treat its `rule_pack.selected_rule_files`, `rule_pack.omitted_rule_files`, `token_economy.omitted_sections`, nested `rule_context.*`, and `scoped_diff` fallback metadata as the source of truth for compact security review scope.
- When `rule_context.artifact_path` is present, use that markdown snapshot as the primary rule text instead of reloading raw rule files.
- Depth-aware required-rules behavior:
  - `depth=1`: evaluate required security rules directly triggered by changed scope first; avoid unrelated rule expansion and full static rule loading.
  - `depth=2`: evaluate the full required security checklist for changed scope.
  - other depths: follow full review behavior; if `depth=3` is explicitly enabled, only non-scope-reducing compaction may still apply.
- Compact mode contract:
  - when `compact_reviewer_output=true`, keep the same mandatory output sections and exact verdict token.
  - keep findings concise (`risk -> evidence -> required action`) and move detail overflow to residual risks.
  - when including failing command/test snippets, cap pasted tail output to `fail_tail_lines`.
  - review/completion gates may emit non-blocking warnings if the artifact exceeds compactness budgets or still contains stripped example markers.

## Review Workflow
1. Detect security-impact scope using canonical trigger matrix:
   `garda-agent-orchestrator/live/skills/orchestration/references/review-trigger-matrix.md`.
2. Validate authentication and token validation flows.
3. Validate authorization checks at service boundaries.
4. Validate payment authorization, webhook authenticity, and idempotency controls.
5. Validate secret handling and sensitive data exposure risks.
6. Use artifact structure from `garda-agent-orchestrator/live/docs/reviews/TEMPLATE.md`.
7. Produce final security verdict.

## Mandatory Output Format
Return the generated output template, not a free-form summary. Preserve these headings exactly and in this order:
1. `## Validation Notes` - concrete reviewed security files, behavior, boundaries, and verification evidence; required for PASS.
2. `## Findings by Severity` - active blocking security findings with file references, or `none`.
3. `## Deferred Findings` - accepted actionable security follow-ups with a concrete next step and `Justification:`, or `none`.
4. `## Residual Risks` - active open security risks that remain after review, or `none`.
5. `## Verdict` - exact verdict token: `SECURITY REVIEW PASSED` or `SECURITY REVIEW FAILED`.

## Hard Fail Conditions
Return `SECURITY REVIEW FAILED` when any item is true:
- Missing or bypassable authorization checks for protected operations.
- Insecure token validation path or trust boundary violation.
- Payment or webhook flow allows replay, forgery, or unauthorized capture.
- Secrets are hardcoded, logged, or otherwise exposed.
- Evidence is missing or non-auditable.

## Evidence Rules
- Use file references with line numbers for each finding.
- Include concrete exploit path or abuse scenario for high-risk findings.
- Include required remediation action per finding.

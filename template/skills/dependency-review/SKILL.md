---
name: dependency-review
description: Independent dependency risk review for manifest, lockfile, and package upgrade changes. Use for requests like "dependency review", "lockfile review", "package upgrade review", or when preflight requires dependency review. Do NOT use for general code review without dependency scope.
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

# Dependency Review

Use this skill for independent dependency-change risk assessment.
Prioritize supply-chain integrity, runtime compatibility, and operational blast radius.

## Required Inputs
- Task goal and expected dependency outcome.
- Changed manifest, lockfile, and version pin files.
- Diff summary for package additions, removals, and upgrades.
- Optional review-context artifact from orchestration: `garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-context.json`.
- Rule context package selected by orchestration and explicitly passed to reviewer:
  - token economy active + `depth=1`: only `00-core.md`, `80-task-workflow.md`, and dependency-triggered rule ids/snippets for changed scope.
  - token economy active + `depth=2`: `00-core.md`, `35-strict-coding-rules.md`, `70-security.md`, `80-task-workflow.md`.
  - token economy disabled or `depth=3`: full required dependency rule set for changed scope.

## Token Economy Mode
- Config source: `garda-agent-orchestrator/live/config/token-economy.json`.
- Apply this section only when `enabled=true` and effective depth is in `enabled_depths`.
- Default policy keeps `enabled_depths=[1,2]`, so `depth=3` follows full review behavior.
- If a deployment explicitly includes `3` in `enabled_depths`, keep the full review scope and allow only non-scope-reducing compaction.
- While active, this section takes precedence over any static rule-file list in `Required Inputs`.
- If orchestration provides review-context artifact, treat its `rule_pack.selected_rule_files`, `rule_pack.omitted_rule_files`, `token_economy.omitted_sections`, and nested `rule_context.*` metadata as the source of truth for compact dependency review scope.
- When `rule_context.artifact_path` is present, use that markdown snapshot as the primary rule text instead of reloading raw rule files.

## Review Workflow
1. Identify manifest, lockfile, and package-manager scope from changed files.
2. Load checklist from `references/dependency-review-checklist.md`.
3. Validate pinning strategy, major-version jumps, and transitive-risk visibility.
4. Validate changelog, release-note, or migration-impact evidence for breaking upgrades.
5. Validate runtime/build/test compatibility assumptions for changed packages.
6. Validate license, integrity, and supply-chain handling for newly introduced dependencies.
7. Use artifact structure from `garda-agent-orchestrator/live/docs/reviews/TEMPLATE.md`.
8. Produce final dependency verdict.

## Mandatory Output Format
1. Findings by severity with file references.
2. Dependency checklist rows with `rule_id`, `status` (`PASS` or `FAIL`), `evidence`.
3. Residual risks and rollout caveats.
4. Explicit verdict: `DEPENDENCY REVIEW PASSED` or `DEPENDENCY REVIEW FAILED`.

## Hard Fail Conditions
Return `DEPENDENCY REVIEW FAILED` when any item is true:
- Unreviewed major-version upgrade or incompatible range widening exists.
- Newly added dependency lacks provenance, integrity, or maintenance justification.
- Lockfile or manifest drift can produce non-deterministic installs.
- Breaking dependency change lacks migration/testing evidence.
- Evidence is missing or non-auditable.

## Evidence Rules
- Use file references with line numbers when possible.
- Include exact package names and before/after version evidence.
- Include required remediation for each blocking finding.

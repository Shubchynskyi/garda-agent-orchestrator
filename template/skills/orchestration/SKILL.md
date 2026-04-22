---
name: orchestration
description: Execute a task end-to-end with deterministic gates, preflight classification, depth control, and required independent reviews. Use for requests like "execute task", "run task", "implement task", "finish task T-00X", or "do task N". Do NOT use for standalone specialist review requests without implementation workflow.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(*)
  - Edit
  - Write
metadata:
  author: garda-agent-orchestrator
  version: 1.0.0
  runtime_requirement: Node.js 24 baseline for public CLI and gate commands
---

# Orchestration

This file is the canonical execution workflow.
Rule files provide policy context, but lifecycle steps and gate order are defined here.
Canonical gate surface is `node garda-agent-orchestrator/bin/garda.js gate <name>`.

## Required Inputs
- User request.
- Current task queue: `TASK.md`.
- Active source-of-truth entrypoint selected for this workspace.
- Relevant rule files from `garda-agent-orchestrator/live/docs/agent-rules/`.
- Token economy config: `garda-agent-orchestrator/live/config/token-economy.json`.

## Execution Depth
- Supported: `depth=1`, `depth=2`, `depth=3`.
- Default: `depth=2`.
- Depth controls context budget and validation thoroughness only.
- Mandatory gates are never optional because of depth.
- Escalation:
  - `FULL_PATH` => minimum `depth=2`
  - required `db/security/refactor` review => minimum `depth=2`
  - high-risk auth/payment/data/infra changes => prefer `depth=3`

## Token Economy
- Config source: `garda-agent-orchestrator/live/config/token-economy.json`.
- Activate reviewer-context compaction only when `enabled=true` and effective depth is in `enabled_depths`.
- Shared gate output filters from `garda-agent-orchestrator/live/config/output-filters.json` stay active regardless of reviewer-context token-economy state.
- Default: keep `enabled=true` with `enabled_depths=[1,2]`; at these depths reviewer context is compacted and token-economy savings are reported in the implementation summary.
- Recommendation when reviewer-context token economy is enabled: use `enabled=true` with `depth=1` only for small, well-localized tasks; prefer `depth=2` or `depth=3` when correctness depends on broader context.
- Short-form `depth=1` guidance is available at `garda-agent-orchestrator/live/skills/orchestration-depth1/SKILL.md`. If your client supports targeted skill loading, prefer that short form over the full orchestration skill when effective depth stays at `1` and no escalation trigger fires.
- Depth-aware reviewer context loading when active:
  - `depth=1`: load task goal, changed files, required review flags, and minimal diff context only.
  - `depth=2`: load `depth=1` context plus required checklists and only relevant rule sections.
  - default `depth=3` policy: use full reviewer context.
  - if a deployment explicitly includes `3` in `enabled_depths`, keep the full reviewer context and allow only non-scope-reducing compaction (for example stripped examples/code blocks or compact reviewer output).
- Depth-aware reviewer rule-pack contract when active:
  - `code` reviewer:
    - `depth=1`: `00-core.md`, `80-task-workflow.md`, plus rule ids/snippets directly triggered by changed scope.
    - `depth=2`: `00-core.md`, `35-strict-coding-rules.md`, `50-structure-and-docs.md`, `70-security.md`, `80-task-workflow.md`.
  - `db` reviewer:
    - `depth=1`: `00-core.md`, `80-task-workflow.md`, plus DB-triggered rule ids/snippets.
    - `depth=2`: `00-core.md`, `35-strict-coding-rules.md`, `70-security.md`, `80-task-workflow.md`.
  - `security` reviewer:
    - `depth=1`: `00-core.md`, `80-task-workflow.md`, plus security-triggered rule ids/snippets.
    - `depth=2`: `00-core.md`, `35-strict-coding-rules.md`, `70-security.md`, `80-task-workflow.md`.
  - `refactor` reviewer:
    - `depth=1`: `00-core.md`, `80-task-workflow.md`, plus refactor-triggered rule ids/snippets.
    - `depth=2`: `00-core.md`, `30-code-style.md`, `35-strict-coding-rules.md`, `50-structure-and-docs.md`, `80-task-workflow.md`.
  - default `depth=3` policy or token economy disabled: full reviewer rule packs.
  - if a deployment explicitly includes `3` in `enabled_depths`, keep full reviewer rule packs and allow only non-scope-reducing compaction.
- Context trimming when active:
  - `strip_examples=true`: remove examples from generated reviewer rule-context markdown snapshot.
  - `strip_code_blocks=true`: remove code blocks from generated reviewer rule-context markdown snapshot.
- Scoped diff contract when active:
  - if `scoped_diffs=true` and reviewer type is `db`, `security`, or `refactor`, generate scoped artifact before reviewer launch:
    - Node: `node garda-agent-orchestrator/bin/garda.js gate build-scoped-diff --review-type "<db|security|refactor>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-scoped.diff" --metadata-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-scoped.json"`
  - helper resolves trigger regexes from `garda-agent-orchestrator/live/config/paths.json` `triggers.<review-type>`.
  - if helper reports `fallback_to_full_diff=true`, pass full diff to reviewer and continue required review.
- Review-context artifact contract when active:
  - generate reviewer context artifact before reviewer launch:
    - Node: `node garda-agent-orchestrator/bin/garda.js gate build-review-context --review-type "<review-type>" --depth "<1|2|3>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --scoped-diff-metadata-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-scoped.json" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-context.json"`
  - JSON artifact must record selected rule pack, omitted sections, `deferred_by_depth` reason when applicable, scoped-diff fallback evidence, and nested `rule_context.*` metadata for the generated markdown snapshot.
  - sibling markdown snapshot (`rule_context.artifact_path`) is the preferred prompt payload for reviewer rule text when token economy mode is active.
- Compact reviewer output contract when active:
  - if `compact_reviewer_output=true`, require compact reviewer artifacts but keep mandatory sections and exact verdict tokens.
  - on failed command/test evidence, cap pasted tail output to `fail_tail_lines`.
  - review/completion gates audit compactness best-effort and emit warnings when reviewer artifacts exceed compact budgets.

## Task Resume Protocol
- When resuming a task already in `IN_PROGRESS` or `IN_REVIEW`, treat resume as full orchestration execution.
- Mandatory resume sequence:
  1. Re-read `AGENTS.md` routing, `00-core.md`, and this orchestration skill before any edits.
  2. Re-open current task row in `TASK.md` and latest artifacts in `runtime/reviews/` plus timeline `runtime/task-events/<task-id>.jsonl`.
  3. Continue from current stage, but do not skip compile/review/completion gates.
  4. Final report contract remains mandatory on resume: summary -> commit command -> explicit commit question.

## Task Start Contract
- The canonical user command is: `Execute task <task-id> from TASK.md strictly through all mandatory orchestrator gates.`
- Active profile is the default execution mode; explicit `depth=<1|2|3>` is a one-run override only.
- Before any edit, a fresh main-agent task run must emit exactly one English start banner from the repo-owned list (`Garda captures my mind` or `Garda rewrites my code`) and list the first mandatory gates to run.
- Reviewer agents, sub-agents, sidecars, and resumed cycles that already passed the start-banner step must not repeat it.
- If the workspace already contains modified files before task-mode entry and the run is not isolated through staged or explicit scope, stop and treat the start as invalid.

## Canonical Workflow
1. Select highest-priority `TODO` task in `TASK.md` and move to `IN_PROGRESS`.
2. If no `TODO` exists, create a task from current user request, then move it to `IN_PROGRESS`.
3. Resolve requested depth and record requested/effective depth in `TASK.md` notes.
4. Enter task mode explicitly before preflight:
   - Node: `node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "<EXPLICIT_TASK_EXECUTION|TASK_CREATED_FROM_REQUEST>" --requested-depth "<1|2|3>" --task-summary "<task summary>" --start-banner "<repo-owned-banner>"`
   - `enter-task-mode` writes task-scoped event `TASK_MODE_ENTERED` automatically and persists `runtime/reviews/<task-id>-task-mode.json`.
5. Record baseline downstream rules explicitly before preflight:
   - Node: `node garda-agent-orchestrator/bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "TASK_ENTRY" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/00-core.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md"`
   - `load-rule-pack` writes task-scoped event `RULE_PACK_LOADED` automatically and persists `runtime/reviews/<task-id>-rule-pack.json`.
6. Build concise plan: scope, files, risks, tests or validation strategy.
   - `enter-task-mode` auto-emits `PLAN_CREATED`; do not backfill it manually unless recovery tooling explicitly requires it.
7. Run handshake diagnostics after task-mode entry and baseline rule-pack loading:
   - canonical invocation: `node garda-agent-orchestrator/bin/garda.js gate handshake-diagnostics ...`.
8. Run shell smoke preflight after handshake diagnostics:
   - canonical invocation: `node garda-agent-orchestrator/bin/garda.js gate shell-smoke-preflight ...`.
9. Run preflight with explicit `--output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json"`:
   - `classify-change` with repeated `--changed-file` for precise scope, or
   - `--use-staged` in dirty workspaces.
   - canonical invocation: `node garda-agent-orchestrator/bin/garda.js gate classify-change ...`.
   - `classify-change` writes task-scoped event `PREFLIGHT_STARTED` first, then `PREFLIGHT_CLASSIFIED` on success or `PREFLIGHT_FAILED` on failure.
10. Apply depth escalation from preflight output when required.
11. Refresh downstream rule-pack evidence for the actual required review set:
   - Node: `node garda-agent-orchestrator/bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "POST_PREFLIGHT" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --loaded-rule-file "<opened-rule-file>"`
   - `load-rule-pack` must include every downstream rule file actually opened after preflight, including risk-specific rule packs required by the selected reviews.
   - This step is order-dependent: do not parallelize it with `classify-change` or `compile-gate` for the same task cycle.
12. Execute implementation path:
   - `FULL_PATH` runtime => tests first, then implementation.
   - non-runtime or `FAST_PATH` runtime => objective validations, then implementation.
13. Run compile gate (mandatory) before review phase:
   - Resolve `fail_tail_lines` from `garda-agent-orchestrator/live/config/token-economy.json`; when missing/invalid, fallback to `50`.
   - Gate output filter profiles are loaded from `garda-agent-orchestrator/live/config/output-filters.json`; invalid config must warn and fall back to passthrough output.
   - Node: `node garda-agent-orchestrator/bin/garda.js gate compile-gate --task-id "<task-id>" --commands-path "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md" --fail-tail-lines "<fail_tail_lines>"`
   - Compile gate auto-emits `IMPLEMENTATION_STARTED` before execution and then writes `COMPILE_GATE_PASSED` or `COMPILE_GATE_FAILED`.
   - Compile gate is strict about preflight scope freshness and fails on scope drift; rerun `classify-change` for the current scope, rerun `load-rule-pack --stage POST_PREFLIGHT`, and then rerun `compile-gate` when scope changes.
   - A newer `PREFLIGHT_CLASSIFIED` also invalidates older post-preflight rule-pack evidence; rerun downstream gates sequentially instead of overlapping the same task cycle.
   - If preflight was created from planned `--changed-file` inputs in a clean workspace before implementation, that refresh is expected once the real diff exists.
   - On failure, do not move to review phase; fix and rerun until pass.
14. Move task to `IN_REVIEW`.
15. Before each required independent review, run `build-review-context` for that review type.
   - Node: `node garda-agent-orchestrator/bin/garda.js gate build-review-context --review-type "<review-type>" --depth "<1|2|3>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --scoped-diff-metadata-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-scoped.json" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-context.json"`
   - This step is mandatory even when token economy is inactive because it auto-emits `REVIEW_PHASE_STARTED`, `SKILL_SELECTED`, and `SKILL_REFERENCE_LOADED`.
16. Run only required independent reviews from preflight:
    - mandatory on every provider: clean-context delegated reviewer sub-agents with isolated review context.
    - same-agent fallback does not satisfy the mandatory review workflow.
    - if a provider bridge cannot launch delegated reviewers, stop and treat the task as blocked until delegated review support exists.
    - baseline: `code`, `db`, `security`, `refactor`
    - optional when enabled in `garda-agent-orchestrator/live/config/review-capabilities.json`: `api`, `test`, `performance`, `infra`, `dependency`
    - when token economy mode is active, generate review-context artifact and attach both the JSON metadata artifact and its `rule_context.artifact_path` markdown snapshot to the reviewer prompt.
    - when `scoped_diffs=true` and required reviewer is `db`, `security`, or `refactor`, run scoped diff helper and attach scoped artifact path plus scoped metadata fallback flag to reviewer prompt.
    - Log event per reviewer invocation: `REVIEW_REQUESTED`.
17. Run `required-reviews-check` and treat result as release gate.
   - `required-reviews-check` writes task-scoped event `REVIEW_GATE_PASSED` or `REVIEW_GATE_FAILED` automatically.
   - `required-reviews-check` fails if explicit task-mode entry evidence is missing (missing `TASK_MODE_ENTERED` / missing `runtime/reviews/<task-id>-task-mode.json`).
   - `required-reviews-check` fails if post-preflight rule-pack evidence is missing (missing `RULE_PACK_LOADED` / missing `runtime/reviews/<task-id>-rule-pack.json`).
   - `required-reviews-check` fails if compile evidence is missing in `runtime/task-events/<task-id>.jsonl` (missing `COMPILE_GATE_PASSED`).
   - `required-reviews-check` fails if workspace changed after compile evidence; rerun compile gate after post-compile edits.
   - If explicit `--*-review-verdict` flags are omitted, the gate defaults expected required verdicts from `preflight.required_reviews` for the current cycle.
   - This defaulting is only a contract convenience; the gate still validates current-cycle artifacts, receipts, review-context bindings, and exact pass tokens, and must not auto-scan `runtime/reviews` for a convenient PASS.
18. Resolve every review finding before `DONE` and repeat required reviews + gate check until the final PASS artifacts are clean.
   - blocking findings must be fixed before rerun.
   - non-blocking findings may be deferred only in `Deferred Findings` with `Justification:` after the active `Findings by Severity` and `Residual Risks` sections are cleared to `none`.
   - On failed gate and return to coding, log event: `REWORK_STARTED`.
19. Run doc impact gate before completion:
   - Node: `node garda-agent-orchestrator/bin/garda.js gate doc-impact-gate --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --task-id "<task-id>" --decision "<NO_DOC_UPDATES|DOCS_UPDATED>" --behavior-changed "<true|false>" --changelog-updated "<true|false>" --rationale "<why>"`
   - Doc impact gate writes task-scoped event `DOC_IMPACT_ASSESSED` or `DOC_IMPACT_ASSESSMENT_FAILED`.
20. Run full-suite validation gate when enabled (controlled by `garda-agent-orchestrator/live/config/workflow-config.json`):
   - Node: `node garda-agent-orchestrator/bin/garda.js gate full-suite-validation --task-id "<task-id>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --repo-root "."`
   - Full-suite validation emits `FULL_SUITE_VALIDATION_PASSED`, `FULL_SUITE_VALIDATION_WARNED`, `FULL_SUITE_VALIDATION_FAILED`, or `FULL_SUITE_VALIDATION_SKIPPED`.
   - When enabled, completion-gate requires `PASSED` or `WARNED` status; `FAILED` and `SKIPPED` block completion.
   - When disabled (default), the gate emits `SKIPPED` and completion-gate does not require the artifact.
21. Run completion gate and treat result as final readiness gate before `DONE`.
   - Node: `node garda-agent-orchestrator/bin/garda.js gate completion-gate --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --task-id "<task-id>"`
   - Completion gate writes task-scoped event `COMPLETION_GATE_PASSED` or `COMPLETION_GATE_FAILED` automatically.
   - Completion gate fails if task-mode entry evidence is missing.
   - Completion gate fails if post-preflight rule-pack evidence is missing.
   - Completion gate fails if a PASS review artifact still contains active findings or residual risks, or if any deferred entry omits `Justification:`.
   - Completion gate validates full-suite-validation cycle binding when enabled.
22. Update required docs and changelog when behavior changed.
   - Internal orchestration artifacts (`TASK.md`, `garda-agent-orchestrator/runtime/**`, `garda-agent-orchestrator/live/docs/changes/CHANGELOG.md`) may remain gitignored in deployed workspaces; update them on disk but do not `git add -f` them unless the user explicitly asks to version orchestrator internals.
23. Record artifacts and evidence in `TASK.md`.
24. After `COMPLETION_GATE_PASSED`, run `node garda-agent-orchestrator/bin/garda.js gate task-audit-summary --task-id "<task-id>" --as-json`; this materializes `runtime/reviews/<task-id>-final-closeout.json` and `runtime/reviews/<task-id>-final-closeout.md`. Use the canonical final-closeout artifact instead of reconstructing the report structure manually.
25. Set final status:
    - `DONE` only when compile gate, required review gate, doc impact gate, and completion gate passed.
    - `BLOCKED` when any mandatory gate failed or cannot run.
    - Log terminal event: `TASK_DONE` or `TASK_BLOCKED`.
25. Report to user in exact order:
    1. implementation summary (include depth, path mode, review verdicts, docs updated)
       - at `depth=1` and `depth=2`, include a token-economy savings line; at `depth=3` it is optional;
       - format savings as `Saved tokens: ~<total> (~<percent>%) (<part> <label> + <part> <label> + ...)` when the baseline is known;
       - keep spaces between numeric values and labels and around `+`; do not emit compressed fragments like `824code review context` or `+25DB review context`;
       - localized summaries may translate the wording, but must preserve the numeric structure; example: `Saved tokens: ~882 (~67%) (824 code review context + 25 DB review context + 33 compile gate output).`
    2. commit suggestion as exact command form, defaulting to conventional style: `git commit -m "<type>(<scope>): <summary>"`
       - if `final_closeout.commit_command_suggestion` is populated, use it verbatim by default; otherwise fall back to the conventional template above.
    3. explicit follow-up question: `Do you want me to commit now? (yes/no)`
26. Close spawned reviewer/specialist agents when platform supports agent lifecycle controls.
27. Never commit unless user explicitly requests commit.

## Reviewer Agent Execution (Platform-Agnostic)
- Apply this section on every platform.
- Mandatory reviews must launch each required reviewer as a fresh-context delegated sub-agent with isolated context on every provider.
- Do not use provider-default reviewer agents that bypass this contract.
- Provider delegation capability and platform launch mapping:
  - Codex (delegation-capable): use sub-agents with isolated review context.
  - Claude Code (delegation-capable): use Agent tool/sub-agents with `fork_context=false`.
  - Gemini (delegation-capable): use delegated reviewer sub-agents with isolated context.
  - Qwen (delegation-capable): use delegated reviewer sub-agents with isolated context.
  - GitHub Copilot CLI (delegation-capable): use `task` tool with `agent_type="general-purpose"`; run one reviewer per isolated task execution.
  - Windsurf (delegation-capable): use delegated reviewer sub-agents through the provider bridge.
  - Junie (delegation-capable): use delegated reviewer sub-agents through the provider bridge.
  - Antigravity (delegation-capable): use delegated reviewer sub-agents through the provider bridge.
  - Providers or bridges without delegated reviewer support are not eligible to satisfy the mandatory review workflow until delegated launch support exists.
- Reviewer routing metadata contract:
  - Each reviewer invocation must capture `reviewer_execution_mode` (`delegated_subagent`) and `reviewer_identity` (`agent:<reviewer-id>`).
  - `build-review-context` emits `reviewer_routing` metadata in the review-context artifact; the orchestrator must populate `reviewer_routing.actual_execution_mode` and `reviewer_routing.reviewer_session_id` after reviewer launch.
  - Historical `same_agent_fallback` artifacts are compatibility-only diagnostics and must not satisfy a fresh mandatory review cycle.
  - Gate diagnostics (`required-reviews-check`, `completion-gate`) must report whether each review has valid delegated fresh-context execution evidence.
- For each required review where preflight `required_reviews.<type>=true`:
  1. Launch reviewer using the platform mapping above with mandatory delegation on capable providers.
  2. Prompt must include:
     - task id and task goal;
     - changed files list from preflight artifact;
     - diff summary (or exact staged diff if available);
     - mandatory skill path for this review type;
     - explicit rule-context package paths selected for this reviewer/depth (do not include non-selected rule files while token economy mode is active);
     - review-context artifact path (`garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-context.json`) and nested markdown snapshot from `rule_context.artifact_path`; this artifact is mandatory lifecycle evidence even when token economy mode is inactive;
     - token economy flags when active (`depth`, `compact_reviewer_output`, `strip_examples`, `strip_code_blocks`);
      - for `db` / `security` / `refactor` required reviews when scoped diffs are enabled: scoped artifact produced by `node garda-agent-orchestrator/bin/garda.js gate build-scoped-diff`, with scoped metadata artifact and full-diff fallback when helper reports empty scope;
      - required output contract:
        - verdict token (`... PASSED` or `... FAILED`);
        - findings list with file evidence;
        - `reviewer_execution_mode` used for this review (`delegated_subagent`);
        - when verdict is pass, keep active `Findings by Severity` and `Residual Risks` empty (`none`); move any accepted non-blocking follow-up to `Deferred Findings` and include `Justification:` in each deferred entry;
        - review artifact write path: `garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>.md`.
   3. Feed reviewer output into `record-review-result` using exactly one source: `--review-output-path` or `--review-output-stdin`.
      - `--review-output-stdin` is only a transport convenience. The gate must still persist raw reviewer input to `garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-output.md` before verdict extraction and receipt materialization.
      - Do not introduce a lighter validation branch for stdin. Verdict, routing, receipt, and telemetry checks must be identical to file-based ingest.
   4. Parse verdict token from the persisted reviewer output artifact.
   5. If verdict is failed, or a PASS artifact still leaves active findings/residual risks without justified deferral, fix or explicitly defer the finding and rerun the same reviewer until the final artifact is clean.
- Reviewer mapping contract:
  - `required_reviews.code=true` => skill `garda-agent-orchestrator/live/skills/code-review/SKILL.md` => pass token `REVIEW PASSED` => gate parameter `-CodeReviewVerdict`
  - `required_reviews.db=true` => skill `garda-agent-orchestrator/live/skills/db-review/SKILL.md` => pass token `DB REVIEW PASSED` => gate parameter `-DbReviewVerdict`
  - `required_reviews.security=true` => skill `garda-agent-orchestrator/live/skills/security-review/SKILL.md` => pass token `SECURITY REVIEW PASSED` => gate parameter `-SecurityReviewVerdict`
  - `required_reviews.refactor=true` => skill `garda-agent-orchestrator/live/skills/refactor-review/SKILL.md` => pass token `REFACTOR REVIEW PASSED` => gate parameter `-RefactorReviewVerdict`
  - `required_reviews.api=true` => skill `garda-agent-orchestrator/live/skills/api-contract-review/SKILL.md` (or custom `.../api-review/SKILL.md`) => pass token `API REVIEW PASSED` => gate parameter `-ApiReviewVerdict`
  - `required_reviews.test=true` => skill `garda-agent-orchestrator/live/skills/testing-strategy/SKILL.md` (or custom `.../test-review/SKILL.md`) => pass token `TEST REVIEW PASSED` => gate parameter `-TestReviewVerdict`
  - `required_reviews.performance=true` => skill `garda-agent-orchestrator/live/skills/performance-review/SKILL.md` => pass token `PERFORMANCE REVIEW PASSED` => gate parameter `-PerformanceReviewVerdict`
  - `required_reviews.infra=true` => skill `garda-agent-orchestrator/live/skills/devops-k8s/SKILL.md` (or custom `.../infra-review/SKILL.md`) => pass token `INFRA REVIEW PASSED` => gate parameter `-InfraReviewVerdict`
  - `required_reviews.dependency=true` => skill `garda-agent-orchestrator/live/skills/dependency-review/SKILL.md` => pass token `DEPENDENCY REVIEW PASSED` => gate parameter `-DependencyReviewVerdict`
- After all required verdicts are collected, run gate script with all verdict parameters:
  - Node: `node garda-agent-orchestrator/bin/garda.js gate required-reviews-check --preflight-path "<path>" --task-id "<task-id>" --code-review-verdict "<...>" --db-review-verdict "<...>" --security-review-verdict "<...>" --refactor-review-verdict "<...>" --api-review-verdict "<...>" --test-review-verdict "<...>" --performance-review-verdict "<...>" --infra-review-verdict "<...>" --dependency-review-verdict "<...>"`
  - Explicit verdict flags are optional when the expected required review set already comes from `preflight.required_reviews`; omitted review types default to their required pass tokens for this task cycle.
- After review gate pass, run doc impact gate:
  - Node: `node garda-agent-orchestrator/bin/garda.js gate doc-impact-gate --preflight-path "<path>" --task-id "<task-id>" --decision "<NO_DOC_UPDATES|DOCS_UPDATED>" --behavior-changed "<true|false>" --changelog-updated "<true|false>" --rationale "<why>"`
- After review gate pass, run completion gate before `DONE`:
  - Node: `node garda-agent-orchestrator/bin/garda.js gate completion-gate --preflight-path "<path>" --task-id "<task-id>"`
- Historical `same_agent_fallback` artifacts may be read for diagnostics only; they do not satisfy a fresh mandatory review cycle.
- HARD STOP: if the provider cannot launch delegated reviewer sub-agents, the mandatory review workflow is blocked until delegated launch support exists.

## Task Event Logging Commands
- Node:
  `node garda-agent-orchestrator/bin/garda.js gate log-task-event --task-id "<task-id>" --event-type "<event-type>" --outcome "INFO|PASS|FAIL|BLOCKED" --message "<short message>" --actor "orchestrator"`
- Task event logs:
  - `garda-agent-orchestrator/runtime/task-events/<task-id>.jsonl`
  - `garda-agent-orchestrator/runtime/task-events/all-tasks.jsonl`
- New task-event writes add best-effort append locking and per-task integrity metadata (`integrity.task_sequence`, `prev_event_sha256`, `event_sha256`).
- `status` and `doctor` surface timeline completeness, not just file presence or hash-chain integrity.
- Terminal events `TASK_DONE` and `TASK_BLOCKED` trigger full log cleanup for temporary reviewer/specialist logs after required artifacts are persisted.
- Human-readable summary:
  - `node garda-agent-orchestrator/bin/garda.js gate task-events-summary --task-id "<task-id>"`

## Escape Hatch Policy (Audited Override)
- Supported only for code review and only for tiny low-risk scopes.
- Command pattern:
  `node garda-agent-orchestrator/bin/garda.js gate required-reviews-check ... --skip-reviews "code" --skip-reason "<reason>"`
- Guardrails enforced by script:
  - only `code` can be skipped,
  - `db/security/refactor` overrides are forbidden,
  - max scope for override: `<=1` changed file and `<=8` changed lines,
  - reason is mandatory and persisted into override artifact.

## Hard Stops
- Do not assign `FAST_PATH` / `FULL_PATH` manually.
- Do not skip explicit task-mode entry via `enter-task-mode` before preflight and implementation.
- Do not skip explicit rule-pack evidence via `load-rule-pack`; reading only the top-level router is insufficient.
- Do not skip preflight classification with explicit `--output-path`.
- Do not move to implementation without plan.
- Do not move to `IN_REVIEW` without passing compile gate (`COMPILE_GATE_PASSED`).
- Do not bypass required reviews without deterministic gate override contract.
- Do not set `DONE` without passing compile gate, `required-reviews-check`, `doc-impact-gate`, and `completion-gate`.
- Do not continue after compile/review when scope changed; rerun preflight and full mandatory gates.
- Do not use `git add -f` to stage ignored orchestration control-plane files just because gates or changelog rules mention them.
- Do not change final report order: summary -> `git commit -m` suggestion -> `Do you want me to commit now? (yes/no)`.
- Do not leave reviewer/specialist agents open after review completion (when platform supports agent lifecycle controls).

## Mandatory Outputs
- Updated task row and status transitions in `TASK.md`.
- Task-mode artifact: `garda-agent-orchestrator/runtime/reviews/<task-id>-task-mode.json`.
- Preflight artifact: `garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json`.
- Compile gate result: `COMPILE_GATE_PASSED`.
- Compile gate evidence: `garda-agent-orchestrator/runtime/reviews/<task-id>-compile-gate.json`.
- Required review artifacts and verdicts.
- Gate check result (`REVIEW_GATE_PASSED` or `REVIEW_GATE_PASSED_WITH_OVERRIDE`).
- Review gate evidence: `garda-agent-orchestrator/runtime/reviews/<task-id>-review-gate.json`.
- Documentation impact gate result and artifact: `DOC_IMPACT_ASSESSED` + `garda-agent-orchestrator/runtime/reviews/<task-id>-doc-impact.json`.
- Completion gate result (`COMPLETION_GATE_PASSED`).
- Task event trace: `garda-agent-orchestrator/runtime/task-events/<task-id>.jsonl`.
- Optional timeline summary for final report: `garda gate task-events-summary` output.
- Optional review-context artifacts for token economy mode: `garda gate build-review-context` JSON output plus sibling markdown snapshot referenced by `rule_context.artifact_path`.
- Final user report.

## Examples
- User: `Execute task T-003 depth=1`
  - Skill resolves task, runs preflight, escalates depth if needed, executes mandatory gates, and reports final state.
- User: `Execute task T-022 depth=2`
  - Skill follows full lifecycle and runs only required specialist reviews from preflight.
- User: `Execute task T-105 depth=1 --skip-review=code --reason="one-line config hotfix"`
  - Skill may use audited override only if gate script allows it for tiny low-risk scope.

## Troubleshooting
- Preflight not found or invalid:
  - Re-run `classify-change` with explicit output path.
- Required review verdict missing:
  - Re-run missing reviewer and then `required-reviews-check`.
- Completion gate failed:
  - Resolve listed timeline/artifact/integrity violations, then rerun `completion-gate`.
- Compile gate failed:
  - Fix compile errors and rerun `compile-gate` until `COMPILE_GATE_PASSED`.
- Compile gate failed with preflight scope drift:
  - Re-run `classify-change` for current scope, rerun `load-rule-pack --stage POST_PREFLIGHT`, and then rerun `compile-gate`.
  - If the original preflight used planned `--changed-file` inputs in a clean workspace before coding, changed line totals may differ once the real diff exists; this is expected.
- Doc impact gate failed:
  - Fix doc-impact decision/rationale/changelog flags and rerun `doc-impact-gate`.
- Override rejected:
  - Scope is too large or specialized reviews are required; remove override and run full review path.
- Git noise in dirty workspace:
  - Stage task-specific project files and run preflight with `--use-staged`.
  - Ignored orchestration control-plane files should stay unstaged unless the user explicitly asks to version them.

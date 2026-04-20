# Task Workflow

Primary entry point: selected source-of-truth entrypoint for this workspace.

## Canonical Workflow Source
- Canonical execution flow is defined in:
  - `garda-agent-orchestrator/live/skills/orchestration/SKILL.md`
- Reviewer-agent execution mechanics are defined in `orchestration/SKILL.md` section `Reviewer Agent Execution (Platform-Agnostic)`.
- This file defines lifecycle semantics and hard-stop contracts only.
- Do not maintain parallel step-by-step workflow variants in multiple files.

## Task Lifecycle
- Task queue source: `TASK.md`.
- Status lifecycle: `TODO -> IN_PROGRESS -> IN_REVIEW -> DONE` or `BLOCKED`.
- Visual markers in `TASK.md` status are allowed (`🟦 TODO`, `🟨 IN_PROGRESS`, `🟧 IN_REVIEW`, `🟩 DONE`, `🟥 BLOCKED`), but canonical status token must remain present.
- If provider-native agent directories are present, use their orchestrator bridge profile before any implementation:
  - `.github/agents/orchestrator.md`
  - `.windsurf/agents/orchestrator.md`
  - `.junie/agents/orchestrator.md`
  - `.antigravity/agents/orchestrator.md`
- Provider bridges must refresh skill routing from `90-skill-catalog.md` and `review-capabilities.json`, including specialist skills added after init.
- One task in active execution at a time.
- Path mode values: `FAST_PATH` or `FULL_PATH`.
- Path mode is assigned only by:
  `node garda-agent-orchestrator/bin/garda.js gate classify-change`.

## Depth Contract
- Supported depth values: `1`, `2`, `3`.
- Default depth: `2`.
- Depth never bypasses mandatory gates.
- Depth escalation applies when:
  - preflight returns `FULL_PATH`;
  - preflight requires specialized review (`db`, `security`, `refactor`, or enabled optional specialist review).

## Agent Start Contract
- The canonical user command is: `Execute task <task-id> from TASK.md strictly through all mandatory orchestrator gates.`
- Active profile is the default execution mode; explicit `depth=<1|2|3>` is a one-run override only.
- Fresh main-agent task run must emit exactly one English start banner from the repo-owned list before any edit.
- That same reply must list the first mandatory gates to run before implementation.
- Reviewer agents, sub-agents, sidecars, and resumed cycles that already passed the start-banner step must not repeat it.
- If the workspace already contains modified files before task-mode entry and the run is not isolated through staged or explicit scope, stop and treat the start as invalid.

## Task Resume Protocol
- Apply this protocol whenever resuming an existing task in `IN_PROGRESS` or `IN_REVIEW`.
- Mandatory resume sequence:
  1. Re-read `AGENTS.md` routing and `00-core.md`.
  2. Re-read orchestration workflow (`live/skills/orchestration/SKILL.md`) and current task row in `TASK.md`.
  3. Re-read existing task evidence (`runtime/reviews/*`, `runtime/task-events/<task-id>.jsonl`) before new changes.
  4. Continue with full mandatory gates; resume never bypasses compile/review/completion gates.
- Final user report contract is mandatory on resume too.

## Mandatory Gate Contract
- Task-mode entry command must pass before preflight or implementation:
  `node garda-agent-orchestrator/bin/garda.js gate enter-task-mode`.
- Task-mode entry must produce `runtime/reviews/<task-id>-task-mode.json` and task-timeline event `TASK_MODE_ENTERED`.
- Baseline downstream rules must be opened and recorded before preflight:
  `node garda-agent-orchestrator/bin/garda.js gate load-rule-pack --stage "TASK_ENTRY"`.
- Baseline rule-pack evidence must produce `runtime/reviews/<task-id>-rule-pack.json` and task-timeline event `RULE_PACK_LOADED`.
- Handshake diagnostics must pass after task-mode entry and before preflight:
  `node garda-agent-orchestrator/bin/garda.js gate handshake-diagnostics`.
- Handshake diagnostics must emit task-timeline event `HANDSHAKE_DIAGNOSTICS_RECORDED`.
- Shell smoke preflight must pass after handshake diagnostics and before preflight:
  `node garda-agent-orchestrator/bin/garda.js gate shell-smoke-preflight`.
- Shell smoke preflight must emit task-timeline event `SHELL_SMOKE_PREFLIGHT_RECORDED`.
- Preflight artifact must exist before review stage.
- Preflight classification must run with explicit `--output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json"`.
- Preflight lifecycle telemetry must show `PREFLIGHT_STARTED` and then either `PREFLIGHT_CLASSIFIED` or `PREFLIGHT_FAILED`.
- Clean-tree preflight (`changed_files_count=0`) is baseline-only evidence, not task completion.
- Zero-diff implementation tasks must end in exactly one of these states before terminal status:
  - produced diff after implementation, then normal gate flow;
  - audited no-op recorded through `node garda-agent-orchestrator/bin/garda.js gate record-no-op --task-id "<task-id>" --reason "<rationale>"`;
  - explicit `BLOCKED` state explaining why no changes were produced.
- After preflight decides `required_reviews.*`, re-run `load-rule-pack --stage "POST_PREFLIGHT" --preflight-path ...` with the actual task-specific downstream rules that were opened.
- Treat `classify-change -> load-rule-pack --stage "POST_PREFLIGHT" -> compile-gate` as one strict same-task chain. Do not parallelize these transitions; a newer `PREFLIGHT_CLASSIFIED` invalidates older post-preflight rule-pack or compile attempts.
- Compile gate command must pass before `IN_REVIEW`:
  `node garda-agent-orchestrator/bin/garda.js gate compile-gate`.
- Compile lifecycle telemetry must show `IMPLEMENTATION_STARTED` before `COMPILE_GATE_PASSED`.
- Compile gate enforces preflight scope freshness; if scope drift is detected, rerun `classify-change` for the current scope, rerun `load-rule-pack --stage "POST_PREFLIGHT"`, and then rerun `compile-gate`.
- When preflight was created from planned `--changed-file` inputs in a clean workspace before implementation, this refresh is expected once the real diff exists; treat it as normal lifecycle recovery, not as an unexpected workflow failure.
- Compile gate validates post-preflight rule-pack evidence for the same task id and preflight artifact.
- Compile gate invocation must pass `fail_tail_lines` from `live/config/token-economy.json` (fallback `50`) to keep failure-output budget deterministic.
- Compile/review gate output compaction profiles are loaded from `live/config/output-filters.json`; invalid or missing config must warn and fall back to passthrough output instead of inventing filtered summaries.
- Shared gate-output compaction is independent of reviewer-context token economy scope; even with token economy disabled or at the default `depth=3` policy, compile/review gates still use `output-filters.json` and `fail_tail_lines`.
- Before each required reviewer invocation, run `node garda-agent-orchestrator/bin/garda.js gate build-review-context ...` for that review type.
- Reviewer preparation must emit `REVIEW_PHASE_STARTED`, `SKILL_SELECTED`, and `SKILL_REFERENCE_LOADED` before the review gate can satisfy completion for code-changing tasks.
- Downstream `test` review preparation must not start until every required upstream non-`test` review for the current cycle has a clean PASS artifact and receipt.
- Known producer-consumer validation flows are launch blockers too. Do not fan out raw shell commands such as `npm run build:node-foundation` and direct `node --test .node-build/...` in parallel; use the guarded workflow path or run producer then consumer strictly sequentially.
- If a later cycle changes only test scope, still run `build-review-context` for reusable upstream `code` review first so current-cycle reuse evidence exists before `test` review starts.
- Required reviews must be launched only from preflight `required_reviews.*`.
- Review gate command must pass before `DONE`:
  `node garda-agent-orchestrator/bin/garda.js gate required-reviews-check`.
- If explicit `--*-review-verdict` flags are omitted, the review gate defaults the expected required verdicts from `preflight.required_reviews` for the current task cycle.
- Those defaults are only a CLI convenience; `required-reviews-check` still validates current-cycle artifacts, receipts, review-context bindings, and pass tokens, and must not auto-pick a stale PASS from `runtime/reviews/`.
- Review gate command validates compile evidence (`COMPILE_GATE_PASSED`) from task timeline for the same task id.
- Review gate command validates task-mode entry evidence (`TASK_MODE_ENTERED`) for the same task id.
- Review gate command validates post-preflight rule-pack evidence (`RULE_PACK_LOADED`) for the same task id and preflight artifact.
- Review gate command validates no workspace drift after compile evidence; post-compile edits require compile gate rerun.
- Review gate rejects zero-diff implementation tasks unless an audited no-op artifact exists for the same task id.
- Documentation impact gate command must pass before `DONE`:
  `node garda-agent-orchestrator/bin/garda.js gate doc-impact-gate`.
- Completion gate command must pass before `DONE`:
  `node garda-agent-orchestrator/bin/garda.js gate completion-gate`.
- After `COMPLETION_GATE_PASSED`, run `node garda-agent-orchestrator/bin/garda.js gate task-audit-summary --task-id "<task-id>" --as-json`; the gate now materializes canonical closeout artifacts at `runtime/reviews/<task-id>-final-closeout.json` and `runtime/reviews/<task-id>-final-closeout.md`. Use those artifacts instead of reconstructing the final closeout order free-form.
- Completion gate validates task-mode entry evidence, post-preflight rule-pack evidence, compile evidence, review-gate evidence, doc-impact evidence, ordered lifecycle evidence (`TASK_MODE_ENTERED`, `RULE_PACK_LOADED`, `PREFLIGHT_CLASSIFIED`, `IMPLEMENTATION_STARTED`, `COMPILE_GATE_PASSED`, `REVIEW_PHASE_STARTED`, review pass evidence), review-skill telemetry (`SKILL_SELECTED`, `SKILL_REFERENCE_LOADED`), best-effort task-event hash-chain integrity, required review artifacts, and final findings-resolution state in PASS review artifacts.
- Completion gate rejects zero-diff implementation tasks unless the task has later produced a real diff or an audited no-op artifact exists at `runtime/reviews/<task-id>-no-op.json`.
- Final PASS review artifacts must keep active `Findings by Severity` and `Residual Risks` empty (`none`). Non-blocking follow-ups may remain only in `Deferred Findings`, and every deferred entry must include `Justification:`.
- Task timeline log must be updated for lifecycle stages and gate outcomes:
  `garda-agent-orchestrator/runtime/task-events/<task-id>.jsonl`.
- The runtime auto-emits task-start and stage-transition events such as `PLAN_CREATED`, `PREFLIGHT_STARTED`, `IMPLEMENTATION_STARTED`, `REVIEW_PHASE_STARTED`, `STATUS_CHANGED`, `PROVIDER_ROUTING_DECISION`, gate pass/fail markers, and terminal completion markers.
- Task-event writers must use best-effort append locking for both per-task log and aggregate `all-tasks.jsonl`; do not rely on unsynchronized raw append for concurrent runs.
- Task-event integrity is procedural hardening only: local hash-chain and replay detection help detect tampering after the fact, but they are not a security-grade trust anchor.
- Task timeline completeness is surfaced in `status` and `doctor`; incomplete timelines are a real workflow defect, not optional trace noise.
- Orchestrator control-plane files (`TASK.md`, `garda-agent-orchestrator/runtime/**`, and internal docs such as `garda-agent-orchestrator/live/docs/changes/CHANGELOG.md`) are local workflow artifacts; in deployed workspaces their ignored status is normal.
- Terminal statuses (`DONE`, `BLOCKED`) require full cleanup of temporary reviewer/specialist logs after required artifacts are persisted.
- Documentation impact updates are required when behavior/contracts/ops docs changed.
- Required changelog or evidence updates to ignored orchestrator paths must stay local on disk; do not use `git add -f` unless the user explicitly requests versioning orchestrator internals.
- Final user report order is mandatory: implementation summary -> conventional-style `git commit -m "<type>(<scope>): <summary>"` suggestion -> `Do you want me to commit now? (yes/no)`.
- At `depth=1` and `depth=2`, the implementation summary must include a token-economy savings line; at `depth=3` it is optional. Include approximate percentage when baseline is known and keep spaced breakdown formatting: `Saved tokens: ~882 (~67%) (824 code review context + 25 DB review context + 33 compile gate output).`
- Reviewer and specialist agents must be closed after verdict capture.
- HARD STOP: do not skip `enter-task-mode`; compile/review/completion evidence is invalid without explicit task-mode entry.
- HARD STOP: do not skip `load-rule-pack`; reading the top-level router alone is not enough to prove downstream rule loading.
- HARD STOP: do not continue a normal task run when the workspace already had modified files before `enter-task-mode`; isolate scope first with staged or explicit preflight inputs.
- HARD STOP: do not launch required reviewers without `build-review-context`; completion requires review-skill telemetry.
- HARD STOP: do not force-stage ignored orchestration control-plane files just because gates, changelog, or reviews reference them.
- HARD STOP: do not set `DONE` until completion gate is `COMPLETION_GATE_PASSED` and final user report is delivered in mandatory order.
- HARD STOP: do not set `DONE` until completion gate is `COMPLETION_GATE_PASSED`, every review finding is either resolved or explicitly deferred with `Justification:`, and the final user report is delivered in mandatory order.
- HARD STOP: any mandatory gate/tooling failure (`Unknown gate`, missing CLI, build dependency errors, stale bundle mismatch) forces an immediate `BLOCKED` state. Broken infrastructure is not a license to continue implementation or bypass the orchestrator.
- If compile command or workflow infra files are hotfixed inside current task, scope is expanded and full re-run is mandatory: preflight -> compile gate -> required reviews gate -> doc impact gate -> completion gate.

## Escape Hatch Contract
- Audited skip-review override is allowed only through gate script parameters.
- Current supported override scope:
  - only code review,
  - only tiny low-risk scope,
  - mandatory explicit reason,
  - mandatory override artifact.
- DB, security, and refactor mandatory reviews are never skippable by override.

## Reviewer Independence
- Mandatory mode on delegation-capable providers: reviewers must be spawned as fresh-context sub-agents (separate reviewer agent with isolated context built from `build-review-context`).
- Same-agent self-review is invalid by default when the provider supports sub-agent delegation; the implementation agent must not review its own changes in-place on delegation-capable platforms.
- Provider delegation capability:
  - Codex: delegation-capable — use sub-agents with isolated review context.
  - Claude Code: delegation-capable — use Agent tool/sub-agents with `fork_context=false`.
  - GitHub Copilot CLI: delegation-capable — use `task` tool with `agent_type="general-purpose"` (one reviewer per isolated task run).
  - Windsurf, Junie, Antigravity: evaluate provider sub-agent support at runtime; default to delegation when available.
  - Single-agent platforms (no sub-agent/task tool): explicit fallback allowed — run independent review passes sequentially, each with explicit scope and isolated checklist, before final verdict aggregation.
- Fallback self-review is mandatory and immediate on single-agent platforms; do not wait for external reviewers.
- Reviewer execution mode must be recorded in review receipts and telemetry:
  - `reviewer_execution_mode`: `delegated_subagent` (preferred) or `same_agent_fallback`.
  - `reviewer_identity`: provider-assigned session/agent id when available, or `self:<task-id>` for fallback.
  - `reviewer_fallback_reason`: required when `same_agent_fallback` is used on conditional/unknown delegation platforms.
  - Gate diagnostics must explain whether each review used delegated fresh-context execution or fallback mode.
- Reviewer verdict is a release gate, not optional advice.
- Required verdicts:
  - code: `REVIEW PASSED`
  - db: `DB REVIEW PASSED`
  - security: `SECURITY REVIEW PASSED`
  - refactor: `REFACTOR REVIEW PASSED`
  - optional specialist verdicts when enabled and required:
    - api: `API REVIEW PASSED`
    - test: `TEST REVIEW PASSED`
    - performance: `PERFORMANCE REVIEW PASSED`
    - infra: `INFRA REVIEW PASSED`
    - dependency: `DEPENDENCY REVIEW PASSED`

## BLOCKED Semantics
- `BLOCKED` means pipeline is paused; no next stage may start.
- Resume only after explicit blocking condition resolution.
- Record `blocked_reason_code` in `TASK.md`.
- For infrastructure-driven blocks, you must report: the exact command, `cwd`, chosen CLI path, and `stderr`.

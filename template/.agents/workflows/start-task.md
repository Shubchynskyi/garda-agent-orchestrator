<!-- garda-agent-orchestrator:managed-start -->
---
description: "Mandatory shared router for any task execution through Garda orchestration."
---

# Start Task

This checklist is the shared start-task router for root entrypoints and provider bridges.
It routes to the canonical Garda workflow and does not replace `80-task-workflow.md` or the orchestration skill.

Before any code changes:
- Open `AGENTS.md` and `TASK.md`.
- If an active provider bridge exists, open it too before implementation.
- Fresh main-agent task runs must begin with exactly one English start banner from the repo-owned list (`Garda captures my mind` or `Garda rewrites my code`) before any edits and then list the first mandatory gates to run.
- Reviewer agents, sub-agents, sidecars, and resumed cycles that already passed the start-banner step must not repeat it.
- Enter orchestrator mode with the canonical command: `Execute task <task-id> from TASK.md strictly through all mandatory orchestrator gates.`
- Use `node bin/garda.js next-step "<task-id>" --repo-root "."` in a source checkout, or `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."` in a deployed workspace, as the first command and repeat it after every suggested command.
- Do not start by guessing `compile-gate`, `classify-change`, or default config flags. Static gate order below is policy context; `next-step` is the executable navigator.
- Use the active profile as the default execution mode; explicit `depth=<1|2|3>` is only a one-run override.
- If the workspace already contains modified files before task-mode entry, stop and isolate scope via `--use-staged` or explicit `--changed-file ...` preflight inputs before continuing.
- Use compact command protocol from `40-commands.md`: first `scan`, then `inspect`, then verbose `debug` only by exception.

## Copy-Paste Start Commands
- First/resume command (source checkout): `node bin/garda.js next-step "<task-id>" --repo-root "."`
- First/resume command (deployed workspace): `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."`
- Use the same `next-step` command before the first gate, after every suggested command, and after any gate failure. Do not start with `compile-gate`, guess flags, or read default config templates when `next-step` can inspect task evidence.
- Source checkout (`--provider`): `node bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<task summary>" --start-banner "<repo-owned-banner>" --provider "<runtime-provider>" --repo-root "."`
- Source checkout (`--provider` + `--routed-to`, optional telemetry): `node bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<task summary>" --start-banner "<repo-owned-banner>" --provider "<runtime-provider>" --routed-to "<provider-bridge-or-entrypoint>" --repo-root "."`
- Source checkout (`TASK_ENTRY` rules): `node bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "TASK_ENTRY" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/00-core.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md" --repo-root "."`
- Deployed workspace (`--provider`): `node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<task summary>" --start-banner "<repo-owned-banner>" --provider "<runtime-provider>" --repo-root "."`
- Deployed workspace (`--provider` + `--routed-to`, optional telemetry): `node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<task summary>" --start-banner "<repo-owned-banner>" --provider "<runtime-provider>" --routed-to "<provider-bridge-or-entrypoint>" --repo-root "."`
- Deployed workspace (`TASK_ENTRY` rules): `node garda-agent-orchestrator/bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "TASK_ENTRY" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/00-core.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md" --repo-root "."`
- Required runtime identity: use `--provider "<runtime-provider>"`; add `--routed-to "<provider-bridge-or-entrypoint>"` only when route telemetry must be pinned.

Mandatory gate order:
0. `next-step "<task-id>"` before the first gate and after every gate; run only the single recommended command it prints unless the user explicitly asks for diagnostics
1. `gate enter-task-mode` with explicit runtime identity via `--provider "<provider>"`; add `--routed-to "<provider-bridge-or-entrypoint>"` only when route telemetry must be pinned, and never rely on canonical SourceOfTruth fallback
2. `gate load-rule-pack --stage TASK_ENTRY`
3. `gate handshake-diagnostics`
4. `gate shell-smoke-preflight`
5. `gate classify-change`
6. POST_PREFLIGHT rule-pack command printed by `next-step`: `gate load-rule-pack --stage POST_PREFLIGHT` or `gate bind-rule-pack-to-preflight`
7. implement only after preflight
8. `gate compile-gate`
9. `gate build-review-context` for each required review
10. `gate required-reviews-check`
11. `gate doc-impact-gate`
12. `gate full-suite-validation` (when enabled via workflow-config.json)
13. `gate completion-gate`

Hard stops:
- If a mandatory gate fails or is unavailable, stop and report the exact command and stderr.
- Do not make code edits before `enter-task-mode`; unscoped pre-task diffs must be isolated first.
- Spawn a new clean-context delegated reviewer for this review context; do not reuse an existing reviewer session. Codex/Claude should use fork_context=false when available, and other providers must use provider-equivalent isolated sub-agent or task launch.
- Reusing a prior review artifact or receipt is valid only through explicit current-cycle reuse evidence; reusing the same reviewer session for a new mandatory review is not valid fresh-context launch evidence.
- After the review receipt is persisted, close or release the reviewer sub-agent session.
- Do not spawn or pre-launch a dependent downstream reviewer before the required upstream PASS artifact and receipt exist for the same cycle.
- Parallel reviewer fan-out is allowed only between independent review types with no dependency edge.
- Do not fan out known producer-consumer validation commands as raw shell sidecars. Flows such as `npm run build:node-foundation` -> direct `node --test .node-build/...` must use the guarded workflow path or run strictly sequentially, never in parallel.
- Do not hand-edit active `TASK.md` lifecycle statuses (`IN_PROGRESS`, `IN_REVIEW`, `DONE`, `BLOCKED`) as a substitute for gates; completion finalization owns `DONE`, review-gate owns `IN_REVIEW`, task-mode owns `IN_PROGRESS`, and explicit operator `task-reset` owns reset/discard.
- Do not mark `DONE` without `COMPLETION_GATE_PASSED`.
- Do not create fake review artifacts or bypass reviewer routing.
- The `40-commands.md` restraint applies only to standalone ad-hoc commands. It does NOT exempt mandatory gates: gates such as `compile-gate` and `full-suite-validation` must execute their underlying build/test/type-check commands when the workflow requires them.
<!-- garda-agent-orchestrator:managed-end -->

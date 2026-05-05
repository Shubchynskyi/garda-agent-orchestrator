<!-- garda-agent-orchestrator:managed-start -->
# TASK.md

Single-file task queue for local agent orchestration.
This file is intentionally expected to be gitignored.
Do not force-add it to git unless the user explicitly asks to version orchestration control-plane files.

Canonical instructions entrypoint for orchestration: `{{CANONICAL_ENTRYPOINT}}`.
Hard stop: first open `{{CANONICAL_ENTRYPOINT}}` and follow its routing links. Only then execute any task from `TASK.md`.
Orchestrator mode starts when task execution is requested from this file (`TASK.md`).
If needed, the agent can add new tasks from user requests and then execute them in orchestrator mode.
Task timeline log (per task): `garda-agent-orchestrator/runtime/task-events/<task-id>.jsonl`.

## Status Legend
- `🟦 TODO`
- `🟨 IN_PROGRESS`
- `🟧 IN_REVIEW`
- `🟩 DONE`
- `🟥 BLOCKED`
- `🟪 DECOMPOSED`

Status cell format rule: keep canonical token, optionally prefixed by marker (for example `🟦 TODO`).

## Active Queue
| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |
|---|---|---|---|---|---|---|---|---|
| T-001 | 🟩 DONE | P1 | process | Verify orchestrator operation, full rule set, and workflow gates | unassigned | {{DEPLOYMENT_DATE}} | default | Completed during full orchestrator setup: install, verify, preflight classification, and review-gate checks. |
<!-- garda-agent-orchestrator:managed-end -->

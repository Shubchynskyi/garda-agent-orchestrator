---
description: "Mandatory router for any Antigravity task execution through Garda orchestration."
---

# Start Task

This checklist routes to the canonical Garda workflow. It does not replace `80-task-workflow.md` or the orchestration skill.

Before any code changes:
- Open `AGENTS.md`, `TASK.md`, and `.antigravity/agents/orchestrator.md`.
- Execute every code task only as `Execute task <task-id> depth=<1|2|3>`.
- Use compact command protocol from `40-commands.md`: first `scan`, then `inspect`, then verbose `debug` only by exception.

Mandatory gate order:
1. `gate enter-task-mode`
2. `gate load-rule-pack --stage TASK_ENTRY`
3. `gate classify-change`
4. `gate load-rule-pack --stage POST_PREFLIGHT`
5. implement only after preflight
6. `gate compile-gate`
7. `gate build-review-context` for each required review
8. `gate required-reviews-check`
9. `gate doc-impact-gate`
10. `gate completion-gate`

Hard stops:
- If a mandatory gate fails or is unavailable, stop and report the exact command and stderr.
- Do not mark `DONE` without `COMPLETION_GATE_PASSED`.
- Do not create fake review artifacts or bypass reviewer routing.
- The `40-commands.md` preference to avoid ad-hoc manual commands does NOT exempt mandatory gates. Gates such as `compile-gate` must execute their underlying build/test commands when the workflow requires them.

---
description: "Mandatory router for any Antigravity task execution through Garda orchestration."
---

# Start Task

This checklist routes to the canonical Garda workflow. It does not replace `80-task-workflow.md` or the orchestration skill.

Before any code changes:
- Open `AGENTS.md`, `TASK.md`, and `.antigravity/agents/orchestrator.md`.
- First execution reply must explicitly state `files not modified yet` before any edits.
- Enter orchestrator mode with the canonical command: `Execute task <task-id> from TASK.md strictly through all mandatory orchestrator gates.`
- Use the active profile as the default execution mode; explicit `depth=<1|2|3>` is only a one-run override.
- If the workspace already contains modified files before task-mode entry, stop and isolate scope via `--use-staged` or explicit `--changed-file ...` preflight inputs before continuing.
- Use compact command protocol from `40-commands.md`: first `scan`, then `inspect`, then verbose `debug` only by exception.

Mandatory gate order:
1. `gate enter-task-mode`
2. `gate load-rule-pack --stage TASK_ENTRY`
3. `gate handshake-diagnostics`
4. `gate shell-smoke-preflight`
5. `gate classify-change`
6. `gate load-rule-pack --stage POST_PREFLIGHT`
7. implement only after preflight
8. `gate compile-gate`
9. `gate build-review-context` for each required review
10. `gate required-reviews-check`
11. `gate doc-impact-gate`
12. `gate completion-gate`

Hard stops:
- If a mandatory gate fails or is unavailable, stop and report the exact command and stderr.
- Do not make code edits before `enter-task-mode`; unscoped pre-task diffs must be isolated first.
- Do not mark `DONE` without `COMPLETION_GATE_PASSED`.
- Do not create fake review artifacts or bypass reviewer routing.
- The `40-commands.md` preference to avoid ad-hoc manual commands does NOT exempt mandatory gates. Gates such as `compile-gate` must execute their underlying build/test commands when the workflow requires them.

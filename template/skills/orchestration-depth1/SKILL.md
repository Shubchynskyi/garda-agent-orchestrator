---
name: orchestration-depth1
description: Short-form orchestration guidance for localized `depth=1` execution when token economy is active. Use for small, well-bounded tasks that do not require broader cross-module reasoning or mandatory depth escalation.
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

# Orchestration (Depth 1 Short Form)

Use this short form only when all of the following stay true:
- effective depth is `1`;
- scope is small and well localized;
- no automatic escalation trigger fires;
- correctness does not depend on broad cross-module context.

Escalate back to the full orchestration skill immediately if:
- preflight reports `FULL_PATH`;
- required `db`, `security`, or `refactor` review forces `depth>=2`;
- the change touches auth, payments, sensitive data, infra, or other high-risk areas;
- scope drifts beyond the original task.

## Minimal Required Inputs
- user request;
- `TASK.md` row for the task;
- `AGENTS.md` routing entrypoint;
- preflight artifact for the task;
- directly touched module context;
- `00-core.md` and `80-task-workflow.md`;
- only the rule ids/snippets directly triggered by changed scope.

## Compact Workflow
1. Start only from `Execute task <task-id> from TASK.md strictly through all mandatory orchestrator gates.` and make the first execution reply explicitly state `files not modified yet`.
2. Move the task to `IN_PROGRESS` and capture requested/effective depth in `TASK.md`.
3. Build a concise plan focused on changed files, risks, and validation.
4. Run `enter-task-mode`, `load-rule-pack --stage TASK_ENTRY`, `handshake-diagnostics`, `shell-smoke-preflight`, and then preflight/classification; stop using this short form if escalation is required.
5. Read only minimal context: core rules, task workflow, touched module context, and scope-triggered rule snippets.
6. Implement the smallest safe change that satisfies the task.
7. Run objective validation for the touched area.
8. Run the mandatory compile gate.
9. Run only the required independent reviews from preflight.
10. Resolve findings, ensure the final PASS artifact has no active findings or residual risks unless accepted non-blocking items are moved to `Deferred Findings` with `Justification:`, run completion gate, and only then mark the task `DONE`.

## Hard Rules
- Depth changes context budget, never gate obligations.
- Do not continue a normal task run when the workspace already had modified files before `enter-task-mode`; isolate scope first with staged or explicit preflight inputs.
- Do not skip compile, review, or completion gates.
- Re-run preflight after meaningful scope changes.
- Do not mark a task `DONE` while any PASS review artifact still has active findings, residual risks, or deferred items without `Justification:`.
- Prefer concise evidence and scoped artifacts over pasting large raw outputs.
- The final summary must include a token-economy savings line using the same spaced `~N (~P%)` structure as the full orchestration contract, including readable ` + ` separators between breakdown segments.

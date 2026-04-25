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
1. Start only from `Execute task <task-id> from TASK.md strictly through all mandatory orchestrator gates.` and make the fresh main-agent execution reply emit exactly one English start banner from the repo-owned list (`Garda captures my mind` or `Garda rewrites my code`) before any edits, then list the first mandatory gates to run.
2. Capture requested/effective depth in `TASK.md`; successful `enter-task-mode` reconciles the task to `IN_PROGRESS`.
3. Build a concise plan focused on changed files, risks, and validation.
4. Run `enter-task-mode`, `load-rule-pack --stage TASK_ENTRY`, `handshake-diagnostics`, `shell-smoke-preflight`, and then preflight/classification; stop using this short form if escalation is required.
5. Read only minimal context: core rules, task workflow, touched module context, and scope-triggered rule snippets.
6. Implement the smallest safe change that satisfies the task.
7. Run objective validation for the touched area.
8. Run the mandatory compile gate.
9. Run only the required independent reviews from preflight; successful review-gate flow reconciles the task to `IN_REVIEW`.
10. Resolve findings, ensure the final PASS artifact has no active findings or residual risks unless accepted non-blocking items are moved to `Deferred Findings` with `Justification:`, run completion gate, and only then let completion finalization reconcile the task to `DONE`.

## Hard Rules
- Depth changes context budget, never gate obligations.
- Do not continue a normal task run when the workspace already had modified files before `enter-task-mode`; isolate scope first with staged or explicit preflight inputs.
- Do not skip compile, review, or completion gates.
- Mandatory reviews still require a fresh clean-context delegated reviewer; do not reuse an existing reviewer session, and close or release the reviewer after receipt persistence.
- Do not hand-edit forward `TASK.md` status transitions; gate flow owns `IN_PROGRESS`, `IN_REVIEW`, and `DONE`.
- Re-run preflight after meaningful scope changes.
- If the original preflight used planned `--changed-file` inputs in a clean workspace before implementation, refresh it before compile by rerunning `classify-change` and `load-rule-pack --stage POST_PREFLIGHT` once the real diff exists.
- Do not mark a task `DONE` while any PASS review artifact still has active findings, residual risks, or deferred items without `Justification:`.
- Prefer concise evidence and scoped artifacts over pasting large raw outputs.
- The final summary must include the same output-compaction line shape as the full orchestration contract: chars first, approximate percentage when baseline is known, readable ` + ` separators between breakdown segments, and token estimate only as a secondary note when available.

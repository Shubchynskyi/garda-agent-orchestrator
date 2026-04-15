# Core Rules

Primary entry point: selected source-of-truth entrypoint for this workspace.

## Language
Respond in {{ASSISTANT_RESPONSE_LANGUAGE}} for explanations and assistance.

## Response Style
Default response brevity: {{ASSISTANT_RESPONSE_BREVITY}}.

## Communication
1. Respond in {{ASSISTANT_RESPONSE_LANGUAGE}}.
2. Keep responses {{ASSISTANT_RESPONSE_BREVITY}} unless the user explicitly asks for more or less detail.
3. Keep code in English (variables, functions, classes, comments in code).
4. Keep documentation in English (README, docs, file content).
5. Task completion always ends with: implementation summary, suggested conventional-style `git commit -m "<type>(<scope>): <summary>"` command (prefer the inferred type/scope from `task-audit-summary` when available), and explicit `Do you want me to commit now? (yes/no)` question (see `80-task-workflow.md`, Mandatory Gate Contract).

## Project Memory — Storage Directive
1. Durable project knowledge (architecture, conventions, stack details, domain constraints, design decisions) must be written to `garda-agent-orchestrator/live/docs/project-memory/`.
2. Do not embed durable project knowledge in orchestrator-managed rule files (`agent-rules/*.md`), config JSON, root entrypoints, or `TASK.md`.
3. The `project-memory/` directory is user-owned; the materializer never overwrites its contents after initial seed.
4. Canonical files: `context.md`, `architecture.md`, `conventions.md`, `stack.md`, `decisions.md`. Add new files in lowercase kebab-case `.md` format when an existing category does not fit.
5. Agents may read `project-memory/` at any time for context. Write access requires explicit user approval or a task instruction that authorises the update.

## Mandatory Infrastructure Integrity
1. Mandatory gate/tooling failures (e.g., `Unknown gate`, missing CLI capability, missing local build dependencies, stale bundle mismatch, unreadable gate artifact paths) are critical infrastructure defects.
2. Any such failure forces an immediate `BLOCKED` condition. You must not continue task execution or implementation when gate infrastructure is broken.
3. User preferences or environment-specific instructions (e.g., "do not run rebuild", "skip tests") never waive the requirement for mandatory gate commands. If a gate requires a build or test execution to satisfy its contract, it must be run regardless of general preferences. In particular, the `40-commands.md` preference to avoid ad-hoc manual commands does not apply to mandatory gate execution — `compile-gate` and other lifecycle gates must run their underlying commands (builds, tests, type-checks) when the workflow requires them.
4. Broken gate infrastructure is not permission to bypass the orchestrator or edit code directly without following the lifecycle.
5. When blocked by infrastructure failure, report the exact command, `cwd`, chosen CLI path, and the complete `stderr` output to the user.

## Code Quality

### Cleanliness and Readability
- Code must be self-documenting.
- Use meaningful names (`productRepository` instead of `repo`).
- Keep functions small and focused.
- Avoid magic numbers and use constants.

### Single Responsibility Principle (SRP)
- Each class or function should have one responsibility.
- Split functions that perform multiple responsibilities.
- Split classes that have multiple reasons to change.

### DRY (Don't Repeat Yourself)
- Do not duplicate code; extract shared logic.
- Avoid copy-paste solutions.
- Reuse services, utilities, and base abstractions.

### Comments
- Minimize comments.
- Do not comment obvious behavior.
- Write comments only in English.
- Use comments only for rationale or non-obvious business constraints.

Bad example:
```java
// Increment counter
counter++;
```

Good example:
```java
// Skip first element due to API limitation that always returns a duplicate
items.stream().skip(1)...
```

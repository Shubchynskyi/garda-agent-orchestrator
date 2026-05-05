# Project Memory

Durable project knowledge that survives every orchestrator lifecycle event.

## Index-First Protocol

1. Read this file first.
2. Read `compact.md` second.
3. Read only the memory files relevant to the task.
4. Inspect source, tests, config, and docs only as needed for evidence.
5. Treat memory as orientation, not proof. Compile, review, and validation gates remain mandatory when required by workflow.

## Ownership Contract

- Everything under `project-memory/` is user-owned.
- Lifecycle materialization may add missing seed files, but must not overwrite, merge, or delete existing files here.
- Agents may write memory files only when workflow mode and explicit operator approval allow it.

## Read-First Files

| File | Purpose |
|---|---|
| `README.md` | This index and ownership protocol. |
| `compact.md` | Bounded task-start project map and routing hints. |

## Focused Memory Files

| File | Purpose |
|---|---|
| `context.md` | Business domain, project goals, and high-level scope. |
| `stack.md` | Languages, frameworks, infrastructure, key dependencies, and unknown/custom stack fallback. |
| `architecture.md` | System architecture, component boundaries, and integration points. |
| `module-map.md` | Repository areas, path ownership, and where to inspect for common changes. |
| `commands.md` | Build, test, dev, release, and verification commands. |
| `conventions.md` | Coding standards, naming rules, and workflow conventions beyond agent-rules. |
| `decisions.md` | Architectural and process decisions with rationale. |
| `risks.md` | Known risks, fragile paths, security notes, and compatibility constraints. |

## Bounded Compact Summary

- Keep `compact.md` below `project_memory_maintenance.max_compact_summary_chars`.
- Put durable details in focused files and link from `compact.md`.
- Remove stale facts instead of accumulating historical noise.

## Adding Files

- Use lowercase kebab-case filenames with `.md` extension, for example `api-contracts.md`.
- Each file should start with a level-1 heading matching its purpose.
- Add new files only for durable project knowledge that agents will reuse across tasks.

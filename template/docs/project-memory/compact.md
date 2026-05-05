# Compact Project Memory

Purpose: short, bounded project map for every task start. Keep this file as links and stable facts, not a full copy of the other memory files.

## Read Order
1. Read `README.md`.
2. Read this file.
3. Read only the task-relevant files listed below.
4. Inspect source, tests, config, and docs needed for the task.

## Project Snapshot
- Domain:
- Primary runtime:
- Main entrypoints:
- Test strategy:
- Release or deployment path:

## Task Routing
| Task type | Read next |
|---|---|
| Feature or bug fix | `module-map.md`, `architecture.md`, `commands.md`, `risks.md` |
| Architecture change | `architecture.md`, `decisions.md`, `module-map.md` |
| Tooling or workflow change | `commands.md`, `module-map.md`, `risks.md`, `decisions.md` |
| Style or convention change | `conventions.md`, `stack.md` |
| Unknown or custom stack | `stack.md`, `commands.md`, `module-map.md`, then inspect repo evidence |

## High-Signal Facts
- 

## Update Notes
- Keep this file below the configured `project_memory_maintenance.max_compact_summary_chars`.
- Move details into focused files and link them from here.
- Update only when durable project facts change.

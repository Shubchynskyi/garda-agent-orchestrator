# Compact Project Memory

Bounded task-start map. Read this file after `README.md`, then open only the task-relevant detailed file.

## Project Snapshot

- Domain:
- Primary runtime:
- Main entrypoints:
- Test strategy:
- Release or deployment path:

## First Reads By Task Type

| Task type | Read next |
|---|---|
| Feature or bug fix | `module-map.md`, `architecture.md`, `commands.md`, `risks.md` |
| Architecture or workflow change | `architecture.md`, `decisions.md`, `module-map.md`, `risks.md` |
| Tooling/config/release change | `commands.md`, `stack.md`, `decisions.md`, `risks.md` |
| Style or convention change | `conventions.md`, `stack.md` |
| Unknown/custom stack | `stack.md`, `commands.md`, `module-map.md`, then inspect repo evidence |

## Core Workflow Contracts

- Project memory is orientation, not proof.
- Verify memory facts against source, tests, config, docs, and gate evidence before changing behavior.
- Write durable current-state contracts only: module ownership, workflow invariants, commands, decisions, risks, and active unknowns.
- Do not store repeated task narratives, transient failures, large command outputs, or duplicated known issues.
- Task ids are optional provenance only and should not be the default heading structure.

## Directory Map

| Need | Start here |
|---|---|
| Source/module ownership | `module-map.md` |
| Commands and validation | `commands.md` |
| Durable decisions | `decisions.md` |
| Risks and fragile contracts | `risks.md` |
| Stack and prerequisites | `stack.md` |

## Update Notes

- Keep this file below `project_memory_maintenance.max_compact_summary_chars`.
- Move details into focused files and link them from here.
- Update only when durable current project facts change.

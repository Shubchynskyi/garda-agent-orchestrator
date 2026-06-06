# Project Memory

Durable project map for agents working in this repository.

This directory is user-owned. Lifecycle commands may seed missing files, but agents must not overwrite, merge, or delete project-memory content unless the operator explicitly asks for a memory update.

## How To Use

1. Read this file.
2. Read `compact.md`.
3. Open only task-relevant files listed in `compact.md` or `module-map.md`.
4. Verify current facts against source, tests, config, and runtime evidence before changing behavior.

Project memory is orientation, not proof. It should help an agent find the right code and contracts quickly; it must not replace `TASK.md`, gate artifacts, source reads, or tests.

## Files

| File | Purpose |
|---|---|
| `compact.md` | Short task-start map: project snapshot, main contracts, routing table, and validation cheat sheet. |
| `context.md` | Product scope, goals, and boundaries. |
| `architecture.md` | Runtime architecture, lifecycle flow, trust boundaries, and artifact ownership. |
| `module-map.md` | Where to inspect code and tests for each project area. |
| `commands.md` | Current commands agents commonly need, with when to run them and cautions. |
| `decisions.md` | Durable architectural and workflow decisions grouped by theme. |
| `risks.md` | Active risk map and fragile contracts to preserve. |
| `conventions.md` | Coding, naming, workflow, and memory maintenance conventions. |
| `stack.md` | Runtime, test, packaging, and infrastructure stack. |

## Write Contract

- Prefer current-state facts over task history.
- Do not use task ids as headings by default.
- Keep task ids only when they are useful provenance for a durable contract.
- Remove or collapse repeated per-task notes once their durable decision is represented in a domain section.
- Keep entries compact enough that `README.md` plus `compact.md` are practical at task start.
- Record uncertainty as a question or risk, not as a fact.

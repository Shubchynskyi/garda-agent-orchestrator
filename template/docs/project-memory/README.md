# Project Memory

Durable project knowledge that survives every orchestrator lifecycle event (init, reinit, update, uninstall-with-keep).

## Ownership Contract

- Everything under `project-memory/` is **user-owned**.
- The materializer never overwrites, merges, or deletes files here.
- Fresh installs seed the category templates below; subsequent lifecycle events leave existing content untouched.

## Document Categories

| File | Purpose |
|---|---|
| `context.md` | Business domain, project goals, and high-level scope. |
| `architecture.md` | System architecture, component boundaries, and integration points. |
| `conventions.md` | Coding standards, naming rules, and workflow conventions beyond the agent-rules contract. |
| `stack.md` | Languages, frameworks, infrastructure, and key dependencies. |
| `decisions.md` | Architectural and process decisions with rationale (lightweight ADR format). |

## Adding Files

- Use lowercase kebab-case filenames with `.md` extension (e.g., `api-contracts.md`, `team-roles.md`).
- Each file should start with a level-1 heading matching its purpose.
- Agents may read any file here for context; only the user or an explicitly user-approved agent action may write.

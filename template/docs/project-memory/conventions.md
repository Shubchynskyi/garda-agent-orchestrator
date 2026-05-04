# Conventions

This file is user-owned. Fresh installs start with the seed conventions below;
update them as the project develops stronger repository-specific rules. Agents
should treat this file as a refinement layer on top of
`docs/agent-rules/30-code-style.md`.

## Code Style
- Prefer small, focused helpers and thin entrypoints instead of mixing parse,
  validate, execute, render, and persistence concerns in one place.
- Keep code readable without narrative comments. Preserve comments only for
  rationale, invariants, security-sensitive constraints, provider or platform
  quirks, and real boundary exceptions.
- Avoid churn-only cleanup. Do not change public CLI, API, or output contracts
  just to make code look cleaner.

## Naming
- Use `camelCase` for internal variables, functions, and non-wire data shapes.
- Use `PascalCase` for type-like symbols and do not prefix interfaces with `I`.
- Name boolean helpers as questions (`is*`, `has*`, `can*`, `should*`) and
  prefer intent-first helper names (`resolve*`, `read*`, `parse*`, `build*`,
  `format*`, `print*`).
- Reserve `UPPER_SNAKE_CASE` for true module-level constants. Keep
  `snake_case` confined to serialized or external boundary fields.

## Workflow
- When style is unclear, follow this priority order:
  `30-code-style.md` -> tooling -> strong project patterns -> common best
  practices.
- Prefer source-of-truth updates in maintained template or project-memory files
  over ad-hoc edits to generated or ignored materializations.
- Refine these seed conventions as the team establishes stable language,
  framework, or domain-specific rules.

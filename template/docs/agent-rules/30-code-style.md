# Code Style

Primary entry point: selected source-of-truth entrypoint for this workspace.

## Purpose
Define style rules for languages that actually exist in this repository.

## Global Rules
- Prefer small, testable functions and explicit naming.
- Keep public APIs stable and documented.
- Follow explicit project rules first, not vague habit or local drift.
- If formatter or linter exists, treat it as source of truth.
- Do not copy inconsistent, legacy, or obviously low-quality patterns just because they already exist in the repository.

## Style Priority Order
- Rules written in this file are the primary source of truth.
- Formatter, linter, and static-analysis configs come next.
- Strong, consistent patterns from high-quality project modules may refine local style decisions.
- Common best practices are the fallback when project-specific guidance is missing.

## Bootstrap Policy When Repository Is Empty
- If there is little or no real project code yet, do not invent a silent style policy.
- Ask the user a mandatory question: accept the default policy of explicit rules + tooling + common best practices, or provide custom project-specific style rules now.
- Record that answer here before broad implementation starts.
- If the default policy is accepted, state it explicitly instead of leaving the section vague.
- As soon as stable project-specific rules exist, replace this bootstrap policy with concrete repository-specific guidance.

## Language-Specific Rules (Fill Only Relevant Sections)

### Java or Kotlin (if present)
- DTO and domain mapping style: `TODO`
- Null-safety and error handling approach: `TODO`
- Transaction and persistence conventions: `TODO`

### TypeScript or JavaScript (if present)
- Type strictness level and runtime validation strategy: `TODO`
- Component and state management conventions: `TODO`
- API contract and schema handling: `TODO`

### Python (if present)
- Type hinting policy and linting rules: `TODO`
- Async patterns and dependency management: `TODO`
- Framework-specific conventions: `TODO`

### Go (if present)
- Package boundaries and interface patterns: `TODO`
- Error wrapping and logging rules: `TODO`

### Rust (if present)
- Ownership and error handling conventions: `TODO`
- Module and crate organization rules: `TODO`

## Definition of Done for Style
- Rules above must match actual stack from `live/project-discovery.md`.
- Outdated language sections must be removed or explicitly marked as not applicable.

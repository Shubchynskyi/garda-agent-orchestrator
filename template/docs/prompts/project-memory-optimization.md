# Project Memory Optimization Prompt

Optimize the project-memory files so another agent can orient quickly with fewer tokens.

## Goal
- Keep project memory as a compact map of the current project, not a task log.
- Preserve durable contracts: module ownership, workflow invariants, commands, decisions, risks, and active unknowns.
- Remove stale duplication, repeated task narratives, long outputs, and details that are already authoritative in source, config, tests, docs, or gate artifacts.

## Required Reading
1. `garda-agent-orchestrator/live/docs/project-memory/README.md`
2. `garda-agent-orchestrator/live/docs/project-memory/compact.md`
3. Focused files under `garda-agent-orchestrator/live/docs/project-memory/` that are relevant to the cleanup.

## Work Rules
- Verify drift-prone facts against current repository evidence before keeping or rewriting them.
- Keep headings stable when possible so future agents can scan quickly.
- Prefer short, current-state bullets over chronological notes.
- Do not paste command output, review reports, runtime JSON, or large code excerpts into memory.
- Preserve useful provenance only when it helps locate a decision or risk; task IDs are optional, not the primary structure.

## Output
- Update only the memory files that need cleanup.
- Report which files changed and which stale or oversized material was removed or consolidated.

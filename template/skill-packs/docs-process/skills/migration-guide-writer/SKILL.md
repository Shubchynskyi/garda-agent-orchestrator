---
name: migration-guide-writer
description: >
  Authors structured migration guides for version upgrades, breaking changes, and configuration transitions.
  Use when the task involves writing, updating, or reviewing a migration/upgrade guide for end-users, operators,
  or developers moving between software versions or adopting breaking changes.
  Trigger phrases: migration guide, upgrade guide, migration doc, version upgrade guide.
  Do NOT use for internal refactoring notes, changelogs, or release announcements that do not include actionable upgrade steps.
license: MIT
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(*)
  - Write
metadata:
  author: garda-agent-orchestrator
  version: 1.0.0
  domain: docs
  triggers: version upgrade, breaking change, config migration, schema migration, API deprecation, platform transition
  role: specialist
  scope: authoring
  output-format: documentation
  related-skills: code-review, api-contract-review, changelog
---

# Migration Guide Writer

## Core Workflow

1. **Scope the migration.** Identify the source version, target version, and every breaking or behavior-changing delta between them. Pull from changelogs, commit history, release notes, and diff of public API surfaces.
2. **State prerequisites.** List required runtime versions, toolchain updates, dependency upgrades, and access/permissions the user must have before starting. Include minimum disk, memory, or downtime estimates when relevant.
3. **Build a compatibility matrix.** For each affected component (API, config schema, database schema, CLI flags, SDK), document which source versions can upgrade directly to the target and which require intermediate stops.
4. **Write ordered upgrade steps.** Number every action the user must take. Each step must be atomic, verifiable, and reversible where possible. Group steps into phases: pre-migration, execution, and post-migration verification.
5. **Document config and data changes.** For every renamed, removed, or re-typed configuration key, environment variable, or data schema column, show a before/after diff or mapping table. Provide a sample of the new config with inline comments.
6. **Add verification checkpoints.** After each critical phase, include a concrete command, query, or UI check the user can run to confirm success before proceeding.
7. **Define rollback boundaries.** State which steps are reversible, which are point-of-no-return, and what the rollback procedure is for each reversible phase. Call out data-loss risks explicitly.
8. **List common failure points.** Document the 3–5 most likely errors and their resolutions. Include exact error messages or symptoms when known.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Migration guide checklist | `references/checklist.md` | Writing or reviewing any migration guide |

## Migration Guide Structure

A well-formed guide follows this outline:

| Section | Purpose |
|---|---|
| Title & version span | `Migrating from vX.Y to vX.Z` — unambiguous scope |
| Prerequisites | Runtime, tooling, permissions, backup state |
| Compatibility matrix | Source → target version mapping, intermediate stops |
| Before you begin | Backup commands, feature-flag advice, maintenance-window guidance |
| Step-by-step upgrade | Numbered, atomic, verifiable actions grouped by phase |
| Config / data changes | Before/after diffs, mapping tables, sample files |
| Verification | Commands or checks to confirm each phase succeeded |
| Rollback procedure | Per-phase rollback steps with data-loss warnings |
| Known issues & FAQ | Common errors, symptoms, and resolutions |

## Constraints

- Do not publish a migration guide without explicit source and target version identifiers.
- Do not combine unrelated version jumps into a single guide; write one guide per major upgrade path.
- Do not omit rollback information; every guide must state rollback boundaries even if rollback is not possible.
- Do not use vague steps like "update your config accordingly"; every config change must show exact keys and values.
- Do not skip verification checkpoints; at least one verification step must follow each destructive or irreversible action.
- Treat database schema migrations, encryption key rotations, and auth provider changes as high-risk steps that require explicit backup and rollback documentation.

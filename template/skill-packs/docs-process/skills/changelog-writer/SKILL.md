---
name: changelog-writer
description: >
  Write or review audience-facing changelogs for releases, version bumps, and
  upgrade communications. Activate when a task involves summarising what changed
  between versions, calling out breaking changes, deprecations, or migrations,
  or preparing release notes for users and operators. Trigger phrases: "write
  changelog", "release notes", "what changed", "version bump", "upgrade notes".
  Negative trigger: commit-message reformatting, git log dumps, internal sprint
  reports, or post-incident reviews (use postmortem-writer).
license: MIT
allowed-tools:
  - Read
  - Grep
  - Glob
  - Write
  - Bash(git log, git diff, git tag)
metadata:
  author: garda-agent-orchestrator
  version: 1.0.0
  domain: docs-process
  triggers: changelog, release notes, version bump, breaking changes, deprecation, upgrade notes
  role: specialist
  scope: documentation
  output-format: markdown-document
  related-skills: adr-writer, migration-guide-writer, runbook-writer
---

# Changelog Writer

## Core Workflow

1. **Identify the release boundary.** Determine the version being released and the previous version or tag it follows. Use `git log`, `git tag`, or version files (`VERSION`, `package.json`) to anchor the diff range. Never write a changelog entry without a concrete before/after boundary.
2. **Determine the audience.** Decide whether the primary readers are end-users, operators/deployers, library consumers, or internal developers. The audience dictates which changes are prominent and which are collapsed or omitted. State the audience explicitly at the top of the entry when the changelog serves mixed readers.
3. **Collect change sources.** Scan merged PRs, closed issues, commit history, and any changeset files (`.changeset/`, `.changelog/`) within the release range. Cross-reference version-bump commits and release scripts to avoid gaps. Do not rely on commit messages alone — titles may be terse or misleading.
4. **Classify and group changes.** Assign every included change to exactly one category. Use a consistent, impact-ordered grouping:
   - **Breaking Changes** — removals, renamed APIs, changed defaults, incompatible schema changes.
   - **Deprecations** — features or APIs scheduled for removal with migration path.
   - **Features** — new capabilities visible to the audience.
   - **Fixes** — corrected defects the audience could encounter.
   - **Performance** — measurable improvements (only if significant).
   - **Internal / Maintenance** — dependency bumps, refactors, CI changes (collapse or omit for external audiences).
5. **Write each entry.** For every change, write a concise sentence from the audience's perspective: what changed, why it matters, and what to do (if action is needed). Link to the originating PR or issue. For breaking changes, include a short migration snippet or pointer to full migration docs.
6. **Surface breaking changes and migrations.** If breaking changes exist, place them first and add a prominent callout (`> ⚠️ Breaking`). For each, describe the before/after behavior and the required migration step. If a separate migration guide exists, cross-reference it rather than duplicating content.
7. **Validate against checklist.** Walk through `references/checklist.md` before marking the changelog entry complete. Confirm version header, date, grouping order, link integrity, and that no merged change was silently dropped.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Changelog quality checklist | `references/checklist.md` | Writing or reviewing any changelog entry |

## Constraints

- Never dump raw commit messages or PR titles as changelog entries. Every line must be rewritten for the declared audience.
- Never omit breaking changes. If a release contains a breaking change without a changelog callout, the entry is incomplete regardless of other content.
- Do not mix audience levels in a single entry without clear section separation (e.g., "For users" vs. "For operators").
- Do not backfill entries for versions that were already released unless explicitly instructed; append only the new release.
- Preserve the project's existing changelog format, heading style, and date convention. Do not restructure the file unless asked.
- Keep entries for a single release in one contiguous block. Do not scatter entries across the file.

## Anti-Patterns

- **Commit-message dump**: pasting `git log --oneline` output and calling it a changelog. Audiences cannot extract impact from commit shortlog.
- **Missing migration path**: documenting that a breaking change happened without explaining how to adapt. A breaking-change entry without a migration step is a support-ticket generator.
- **Buried breaking changes**: hiding removals or default changes inside a "Fixes" or "Misc" section. Breaking changes must always appear first.
- **Version-only header**: a version number with no date, making it impossible to correlate the release with deployment timelines or incident windows.
- **Orphan entries**: changelog lines that reference a PR or issue number that does not exist or is inaccessible. Always verify link targets.

# Changelog Entry Checklist

Use this checklist when writing or reviewing a changelog entry for a release.

## Header & Metadata

- [ ] Version number matches the actual release tag or planned version.
- [ ] Release date is present and uses the project's date format (e.g., `YYYY-MM-DD`).
- [ ] Header style is consistent with existing entries in the changelog file.

## Completeness

- [ ] Every merged PR / closed issue in the release range is accounted for (included or explicitly excluded as internal-only).
- [ ] No change is silently dropped; omissions are intentional and justified by audience scope.

## Grouping & Order

- [ ] Breaking Changes appear first when present.
- [ ] Deprecations follow breaking changes.
- [ ] Remaining groups follow a consistent order: Features → Fixes → Performance → Internal.
- [ ] Each change belongs to exactly one group; no duplicates across sections.

## Breaking Changes & Migrations

- [ ] Every breaking change has a prominent callout (`⚠️ Breaking` or equivalent).
- [ ] Each breaking change describes before/after behavior.
- [ ] A migration step or link to migration docs is provided for every breaking change.
- [ ] Deprecation entries state the removal timeline and the recommended replacement.

## Entry Quality

- [ ] Each line is written from the audience's perspective, not the developer's.
- [ ] Entries describe impact ("X now does Y") not implementation ("refactored Z module").
- [ ] PR or issue links are present and point to accessible, existing resources.
- [ ] No raw commit messages or PR titles used verbatim as entries.

## Consistency

- [ ] Formatting matches the project's existing changelog conventions (bullet style, link format, heading level).
- [ ] New entry is inserted at the correct position (typically top of file, below any preamble).
- [ ] No unintended edits to previous release entries.

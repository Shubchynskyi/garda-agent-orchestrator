# Migration Guide Checklist

## Scope & Prerequisites

- [ ] Source and target versions are stated explicitly in the title.
- [ ] All prerequisites (runtime, toolchain, permissions, backups) are listed before step 1.
- [ ] Compatibility matrix covers every affected component.
- [ ] Intermediate upgrade stops are documented when direct jump is unsupported.

## Upgrade Steps

- [ ] Steps are numbered, atomic, and grouped by phase (pre-migration, execution, post-migration).
- [ ] Each step states what to do, not just what changed.
- [ ] Destructive or irreversible steps are flagged with a warning.
- [ ] Commands use exact syntax; no pseudocode or placeholders.

## Config & Data

- [ ] Every changed config key, env var, or schema field has a before/after diff or mapping table.
- [ ] Sample config files use realistic values, not placeholders.
- [ ] Data migration commands include expected duration or row-count estimates where applicable.

## Verification & Rollback

- [ ] At least one verification checkpoint exists after each critical phase.
- [ ] Rollback procedure is documented per phase with data-loss boundaries.
- [ ] Point-of-no-return steps are explicitly called out.

## Failure Guidance

- [ ] Top 3–5 common errors are listed with exact symptoms and resolutions.
- [ ] Edge cases (partial upgrade, mixed-version clusters, interrupted migrations) are addressed.

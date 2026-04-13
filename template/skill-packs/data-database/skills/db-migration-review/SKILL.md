---
name: db-migration-review
description: >
  Reviews database schema migrations for safety, backward compatibility, lock risk, data correctness,
  and rollback feasibility. Use when a task introduces or modifies migration files, schema definitions,
  backfill scripts, index changes, or column-level alterations in any SQL or ORM migration framework.
  Trigger phrases: migration review, schema migration, db schema review, migration safety, backfill review.
  Do NOT use for pure application query tuning or read-only analytics work that does not alter schema.
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
  domain: data
  triggers: Flyway, Liquibase, Alembic, Prisma Migrate, Drizzle, Knex, Sequelize, TypeORM, Django migrations, Rails ActiveRecord, raw DDL
  role: specialist
  scope: review
  output-format: review-findings
  related-skills: code-review, api-contract-review, dependency-review
---

# DB Migration Review

## Core Workflow

1. **Inventory migration files.** Identify every new or changed migration, seed, and backfill script in the changeset. Confirm ordering: timestamp or sequence numbers must be monotonically increasing and free of gaps or collisions with other in-flight branches.
2. **Classify each operation by risk tier.** Map every DDL statement to a risk level:
   - *Low*: `ADD COLUMN ... NULL`, `CREATE INDEX CONCURRENTLY`, add new table.
   - *Medium*: `ADD COLUMN ... DEFAULT` (engine-dependent rewrite), add non-concurrent index, add `CHECK`/`NOT NULL` with backfill.
   - *High*: `DROP COLUMN`, `RENAME COLUMN`, change column type, `DROP TABLE`, large backfill on hot table.
3. **Verify expand-contract sequencing.** Breaking schema changes must follow the expand → migrate data → contract pattern across at least two deployment cycles. A single migration that both adds and drops the old column is a hard fail unless the table is provably unused.
4. **Assess lock and rewrite impact.** For each DDL, determine whether the target engine acquires an `ACCESS EXCLUSIVE` lock or triggers a full table rewrite. Flag any operation that locks a high-traffic table for more than trivial duration. Recommend online-DDL tools (`pt-online-schema-change`, `gh-ost`, `pg_repack`, `CONCURRENTLY`) where applicable.
5. **Evaluate index rollout.** New indexes on large tables must be created concurrently or out-of-band. Verify that index columns match real query patterns (check existing slow-query logs or explain plans if available). Confirm that partial or expression indexes have correct predicates.
6. **Review backfill correctness.** Backfills must be batched, idempotent, and restartable. Verify they set only the intended rows, handle NULLs explicitly, and respect concurrent writes during the migration window. Confirm timeout/batch-size defaults are safe for production row counts.
7. **Check rollback feasibility.** Every migration must either be reversible via a down-migration or paired with a documented manual rollback procedure. Destructive operations (`DROP COLUMN`, `DROP TABLE`) must be preceded by a verified backup or data-retention window.
8. **Validate dual-read/write windows.** When old and new columns or tables coexist, confirm application code reads from the correct source at each deployment stage and that writes propagate to both locations until the contract phase removes the old path.
9. **Confirm deployment coordination.** Ensure the migration plan documents ordering relative to application releases (migrate-first vs. code-first), feature-flag dependencies, and rollback triggers. Flag any migration that assumes instant deployment of all application nodes.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Migration safety checklist | `references/checklist.md` | Any migration review or authoring task |

## Migration Risk Heuristics

A migration is high-risk if any of the following apply:

- Acquires an exclusive lock on a table with sustained write traffic.
- Performs a full table rewrite on a table exceeding the engine's online-DDL threshold.
- Removes or renames a column that existing application code or downstream consumers still reference.
- Backfills millions of rows in a single transaction without batching.
- Has no down-migration and the forward migration is not idempotent.
- Changes column type in a way that may truncate, lose precision, or reject existing values.
- Depends on a specific application deploy order but does not document it.

When uncertain, treat the migration as high-risk and require explicit risk-acceptance sign-off.

## Constraints

- Do not approve a migration that drops or renames a column still referenced by deployed application code.
- Do not accept a non-concurrent index creation on a large production table without explicit justification.
- Do not permit a backfill that runs unbatched or is non-idempotent.
- Do not skip rollback review; every destructive migration must have a documented recovery path.
- Do not approve migrations that combine expand and contract steps in a single deployment cycle for active tables.
- Treat any migration without ordering validation (duplicate timestamps, sequence collisions) as a hard fail.

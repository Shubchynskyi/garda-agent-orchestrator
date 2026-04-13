---
name: sql-review
description: >
  Reviews SQL statements and data-access code for correctness, safety, null handling, join semantics,
  parameterization, transaction boundaries, pagination, and maintainability under change.
  Use when a task introduces or modifies SQL queries, repository/DAL layers, ORM raw-query calls,
  stored procedures, or view definitions.
  Trigger phrases: sql review, query review, sql correctness, data access review.
  Do NOT use for schema migration safety (use db-migration-review) or vendor-specific query performance tuning (use query-performance).
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
  triggers: SQL files, repository layer, DAL, raw SQL in ORM, Knex query builder, Sequelize literal, TypeORM raw, Prisma $queryRaw, Drizzle sql template, stored procedures, views
  role: specialist
  scope: review
  output-format: review-findings
  related-skills: code-review, db-migration-review, query-performance
---

# SQL Review

## Core Workflow

1. **Collect SQL surface.** Identify every new or changed SQL statement: standalone `.sql` files, inline raw queries in application code, query-builder chains that produce raw fragments, stored procedures, and view definitions. Include ORM escape hatches (`$queryRaw`, `Sequelize.literal`, `knex.raw`, `sql` tagged templates).
2. **Verify parameterization.** Every external input must reach SQL through bind parameters or the ORM's parameterization API—never through string concatenation or template interpolation. Flag any dynamic column/table names that bypass allow-list validation.
3. **Audit NULL semantics.** Check that comparisons use `IS NULL` / `IS NOT NULL` instead of `= NULL`. Verify that `COALESCE`, `NULLIF`, and `IFNULL` are applied where NULLs can propagate through `JOIN`, `LEFT JOIN`, or aggregation. Confirm `NOT IN` clauses cannot silently return empty sets when the subquery contains NULL.
4. **Validate JOIN correctness.** Confirm join conditions match actual key relationships and cardinality. Flag implicit cross joins, missing join predicates, and joins on nullable columns without NULL guards. Verify that `LEFT JOIN` versus `INNER JOIN` choice reflects intended row-preservation behavior.
5. **Check aggregation and grouping.** Ensure every non-aggregated column in `SELECT` appears in `GROUP BY`. Verify `HAVING` filters reference aggregate results, not pre-group row values. Flag `DISTINCT` used as a band-aid for duplicate rows caused by incorrect joins.
6. **Review transaction boundaries.** Confirm multi-statement mutations run inside an explicit transaction with appropriate isolation level. Verify read-then-write sequences are protected from TOCTOU races. Check that long-running transactions do not hold locks unnecessarily.
7. **Assess mutation safety.** `UPDATE` and `DELETE` must have a restrictive `WHERE` clause; flag unguarded mutations that could affect all rows. `INSERT … ON CONFLICT` / `MERGE` must handle all conflict columns. Verify `RETURNING` is used where the caller needs affected-row data.
8. **Evaluate pagination correctness.** `OFFSET`-based pagination must be flagged when used on mutable result sets. Keyset (cursor) pagination is preferred. Verify `ORDER BY` is deterministic (includes a unique tiebreaker column).
9. **Check readability and maintainability.** CTEs or subqueries should have meaningful aliases. Avoid `SELECT *` in production code paths. Confirm that complex predicates are commented or decomposed.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| SQL review checklist | `references/checklist.md` | Any SQL review or data-access authoring task |

## Constraints

- Do not approve any query that constructs SQL from unsanitized external input without bind parameters.
- Do not accept `= NULL` or `<> NULL` comparisons; require `IS [NOT] NULL`.
- Do not permit unguarded `UPDATE` or `DELETE` without a `WHERE` clause or confirmation of intentional full-table mutation.
- Do not approve `NOT IN (subquery)` when the subquery column is nullable; require `NOT EXISTS` instead.
- Do not allow `OFFSET`-based pagination on large mutable datasets without documented justification.
- Do not accept `DISTINCT` as a fix for duplicate rows without verifying join correctness first.
- Treat any raw SQL bypass of the ORM's parameterization as high-risk and require explicit review.

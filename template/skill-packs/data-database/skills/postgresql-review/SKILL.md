---
name: postgresql-review
description: Review PostgreSQL-specific schema design, query plans, MVCC behavior, index strategy, locking, JSONB usage, and runtime configuration. Use when a task involves PostgreSQL DDL, migration authoring, EXPLAIN output, vacuum tuning, transaction isolation choices, or Postgres-specific extensions. Triggers — EXPLAIN ANALYZE, vacuum, advisory lock, GIN index, partial index, JSONB, materialized view, pgbouncer, connection pool. Negative trigger — generic SQL review with no PostgreSQL-specific constructs.
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
  triggers: EXPLAIN ANALYZE, autovacuum, GIN, BRIN, partial index, JSONB, advisory lock, CTE, materialized view, pg_stat, pgbouncer, row-level security
  role: specialist
  scope: review-and-fix
  output-format: findings-and-checklist
  related-skills: sql-review, query-performance, db-migration-review
---

# PostgreSQL Review

## Core Workflow

1. Identify PostgreSQL version and configuration scope — locate `postgresql.conf` overrides, connection-pool settings (PgBouncer/pgpool), and the ORM or driver in use (node-postgres, pgx, psycopg, Prisma, etc.).
2. Review schema changes for PostgreSQL-specific correctness: data-type choice (UUID vs BIGSERIAL, JSONB vs JSON, TIMESTAMPTZ vs TIMESTAMP), constraint expressions, generated columns, and enum evolution safety.
3. Evaluate index strategy: confirm B-tree column order matches query patterns; assess GIN for JSONB/array/full-text, BRIN for append-only time-series, and partial indexes for selective predicates; reject redundant or overlapping indexes.
4. Analyze query plans with `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)`: flag sequential scans on large tables, lossy bitmap heap scans, high sort/hash costs, and CTE fences that prevent predicate push-down (pre-v12 behavior).
5. Assess MVCC and locking implications: verify transaction isolation level matches the use-case, check for long-running transactions that block autovacuum, detect advisory-lock misuse, and flag `SELECT … FOR UPDATE` on hot rows without `SKIP LOCKED` or retry logic.
6. Validate autovacuum health: ensure high-churn tables have tuned per-table autovacuum thresholds; confirm that bulk-load or delete operations are followed by explicit `ANALYZE`; flag disabled autovacuum.
7. Review migration safety: verify DDL uses concurrent index creation (`CREATE INDEX CONCURRENTLY`), avoids table-rewrite ALTERs on large tables without a low-downtime plan, and includes rollback steps.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| PostgreSQL review checklist | `references/checklist.md` | Any PostgreSQL schema, query, or configuration review |

## Constraints

- Do not recommend GIN or GiST indexes without confirming the query patterns justify the write-amplification cost.
- Do not lower transaction isolation level to fix performance without documenting the consistency trade-off.
- Do not add `FOR UPDATE` or advisory locks without a deadlock-avoidance strategy and timeout.
- Do not approve migrations that take `ACCESS EXCLUSIVE` locks on high-traffic tables without a low-downtime plan.
- Treat autovacuum parameter changes and `postgresql.conf` tuning as production-critical; require evidence from `pg_stat_user_tables` or `pg_stat_activity` before recommending changes.
- Do not conflate generic SQL best practices with PostgreSQL-specific guidance; defer generic concerns to the `sql-review` or `query-performance` skills.

# PostgreSQL Review Checklist

## Version, Types & Schema Semantics

- [ ] Confirm PostgreSQL version and note feature availability (for example non-blocking `ADD COLUMN DEFAULT` in newer versions).
- [ ] Verify data types: prefer `TIMESTAMPTZ` over `TIMESTAMP`, `JSONB` over `JSON`, and server-generated UUID defaults where applicable.
- [ ] Ensure schema and migration changes include explicit rollback or compensating DDL and are tested against representative data volume.

## Query Plans & Indexes

- [ ] Check that every new index uses `CREATE INDEX CONCURRENTLY` when production locking matters.
- [ ] Validate index type selection: B-tree for equality or range, GIN for JSONB containment or full-text, BRIN for append-only large tables.
- [ ] Review partial indexes to confirm the predicate matches the dominant query pattern.
- [ ] Run `EXPLAIN (ANALYZE, BUFFERS)` on changed queries and reject unexplained sequential scans on non-trivial tables.

## Concurrency, Locks & Transactions

- [ ] Check CTE usage and planner behavior for the target PostgreSQL version; prefer subqueries or lateral joins when push-down matters.
- [ ] Verify transaction isolation level and require explicit retry logic for SERIALIZABLE or REPEATABLE READ use.
- [ ] Inspect `FOR UPDATE` or `FOR SHARE` usage; confirm `SKIP LOCKED` or `NOWAIT` when appropriate and review lock ordering for deadlock risk.
- [ ] Check connection-pool configuration (PgBouncer or pgpool) for compatibility with prepared statements, transactions, and advisory locks.

## Operations & Maintenance

- [ ] Validate autovacuum settings on high-churn tables and confirm ANALYZE follows bulk DELETE or COPY operations.
- [ ] Review JSONB access patterns and ensure indexed operators are used instead of expensive extract-and-filter scans.
- [ ] Note replication, failover, or long-running migration implications when the change touches hot tables or large backfills.

## Release & Rollback

- [ ] Confirm lock-heavy or rewrite-heavy operations have a deployment window, abort threshold, and rollback path.
- [ ] Check whether replicas, logical consumers, or long-running transactions will amplify the change beyond the primary node.
- [ ] Treat schema, query, and pool changes as one release unit when they must land together for planner stability.

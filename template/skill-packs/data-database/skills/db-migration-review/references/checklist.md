# DB Migration Safety Checklist

## Ordering & Idempotency

- [ ] Migration timestamps or sequence numbers are unique and monotonically increasing.
- [ ] No ordering collision with migrations from other in-flight branches.
- [ ] Each migration is idempotent or guarded by `IF NOT EXISTS` / `IF EXISTS` checks.

## Lock & Rewrite Risk

- [ ] No `ACCESS EXCLUSIVE` lock held on a high-traffic table for more than trivial duration.
- [ ] Table-rewriting operations use online-DDL tooling or are scheduled in a maintenance window.
- [ ] `CREATE INDEX` on large tables uses `CONCURRENTLY` (Postgres) or equivalent.

## Expand-Contract Discipline

- [ ] Column drops and renames are separated from the add/populate step by at least one deployment cycle.
- [ ] Application code reads from the new column/table before the old one is removed.
- [ ] Dual-write logic propagates to both old and new locations during the transition window.

## Backfill Safety

- [ ] Backfill runs in batches with configurable batch size and sleep interval.
- [ ] Backfill is idempotent and restartable from the last processed batch.
- [ ] NULL and edge-case values are handled explicitly.
- [ ] Backfill respects concurrent writes and does not overwrite newer data.
- [ ] Estimated run time and row count are documented for production.

## Rollback & Recovery

- [ ] A working down-migration exists or a manual rollback procedure is documented.
- [ ] Destructive operations are preceded by a verified backup or retention window.
- [ ] Rollback has been tested against realistic data (not just an empty schema).

## Data Correctness

- [ ] Column type changes preserve precision, range, and encoding of existing values.
- [ ] Default values match application semantics and do not introduce silent data drift.
- [ ] `NOT NULL` constraints are added only after all existing rows satisfy the constraint.
- [ ] Foreign key additions do not reference stale or orphaned rows.

## Deployment Coordination

- [ ] Migration-first vs. code-first ordering is documented and matches the deploy pipeline.
- [ ] Feature flags gate new code paths until the migration is confirmed applied.
- [ ] Rollback trigger criteria are defined (error rate, latency threshold, data anomaly).
- [ ] Multi-node deploy scenario is considered; no migration assumes instant fleet-wide rollout.

## Index Quality

- [ ] New indexes match real query patterns (verified against slow-query logs or explain plans).
- [ ] Redundant or overlapping indexes are identified and removed.
- [ ] Partial or expression indexes have correct predicates.
- [ ] Index creation estimated time is acceptable for production traffic levels.

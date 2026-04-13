# Query Performance Checklist

## Baseline & Plan Quality

- [ ] Capture before/after timing or plan output on representative data, not an empty dev database.
- [ ] Reject sequential scans on non-trivial tables unless explicitly justified.
- [ ] Compare estimated vs actual rows; large skew suggests stale stats or wrong predicates.

## Index & Predicate Shape

- [ ] Verify every `WHERE`, `JOIN ON`, and `ORDER BY` column is covered by an appropriate index.
- [ ] Check composite-index column order matches predicate and sort order.
- [ ] Review implicit casts or function wraps on indexed columns that prevent index use.
- [ ] Avoid adding redundant or overlapping indexes without write-cost review.

## Access Pattern & Result Shape

- [ ] Detect N+1 access patterns; prefer batch or join-based loading.
- [ ] Ensure pagination uses keyset/cursor strategy instead of large OFFSET on big mutable sets.
- [ ] Avoid `SELECT *`; project only required columns, especially with wide rows or LOBs.
- [ ] Flag `DISTINCT` used to mask duplicate rows from incorrect joins.
- [ ] Check for missing `LIMIT` on exploratory or admin queries that could return unbounded rows.

## Safety & Regression Proof

- [ ] Validate that new or changed indexes do not degrade write throughput or lock hot tables unexpectedly.
- [ ] Confirm query changes preserve ordering semantics and contract behavior.
- [ ] Require verification against representative data volumes before approving the optimization.

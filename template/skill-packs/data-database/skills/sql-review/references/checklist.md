# SQL Review Checklist

## Parameterization & Injection Safety

- [ ] All external inputs reach SQL through bind parameters or ORM parameterization API.
- [ ] Dynamic table/column names are validated against an explicit allow-list.
- [ ] No string concatenation or unescaped template interpolation builds SQL fragments.
- [ ] ORM raw-query escape hatches (`$queryRaw`, `knex.raw`, `Sequelize.literal`) use placeholders.

## NULL Semantics

- [ ] Comparisons use `IS NULL` / `IS NOT NULL`, never `= NULL` or `<> NULL`.
- [ ] `COALESCE` or `IFNULL` is applied where NULLs propagate through joins or expressions.
- [ ] `NOT IN (subquery)` is replaced with `NOT EXISTS` when the subquery column is nullable.
- [ ] Aggregate functions (`COUNT`, `SUM`, `AVG`) account for NULL rows producing unexpected results.

## JOIN Correctness

- [ ] Every join has an explicit `ON` clause matching actual key relationships.
- [ ] No accidental cross joins from missing or incorrect join predicates.
- [ ] `LEFT JOIN` vs. `INNER JOIN` choice matches intended row-preservation behavior.
- [ ] Joins on nullable columns include NULL guards where semantics require it.
- [ ] Multi-table joins are reviewed for unintended row multiplication.

## Aggregation & Grouping

- [ ] Every non-aggregated `SELECT` column appears in `GROUP BY`.
- [ ] `HAVING` clauses reference aggregate results, not pre-group row values.
- [ ] `DISTINCT` is not used as a band-aid for duplicates caused by incorrect joins.

## Transaction Boundaries

- [ ] Multi-statement mutations execute inside an explicit transaction.
- [ ] Isolation level is appropriate for the operation (no unnecessary serializable).
- [ ] Read-then-write sequences are protected against TOCTOU races.
- [ ] Transactions are kept short; long-held locks are documented and justified.
- [ ] Error paths execute rollback; no transaction is left dangling on exception.

## Mutation Safety

- [ ] `UPDATE` and `DELETE` have a restrictive `WHERE` clause.
- [ ] Unguarded full-table mutations are flagged and require explicit confirmation.
- [ ] `INSERT … ON CONFLICT` / `MERGE` specifies all relevant conflict columns.
- [ ] `RETURNING` is used when the caller needs affected-row data.
- [ ] Mutation side effects (triggers, cascades) are identified and reviewed.

## Pagination & Ordering

- [ ] `ORDER BY` includes a unique tiebreaker column for deterministic results.
- [ ] `OFFSET`-based pagination on large mutable sets is flagged; keyset pagination preferred.
- [ ] Cursor values are opaque to the client and validated server-side.

## Readability & Maintainability

- [ ] No `SELECT *` in production code paths; columns are listed explicitly.
- [ ] CTEs and subqueries have meaningful aliases.
- [ ] Complex predicates are commented or decomposed into named CTEs.
- [ ] Magic numbers and hard-coded IDs are extracted to named constants or parameters.

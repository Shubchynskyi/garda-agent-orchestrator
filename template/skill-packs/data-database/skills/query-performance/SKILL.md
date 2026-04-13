---
name: query-performance
description: >
  Diagnose and improve SQL query performance. Use when a task involves slow
  queries, EXPLAIN plan analysis, index tuning, join optimization, N+1
  detection, pagination efficiency, or query regression checks. Trigger
  phrases: slow query, explain plan, missing index, full table scan, N+1,
  query timeout, lock contention. Negative trigger: schema-only migrations
  with no query or access-pattern change.
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
  triggers: EXPLAIN, slow query, index, N+1, full scan, sort cost, pagination, query regression, ORM eager/lazy load
  role: specialist
  scope: review-and-fix
  output-format: findings-and-checklist
  related-skills: sql-review, db-migration-review, code-review
---

# Query Performance

## Core Workflow

1. **Establish a real baseline.** Identify the query under review, its caller, and the tables/views involved, then anchor the analysis to representative data volume and workload. Do not reason from an empty local database or a toy fixture and call the result a performance review.
2. **Inspect the plan, not the SQL alone.** Obtain `EXPLAIN ANALYZE` (plus buffers/verbose output when available) and compare estimated vs actual row counts. Large estimate skew often matters as much as the raw cost because it points to stale statistics, low-selectivity predicates, or a plan choice the optimizer is making on bad assumptions.
3. **Review predicate, join, and sort shape together.** Verify filters, join keys, and `ORDER BY` clauses line up with actual indexes. Check composite-index ordering, low-selectivity leading columns, function-wrapped predicates, implicit casts, and join types that inflate work or defeat index use.
4. **Audit access-pattern pathologies.** Look for N+1 loops, repeated round-trips, unbounded result sets, `SELECT *` on wide rows, redundant ORM eager loading, and OFFSET pagination on hot mutable tables. A slow endpoint is often many cheap queries plus network chatter rather than one obviously bad statement.
5. **Model the write-side and concurrency cost of the fix.** Adding an index, changing pagination, or rewriting a join is not free. Review write amplification, index-build lock behavior, temp-file sort spill, memory pressure, and whether the proposed optimization changes the observable ordering or contract of the endpoint.
6. **Propose the smallest safe improvement and prove it.** Prefer the minimal change that addresses the real bottleneck: predicate rewrite, better projection, batch load, cursor pagination, or an index with clear justification. Require before/after plan or latency evidence, and note rollback or migration impact when the fix changes schema or API behavior.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Performance checklist | `references/checklist.md` | Any query performance review or optimization task |

## Failure Patterns

- Adding `DISTINCT` to hide duplicate rows caused by a bad join rather than fixing the join shape.
- Adding indexes before confirming selectivity, predicate shape, and write-path cost.
- Trusting `EXPLAIN` output from empty or toy datasets and calling the conclusion production-ready.
- Replacing one measurable SQL bottleneck with many application-level round-trips or N+1 fetches.
- Shipping cursor pagination without a stable, unique sort order that preserves user-visible semantics.
- Wrapping indexed columns in functions or casts that silently defeat index use.

## Constraints

- Do not approve optimization claims without before/after evidence or at least plan-level comparison on representative data.
- Do not add indexes without considering write-path cost, table size, and existing index overlap.
- Do not rewrite queries in application code without verifying the new plan against realistic data volumes.
- Do not silently convert lazy-loaded associations to eager-load without assessing memory and payload impact.
- Do not change pagination semantics or ordering guarantees silently while chasing speed.
- Do not move filtering or sorting into application code unless the new cost profile is measured and bounded.
- Treat pagination strategy changes and lock-hint additions as migration-level risks requiring rollback safety.

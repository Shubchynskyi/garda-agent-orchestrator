---
name: prisma-review
description: >
  Reviews Prisma schema design, migration safety, relation modeling, client usage, and query correctness.
  Use when a task touches schema.prisma, prisma/migrations/, Prisma Client queries, seed scripts,
  repository/service layers that import @prisma/client, or any prisma generate / prisma migrate workflow.
  Trigger phrases: prisma review, schema review, migration review, prisma query review.
  Do NOT use for generic SQL tuning unrelated to Prisma, or for Sequelize/TypeORM/Drizzle schemas.
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
  triggers: schema.prisma, prisma migrate, prisma generate, @prisma/client, Prisma seed, relation modeling
  role: specialist
  scope: review
  output-format: review-findings
  related-skills: code-review, node-backend, sql-review, db-migration-review
---

# Prisma Review

## Core Workflow

1. **Locate schema and client usage.** Find `schema.prisma` (may live at `prisma/schema.prisma` or a custom path in `package.json` → `prisma.schema`). Identify every file that imports from `@prisma/client` or references the generated `PrismaClient`.
2. **Validate schema design.** Check that every model has an explicit `@id` or `@@id`, relations use correct scalar fields and `@relation` attributes, index annotations (`@@index`, `@@unique`) cover query-critical columns, and enum types are used instead of unconstrained strings where the domain is closed.
3. **Review migration safety.** Compare the latest migration SQL in `prisma/migrations/` against the schema diff. Flag destructive operations: column drops, type narrowing, `NOT NULL` additions without defaults, index drops on high-traffic tables, and renaming columns (Prisma emits drop+add, not `ALTER … RENAME`). Confirm `prisma migrate deploy` will not fail on production data.
4. **Audit client query patterns.** Verify that `select` or `include` is explicit on every query — never rely on default full-model fetch. Flag N+1 patterns: loops that issue per-item `findUnique`/`findFirst` instead of a single `findMany` with `where: { id: { in: ids } }`. Check that nested `include` depth is bounded and justified.
5. **Check transaction correctness.** Ensure multi-write operations use `prisma.$transaction()` (sequential array or interactive callback). Confirm the isolation level is intentional. Flag fire-and-forget writes that silently discard errors.
6. **Verify generate and drift.** Confirm that `prisma generate` has been run after schema changes so the generated client matches the schema. If CI runs `prisma generate`, verify the step order: generate before build/test. Flag any raw SQL (`$queryRaw`, `$executeRaw`) that duplicates logic expressible through the typed client.
7. **Inspect seed and test data.** If `prisma/seed.ts` or `prisma/seed.js` exists, ensure it is idempotent (upserts or deletes before inserts), respects foreign-key ordering, and does not embed secrets. Verify test helpers reset state without leaving orphan records.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Prisma review checklist | `references/checklist.md` | Any Prisma schema, migration, or client change |

## Constraints

- Do not approve migrations that contain destructive column operations without an explicit data-migration or backfill plan.
- Do not allow queries that fetch full models without `select` or `include` in hot paths; treat implicit full-fetch as a performance finding.
- Do not permit `$queryRaw` or `$executeRaw` when the same operation is expressible through the typed Prisma Client API, unless there is a documented performance justification.
- Do not accept schema changes without a corresponding migration file; a schema–migration drift is a hard-fail finding.
- Do not skip relation-load review; unbounded nested `include` chains are a high-severity risk.
- Treat any rename of a model or field as potentially breaking: Prisma maps renames to drop+create, which causes data loss without `@map`/`@@map`.

# Prisma Review Checklist

## Schema Design

- [ ] Every model declares an explicit `@id` or `@@id`.
- [ ] Relation fields carry correct `@relation` with `fields` and `references`.
- [ ] `@@index` covers columns used in `where`, `orderBy`, and `distinct` queries.
- [ ] `@@unique` constraints match domain uniqueness invariants.
- [ ] Enums are used for closed value sets instead of bare `String`.
- [ ] Optional fields (`?`) are intentional; no silent nullability widening.
- [ ] `@map` / `@@map` used when field or model names differ from DB column/table names to prevent data-loss renames.
- [ ] `@default` values are set for new non-nullable columns to keep migrations additive.

## Migration Safety

- [ ] Migration SQL reviewed; no unintended `DROP COLUMN` or `DROP TABLE`.
- [ ] Column type changes preserve data (e.g., `VARCHAR(50)` → `VARCHAR(255)`, not the reverse).
- [ ] New `NOT NULL` columns include a `DEFAULT` or are preceded by a backfill step.
- [ ] Renamed fields use `@map` to avoid drop+create at the database level.
- [ ] Migration ordering is linear; no manual timestamp edits that break `_prisma_migrations` history.
- [ ] `prisma migrate deploy` tested against a representative dataset (or documented as safe).

## Client Usage

- [ ] Every query specifies `select` or `include`; no implicit full-model fetch in hot paths.
- [ ] No N+1 patterns: per-item `findUnique` inside a loop replaced with batched `findMany`.
- [ ] Nested `include` depth is bounded (≤ 2 levels unless explicitly justified).
- [ ] Pagination uses `cursor`-based approach or `skip/take` with a bounded page size.
- [ ] `create`, `update`, `delete` return only the fields the caller needs.

## Transactions

- [ ] Multi-write operations wrapped in `prisma.$transaction()`.
- [ ] Interactive transactions specify an appropriate timeout and isolation level.
- [ ] No fire-and-forget writes; every mutation's promise is awaited and errors handled.
- [ ] Nested `create`/`connectOrCreate` inside a single operation preferred over manual multi-step writes when possible.

## Generate & Drift

- [ ] `prisma generate` has been run after the latest schema change.
- [ ] CI pipeline runs `prisma generate` before build and test steps.
- [ ] No mismatch between `schema.prisma` and the generated client (`@prisma/client` is up to date).
- [ ] `prisma db pull` used only for initial import; ongoing changes flow from schema-first migrations.

## Raw SQL & Escape Hatches

- [ ] `$queryRaw` / `$executeRaw` used only when the typed API cannot express the query.
- [ ] Raw SQL uses parameterized inputs (`Prisma.sql` tagged template); no string interpolation.
- [ ] Raw query results are validated or cast to a known type before use.

## Seed & Test Data

- [ ] Seed script is idempotent (uses `upsert` or cleans before insert).
- [ ] Seed respects foreign-key insertion order.
- [ ] No secrets or real PII in seed data.
- [ ] Test helpers reset state between runs without leaving orphan records.

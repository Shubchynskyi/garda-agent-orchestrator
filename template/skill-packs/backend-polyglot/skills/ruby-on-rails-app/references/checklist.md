# Ruby on Rails Delivery Checklist

## Pre-flight

- [ ] Confirm Rails version and Ruby version in `Gemfile` / `.ruby-version`.
- [ ] Confirm test runner (`rspec`, `minitest`) and lint tool (`rubocop`) from `40-commands.md`.
- [ ] Run `bundle install` if Gemfile changed.

## Routing & Controllers

- [ ] New/changed routes use RESTful resources or explicit verb constraints.
- [ ] Controller actions call `permit` on params via strong-parameter methods.
- [ ] No business logic lives directly in controller actions; delegated to services or models.
- [ ] Authorization check (Pundit `authorize`, Action Policy, or custom) present on every state-mutating action.
- [ ] Error responses follow a consistent format (JSON:API, problem-details, or project convention).

## Models & Active Record

- [ ] Associations use `dependent:` option where applicable.
- [ ] Queries use `includes` / `preload` / `eager_load` to avoid N+1; verified with `bullet` or query logs.
- [ ] Scopes and validations tested; no model-level `default_scope` unless justified.
- [ ] Callbacks documented; no callback triggers external I/O without explicit idempotency handling.
- [ ] Enum declarations include `_prefix` or `_suffix` when collision risk exists.

## Migrations

- [ ] Migration is reversible (`change` method or explicit `up`/`down`).
- [ ] No destructive column removal on columns still read by running code (two-phase deploy).
- [ ] Index additions on large tables use `algorithm: :concurrently` (PostgreSQL) or equivalent.
- [ ] Data migrations extracted to rake tasks or separate migration files, not mixed with schema changes.
- [ ] `db/schema.rb` or `db/structure.sql` regenerated and committed.

## Background Jobs

- [ ] Job arguments are primitive or Global ID–serializable.
- [ ] Job is idempotent; safe to retry without side-effect duplication.
- [ ] Retry count and dead-letter behavior configured.
- [ ] `ActiveJob::DeserializationError` handled when record may be deleted before execution.

## Security & Configuration

- [ ] CSRF protection enabled for browser endpoints; API endpoints use token auth.
- [ ] `config.force_ssl` active in production.
- [ ] Secrets stored in credentials or ENV; no plaintext secrets in repo.
- [ ] Required ENV vars validated at boot (e.g., initializer with `ENV.fetch`).
- [ ] Mass assignment protection verified; no `permit!` in production code.

## Tests & Quality

- [ ] Tests cover changed controller actions, model validations, and service paths.
- [ ] `bundle exec rubocop` passes or only has pre-existing offenses.
- [ ] `bundle exec rails test` / `bundle exec rspec` passes.
- [ ] Feature specs or request specs cover critical user-facing flows if applicable.

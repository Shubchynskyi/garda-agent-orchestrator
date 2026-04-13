# Java Spring Checklist

## Runtime Surface & Boundaries

- [ ] Verify the actual build, test, and packaging commands from `40-commands.md` before coding.
- [ ] Keep dependency injection constructor-based and preserve controller -> service -> repository boundaries.
- [ ] Confirm public endpoints use explicit DTOs, not persistence entities.
- [ ] Identify whether the change runs in MVC, WebFlux, schedulers, messaging consumers, or multiple runtime surfaces.

## Validation & API Contracts

- [ ] Validate request DTOs and external input explicitly at the controller boundary.
- [ ] Confirm serialization, nullability, enum handling, and error envelopes remain stable for public contracts.
- [ ] Review pagination, idempotency, and versioned endpoint behavior when the change affects external APIs.

## Persistence & Transactions

- [ ] Review transaction boundaries, fetch plans, lazy-loading behavior, and N+1 risk.
- [ ] Review Flyway/Liquibase or schema-related changes together with rollout compatibility.
- [ ] Check repository queries, locking, and batching for hot-path or bulk-processing behavior.

## Security & Configuration

- [ ] Check security rules, method protection, filter-chain ordering, profile-specific config, and secret handling.
- [ ] Confirm `@ConfigurationProperties`, feature flags, and environment overrides fail safely and validate required fields.
- [ ] Verify outbound client configuration, timeouts, and circuit-breaking for remote dependencies.

## Background Work & Messaging

- [ ] Validate async jobs, schedulers, or messaging listeners for retry, idempotency, and shutdown behavior.
- [ ] Review listener concurrency, dead-letter handling, and duplicate-delivery assumptions where queues or topics are involved.
- [ ] Confirm background work does not bypass transaction or security expectations established in synchronous paths.

## Tests & Operability

- [ ] Confirm health checks, logs, and metrics still cover the changed path.
- [ ] Add targeted tests for changed controller, service, and repository boundaries plus any cross-layer behavior.
- [ ] Cover negative-path tests for auth, validation, transaction rollback, and dependency failure propagation.

# Node Backend Checklist

## Runtime Surface

- [ ] Confirm the real entrypoints and the canonical lint, type-check, test, and build commands from `40-commands.md`.
- [ ] Verify whether the changed code runs in HTTP request paths, workers, queue consumers, cron jobs, or multiple runtimes.
- [ ] Check framework-specific lifecycle assumptions before editing shared middleware, decorators, or error mappers.

## Contracts & Boundaries

- [ ] Validate request, response, and message schemas explicitly at service edges.
- [ ] Confirm handlers/controllers do not leak framework request/response objects into domain logic.
- [ ] Check error responses and status codes remain deterministic for public contracts.
- [ ] Validate pagination, idempotency keys, and webhook replay semantics when the change affects public integration paths.

## Async & Side Effects

- [ ] Review timeouts, cancellation, retries, idempotency, and shutdown behavior for every changed async flow.
- [ ] Verify background jobs/consumers own failures and do not swallow rejected promises or poison messages.
- [ ] Confirm transactions, outbox/event publication, and cache invalidation keep side effects consistent.
- [ ] Check backpressure, queue lease/ack behavior, and retry storms when external systems are degraded.

## Data & Dependencies

- [ ] Review repository/data-layer changes together with migration and rollout compatibility.
- [ ] Confirm dependency upgrades, runtime-version changes, and generated clients are compatible with deployed environments.
- [ ] Verify outbound HTTP, DB, cache, and queue clients use bounded timeouts and connection reuse.

## Security & Operability

- [ ] Check auth/authz middleware ordering, secret/config loading, and tenant or account boundary enforcement.
- [ ] Validate structured logging, metrics/tracing, and health/readiness coverage for changed runtime paths.
- [ ] Confirm failure paths preserve enough context for support without leaking secrets or internal implementation details.

## Tests & Rollout

- [ ] Add or update tests for handlers, services, adapters, and any changed side-effect path.
- [ ] Exercise negative-path tests for validation, auth, retry exhaustion, and downstream failure behavior.
- [ ] Document rollout assumptions when the change depends on workers, queues, or schema sequencing.

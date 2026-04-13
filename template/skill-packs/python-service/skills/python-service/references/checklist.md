# Python Service Checklist

## Runtime Surface

- [ ] Confirm Python version, package manager, and canonical lint/type-check/test/build commands from `40-commands.md`.
- [ ] Verify whether the changed code runs in ASGI/WSGI request paths, workers, scheduled jobs, or multiple runtimes.
- [ ] Identify the actual framework/runtime boundary (FastAPI, Django, Flask, Celery, plain worker) before refactoring shared helpers.

## Contracts & Configuration

- [ ] Validate request/data models explicitly with typed schemas or serializers.
- [ ] Confirm settings load through a dedicated config module and required env vars are validated at startup.
- [ ] Check there are no import-time side effects that create clients, open connections, or mutate global state.
- [ ] Review auth dependencies, middleware, and tenant/account boundaries where the change touches public endpoints.

## Async & I/O Safety

- [ ] Review async paths for blocking DB/HTTP/file I/O and hidden event-loop bridging.
- [ ] Check worker/job idempotency, retry bounds, dead-letter handling, and partial-failure behavior.
- [ ] Confirm timeouts, cancellation, pool limits, and client reuse are explicit for DB, cache, and HTTP calls.

## Data, Jobs & Packaging

- [ ] Review migrations, dependency changes, session/transaction scope, and runtime compatibility together.
- [ ] Validate queue consumers, schedulers, and task handoff for replay safety and duplicate-write prevention.
- [ ] Check packaging artifacts and entrypoints when the task touches startup code, `pyproject.toml`, or deployment commands.

## Security & Operability

- [ ] Confirm logging, health checks, and metrics remain meaningful for the changed code paths.
- [ ] Check secret/config sourcing, feature-flag defaults, and environment-specific overrides for drift risk.
- [ ] Verify errors surface enough context for diagnosis without leaking stack traces or credential material.

## Tests & Rollout

- [ ] Add or update tests for the changed API/service/job flows, not only pure helper functions.
- [ ] Cover negative paths for validation, retry exhaustion, and upstream/downstream failure propagation.
- [ ] Note deployment assumptions when the change requires worker rollout, migration ordering, or cache warmup.

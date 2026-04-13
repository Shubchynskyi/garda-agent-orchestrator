# Go HTTP Service Checklist

## Runtime Surface

- [ ] Identify router or framework (`net/http`, `chi`, `gin`, `echo`, `fiber`) and confirm project layout.
- [ ] Confirm actual entrypoints (`main.go`, `cmd/`, workers) before refactoring shared server wiring.
- [ ] Validate request input at the handler edge and reject invalid payloads with structured 4xx responses.

## Middleware & Boundaries

- [ ] Confirm `context.Context` flows from request through all downstream I/O calls.
- [ ] Verify middleware ordering: recovery -> request-id -> logging -> auth -> rate-limit -> business.
- [ ] Keep handlers thin; do not leak framework request or response objects into service packages.

## Concurrency & I/O

- [ ] Check shared state for race conditions; run `go test -race ./...` on affected packages.
- [ ] Ensure DB, cache, and HTTP client calls use context-derived timeouts, not bare `context.Background()`.
- [ ] Confirm spawned goroutines have lifecycle ownership, cancellation, and error collection.
- [ ] Verify error-to-status mapping is centralized and does not leak internals to clients.

## Security & Release Safety

- [ ] Check auth, rate-limit, and trusted-proxy middleware changes for ordering or tenant-boundary regressions.
- [ ] Confirm secrets and per-environment config are loaded once at startup rather than read ad hoc inside handlers.
- [ ] Note rollout assumptions when a changed handler depends on queue consumers, cache state, or staged schema changes.

## Operability & Validation

- [ ] Verify graceful shutdown handles `SIGINT` and `SIGTERM` and drains in-flight requests.
- [ ] Check structured logging, tracing hooks, and health or readiness endpoints on changed paths.
- [ ] Run `go vet ./...`, the configured linter, and `go test ./...` with zero new regressions.

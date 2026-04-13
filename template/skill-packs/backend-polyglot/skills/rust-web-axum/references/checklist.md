# Rust Web Axum Checklist

## Runtime Surface

- [ ] Identify Axum version and Tokio runtime configuration; confirm project module layout.
- [ ] Validate request input via extractors (`Json`, `Query`, `Path`) with serde and validation; reject invalid payloads with structured 4xx responses.
- [ ] Confirm `AppState` uses `FromRef` for sub-state and avoids unnecessary `Arc<Mutex<...>>` wrappers around read-only config.

## Handlers, Extractors & Middleware

- [ ] Verify extractor ordering in handler signatures with body-consuming extractors last.
- [ ] Check Tower middleware ordering: tracing -> request-id -> CORS -> auth -> rate-limit -> body-limit -> app layers.
- [ ] Verify the unified error type implements `IntoResponse` and does not leak internal details or backtraces.

## Async Safety & Lifecycle

- [ ] Ensure no `MutexGuard` or lock guard is held across `.await`; use `tokio::sync` types for async-safe sharing.
- [ ] Confirm all I/O is async and blocking work is offloaded to `spawn_blocking`.
- [ ] Verify spawned tasks (`tokio::spawn`) have lifecycle tracking, cancellation, and error handling.

## State, Security & Policy

- [ ] Check auth, CORS, body-limit, and request-size controls when middleware or extractors change.
- [ ] Confirm shared state, secrets, and configuration are injected once and not reconstructed ad hoc per request.
- [ ] Review websocket, SSE, or streaming handlers for backpressure and disconnect behavior when those paths are touched.

## Operability & Validation

- [ ] Verify graceful shutdown via `axum::serve(...).with_graceful_shutdown(signal)` with proper signal handling.
- [ ] Check tracing, metrics, and health/readiness coverage on changed paths.
- [ ] Run `cargo fmt --check`, `cargo clippy -- -D warnings`, and `cargo test` with zero new regressions.

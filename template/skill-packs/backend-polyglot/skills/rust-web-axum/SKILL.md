---
name: rust-web-axum
description: Specialist skill for production Axum-based Rust web services. Use when task involves Axum routers, extractors, typed application state, Tower middleware, or Tokio async service lifecycle. Triggers — Axum, Tower, tower-http, Tokio, Router, handler, extractor, IntoResponse, graceful shutdown. Negative trigger — CLI tools, procedural macros crate, WASM-only targets, pure library crates with no HTTP transport.
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
  domain: backend
  triggers: Axum, Tower, tower-http, Tokio, Router, handler, extractor, State, IntoResponse, graceful shutdown
  role: specialist
  scope: implementation
  output-format: code-and-review
  related-skills: orchestration, code-review, dependency-review
---

# Rust Web Axum

## Core Workflow

1. Identify the Axum version, Tokio runtime flavour (`#[tokio::main]` vs. manual `Builder`), and project layout (`src/main.rs`, `src/lib.rs`, `src/routes/`, `src/handlers/`).
2. Keep transport (handlers/extractors), business logic (domain services), and persistence (repository traits + impls) in separate modules; never leak `axum::extract` or `http` types past the handler boundary.
3. Define application-wide shared resources in a typed `AppState` struct passed via `Router::with_state`; use `FromRef` for sub-state extraction instead of wrapping everything in `Arc<Mutex<…>>`.
4. Validate and deserialize request input through Axum extractors (`Json<T>`, `Query<T>`, `Path<T>`) with `serde` derive; apply additional validation (e.g., `validator` crate) before entering business logic.
5. Implement a unified error type that implements `IntoResponse`; map internal errors to appropriate HTTP status codes in one place, never expose internal details or backtraces to clients.
6. Layer Tower middleware deliberately: `TraceLayer` → request-id → CORS → auth → rate-limit → body-limit → application middleware; apply layers via `Router::layer` or `ServiceBuilder`.
7. Keep all I/O operations (`sqlx`, `reqwest`, HTTP clients, file I/O) fully `async` on Tokio; never call blocking code on the async executor — use `tokio::task::spawn_blocking` for CPU-bound or synchronous FFI work.
8. Propagate cancellation through `CancellationToken` or `tokio::select!` where long-running tasks need cooperative shutdown; respect request timeouts via `tower_http::timeout::TimeoutLayer`.
9. Emit structured traces with `tracing` and `tracing-subscriber`; expose `/health` and `/ready` endpoints; propagate OpenTelemetry context when distributed tracing is present.
10. Implement graceful shutdown: bind with `tokio::net::TcpListener`, serve via `axum::serve(…).with_graceful_shutdown(signal)`, and drain in-flight connections before exiting the Tokio runtime.
11. Run `cargo clippy -- -D warnings`, `cargo fmt --check`, and `cargo test` before marking the task complete; confirm no new `unsafe` blocks without justification.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Delivery checklist | `references/checklist.md` | Any Axum service feature, refactor, or review |

## Constraints

- Do not mix HTTP transport concerns, domain logic, and persistence in one handler function or module.
- Do not hold `MutexGuard` or any lock across `.await` points; prefer message passing or `tokio::sync` primitives.
- Do not use `unwrap()` / `expect()` on fallible operations in handler paths; convert to the unified error type.
- Do not spawn detached tasks (`tokio::spawn`) from handlers without lifecycle tracking (e.g., `TaskTracker`, `JoinSet`).
- Do not expose raw `sqlx::Error`, `reqwest::Error`, or panic backtraces in HTTP responses.
- Treat dependency upgrades, middleware reordering, extractor ordering changes, and `Send`/`Sync` bound modifications as high-risk.

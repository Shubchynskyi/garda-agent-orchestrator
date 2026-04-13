---
name: go-http-service
description: Specialist skill for production Go HTTP services. Use when task involves Go HTTP handlers, routers, middleware, context propagation, or server lifecycle. Triggers — Go HTTP, chi, gin, echo, fiber, net/http, handler, middleware, graceful shutdown. Negative trigger — CLI tools, code-generation scripts, pure library packages with no HTTP transport.
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
  triggers: Go HTTP, net/http, chi, gin, echo, fiber, handler, middleware, router, graceful shutdown
  role: specialist
  scope: implementation
  output-format: code-and-review
  related-skills: orchestration, code-review, dependency-review
---

# Go HTTP Service

## Core Workflow

1. Identify the router/framework in use (`net/http`, `chi`, `gin`, `echo`, `fiber`) and the project layout (`cmd/`, `internal/`, `pkg/`).
2. Keep transport (handlers), business logic (services), and persistence (repositories) in separate packages; do not leak `http.Request` or framework types past the handler boundary.
3. Validate and bind request input at the handler layer; return structured error responses with consistent status codes.
4. Propagate `context.Context` from the request through every service and I/O call; never store contexts in structs.
5. Order middleware deliberately: recovery → request-id → logging → auth → rate-limit → business middleware.
6. Guard shared mutable state with appropriate synchronization (`sync.Mutex`, `sync.RWMutex`, channels, or `sync/atomic`); prefer immutable configuration injected at startup.
7. Wrap database, cache, and external HTTP calls with timeouts derived from the request context; handle `context.Canceled` and `context.DeadlineExceeded` explicitly.
8. Map internal errors to HTTP status codes in one place (error-mapping middleware or a response helper); never expose stack traces or internal details to clients.
9. Emit structured logs (`slog`, `zap`, `zerolog`) and expose health/readiness endpoints; propagate trace headers when distributed tracing is present.
10. Implement graceful shutdown: listen for `SIGINT`/`SIGTERM`, call `Server.Shutdown(ctx)` with a deadline, and drain in-flight connections before exit.
11. Run `go vet`, linter (`golangci-lint run` or `staticcheck`), and `go test ./...` before marking the task complete.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Delivery checklist | `references/checklist.md` | Any Go HTTP service feature, refactor, or review |

## Constraints

- Do not mix HTTP transport concerns, business logic, and persistence in one function or package.
- Do not ignore or discard `context.Context`; always pass it through the call chain.
- Do not use `init()` functions for service wiring; prefer explicit dependency injection in `main` or a composition root.
- Do not spawn unmanaged goroutines from handlers without lifecycle control (`errgroup`, `sync.WaitGroup`, or a worker pool).
- Do not return bare `500 Internal Server Error` without logging the underlying cause server-side.
- Treat Go module upgrades, middleware reordering, and concurrency changes as high-risk.

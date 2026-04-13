---
name: dotnet-webapi
description: Specialist skill for production ASP.NET Core Web API services. Use when task involves controllers, minimal APIs, middleware, DI registration, request validation, auth/authz, EF Core, error handling, or server lifecycle in a .NET HTTP service. Triggers — ASP.NET Core, Web API, controller, minimal API, middleware, DbContext, authorize, health check. Negative trigger — Blazor UI, MAUI, WPF, console-only tools, class-library packages with no HTTP host.
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
  triggers: ASP.NET Core, Web API, controller, minimal API, middleware, DbContext, authorize, health check, cancellation token, graceful shutdown
  role: specialist
  scope: implementation
  output-format: code-and-review
  related-skills: orchestration, code-review, dependency-review
---

# .NET Web API

## Core Workflow

1. Identify the hosting model and API style: determine whether the project uses controllers (`[ApiController]`) or minimal APIs (`app.MapGet/MapPost`), and locate the composition root (`Program.cs` or `Startup.cs`).
2. Respect the middleware pipeline order: exception handler → HTTPS redirection → CORS → authentication → authorization → rate limiting → custom middleware → endpoint routing. Inserting middleware out of order silently breaks auth or error handling.
3. Register services through DI with correct lifetimes: use `Scoped` for per-request work (DbContext, unit-of-work), `Singleton` for thread-safe caches/options, `Transient` for stateless helpers. Never capture a `Scoped` service inside a `Singleton`.
4. Validate requests at the entry boundary: use `FluentValidation`, `DataAnnotations`, or minimal-API filters/`IEndpointFilter` before business logic executes. Return `ProblemDetails` (RFC 9457) for all 4xx/5xx responses.
5. Keep auth and authz boundaries explicit: apply `[Authorize]` or `RequireAuthorization()` per-endpoint, define policies in one place, and never rely on middleware ordering alone to protect resources.
6. Accept and propagate `CancellationToken` in every async controller action, service method, and EF Core query. Honor cancellation in long-running I/O to avoid wasted server resources.
7. Separate transport (controllers/endpoints), application logic (services), and persistence (repositories/DbContext). Do not leak `HttpContext`, `IFormFile`, or controller types into service or domain layers.
8. Wrap EF Core and external HTTP/gRPC calls with explicit timeouts or cancellation; handle `DbUpdateConcurrencyException`, `OperationCanceledException`, and transient faults with retry policies (Polly/`Microsoft.Extensions.Http.Resilience`).
9. Map internal exceptions to HTTP status codes in a global exception handler (`IExceptionHandler` or exception-handling middleware); never expose stack traces, connection strings, or internal details to clients.
10. Emit structured logs via `ILogger<T>` and configure OpenTelemetry or `ActivitySource` tracing for cross-service calls. Expose `/health` and `/ready` endpoints via `MapHealthChecks`.
11. For background work use `IHostedService` or `BackgroundService` with proper cancellation; do not spawn unmanaged `Task.Run` fire-and-forget calls from request handlers.
12. Ensure graceful shutdown: the host listens for `SIGTERM`/`SIGINT`, drains in-flight requests, flushes telemetry, and disposes scoped resources. Validate with `IHostApplicationLifetime` callbacks if custom cleanup is needed.
13. Run `dotnet build --no-restore`, `dotnet test --no-build`, and any project-specific linter/analyzer (e.g., `dotnet format --verify-no-changes`) before marking the task complete.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Delivery checklist | `references/checklist.md` | Any ASP.NET Core Web API feature, refactor, or review |

## Constraints

- Do not mix HTTP transport concerns, business logic, and persistence in one method or class.
- Do not register services with mismatched lifetimes (e.g., scoped inside singleton).
- Do not discard `CancellationToken` parameters; always forward them to async I/O.
- Do not return raw exception messages or stack traces to API consumers.
- Do not use `IServiceProvider.GetService` for runtime resolution when constructor injection is possible.
- Do not add middleware after `UseRouting`/`UseEndpoints` unless its position is intentional and documented.
- Treat EF Core migrations, middleware reordering, auth policy changes, and NuGet major-version upgrades as high-risk.

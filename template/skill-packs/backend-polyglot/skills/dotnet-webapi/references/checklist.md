# .NET Web API Checklist

## Runtime Surface

- [ ] Identify API style (controllers vs minimal APIs) and hosting model (`Program.cs` or `Startup.cs`).
- [ ] Confirm DI registrations use correct lifetimes; no scoped service is captured by a singleton.
- [ ] Validate request payloads at the entry boundary and reject invalid input with `ProblemDetails` 4xx responses.

## Pipeline & Contracts

- [ ] Verify middleware pipeline order: exception handler -> HTTPS -> CORS -> auth -> authz -> rate limit -> routing.
- [ ] Check that `[Authorize]` or `RequireAuthorization()` is applied per endpoint; no resources are left unprotected by accident.
- [ ] Confirm global exception handling maps errors to status codes without leaking internals.

## Data & External I/O

- [ ] Ensure every async action and service method accepts and forwards `CancellationToken`.
- [ ] Confirm EF Core queries use cancellation tokens and handle `DbUpdateConcurrencyException`.
- [ ] Verify external HTTP or gRPC calls use timeout and retry policies with bounded budgets.

## Background Work & Operability

- [ ] Confirm background work uses `IHostedService` or `BackgroundService` with proper cancellation, not fire-and-forget tasks.
- [ ] Check structured logging (`ILogger<T>`), health endpoints, and readiness probes for changed paths.
- [ ] Validate graceful shutdown drains requests and disposes scoped resources.

## Validation & Tooling

- [ ] Cover changed endpoints with integration or contract tests when public behavior moved.
- [ ] Review auth, validation, and dependency-failure negative paths instead of only happy-path assertions.
- [ ] Run `dotnet build --no-restore`, `dotnet test --no-build`, and configured analyzers or formatters with zero new findings.

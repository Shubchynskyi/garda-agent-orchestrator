---
name: node-backend
description: >
  Specialist skill for production Node.js backend services. Use when a task
  touches HTTP handlers, workers, queue consumers, service modules,
  persistence adapters, contract validation, background processing, or
  runtime lifecycle. Trigger phrases: "endpoint", "middleware",
  "queue consumer", "worker", "validation", "Express", "Fastify", "NestJS".
  Do NOT use for frontend-only work or package-only library changes with no
  long-lived service/runtime behavior.
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
  triggers: Node.js, Express, Fastify, NestJS, worker, queue consumer, middleware, validation, background job, shutdown
  role: specialist
  scope: implementation-and-review
  output-format: code-and-review
  related-skills: code-review, dependency-review, api-contract-review
---

# Node Backend

## Core Workflow

1. **Identify the runtime shape first.** Confirm the entrypoint, package manager, framework, and execution model before editing: HTTP API, worker, queue consumer, cron process, or mixed runtime. Pull the actual lint, type-check, test, and build commands from `40-commands.md`; do not guess from package scripts alone.
2. **Draw boundaries before changing behavior.** Keep transport (handler/controller), business logic (service/use-case), persistence (repository/data adapter), and external integrations in separate layers. Framework request/response objects should stop at the transport boundary; domain services should not depend on Express/Fastify/Nest request types.
3. **Lock edge contracts.** Validate request bodies, query params, headers, queue payloads, and environment-derived config explicitly at the boundary. Keep response shapes, status codes, and error envelopes deterministic; if a contract changes, treat it as an API review, not a refactor.
4. **Audit async and background execution.** Every async path needs ownership: who awaits it, who handles failure, and who stops it at shutdown. Check timeouts, `AbortSignal` propagation where supported, retry bounds, idempotency for workers/consumers, and dead-letter or poison-message behavior for background processing.
5. **Review persistence and side effects together.** Confirm transaction boundaries, outbox/event publication ordering, cache invalidation, and file/network side effects are consistent with the changed behavior. If a schema or queue-payload change is involved, verify currently deployed nodes can coexist safely during rollout.
6. **Check resource and latency controls.** Downstream HTTP, DB, and cache calls must have bounded timeouts, connection-pool awareness, and no unbounded fan-out from one incoming request. Prefer explicit concurrency limits for batch work or scatter-gather flows instead of trusting event-loop throughput.
7. **Confirm operability.** Health/readiness endpoints, startup config validation, structured logs, metrics/traces, and graceful process shutdown are part of correctness. Verify changed code paths still emit enough signal to diagnose timeouts, retries, partial failures, and queue lag in production.
8. **Validate changed paths with the real command set.** Run lint, type-check, test, and build commands from `40-commands.md`. When the change touches side effects, make sure tests cover both the request path and the side-effect path rather than only the happy-path return value.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Delivery checklist | `references/checklist.md` | Any Node backend feature or review |

## High-Risk Areas

- Auth/session behavior, queue semantics, streaming responses, schema migrations, cache invalidation, and major runtime/dependency upgrades should be treated as change-management events, not routine edits.

## Constraints

- Do not mix transport shaping, business rules, and persistence in one handler or module.
- Do not leave fire-and-forget promises without lifecycle ownership or failure reporting.
- Do not add retries to non-idempotent writes unless there is a deduplication key or explicit compensating logic.
- Do not read environment variables deep inside request paths; resolve config at startup and inject it.
- Do not widen response shapes, status-code semantics, or message contracts silently.
- Treat migrations, queue payload changes, and framework major-version upgrades as high-risk and review them alongside rollout behavior.

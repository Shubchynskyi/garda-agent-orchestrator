---
name: python-service
description: >
  Specialist skill for production Python services. Use when a task touches
  FastAPI, Django, Flask, workers, background jobs, package/runtime setup,
  typed schemas, or deployment-safe service behavior. Trigger phrases:
  "endpoint", "async", "worker", "Celery", "schema", "FastAPI", "Django",
  "Flask". Do NOT use for notebook-only analysis, one-off scripts, or library
  packages with no long-lived service/runtime behavior.
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
  triggers: Python service, FastAPI, Django, Flask, Celery, worker, API, packaging, pytest, pydantic
  role: specialist
  scope: implementation-and-review
  output-format: code-and-review
  related-skills: code-review, dependency-review, db-migration-review
---

# Python Service

## Core Workflow

1. **Identify the runtime model.** Confirm the Python version, package manager, and actual commands from `40-commands.md`, then determine the runtime shape: FastAPI/ASGI, Django/WSGI or ASGI, Flask, worker-only, or mixed web plus background jobs. The sync-vs-async model matters before you touch I/O or concurrency.
2. **Draw layer boundaries early.** Keep routers/views/handlers, domain services, persistence, and background jobs separate. Framework objects (`Request`, `Response`, ORM model instances, Celery task context) should not become implicit dependencies of domain logic.
3. **Lock contracts and typing.** Validate request and response shapes explicitly with Pydantic, serializers, dataclasses, or typed DTOs. Prefer typed boundaries over `dict[str, Any]` or raw ORM instances crossing layers. If the task changes a public API or worker payload, treat it as a contract change.
4. **Make configuration explicit and import-safe.** Load settings through a dedicated config module or settings class; validate required env vars at startup. Do not hide network calls, DB connections, or env-derived mutations inside import side effects, since they make tests and CLI tooling non-deterministic.
5. **Audit async, threads, and workers.** In async services, verify there are no blocking DB/HTTP/file calls inside request paths without an explicit worker-thread or process strategy. In Celery/RQ/Huey-style jobs, check idempotency, retry bounds, dead-letter behavior, and safe handling of partial side effects.
6. **Review persistence and migrations together.** Confirm transaction/session scope is explicit, ORM models do not leak through service boundaries, and schema changes remain compatible with currently deployed code. Treat Alembic, Django migrations, and package upgrades that touch ORM/runtime behavior as rollout-sensitive changes.
7. **Confirm operability.** Structured logging, health endpoints, startup validation, metrics, worker observability, and clean shutdown are part of correctness. A service change is not production-ready if the failure mode becomes harder to detect or triage.
8. **Run the real validation set.** Execute lint, type-check, tests, and packaging/build commands from `40-commands.md`. If the change touches web plus worker paths, validate both; do not stop at a passing unit test if runtime packaging or startup config is now broken.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Delivery checklist | `references/checklist.md` | Any Python service feature or review |

## High-Risk Areas

- Async/sync boundary changes, migrations, dependency pin shifts, worker delivery semantics, and secrets/config handling should be treated as high-risk because they often fail outside the happy-path unit-test envelope.

## Constraints

- Do not bury configuration or runtime I/O in import side effects.
- Do not couple framework adapters directly to data-storage internals.
- Do not use broad `except Exception` handling where a narrower error class is available.
- Do not perform blocking DB/HTTP/file I/O inside async request paths without an explicit offload strategy.
- Do not scatter raw `os.environ` reads across the codebase; resolve settings centrally and validate them.
- Prefer explicit interfaces, fixtures, and typed boundaries over implicit framework magic.

---
name: java-spring
description: >
  Specialist skill for production Spring Boot services. Use when a task
  touches controllers, services, repositories, transactions, Spring Security,
  persistence mappings, schedulers, messaging, or Boot runtime wiring.
  Trigger phrases: "controller", "service", "repository", "transaction",
  "Spring Security", "JPA", "Flyway", "Liquibase". Do NOT use for plain Java
  libraries with no Spring container, transport, or persistence behavior.
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
  triggers: Spring Boot, Spring MVC, Spring Security, Spring Data JPA, Maven, Gradle, Java service, REST API
  role: specialist
  scope: implementation-and-review
  output-format: code-and-review
  related-skills: code-review, security-review, api-contract-review
---

# Java Spring

## Core Workflow

1. **Identify module and runtime boundaries.** Confirm module layout, the Spring Boot entrypoint, and the real build/test commands from `40-commands.md`. Determine whether the change touches MVC controllers, scheduled jobs, messaging consumers, REST clients, or persistence wiring before editing.
2. **Keep the service layered on purpose.** Controllers map transport to DTOs, services own business rules, repositories own persistence access, and infrastructure adapters own external I/O. Constructor injection only; if a class needs five unrelated collaborators, treat that as a design smell rather than wiring it more deeply into the container.
3. **Lock edge DTOs and error contracts.** Request validation belongs at the controller boundary via Bean Validation or explicit validators. Public endpoints should use explicit DTOs and a centralized exception-mapping strategy (`@ControllerAdvice`, `ProblemDetail`, or equivalent). Do not expose entities or internal exception details directly.
4. **Review transaction and persistence behavior together.** Check where `@Transactional` boundaries start and end, whether lazy loading is safe, and whether query shape causes N+1 or oversized fetch graphs. Treat entity-model changes, cascade rules, and schema migrations as rollout-sensitive, not local refactors.
5. **Audit security and authorization flow.** Confirm `SecurityFilterChain` ordering, method security, and principal/role mapping are correct for the changed endpoint or job. When auth behavior changes, review both route-level and method-level protection; silent policy widening is a contract change.
6. **Check configuration, profiles, and secrets.** Prefer `@ConfigurationProperties` or typed config beans over scattered `@Value` strings. Validate profile-specific behavior, secret loading, and startup-time config validation so runtime differences are explicit and testable.
7. **Review async, messaging, and scheduled work.** For `@Async`, schedulers, Kafka/Rabbit listeners, or batch jobs, confirm retry behavior, idempotency, transaction coupling, and shutdown semantics. Background processing is not secondary to the request path; it is part of the production contract.
8. **Confirm operability and validation depth.** Verify Actuator/health endpoints, structured logs, metrics/traces, and graceful shutdown still fit the changed path. Run compile/test commands from `40-commands.md` and prefer controller/service/repository slice coverage plus targeted integration tests when behavior crosses boundaries.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Delivery checklist | `references/checklist.md` | Any Spring Boot feature or review |

## High-Risk Areas

- Security configuration, Flyway/Liquibase migrations, entity-to-DTO contract changes, transactional semantics, and major starter or framework upgrades should be treated as high-risk because they often fail across module boundaries rather than in isolated unit tests.

## Constraints

- Do not use field injection.
- Do not expose persistence entities directly from public endpoints.
- Do not rely on lazy loading during JSON serialization or view rendering.
- Do not assume self-invocation will trigger `@Transactional`, `@Cacheable`, or method-security proxies.
- Do not hide breaking API or schema changes behind silent refactors.
- Prefer explicit DTOs, validation, and exception mapping for public endpoints.

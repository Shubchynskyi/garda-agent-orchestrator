---
name: architecture-review
description: >
  Reviews cross-module and system-design changes for boundary violations, coupling drift,
  failure-mode gaps, data-ownership conflicts, deployment blast radius, and mismatch between
  stated architecture and actual changed code.
  Use when a task touches service boundaries, module public APIs, cross-cutting shared code,
  integration points, infra topology, or data-ownership contracts.
  Trigger phrases: arch review, design review, system review, boundary review, module review.
  Do NOT use for single-module internal refactors that do not alter any public surface or dependency direction.
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
  domain: quality
  triggers: service boundary, module split, cross-module dependency, shared library change, data ownership, deployment topology, integration point
  role: specialist
  scope: review
  output-format: review-findings
  related-skills: code-review, api-contract-review, dependency-review
---

# Architecture Review

## Core Workflow

1. **Map the change boundary.** Identify every module, service, or package touched by the diff. For each, determine its stated responsibility (from architecture docs, ADRs, or README) and its actual dependency direction in the code.
2. **Check dependency direction.** Verify that dependencies flow in the declared direction (e.g., feature → core, service → shared-lib, not the reverse). Flag any new import that inverts or creates a circular dependency between modules.
3. **Assess coupling surface.** For each cross-module change, check whether the touched interface is the narrowest necessary: no leaking of internal types, no shared mutable state, no implicit temporal coupling. Prefer explicit contracts (interfaces, DTOs, events) over direct access to another module's internals.
4. **Evaluate failure modes.** For every new integration point or changed inter-service call, confirm: timeout, retry budget, fallback/degradation path, and circuit-breaker or bulkhead where appropriate. Flag synchronous chains longer than two hops without an async boundary.
5. **Verify data ownership.** Confirm that only the owning module writes to each data store or topic. Flag any change that introduces a second writer, shares a database table across module boundaries, or reads another module's data without a declared contract.
6. **Estimate deployment blast radius.** Determine the minimum set of services/packages that must be deployed together. Flag changes that widen the required deployment set or that lack a rollback-safe migration path (e.g., non-additive schema change combined with a code change in one release).
7. **Cross-check architecture docs.** If architecture decision records (ADRs), diagrams, or architecture docs exist, verify the change is consistent with them. If the change intentionally diverges, require an updated or new ADR before approval.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Architecture review checklist | `references/checklist.md` | Any cross-module or system-design change |

## Anti-Patterns

- **Shared module as escape hatch**: moving logic into a common package only to bypass boundary friction, which usually hides ownership problems instead of solving them.
- **Second writer syndrome**: allowing another module or service to write the same table, topic, or file path without a formal ownership transfer.
- **Synchronous convenience chain**: replacing an explicit async boundary with a long synchronous call path that widens latency and failure blast radius.
- **Coupled rollout by accident**: changes that require multiple deploys, schema flips, or flag timing to line up, but document none of those constraints.

## Constraints

- Do not approve cross-boundary changes that invert the declared dependency direction without an explicit ADR or documented decision.
- Do not accept new shared mutable state between independently deployable modules.
- Do not permit a module to directly access another module's persistence (DB tables, queues, files) without a formal contract.
- Do not skip failure-mode analysis for new synchronous inter-service or inter-module calls.
- Treat any change that widens deployment blast radius or removes rollback safety as a hard-fail unless explicitly justified and documented.
- Do not conflate this review with line-level code quality; focus on structural, boundary, and system-level concerns only.

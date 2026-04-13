---
name: tool-calling-patterns
description: Specialist skill for multi-step tool orchestration in agentic systems. Use when building, reviewing, or debugging agent tool loops, function-calling schemas, tool registries, planner-executor pipelines, or retry/fallback logic around tool invocations. Triggers include tool registry, function schema, agent executor, tool router, planner. Not for single-shot prompt engineering or RAG retrieval.
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
  domain: ai-agentic
  triggers: tool registry, function calling, agent executor, tool router, planner, tool schema, orchestration loop
  role: specialist
  scope: implementation
  output-format: code-and-review
  related-skills: llm-app-basics, multi-agent-review, orchestration, code-review
---

# Tool Calling Patterns

## Core Workflow

1. **Inventory the tool surface and ownership.** Locate the registry, planner, executor, and schema source. Confirm every callable tool has one canonical definition: name, purpose, auth context, parameter schema, output shape, and implementation owner. If the runtime can invoke tools that are not declared in the same registry, treat that as an architectural defect.
2. **Classify tools by safety and side effects.** Separate read-only, idempotent write, and non-idempotent write tools before touching orchestration logic. Retry and parallelism policy must depend on that class; a payment capture, deletion, or external write must never inherit the same retry path as a read-only lookup.
3. **Validate inputs before dispatch.** Enforce schema validation on every payload before execution. Required fields, enums, string lengths, and nested object shapes must be checked at the boundary; malformed calls should fail fast or trigger a re-plan, not leak invalid input to downstream systems.
4. **Make sequencing explicit.** The planner or chain must order dependent tool calls intentionally, record which outputs feed which later steps, and gate downstream execution on validated upstream results. Do not rely on model intuition for ordering when a deterministic state machine or planner can express it.
5. **Constrain loop state and halt conditions.** Track step count, visited tool states, and retry budget inside the orchestration loop. Every run needs explicit stop conditions for success, exhaustion, or escalation; otherwise the agent will drift into unbounded tool churn.
6. **Treat failures as structured events.** Surface tool errors with tool name, input summary, error category, retry eligibility, and user-safe message. Retries must be bounded, back-off aware, and limited to transient failures. Schema, permission, and policy violations should fail-fast and force a re-plan or human escalation.
7. **Validate outputs before forwarding.** Check every tool result against the expected output contract before feeding it into the next step or returning it to the user. Empty responses, partial payloads, stale cache hits, and timeout placeholders are explicit error states, not "best effort" successes.
8. **Instrument and test the orchestration path.** Add traces or audit logs for selected tool, arguments summary, latency, retry count, and final disposition. Validate the happy path plus malformed input, unavailable tool, timeout, duplicate-write, and partial-output scenarios before considering the loop production-safe.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Tool orchestration checklist | `references/checklist.md` | Any tool-calling feature, agent loop change, or tool registry review |

## Failure Patterns

- **Schema says one thing, implementation accepts another.** This creates silent drift where the model appears to call the tool correctly but the executor mutates or defaults fields behind the scenes.
- **Retrying writes as if they were reads.** Duplicate sends, duplicate charges, duplicate deletes, and replayed side effects usually start with a generic retry wrapper that forgot tool idempotency classes exist.
- **Blindly trusting tool output.** A downstream step that consumes partial JSON, empty arrays, or timeout sentinels as valid data will manufacture confident but false final answers.
- **No halt contract.** Orchestrators that lack max-step, no-progress, or escalation rules eventually loop on the same failing tool selection until quota or latency is exhausted.

## Constraints

- Never invoke a tool that is absent from the active registry; treat unregistered tool names as hallucinations and surface them as errors.
- Do not retry non-idempotent tool calls (writes, deletes, payments) without explicit confirmation or a deduplication key.
- Do not silently swallow tool errors or convert failures into fabricated success results; every tool failure must propagate structured context to the orchestrator.
- Keep tool descriptions and parameter schemas co-located with tool implementations; do not let schema drift from behavior.
- Avoid unbounded sequential tool chains; enforce a maximum step count per agent turn and surface a clear halt when the limit is reached.
- Do not forward raw tool output directly to users or later tools unless the output shape and policy checks have already passed.

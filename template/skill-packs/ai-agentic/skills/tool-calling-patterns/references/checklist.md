# Tool Calling Patterns Checklist

## Registry & Schema

- [ ] Every tool has a machine-readable schema (name, description, typed parameters, required fields).
- [ ] Tool resolution uses a single registry; no inline or ad-hoc tool definitions bypass it.
- [ ] Schema is co-located with or generated from tool implementation code.
- [ ] Tool metadata records side-effect class (read-only, idempotent write, non-idempotent write) and any auth/policy requirements.

## Input Validation

- [ ] Tool call payloads are validated against the schema before dispatch.
- [ ] Constraint violations (missing fields, wrong types, out-of-range values) trigger re-prompt or structured rejection, not silent pass-through.
- [ ] User text is never injected into a shell/SQL/request tool without a tool-specific sanitization or parameterization boundary.

## Planning & State Handoff

- [ ] The planner records dependencies between tool calls explicitly; downstream steps only read validated upstream outputs.
- [ ] Loop state tracks step count, retry count, and whether the agent is making forward progress.
- [ ] Re-plan or escalate when the same failing tool path repeats instead of recursively trying the same call forever.

## Sequencing & Idempotency

- [ ] Dependent tool calls are explicitly ordered; parallel execution is only used when all concurrent tools are idempotent.
- [ ] Non-idempotent operations include a deduplication or confirmation mechanism.
- [ ] Maximum step count per agent turn is enforced and configurable.
- [ ] Read-only tools can be parallelized only when their combined latency and payload size remain bounded.

## Execution Policy & Safety

- [ ] Tool allowlists, auth scopes, and environment boundaries are enforced before execution.
- [ ] Non-idempotent tools cannot inherit a generic retry policy meant for lookups.
- [ ] Timeouts, rate limits, and circuit-breaker rules are defined per tool class, not as one blanket default.

## Error Handling & Retries

- [ ] Tool errors surface structured context: tool name, input summary, error category, retry eligibility.
- [ ] Retries are bounded, use back-off, and are restricted to transient-error classifications.
- [ ] Auth, schema, and permission errors fail-fast without retry.
- [ ] Partial failures in multi-tool plans surface enough state to resume or roll back intentionally.

## Output Validation

- [ ] Tool results are validated against the expected output schema before downstream use.
- [ ] Empty results, timeouts, and unexpected shapes are treated as explicit error states.
- [ ] No tool output is passed to the user or next step without validation.
- [ ] Cached or replayed tool results are tagged so the orchestrator can distinguish fresh execution from reused state.

## Hallucination Prevention

- [ ] Calls to unregistered tool names are rejected and surfaced as errors.
- [ ] Fabricated parameters not present in the schema are detected and blocked.
- [ ] Agent is never allowed to invent tool capabilities beyond the registry.

## Testing & Telemetry

- [ ] Tests cover happy path, malformed input, unavailable tool, timeout, duplicate-write prevention, and invalid output shape.
- [ ] Execution logs or traces capture selected tool, argument summary, latency, retry count, and final disposition.
- [ ] Operational dashboards can distinguish planner failure, validation failure, tool failure, and policy rejection.

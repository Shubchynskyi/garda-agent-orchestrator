# LLM App Basics Checklist

## Task Framing & Prompt Architecture

- [ ] Input and output contracts are defined as typed schemas or test fixtures before prompt authoring.
- [ ] Prompt is split into versioned template sections (system, persona, task directive, output format).
- [ ] No raw user input is concatenated into system-level prompt regions.
- [ ] Few-shot examples (if any) cover the happy path, an edge case, and a refusal case.

## Context Assembly & Token Budget

- [ ] Token allocation is measured, not estimated; prompt + context fits within the model window with margin for the response.
- [ ] Context bands have explicit priority; lowest-priority band is trimmed first on overflow.
- [ ] Multi-turn history or retrieval context is gated by a token-budget check before the call.

## Structured Output

- [ ] Model is called with native structured-output mode (JSON mode, function schema, guided generation) when downstream expects a typed shape.
- [ ] Every model response is validated against the declared schema before forwarding.
- [ ] Validation failures are treated as retriable errors with bounded retry count, not silently passed through.

## Guardrails & Safety

- [ ] User input is sanitized before prompt assembly (injection resistance, PII scrubbing, length limits).
- [ ] Model output is checked against content policy and hallucination heuristics before reaching the user.
- [ ] Guardrail interventions are logged with enough detail for incident triage.

## Model Configuration & Fallback

- [ ] Model version, temperature, max-tokens, and stop sequences are pinned in an external config file.
- [ ] Deterministic settings (temperature 0, fixed seed) are used for any reproducibility-critical path.
- [ ] A fallback chain is defined (primary model → cheaper model → cached response → graceful error).
- [ ] Timeout, retry with back-off, and circuit-breaker are implemented for provider errors.
- [ ] Model identifiers are not hard-coded in application logic.

## Cost & Latency

- [ ] Every LLM call is instrumented with token counts (prompt + completion), latency, and estimated cost.
- [ ] Budget caps exist per request, per user, or per billing cycle as appropriate.
- [ ] Cost and latency baselines are re-measured after any prompt or model change.
- [ ] Rate-limit and quota errors from providers are handled with back-pressure, not silent failure.

## Testing & Observability

- [ ] At least one representative test asserts on the output schema for each prompt template.
- [ ] Edge-case inputs (empty, overlong, adversarial) have explicit test coverage.
- [ ] Prompt version and model version are included in structured logs for traceability.
- [ ] Regression suite covers known failure modes discovered in production or evaluation runs.

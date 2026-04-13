---
name: llm-app-basics
description: >
  Production foundations for LLM-powered applications: prompt architecture, context assembly,
  structured output enforcement, guardrails, model fallback, cost/latency budgeting, and
  deterministic runtime behavior patterns.
  Use when a task creates or modifies prompt templates, model configuration, output schemas,
  guardrail/moderation layers, token-budget logic, or any code that sends requests to an LLM
  provider and processes the response in a production path.
  Trigger phrases: llm app, prompt architecture, structured output, guardrail, model config,
  llm production, model fallback, token budget.
  Do NOT use for RAG retrieval/chunking (use rag-patterns), multi-step tool orchestration
  (use tool-calling-patterns), or evaluation harness design (use evals-design).
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
  triggers: prompt template, model config, output schema, guardrail, moderation, LLM SDK, completion endpoint, chat endpoint
  role: specialist
  scope: implementation
  output-format: code-and-review
  related-skills: tool-calling-patterns, rag-patterns, evals-design, code-review
---

# LLM App Basics

## Core Workflow

1. **Frame the task before writing the prompt.** Define the exact input contract (what the caller provides), the expected output contract (shape, fields, value ranges), and the failure mode (what the system does when the model returns garbage). Write this contract down as a typed schema or test fixture before authoring any prompt text.
2. **Assemble context deliberately.** Budget token allocation across system instructions, few-shot examples, retrieved context, and user input. Measure actual token counts, not character estimates. Trim or summarize the lowest-priority context band first when approaching the model's context window. Never silently truncate high-priority context.
3. **Separate prompt structure from content.** Keep system instructions, persona framing, task-specific directives, and output format instructions in distinct, version-controlled template sections. Avoid string concatenation of raw user input into system-level prompt regions.
4. **Enforce structured outputs.** Use the model's native structured-output mode (JSON mode, function-calling schema, guided generation) whenever the downstream consumer expects a typed shape. Validate every model response against the declared schema before passing it forward; treat validation failures as retriable errors, not silent data.
5. **Apply guardrails at both edges.** Validate and sanitize user input before it enters the prompt (injection resistance, PII scrubbing, length limits). Validate model output before it reaches the user or downstream system (content policy, schema compliance, hallucination heuristics). Log every guardrail intervention for observability.
6. **Configure model parameters with intent.** Pin model version, temperature, max-tokens, and stop sequences in a config file, not inline code. Document why each parameter value was chosen. Use deterministic settings (temperature 0, fixed seed where supported) for any path that must be reproducible.
7. **Plan for model fallback and degradation.** Define a fallback chain (e.g., primary model → smaller/cheaper model → cached response → graceful error). Implement timeout, retry with exponential back-off for transient provider errors, and circuit-breaker for sustained outages. Never let an LLM provider timeout block the user-facing request indefinitely.
8. **Track cost and latency as production metrics.** Instrument every LLM call with token counts (prompt + completion), wall-clock latency, and estimated cost. Set budget alerts or hard caps per request, per user, and per billing cycle. Review cost dashboards before and after prompt or model changes.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| LLM app delivery checklist | `references/checklist.md` | Any LLM integration feature, prompt change, or model config review |

## Constraints

- Do not embed user-supplied content directly into system-level prompt sections; treat all user input as untrusted.
- Do not rely on free-text model output for any control-flow decision; always parse against a schema or enum.
- Do not hard-code model identifiers in application logic; externalize to configuration so fallback and migration are possible without code changes.
- Do not ship prompt changes without at least one representative test case that asserts on the output schema, not just on "model returned something."
- Do not assume latency or cost stability across model versions; re-measure after every model or prompt change.
- Do not ignore rate-limit or quota responses from providers; implement back-pressure and surface clear errors to callers.
- Treat any prompt that concatenates retrieval context, tool results, or multi-turn history as high-risk for context overflow; enforce explicit token-budget checks before the call.

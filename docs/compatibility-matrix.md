# Provider Compatibility Matrix

Status badges: **✅ Tested** · **🟡 Partial** · **🔬 Experimental** · **— Not applicable**

This matrix documents the current support level for each provider family.
Every claim below is backed by automated tests or implementation evidence in the repository;
see the [Evidence Sources](#evidence-sources) section for traceability.

## Provider Overview

| Provider | Entrypoint | Bridge Profile | Config Bootstrap |
|---|---|---|---|
| Claude | `CLAUDE.md` | — | `.claude/settings.local.json` |
| Codex | `AGENTS.md` | — | — |
| Cursor | `AGENTS.md` (shared with Codex) | — | — |
| DeepSeek | `AGENTS.md` (shared model-provider entrypoint) | — | — |
| Gemini | `GEMINI.md` | — | — |
| Qwen | `QWEN.md` | — | optional `.qwen/settings.json` |
| GitHub Copilot | `.github/copilot-instructions.md` | `.github/agents/orchestrator.md` | — |
| Windsurf | `.windsurf/rules/rules.md` | `.windsurf/agents/orchestrator.md` | — |
| Junie | `.junie/guidelines.md` | `.junie/agents/orchestrator.md` | — |
| Antigravity | `.antigravity/rules.md` | `.antigravity/agents/orchestrator.md` | — |

`Codex`, `Cursor`, and `DeepSeek` intentionally share the same root entrypoint file while remaining distinct runtime providers.

## Core Feature Matrix

| Feature | Claude | Codex | Cursor | DeepSeek | Gemini | Qwen | Copilot | Windsurf | Junie | Antigravity |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Entrypoint materialization | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Managed-block injection | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Redirect entrypoints | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Start-task router | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Orchestrator bridge profile | — | — | — | — | — | — | ✅ | ✅ | ✅ | ✅ |
| Skill bridge agents | — | — | — | — | — | — | ✅ | — | — | — |
| Token economy | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Scoped diffs | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Compact-command protocol | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Gate Sequence Compliance

All supported providers share the same mandatory gate sequence.
Tests verify that each materialized entrypoint and start-task router includes the full ordered gate set.

| Gate | Claude | Codex | Cursor | DeepSeek | Gemini | Qwen | Copilot | Windsurf | Junie | Antigravity |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `enter-task-mode` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `load-rule-pack` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `classify-change` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `compile-gate` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `build-review-context` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `required-reviews-check` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `doc-impact-gate` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `completion-gate` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Review Delegation

Required reviews run as independent fresh-context delegated sub-agents on every supported provider.

| Provider | Delegation Mode | Mechanism | Status |
|---|---|---|:---:|
| Claude | Delegated sub-agent | Agent tool (`fork_context=false`) | ✅ |
| Codex | Delegated sub-agent | Native sub-agents | ✅ |
| Cursor | Delegated sub-agent | Delegated reviewer sub-agents with isolated context | ✅ |
| DeepSeek | Delegated sub-agent | Delegated reviewer sub-agents with isolated context | ✅ |
| GitHub Copilot | Delegated sub-agent | `task` tool (`agent_type="general-purpose"`) | ✅ |
| Windsurf | Delegated sub-agent | Provider sub-agents with isolated review context | ✅ |
| Junie | Delegated sub-agent | Provider sub-agents with isolated review context | ✅ |
| Antigravity | Delegated sub-agent | Provider sub-agents with isolated review context | ✅ |
| Gemini | Delegated sub-agent | Delegated reviewer sub-agents with isolated context | ✅ |
| Qwen | Delegated sub-agent | Delegated reviewer sub-agents with isolated context | ✅ |

**Notes:**
- Required reviews must use `delegated_subagent` mode on every supported provider.
- Providers or bridges that cannot launch delegated reviewer sub-agents cannot satisfy the mandatory review workflow.

## Review Type Support

All 9 review types are available to every provider through the same gate infrastructure.
Whether a specific review type activates depends on the preflight classifier and `review-capabilities.json`,
not the provider.

| Review Type | Mandatory | Pass Token | All Providers |
|---|:---:|---|:---:|
| code | Yes | `REVIEW PASSED` | ✅ |
| db | Yes | `DB REVIEW PASSED` | ✅ |
| security | Yes | `SECURITY REVIEW PASSED` | ✅ |
| refactor | Yes | `REFACTOR REVIEW PASSED` | ✅ |
| api | No | `API REVIEW PASSED` | ✅ |
| test | No | `TEST REVIEW PASSED` | ✅ |
| performance | No | `PERFORMANCE REVIEW PASSED` | ✅ |
| infra | No | `INFRA REVIEW PASSED` | ✅ |
| dependency | No | `DEPENDENCY REVIEW PASSED` | ✅ |

## Test Coverage by Provider

The execution-path test suite (`tests/node/gates/provider-workflow-execution.test.ts`) validates
all 9 providers across multiple dimensions.

| Test Dimension | Tests per Provider | Total |
|---|:---:|:---:|
| Handshake diagnostics | 5 | 45 |
| Evidence lifecycle | 2 | 18 |
| Provider compliance | 4 | 36 |
| Gate sequence verification | 5 | 45 |
| Bridge execution contracts | 5 (bridge only) | 20 |
| Cross-provider context | — | 6 |
| Multi-provider workspace | — | 3 |
| Redirect entrypoints | 2 | 18 |
| Structural invariants | — | 8 |
| Compliance format output | — | 2 |
| **Total** | | **~201** |

Additional provider-relevant test suites:

| Suite | Path | Scope |
|---|---|---|
| Cross-provider router matrix | `tests/node/materialization/cross-provider-router-matrix.test.ts` | Entrypoint canonicalization across 9 providers and 8 unique entrypoints |
| Provider compliance validators | `tests/node/validators/provider-compliance.test.ts` | Managed-block and structure validation |
| CLI provider routing | `tests/node/cli/commands/gates.test.ts` | `--provider` option dispatch |

## Status Definitions

| Badge | Meaning |
|---|---|
| ✅ Tested | Validated by automated tests and/or confirmed through real task execution. |
| 🟡 Partial | Core workflow exists, but some documented surfaces or non-critical capability details still need follow-up before the provider story is fully consistent. |
| 🔬 Experimental | Designed and materialized, but broader real-task evidence is still limited. |
| — | Feature does not apply to this provider (e.g., bridge profiles for root-entrypoint-only providers). |

## Evidence Sources

| Evidence | Location |
|---|---|
| Provider constants and entrypoint map | `src/core/constants.ts` |
| Bridge and skill-bridge profile definitions | `src/materialization/common.ts` |
| Reviewer routing and delegation policy | `src/gates/reviewer-routing.ts` |
| Delegation rules | `garda-agent-orchestrator/live/skills/orchestration/SKILL.md` |
| Execution-path tests (T-011) | `tests/node/gates/provider-workflow-execution.test.ts` |
| Cross-provider router tests | `tests/node/materialization/cross-provider-router-matrix.test.ts` |
| Provider compliance tests | `tests/node/validators/provider-compliance.test.ts` |
| Review capabilities config | `garda-agent-orchestrator/live/config/review-capabilities.json` |
| Token economy config | `garda-agent-orchestrator/live/config/token-economy.json` |

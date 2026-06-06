# Supported Providers

Garda supports multiple AI coding agent provider surfaces through one canonical workflow.
This page is the human-readable provider list for the current release line.

For test-backed details, see [Provider Compatibility Matrix](compatibility-matrix.md).

## Current Provider Surfaces

| Provider | Entrypoint | Bridge Profile | Notes |
|---|---|---|---|
| Claude | `CLAUDE.md` | — | Root provider entrypoint. |
| Codex | `AGENTS.md` | — | Shares the root `AGENTS.md` compatibility path. |
| Cursor | `AGENTS.md` | — | Shares the root `AGENTS.md` compatibility path. |
| DeepSeek | `AGENTS.md` | — | Shares the root `AGENTS.md` compatibility path. |
| Gemini | `GEMINI.md` | — | Root provider entrypoint. |
| Qwen | `QWEN.md` | optional `.qwen/settings.json` | Root provider entrypoint with optional config bootstrap. |
| GitHub Copilot | `.github/copilot-instructions.md` | `.github/agents/orchestrator.md` | Provider bridge profile for orchestrator routing. |
| Windsurf | `.windsurf/rules/rules.md` | `.windsurf/agents/orchestrator.md` | Provider bridge profile for orchestrator routing. |
| Junie | `.junie/guidelines.md` | `.junie/agents/orchestrator.md` | Provider bridge profile for orchestrator routing. |
| Antigravity | `.antigravity/rules.md` | `.antigravity/agents/orchestrator.md` | Antigravity 2.0 / Antigravity CLI provider surface with delegated sub-agent review support when the active runtime can launch fresh reviewer subagents. |

## Shared Entrypoints

Codex, Cursor, and DeepSeek intentionally share `AGENTS.md` while remaining separate runtime providers.
The shared file keeps the root workflow consistent and lets the runtime provider be tracked separately.

## Antigravity Review Delegation

Garda supports Antigravity 2.0 and Antigravity CLI provider surfaces for mandatory independent reviews when the active Antigravity runtime can delegate work to fresh sub-agent reviewers.
The fail-closed evidence model is unchanged: task-mode and handshake evidence must still attest a launchable delegated reviewer route, and review receipts must still record `reviewer_execution_mode=delegated_subagent` plus the provider-assigned reviewer identity.
If an Antigravity runtime cannot launch a fresh isolated reviewer for the current task context, Garda must stop or route to another supported provider instead of accepting hand-written review artifacts.

References: [Antigravity 2.0](https://antigravity.google/product/antigravity-2), [Antigravity CLI](https://antigravity.google/product/antigravity-cli), and [Antigravity CLI subagents](https://antigravity.google/docs/cli-subagents).

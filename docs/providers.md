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
| Antigravity | `.antigravity/rules.md` | `.antigravity/agents/orchestrator.md` | Task workflow can run, but independent delegated reviews are not currently supported without a confirmed provider-native sub-agent launch tool. |

## Shared Entrypoints

Codex, Cursor, and DeepSeek intentionally share `AGENTS.md` while remaining separate runtime providers.
The shared file keeps the root workflow consistent and lets the runtime provider be tracked separately.

## Antigravity Review Limitation

Antigravity can use Garda's task workflow instructions, but current Antigravity tooling does not provide a confirmed independent sub-agent launch surface.
If a task requires mandatory independent review, Antigravity alone cannot satisfy that review contract in the current release line.

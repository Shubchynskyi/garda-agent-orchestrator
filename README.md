# Garda Agent Orchestrator

<p align="center">
  <img src="docs/assets/garda-github-social-preview.png" alt="Garda - Governed workflows for AI coding agents" />
</p>

**Governed workflows for AI coding agents.**

Garda turns Claude, Codex, Copilot, Gemini, Qwen, Windsurf, Junie, and Antigravity into a controlled local development workflow with task lifecycle, mandatory gates, review artifacts, doc-impact checks, and auditable completion.

`GARDA = Governed Agent Runtime, Deployment, and Audit.`

**[Website](https://garda-workflow.netlify.app/)** · **[Quick Start](#quick-start)** · **[User Guide](HOW_TO.md)** · **[Architecture](docs/architecture.md)** · **[Work Example](docs/work-example.md)** · **[CLI Reference](docs/cli-reference.md)** · **[Configuration](docs/configuration.md)** · **[Changelog](CHANGELOG.md)**

## Without Garda / With Garda

| Without Garda | With Garda |
|---|---|
| Agent jumps straight into edits | Agent enters a controlled task workflow |
| Tests, reviews, and docs checks depend on discipline | Gates run in a defined order |
| Completion means whatever the agent claims | Completion is checked before being accepted |
| Review context can drift | Review artifacts are required |
| No shared audit trail | Task-event history records the workflow |
| Each provider needs separate habits | One workflow surface across agents |

## Workflow

```text
Task -> enter-task-mode -> load-rule-pack -> preflight -> compile -> review-context -> required reviews -> doc-impact -> completion
```

Garda does not replace your coding agent. It gives every agent the same controlled path to done.

## Why Garda?

AI coding agents are powerful, but in real repositories they can skip steps, lose context, avoid reviews, and mark work as done too early.

Garda adds a governance layer:

- task lifecycle: `TODO → IN_PROGRESS → IN_REVIEW → DONE`
- mandatory gates: preflight, compile, review, doc-impact, completion
- provider-agnostic rules for Claude, Codex, Copilot, Gemini, Qwen, Windsurf, Junie, and Antigravity
- auditable task events and review artifacts
- local Node/TypeScript CLI runtime
- token-economy defaults for compact green-path execution

## Quick Start

```shell
npm install -g garda-agent-orchestrator
garda setup
```

Then give [AGENT_INIT_PROMPT.md](AGENT_INIT_PROMPT.md) to your coding agent. The agent reuses existing init answers, confirms active agent files, fills project context, offers optional skill packs, and finishes with `garda agent-init`.

After `garda agent-init` passes, pick a task from `TASK.md` and tell the agent:

```text
Execute task T-001 from TASK.md strictly through all mandatory orchestrator gates.
```

The active profile (`balanced`, `fast`, `strict`, `docs-only`) provides the default execution mode; use explicit `depth=` only as a one-run override.

Mandatory gate order:
`enter-task-mode -> load-rule-pack -> handshake-diagnostics -> shell-smoke-preflight -> classify-change -> load-rule-pack -> compile-gate -> build-review-context -> required-reviews-check -> doc-impact-gate -> completion-gate`

Temporary fallback without global install:

```shell
npx -y garda-agent-orchestrator setup
```

`npx` runs the package once and does not keep `garda` or `gao` in your `PATH`.
If you want persistent commands, install globally.

## Key Features

| Feature | Description |
|---|---|
| **8 Supported Providers** | Claude, Codex, Copilot, Gemini, Qwen, Windsurf, Junie, Antigravity — single canonical rule set |
| **Mandatory Quality Gates** | Preflight → Compile → Review → Doc-Impact → Completion |
| **Token Economy** | Reviewer-context compaction, scoped diffs, gate output filtering — saves 60–100% on green builds |
| **Task Lifecycle** | `TODO → IN_PROGRESS → IN_REVIEW → DONE` with hash-chain integrity |
| **9 Review Types** | code, db, security, refactor, api, test, performance, infra, dependency |
| **Node Runtime** | Public CLI and gate flows run through the Node/TypeScript router with no shell runtime dependency |
| **Compact Command Hints** | Agent rules teach efficient CLI flags for everyday commands |

## Supported Providers

| Provider | Entrypoint | Bridge Profile |
|---|---|---|
| Claude | `CLAUDE.md` | `.claude/settings.local.json` |
| Codex | `AGENTS.md` | — |
| Gemini | `GEMINI.md` | — |
| Qwen | `QWEN.md` | optional `.qwen/settings.json` context bootstrap |
| GitHub Copilot | `.github/copilot-instructions.md` | `.github/agents/*.md` |
| Windsurf | `.windsurf/rules/rules.md` | `.windsurf/agents/orchestrator.md` |
| Junie | `.junie/guidelines.md` | `.junie/agents/orchestrator.md` |
| Antigravity | `.antigravity/rules.md` | `.antigravity/agents/orchestrator.md` |

## CLI Commands

| Command | Description |
|---|---|
| `garda` | Safe overview: help + current project status |
| `garda setup` | First-run CLI onboarding without requiring an agent for the 6 answers |
| `garda agent-init` | Hard code-level gate that finalizes agent onboarding |
| `garda next-step` | Show the exact next orchestrator command for a task |
| `garda status` | Short project status snapshot |
| `garda doctor` | Run verify + manifest validation from existing answers |
| `garda preprompt` | Build a read-only task brief with current context and canonical next commands |
| `garda status why-blocked` | Explain why blocked or stalled tasks cannot progress, including task-event lock blockers |
| `garda doctor explain` | Print remediation steps for known failure IDs |
| `garda bootstrap` | Bundle-only deploy without install |
| `garda install` | Deploy/refresh orchestrator (requires init-answers.json) |
| `garda init` | Re-materialize `live/` from existing answers |
| `garda reinit` | Change init answers without full reinstall |
| `garda check-update` | Compare current deployment with a newer npm package or local source |
| `garda update` | Apply the update workflow directly (`--dry-run` for preview) |
| `garda update git` | Apply or preview an update from a git repo or local clone |
| `garda rollback` | Roll back to a specific version or restore from the latest rollback snapshot |
| `garda cleanup` | Remove retained runtime artifacts or edit review-artifact retention policy |
| `garda uninstall` | Remove orchestrator with keep/delete choices |
| `garda skills` | List, suggest, add, remove, and validate optional built-in skill packs |
| `garda profile` | List, switch, create, delete, and validate workspace profiles |

Published command names: `garda`, `gao`, `garda-agent-orchestrator`

Full reference: **[docs/cli-reference.md](docs/cli-reference.md)**

## Version

- Package: `garda-agent-orchestrator`
- Current version source of truth: `VERSION`
- Package manifest versions: `package.json`, `package-lock.json`
- Recommended CLI install: `npm install -g garda-agent-orchestrator`
- Recommended first command: `garda setup`
- One-off fallback without install: `npx -y garda-agent-orchestrator setup`
- Install locally only if you want repo-local binaries in `node_modules/.bin`: `npm install garda-agent-orchestrator`

## Naming

- Package and bundle name: `garda-agent-orchestrator`
- Published command names: `garda`, `gao`, `garda-agent-orchestrator`
- Launcher path: `bin/garda.js`

## Runtime Baseline

- **Node.js 24 LTS is the supported runtime baseline** for the public CLI, lifecycle commands, and gate commands. CI targets Node 24 across the supported OS matrix.
- **Compatibility note:** as of `v1.0.0`, the codebase also builds on `Node 20.20.2` and `Node 22.22.2`. However, those versions are not part of the official support contract, and runtime diagnostics still enforce the documented `>=24.0.0` baseline.
- **Compile-first runtime contract:** `src/**/*.ts` is the source of truth, `src/bin/garda.ts` compiles into the public `bin/garda.js` launcher, and that launcher executes compiled JavaScript from `dist/src/**/*.js` or the staged `.node-build/src/**/*.js` test build. Raw `src/**/*.ts` files are never executed directly.
- **Strict TypeScript means compiler-enforced typing across all maintained code paths:** `tsconfig.build.json` runs `strict:true` for `src/**/*.ts`, and the wider repo graph (`tsconfig.node-foundation.json` / `tsconfig.tests.json`) covers `src/**/*.ts`, `tests/node/**/*.ts`, and `scripts/node-foundation/**/*.ts`.
- **Release validation is explicit:** `npm run validate:release` proves `build -> test -> pack -> install/invoke` for the published CLI contract.
- **GitHub Actions CI mirrors the hot path:** `ci.yml` runs `typecheck`, `test`, `validate:release`, and a cross-platform lifecycle smoke that installs from the current workflow branch instead of drifting to the repository default branch.
- Root `tsconfig.json` extends `tsconfig.node-foundation.json`, so editors like IntelliJ IDEA or WebStorm can discover the repository without custom setup.

## Documentation

| Document | Description |
|---|---|
| **[HOW_TO.md](HOW_TO.md)** | Step-by-step user guide |
| **[docs/cli-reference.md](docs/cli-reference.md)** | Complete CLI command reference |
| **[docs/architecture.md](docs/architecture.md)** | Design, runtime model, deployed files |
| **[docs/configuration.md](docs/configuration.md)** | Token economy, output filters, review capabilities |
| **[docs/node-platform-foundation.md](docs/node-platform-foundation.md)** | Node foundation, execution model, validators, and build/test skeleton |
| **[docs/work-example.md](docs/work-example.md)** | Task lifecycle walkthrough |
| **[AGENT_INIT_PROMPT.md](AGENT_INIT_PROMPT.md)** | Setup prompt for coding agents |
| **[CHANGELOG.md](CHANGELOG.md)** | Full changelog |
| **[MANIFEST.md](MANIFEST.md)** | Bundle file manifest |

## Release Background

Garda was not started from scratch in this repository. Earlier versions were developed privately as shell/Python prototypes before being rewritten and consolidated into the current Node/TypeScript implementation. This public repository intentionally starts from the first stable public release, `v1.0.0`, so the earlier internal incubation history is not reflected in the public commit log.

## Recent Changes

- Completed the final TS-only source transition: `src/bin/garda.ts` now owns the public CLI launcher and `bin/garda.js` is build-generated only.
- Source installs now self-build through `npm prepare`, so the generated launcher and compiled runtime are materialized before execution.
- Packaging tests now build in isolated fixture repositories, removing cross-test races on shared `dist/` state.
- Stabilized the Node gate router for scoped diff, review-context, task-event summary, and completion flows.
- Added root `tsconfig.json` for standard editor/IDE TypeScript discovery and included it in the published package surface.
- Full `tests/node/**` baseline now completes cleanly without temp workspace helper noise.
- Compact Command Hints added to agent rules for token-efficient CLI usage.
- E2E smoke tests covering full install/reinit/uninstall lifecycle matrix.
- Token-economy defaults aligned: `enabled=true` with `enabled_depths=[1,2]`.
- LF line endings enforced for pre-commit hook and bash artifacts on all platforms.
- Parser-aware gate compaction and review-context artifacts for token-economy mode.
- Added update workflow with version check and npm-based update source resolution.
- Completed the runtime cutover to a Node-only lifecycle and gate surface.
- Added npm package CLI with `garda`, `gao`, `garda-agent-orchestrator` aliases.

## Important Notes

- `garda setup` can collect the 6 init answers itself and write `runtime/init-answers.json` without an agent.
- After CLI setup, use `AGENT_INIT_PROMPT.md` so the agent reuses existing init answers, clarifies language when it cannot recognize it confidently, explicitly confirms which agent entrypoint files are actively used, fills project-specific context, optionally manages built-in skill packs, and finishes with the hard `garda agent-init` gate.
- Optional skills are discovered from the compact `live/config/skills-index.json` index. After the user selects a built-in pack, it should be installed into `live/skills/**` without reading the full optional `SKILL.md` immediately. Full optional skill files should be opened only later, when the selected skill is actually activated for a task or a hard activation rule requires it.
- `garda` without arguments is now non-destructive and only prints overview/help.
- The public CLI owns the validated runtime surface for lifecycle commands and gate routes.
- Update trust is allowlist-first by default. Any bypass for local paths or non-standard update sources must be explicit via `--trust-override --no-prompt`, and ordinary CLI flows ignore the legacy `GARDA_UPDATE_TRUST_OVERRIDE` environment variable.
- Task-event lock diagnostics live only under `garda-agent-orchestrator/runtime/task-events/*.lock`. Use `garda doctor --cleanup-stale-locks --dry-run` before removing stale lock directories, and do not treat `runtime/reviews/` as part of the lock subsystem.
- `bin/garda.js` is a generated launcher compiled from `src/bin/garda.ts`; repository builds run from `dist/src/**/*.js`, tests can stage `.node-build/src/**/*.js`, and packaged installs invoke the same compiled contract from `node_modules`.
- Root `tsconfig.json` is the editor-facing entrypoint and simply extends `tsconfig.node-foundation.json`.
- Installer is non-destructive for existing project files outside managed blocks.
- Commit message format is project-defined; conventional commits are optional.
- For detailed deployment, lifecycle, and configuration information, see the `docs/` directory.

## License

Apache License 2.0. See `LICENSE`.

## Author

- Dmytro Shubchynskyi
- Email: d.shubchynskyi@gmail.com
- LinkedIn: https://www.linkedin.com/in/shubchynskyi

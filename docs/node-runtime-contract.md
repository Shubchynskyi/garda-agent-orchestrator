# Node Runtime Contract

Version source: VERSION
Frozen: 2026-03-27

This document captures the current Node-only runtime surface.

## Public Surface

- CLI aliases: `garda`, `gao`, `garda-agent-orchestrator`
- Entrypoint: generated `bin/garda.js` (compiled from `src/bin/garda.ts`)
- Runtime baseline: `Node.js >=24.0.0`

## Execution Modes

- Source-repository mode: run `npm run build`, which compiles `src/bin/garda.ts` into `bin/garda.js`; that launcher then resolves compiled `dist/src/**/*.js`.
- Source-install mode: `npm install` from a source checkout runs `prepare`, which builds the generated launcher and compiled runtime before first use.
- Test-staged mode: Node foundation tests may stage `.node-build/src/**/*.js`, and `bin/garda.js` can resolve that compiled output when `dist/` is intentionally absent in the fixture.
- Packaged-install mode: under `node_modules`, `bin/garda.js` first delegates to a local workspace/source `bin/garda.js` when the current project already contains an orchestrator checkout or deployed bundle; otherwise it falls back to its packaged compiled runtime in `dist/src/**/*.js`.
- Raw `src/**/*.ts` files are compile-time inputs only; direct `.ts` execution is not part of the supported runtime contract.
- Public CLI commands, gate names, and verification markers are the same in both modes.

## Command Inventory

Lifecycle commands:

```text
setup, agent-init, status, doctor, bootstrap, install, init, reinit, verify, check-update, update, rollback, uninstall, skills
```

Additional public routes:

```text
update git
gate <name>
```

Zero-argument invocation prints the safe overview. Unknown first positional falls through to `bootstrap`.

`Workspace ready` is blocked by `runtime/agent-init-state.json` until the hard `agent-init` gate passes.

## Source-of-Truth Values

| SourceOfTruth | Canonical Entrypoint |
|---|---|
| Claude | `CLAUDE.md` |
| Codex | `AGENTS.md` |
| Gemini | `GEMINI.md` |
| Qwen | `QWEN.md` |
| GitHubCopilot | `.github/copilot-instructions.md` |
| Windsurf | `.windsurf/rules/rules.md` |
| Junie | `.junie/guidelines.md` |
| Antigravity | `.antigravity/rules.md` |

## Init Answers Contract

`runtime/init-answers.json` keeps:

- `AssistantLanguage`
- `AssistantBrevity`
- `SourceOfTruth`
- `EnforceNoAutoCommit`
- `ClaudeOrchestratorFullAccess`
- `TokenEconomyEnabled`
- `CollectedVia`
- optional `ActiveAgentFiles`

Allowed brevity values:

```text
concise, detailed
```

Allowed `CollectedVia` values:

```text
AGENT_INIT_PROMPT.md, CLI_INTERACTIVE, CLI_NONINTERACTIVE
```

## Deployed Bundle Surface

The deployed bundle keeps:

```text
.gitattributes
bin/
dist/
src/
template/
AGENT_INIT_PROMPT.md
CHANGELOG.md
HOW_TO.md
LICENSE
MANIFEST.md
README.md
VERSION
package.json
```

The runtime materializes:

- `live/config/**`
- `live/docs/**`
- `live/skills/**`
- `live/project-discovery.md`
- `live/source-inventory.md`
- `live/init-report.md`
- `live/USAGE.md`
- `live/version.json`
- `runtime/reviews/**`
- `runtime/task-events/**`

Ordinary `update` and `check-update --apply` additionally:

- sync the new bundle into place
- re-run install and live materialization
- apply built-in migrations for mandatory live rule contracts in existing workspaces
- run verify plus manifest validation before the update is considered successful
- invalidate cached bundle runtime modules after a successful apply so long-lived host processes reload the synced bundle on later commands
- keep update-source trust in enforced mode unless the operator explicitly passes `--trust-override --no-prompt`
- record trust-policy audit data (`TrustPolicy`, `TrustOverrideUsed`, `TrustOverrideSource`) in update CLI output and update reports

Update trust model:

- Trusted mode accepts only the allowlisted npm package name and allowlisted git repository URLs.
- Local `--source-path` update sources are test/dev-only flows and require explicit `--trust-override --no-prompt`.
- The legacy `GARDA_UPDATE_TRUST_OVERRIDE` environment variable is ignored by ordinary CLI/runtime flows and is reserved for test-only harness paths.

## Gate Inventory

Canonical gate surface:

```text
node garda-agent-orchestrator/bin/garda.js gate <name>
```

Shipped gates:

- `enter-task-mode`
- `load-rule-pack`
- `classify-change`
- `compile-gate`
- `required-reviews-check`
- `record-no-op`
- `doc-impact-gate`
- `completion-gate`
- `build-scoped-diff`
- `build-review-context`
- `log-task-event`
- `task-events-summary`
- `validate-manifest`
- `human-commit`

Lifecycle auto-emission:

- `enter-task-mode` auto-emits `TASK_MODE_ENTERED`, `PLAN_CREATED`, and best-effort `STATUS_CHANGED` / `PROVIDER_ROUTING_DECISION`
- `classify-change` auto-emits `PREFLIGHT_STARTED` and then `PREFLIGHT_CLASSIFIED` or `PREFLIGHT_FAILED`
- `compile-gate` auto-emits `IMPLEMENTATION_STARTED` and then `COMPILE_GATE_PASSED` or `COMPILE_GATE_FAILED`
- `build-review-context` auto-emits `REVIEW_PHASE_STARTED`, `SKILL_SELECTED`, and `SKILL_REFERENCE_LOADED` for the selected review skill
- `record-no-op` writes `runtime/reviews/<task-id>-no-op.json` for audited `already done` / `no changes required` / `audit only` outcomes
- `required-reviews-check`, `doc-impact-gate`, and `completion-gate` append their pass/fail markers to the task timeline
- `status` and `doctor` report task-timeline completeness, not just timeline presence

Zero-diff guard:

- A clean-tree `classify-change` result is `BASELINE_ONLY`, not successful completion evidence.
- For implementation tasks, zero-diff preflight must lead to one of three states:
  - a later produced diff, then normal compile/review/completion flow;
  - an audited no-op artifact recorded through `gate record-no-op`;
  - an explicit blocked state.
- `required-reviews-check` and `completion-gate` reject zero-diff tasks without audited no-op evidence.

## Verification Markers

- Overview marker: `GARDA_OVERVIEW`
- Bootstrap success: `GARDA_BOOTSTRAP_OK`
- Setup success: `GARDA_SETUP`
- Status marker: `GARDA_STATUS`
- Verify success: `Verification: PASS`
- Verify failure tail: `Verification failed. Resolve listed issues and rerun.`

Compact validation success markers:

- `garda status --compact` (ready): `GARDA_STATUS: ready | source=<provider>`
- `garda doctor --compact` (pass): `Doctor: PASS | verify=PASS | manifest=PASS`
- `garda verify --compact` (pass): `Verification: PASS | paths=<count> | violations=0`
- `garda gate validate-manifest --compact` (pass): `MANIFEST_VALIDATION_PASSED | entries=<count>`

## Validation

Contract coverage lives in:

- strict runtime build config: `tsconfig.build.json`
- strict test/build-harness config: `tsconfig.tests.json`
- `tests/node/**`
- `npm test`
- `npm run validate:release`

`TypeScript` in this repository means compiler-enforced strict typing across the runtime (`src/**`), Node test suite (`tests/node/**`), and supporting build/test scripts (`scripts/node-foundation/**`). `npm run validate:release` proves the public release path as `build -> test -> pack -> install/invoke`.

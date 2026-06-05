# Run Methods

Copy-paste command reference for common Garda Agent Orchestrator launch methods.

Current package version source in this repository: `VERSION`.

## 1. Run Directly From Source Tree

Use this when testing the repository itself without packing or installing.
Compile first so `src/bin/garda.ts` is emitted as `bin/garda.js` and can launch the built runtime.

```text
cd D:\Projects\garda-agent-orchestrator

npm run build

node .\bin\garda.js
node .\bin\garda.js --help
node .\bin\garda.js setup --target-root . --no-prompt --assistant-language English --assistant-brevity concise --source-of-truth Codex --enforce-no-auto-commit false --claude-orchestrator-full-access false --token-economy-enabled true
node .\bin\garda.js status --target-root .
node .\bin\garda.js agent-init --target-root . --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --active-agent-files "AGENTS.md" --project-rules-updated yes --skills-prompted yes
node .\bin\garda.js doctor --target-root . --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
```

## 2. Global Install From Published npm Package

Use this for normal day-to-day CLI usage.

```text
npm install -g garda-agent-orchestrator

garda
gao
garda-agent-orchestrator
```

## 3. Run Through `npx` From Published npm Package

Use this after `npm publish`.
Use this only when you want a temporary run without global install.
Use the package name with `npx`; the shorter `garda` and `gao` names are CLI aliases after install, not npm package names.

```text
npx -y garda-agent-orchestrator
npx -y garda-agent-orchestrator setup
npx -y garda-agent-orchestrator status --target-root .
```

## 4. Install From Local Repository Folder

Use this to test package behavior without publishing.

```text
mkdir C:\Temp\garda-folder-test
cd C:\Temp\garda-folder-test
npm init -y
git init

npm install D:\Projects\garda-agent-orchestrator

npx garda-agent-orchestrator
npx garda-agent-orchestrator setup --target-root . --no-prompt --assistant-language English --assistant-brevity concise --source-of-truth Codex --enforce-no-auto-commit false --claude-orchestrator-full-access false --token-economy-enabled true
npx garda-agent-orchestrator status --target-root .
```

## 5. Pack To `.tgz` And Test Like a Real npm Artifact

This is the best pre-publish smoke test.

```text
cd D:\Projects\garda-agent-orchestrator
npm pack --dry-run
npm pack

mkdir C:\Temp\garda-npm-test
cd C:\Temp\garda-npm-test
npm init -y
git init

npm install D:\Projects\garda-agent-orchestrator\garda-agent-orchestrator-<current-version>.tgz

npx garda-agent-orchestrator
npx garda-agent-orchestrator setup --target-root . --no-prompt --assistant-language English --assistant-brevity concise --source-of-truth Codex --enforce-no-auto-commit false --claude-orchestrator-full-access false --token-economy-enabled true
npx garda-agent-orchestrator status --target-root .
```

## 6. Run Local Binary After `npm install`

Useful when you want to avoid `npx`.

```text
.\node_modules\.bin\garda.cmd
.\node_modules\.bin\gao.cmd
.\node_modules\.bin\garda-agent-orchestrator.cmd
```

## 7. Global Install From Local `.tgz`

Use this to test the global CLI before publish.

```text
cd D:\Projects\garda-agent-orchestrator
npm pack
npm install -g .\garda-agent-orchestrator-<current-version>.tgz

garda
garda setup
garda status --target-root .
```

## 8. Recommended Local Validation Before Publish

```text
cd D:\Projects\garda-agent-orchestrator

npm run release:preflight
npm run test:release-smoke
npm run validate:release
node .\bin\garda.js gate validate-manifest --manifest-path MANIFEST.md
```

`npm run release:preflight` is the final release-readiness command. It first runs `npm run validate:release-readiness`, which checks static alignment for package scripts and files, CI update-smoke wiring, runtime-state docs, security/audit package surface, manifest-listed docs, and the tracked `docs/release-readiness.md` release checklist. It then runs `npm run test:release-smoke`, a short deterministic suite for task id parsing, task-event append integrity, basic next-step routing, status/doctor formatting, and package smoke coverage, before the full `npm run validate:release` proof.

`npm run validate:release` is the explicit release contract:

```text
npm run validate:clean-worktree
npm run validate:version-parity
npm run build
npm run typecheck
npm run lint
npm run coverage
npm run audit:prod
npm pack -> npm install <tarball> -> invoke the packaged CLI
npm run validate:clean-worktree
```

`npm run validate:clean-worktree` blocks release handoff when Git cannot prove a `HEAD`, branch/status state, or clean tracked/untracked worktree. Clean detached `HEAD` states are valid for reproducible CI and package checks.

`npm run coverage` wraps the existing full `npm test` path with `c8` reporting. Initial coverage is report-only; thresholds should be added only after an explicit baseline decision. The final `pack -> install -> invoke` proof is executed by `tests/node/packaging/pack-smoke.test.ts` after the strict TypeScript runtime, lint, coverage, production audit, and supporting build scripts have already passed.

Direct `npm pack` and `npm pack --dry-run` run the package `prepack` lifecycle, which enforces a clean worktree before package preparation and again after `build:publish-runtime`.

## 9. Update And Rollback In A Deployed Workspace

```text
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --apply --no-prompt
garda update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda update git --target-root "." --repo-url "." --check-only
garda rollback --target-root "."
```

Notes:
- Source-tree execution is compile-first: rebuild after changing `src/**/*.ts`, `tests/node/**/*.ts`, or `scripts/node-foundation/**/*.ts`.
- Direct `node --test .node-build/...` runs are producer-consumer flows: refresh `.node-build/` with `npm run build:node-foundation` or `npm test` before the consumer, and do not overlap the producer with the consumer.
- `check-update` is compare-first.
- `update` applies immediately.
- `update git` uses a git clone source instead of npm; with no extra flags it uses the default GitHub repository.
- `rollback` restores the latest saved rollback snapshot and the matching bundle backup when available.

## 10. After CLI Setup: Agent Handoff

After primary setup, give the agent:

```text
<project-root>\garda-agent-orchestrator\AGENT_INIT_PROMPT.md
```

The agent should then:
- validate and normalize `AssistantLanguage`;
- fill project context files;
- optionally use `garda skills suggest --target-root .` to recommend built-in packs from the compact skills index;
- replace placeholders in `live/docs/agent-rules/40-commands.md`;
- run `garda agent-init --target-root . --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --active-agent-files "<active-agent-files>" --project-rules-updated yes --skills-prompted yes`;
- only after `agent-init` passes, run `garda doctor --target-root . --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"`.

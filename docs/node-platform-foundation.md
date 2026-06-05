# Node Platform Foundation

## Goal

This document records the TypeScript/Node foundation that now backs the active runtime.

- baseline: **Node 24 LTS primary**, with **Node 22.13+ LTS compatibility**
- source of truth: **`src/**/*.ts`**
- executed runtime: **`dist/src/**/*.js`** (or staged **`.node-build/src/**/*.js`** in test fixtures)
- public router: generated **`bin/garda.js`** compiled from **`src/bin/garda.ts`**
- validation and gate logic run through the same Node runtime

## Source Layout

| Path | Role |
|---|---|
| `src/bin/garda.ts` | TypeScript source for the generated public CLI launcher |
| `src/cli/index.ts` | Foundation descriptor for the active Node runtime |
| `src/core/*.ts` | Shared constants, fs/path helpers, template utilities |
| `src/materialization/*.ts` | Install/init materialization logic |
| `src/lifecycle/*.ts` | Bootstrap, install, reinit, update, uninstall flows |
| `src/validators/*.ts` | Status, verify, doctor, manifest validation |
| `src/gates/*/*.ts` | Gate implementations and task-event summaries organized by domain |
| `src/gate-runtime/*.ts` | Shared gate runtime helpers |
| `tests/node/**` | Node-native unit and integration coverage |
| `scripts/node-foundation/*.ts` | Repository-only build/test harness for staged `.node-build/` output |
| `tsconfig.json` | Editor-facing entrypoint |
| `tsconfig.node-foundation.json` | Tooling contract for the Node foundation |

## Execution Model

- `src/**/*.ts` is the strict TypeScript source of truth; it is compiled before execution.
- `src/bin/garda.ts` compiles into the public `bin/garda.js` launcher; under `node_modules` it behaves as a thin router that prefers a local workspace/source launcher when one exists, and otherwise executes compiled JavaScript from `dist/src/**/*.js` or staged `.node-build/src/**/*.js`.
- `scripts/node-foundation/build.ts` produces `.node-build/` for staged contract tests, `dist/` for the published-package runtime, and syncs the generated `bin/garda.js` launcher from compiled TypeScript output.
- Direct execution of raw `.ts` files is no longer part of the supported runtime.

## Validator Strategy

Validation stays in-repo and TypeScript-first:

- init-answer validation
- managed config validation
- workspace layout checks
- manifest duplicate detection
- doctor and verify aggregation

## Build and Test

### `npm run build`

Compiles the lightweight helper graph (`src/bin/**/*.ts` plus `scripts/node-foundation/**/*.ts`) into `.scripts-build/`, then publishes compiled runtime artifacts into `dist/`.

This command does not certify direct `node --test .node-build/...` consumers. Those tests depend on the staged `.node-build/` graph, not only on `dist/`.

### `npm test`

Compiles the lightweight helper graph into `.scripts-build/`, rebuilds the wider staged `.node-build/` graph from `tsconfig.tests.json`, and executes the compiled `tests/node/**/*.test.js` suite.

When an operator needs to run direct compiled tests from `.node-build/`, the producer-consumer chain must stay sequential: refresh `.node-build/` first with `npm run build:node-foundation` or `npm test`, then run the direct `node --test .node-build/...` consumer. The runtime now blocks stale or concurrently-written `.node-build/` consumers instead of letting them run against untrusted artifacts.

### `npm run validate:release`

Runs the explicit release proof path:

1. `npm run validate:clean-worktree`
2. `npm run validate:version-parity`
3. `npm run build`
4. `npm run validate:embedded-bundle-parity`
5. `npm run quality`
6. compiled `tests/node/packaging/pack-smoke.test.js`, which performs `npm pack -> npm install <tarball> -> CLI invoke`
7. `npm run validate:clean-worktree`

`npm run validate:clean-worktree` fails closed when the repository cannot prove a Git `HEAD`, branch/status state, or clean tracked/untracked worktree. Clean detached `HEAD` states are allowed for reproducible CI/package checks, but dirty tracked files and untracked files block release handoff.

`npm run validate:embedded-bundle-parity` treats the nested `garda-agent-orchestrator/` checkout bundle as a generated artifact. If it is omitted or gitignored, the release check records that state as valid because it is not part of the release surface; if it is present and not gitignored, the check compares root and bundle tree hashes for the release sync surface, including source, compiled `dist`, templates, package metadata, and runtime-referenced docs.

`npm run quality` composes `typecheck`, `lint`, report-only `coverage`, and `audit:prod`. Coverage reports use the repository `c8` configuration so maintained source boundaries are measured; `all=true` keeps unexecuted maintained source visible in the report, and the test build emits source maps for the staged `.node-build/src` and `.node-build/scripts/node-foundation` execution projection. Generated and retained trees such as `dist`, `.node-build/tests`, `.scripts-build`, `coverage`, deployed runtime artifacts, `node_modules`, and tests are excluded from the reported surface. This keeps the release contract explicit: the shipped package must build, typecheck, lint, pass the full test suite under coverage collection, pass production dependency audit, pack from a clean tree, install, execute from the packaged runtime, and leave the release tree clean.

Direct `npm pack` and `npm pack --dry-run` are guarded by `prepack`, which runs the same clean-worktree preflight before package preparation and again after `build:publish-runtime`.

### `npm run release:preflight`

Runs the final operator-facing release readiness gate before the expensive release validation path:

1. `npm run validate:release-readiness`
2. `npm run test:release-smoke`
3. `npm run validate:release`

`npm run validate:release-readiness` is a short checklist gate. It verifies static alignment for package scripts, shipped package files, production audit wiring, CI release validation, lifecycle update smoke wiring, runtime-state documentation, manifest validation guidance, security document package/manifest surface, and the tracked `docs/release-readiness.md` checklist before the release is cut. `npm run test:release-smoke` then exercises high-signal runtime contracts for task id parsing, task-event append integrity, next-step startup routing, status/doctor formatting, and package smoke coverage. It intentionally does not replace `npm run validate:release`; the latter remains the build/test/pack/install proof.

### GitHub Actions CI

Repository CI mirrors the same contract in `.github/workflows/ci.yml`:

1. `npm run typecheck`
2. `npm run lint`
3. `npm test` (runs on Node 22.13+ and Node 24)
4. `npm run validate:release`
5. cross-platform lifecycle smoke on Linux, macOS, and Windows (Node 22.13+ and Node 24)

The lifecycle smoke installs from a `file://` clone of the current workflow branch, not implicitly from the repository default branch. That keeps pull-request and branch runs aligned with the code under test.

### Node 22 Compatibility Contract

Node 22.13+ is an official Garda 1.1.x compatibility runtime line. Node 24 remains the primary baseline, but the public runtime contract now requires every official support surface to include both Node 22.13+ and Node 24:

1. `package.json` engines allow `^22.13.0 || >=24.0.0`.
2. CI runs typecheck, full tests, release validation, and smoke coverage on Node 22.13+ and Node 24.
3. Runtime diagnostics and docs describe Node 22.13+ as supported and warn, rather than hard-block, when the current runtime is outside the tested support matrix.
4. TypeScript Node typings track the lower supported Node 22 line so Node 24-only APIs are not accidentally used.

Node 23, Node 22 versions before 22.13.0, and Node 20 or older remain outside the official support matrix. They are not CI/release-tested, but runtime version mismatch alone is warning-only.

## Current Runtime State

- `bin/garda.js` is a generated runtime launcher; the maintained source of truth lives in `src/bin/garda.ts`.
- Lifecycle commands and gates are Node-only.
- `TypeScript` means `strict:true` across runtime code, Node tests, and the repository build/test harness.
- Historical shell wrappers have been removed from the runtime surface.

## Repository Branch Note

- `master` and `dev` are the active heads for the current Node runtime line.
- `feat/node-runtime-migration` may still appear in clones or remotes as a historical alias that points to the same head; it is not a separate maintained runtime track.

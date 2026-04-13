# Node Platform Foundation

## Goal

This document records the TypeScript/Node foundation that now backs the active runtime.

- baseline: **Node 24 LTS**
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
| `src/gates/*.ts` | Gate implementations and task-event summaries |
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

### `npm test`

Compiles the lightweight helper graph into `.scripts-build/`, rebuilds the wider staged `.node-build/` graph from `tsconfig.tests.json`, and executes the compiled `tests/node/**/*.test.js` suite.

### `npm run validate:release`

Runs the explicit release proof path:

1. `npm run build`
2. `npm test`
3. compiled `tests/node/packaging/pack-smoke.test.js`, which performs `npm pack -> npm install <tarball> -> CLI invoke`

This keeps the release contract explicit: the shipped package must build, pass the full test suite, pack cleanly, install, and execute from the packaged runtime.

### GitHub Actions CI

Repository CI mirrors the same contract in `.github/workflows/ci.yml`:

1. `npm run typecheck`
2. `npm test` (runs on Node 24)
3. `npm run validate:release`
4. cross-platform lifecycle smoke on Linux, macOS, and Windows (Node 24)

The lifecycle smoke installs from a `file://` clone of the current workflow branch, not implicitly from the repository default branch. That keeps pull-request and branch runs aligned with the code under test.

## Current Runtime State

- `bin/garda.js` is a generated runtime launcher; the maintained source of truth lives in `src/bin/garda.ts`.
- Lifecycle commands and gates are Node-only.
- `TypeScript` means `strict:true` across runtime code, Node tests, and the repository build/test harness.
- Historical shell wrappers have been removed from the runtime surface.

## Repository Branch Note

- `master` and `dev` are the active heads for the current Node runtime line.
- `feat/node-runtime-migration` may still appear in clones or remotes as a historical alias that points to the same head; it is not a separate maintained runtime track.

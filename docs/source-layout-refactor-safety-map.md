# Source Layout Refactor Safety Map

This map is the safety contract for source-layout refactors. It is intentionally
behavior-preserving: future layout tasks may move or split files only when the
public command, gate, lifecycle, artifact, and review-trust contracts stay
compatible.

## Scope

The current crowded source areas are:

| Area | Current shape | Safe refactor direction |
|---|---:|---|
| `src/cli/commands` | 64 top-level files, plus existing `gate-flows/**` and `gate-review-handlers/**` families | Group durable command families under owner directories and keep public command facades stable. |
| `src/gate-runtime` | 46 top-level files | Group by evidence IO, timeline summaries, review artifacts/indexes, locks, and retention/runtime indexes. |
| `src/lifecycle` | 37 top-level files | Group by update/apply, rollback, cleanup/removal, locks, retention policy, and update-source checks. |
| `src/validators` | 24 top-level files | Group by doctor/status/workspace/verify diagnostics only where imports can stay stable. |
| `src/materialization` | 18 top-level files with large init/install flows | Split scenario phases behind existing init/install facades before introducing directories. |
| `src/core` | 28 top-level primitives | Split only clearly separable helpers; do not create a generic bucket for unrelated primitives. |

`src/gates/next-step/next-step.ts` remains a separate facade-extraction track and
is not part of this layout block except for tiny import fixes caused by a moved
facade.

## Compatibility Boundaries

Keep these imports stable unless a child task explicitly changes the public API:

- CLI entry and dispatch: `src/cli/runtime-main.ts`, `src/cli/main.ts`,
  `src/cli/commands/command-dispatch.ts`, and command modules imported by tests.
- Gate CLI facades: `src/cli/commands/gates.ts`,
  `src/cli/commands/gate-command.ts`, `src/cli/commands/gate-build-handlers.ts`,
  `src/cli/commands/gate-task-handlers.ts`, and
  `src/cli/commands/gate-review-handlers/**` public barrel paths.
- Runtime facades and indexes: `src/gate-runtime/task-events.ts`,
  `src/gate-runtime/review-artifacts.ts`, `src/gate-runtime/reviews-index.ts`,
  and `src/gate-runtime/timeline-summary.ts`.
- Lifecycle/materialization facades used by CLI/tests:
  `src/lifecycle/update.ts`, `src/lifecycle/rollback.ts`,
  `src/lifecycle/check-update.ts`, `src/materialization/init.ts`, and
  `src/materialization/install.ts`.
- Validator public imports: `src/validators/index.ts`, `src/validators/doctor.ts`,
  `src/validators/status.ts`, and `src/validators/verify.ts`.
- Core primitives with many direct consumers: `src/core/workflow-config.ts`,
  `src/core/provider-registry.ts`, `src/core/subprocess.ts`, and
  `src/core/dependent-validation-chains.ts`.

## Facade Classification

The current one-line compatibility re-exports fall into two classes:

- Public/stable facades: package-facing barrels, command and gate dispatch
  surfaces, validator entrypoints, core primitives listed above, lifecycle
  update/rollback/check-update entrypoints, and runtime review/timeline roots
  that are imported by tests or cross-domain callers.
- Internal compatibility facades: root files that only preserve pre-split
  paths for helpers now owned by a focused subdirectory, such as
  `src/validators/doctor-*`, `src/validators/status-*`, and
  `src/materialization/project-memory-*`. New same-domain implementation code
  should import the canonical subdirectory path directly while old public/test
  imports stay supported through the facade.

If a file is moved behind a new directory, keep a facade or compatibility
re-export at the old import path until the affected source and test imports are
updated in the same child task.

Internal-only source helper paths are not public compatibility contracts by
default. For example, `src/cli/commands/gates-*.ts` helper modules may move to
`src/cli/commands/gates/**` and the old root files may be deleted when the same
child task migrates all in-repository source imports, tests, and documentation
path hints to the canonical owner path. The preserved contract is CLI/gate
behavior, output, exit codes, artifact schemas, and documented public entrypoints,
not arbitrary historical source file locations.

## Move Order

Use this order so each child task has a bounded blast radius:

1. CLI command family layout.
2. Large standalone CLI command boundaries after layout is stable.
3. Gate runtime internals.
4. Lifecycle internals.
5. Validators, materialization, and selected core hotspots.

Do not combine CLI command moves with lifecycle or gate-runtime moves. Do not
combine source moves with behavior fixes unless the fix is required to preserve
the current public contract.

## Validation Map

| Future task | Focused validation before mandatory gates |
|---|---|
| CLI command layout | `tests/node/cli/**`, especially `tests/node/cli/commands/**` and gate CLI command suites. |
| Standalone CLI command splits | Command-specific tests for profile, stats, setup, update, repair, workspace maintenance, and dispatch. |
| Gate runtime layout | `tests/node/gate-runtime/**`, review artifact/reuse tests, timeline/status tests. |
| Lifecycle layout | `tests/node/lifecycle/**`, update/check-update tests, cleanup tests, protected-manifest tests. |
| Validators/materialization/core | `tests/node/validators/**`, `tests/node/materialization/**`, `tests/node/core/**`, plus affected provider/materialization tests. |

Every child task must still finish through the normal orchestrator gates:
compile, required reviews, doc-impact, full-suite when enabled, completion, and
final audit.

## Guardrails

- Preserve CLI command names, flags, exit codes, text output, and JSON output.
- Preserve gate artifact schemas, runtime evidence paths, timeline event names,
  receipt semantics, and review-trust validation.
- Preserve self-hosted update, rollback, protected-manifest, cleanup, and
  materialized workspace behavior.
- Avoid `utils`, `misc`, or `common` directories unless the owner domain is
  specific and stable.
- Prefer small compatibility facades over broad import rewrites only when public
  consumers are uncertain. For proven internal helper paths, migrate consumers
  and delete the old file instead of keeping dead facades.
- Keep generated output directories (`dist/**`, `.node-build/**`, `coverage/**`)
  out of refactor scope; they are validation artifacts, not source ownership.

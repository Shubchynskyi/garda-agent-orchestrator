# Full-Suite Hang And Lock Audit

This audit records the `T-736-6` findings for mandatory full-suite execution on Windows after the sharded runner, duration balancing, build/prep reuse, and performance guidance work.

## Observed Signals

- Recent mandatory runs of `npm run test:sharded` still took about five minutes: `298159ms`, `304497ms`, and `308074ms` for successful runs, with two failed runs recorded at `304117ms` and `339277ms`.
- The duration-history file is rolling and keeps only compact status, duration, timeout, exit code, and command fields. It does not preserve enough failed-run context to explain a prior `fail 0` plus shard exit `1` anomaly after the canonical artifact is overwritten by a later run.
- Current `.node-build/test-shard-logs` contains only the latest successful shard log directories. Failed-run shard logs are not copied into task-scoped runtime evidence, so they are easy to lose when `.node-build` is rebuilt or cleaned.
- The latest successful outer shard logs contain expected nested `NODE_FOUNDATION_TEST_SHARD_DONE ... exit=7` lines from `node-foundation-test-wrapper.test.ts`, where the test intentionally stubs a failing inner shard and asserts aggregate failure. These nested lines are useful coverage, but they make raw log grep misleading unless outer shard boundaries are distinguished from inner fixture output.
- Current live-state inspection found no leftover Node test workers and no generated lock directories at repo root. The earlier leftover-process incident is consistent with an externally killed gate process rather than a currently active leak.

## Root Causes And Bounded Hypotheses

### 1. Shard children have no independent timeout or heartbeat

`scripts/node-foundation/test.ts` starts one `node --test` child per shard and waits on `Promise.all`. If a shard child stops producing output or never emits `close`, the wrapper has no per-shard timeout, heartbeat, last-output timestamp, or explicit kill path. The full-suite gate timeout can still kill the outer command when the gate process remains alive, but the shard wrapper itself cannot explain which shard stopped making progress.

Impact: a real shard hang becomes a generic full-suite timeout, and local operator timeouts can leave little task-scoped evidence.

### 2. Gate-managed timeout and shell-level timeout are different failure modes

`full-suite-validation` writes a run marker before executing the configured command and clears it after it writes the gate artifact. The subprocess layer kills the Windows `cmd.exe` tree on its own timeout, abort, or normal parent termination path.

If the outer tool/session kills the gate process itself, the gate may not reach artifact writing, generated lock cleanup, or marker clearing. That explains the earlier shell-level timeout symptom: leftover marker and process uncertainty can occur even though gate-managed timeout cleanup is implemented.

Impact: `next-step` can detect an interrupted run marker, but the recovery path is still diagnostic rather than a clear safe cleanup/remediation command.

### 3. Failed-run forensics are not durable enough

Successful full-suite output is intentionally omitted, and the latest canonical full-suite artifact is replaced by each run. For failed runs, output is retained in the run artifact, but the compact duration history is not enough after later runs overwrite the task artifact or when the failure was observed only through console output.

The sharded runner writes logs under `.node-build/test-shard-logs/run-<pid>` by default. That is useful while the build root survives, but it is not task-scoped runtime evidence.

Impact: the system can know that `npm run test:sharded` failed with `exit_code=1` but lose the exact failing shard path, parent suite timeout, or last-output line needed for a later audit.

### 4. Lock cleanup is conservative and only runs after gate-managed timeout

Generated lock cleanup after full-suite timeout only removes `.scripts-build.lock`, `.node-build.lock`, or `dist.lock` when an owner PID exists and is proven dead. Missing owner metadata, transient read errors, unknown owner state, or live owners are retained by design.

That is the right safety default, but it means an externally killed full-suite can still leave the operator with a stale lock until the build-root lock timeout, metadata grace period, or stale-age rule resolves it.

Impact: lock safety is stronger than lock UX. A stuck or externally interrupted run needs better diagnostics and a safe operator remediation command, not weaker lock deletion rules.

### 5. The five-minute floor is now concentrated in real test work

The current `T-736` changes made sharding and reuse available, and workflow config now runs `npm run test:sharded` for mandatory full-suite evidence. Recent successful runs are still roughly five minutes because a large amount of real Node test work remains, including integration-heavy gate and lifecycle suites.

`T-736-5` already fixed one concrete suite-level timeout risk by increasing the `full-suite-validation-cli-transaction` test timeout. The remaining bottleneck is not one obvious global wait; it needs targeted slow-suite decomposition and better telemetry retention.

## Follow-Up Tasks

The audit should not be closed by increasing only the global full-suite timeout. The next work should be split so each change has a narrow verification surface:

- `T-736-7`: add per-shard timeout, heartbeat, last-output diagnostics, and child-tree cleanup to the sharded runner.
- `T-736-8`: persist failed shard logs and failure summaries into task-scoped runtime evidence so later audits do not depend on `.node-build`.
- `T-736-9`: make interrupted full-suite run-marker recovery print a safe cleanup/remediation path for externally killed gate processes.
- `T-736-10`: improve generated lock diagnostics around retained locks after timeouts without weakening conservative owner checks.
- `T-736-11`: continue targeted slow-suite decomposition for the suites that still dominate the five-minute wall clock.

## Current Recommendation

Keep `npm run test:sharded` as the mandatory optimized command. It is now the right default, but the remaining work is stability and diagnostics rather than another broad performance switch. The next code changes should make hangs explainable first, then reduce slow suites once the failure evidence is durable.

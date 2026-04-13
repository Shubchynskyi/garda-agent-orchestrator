# Orchestrator Work, Protected Paths, and Isolation Remediation

## Overview

The orchestrator protects its own control-plane files from accidental
modification by task agents. At **preflight** and **completion** gates the
runtime re-scans every protected file, builds a SHA-256 snapshot, and stores
an aggregate snapshot digest for the task so completion can detect tampering
without carrying the full preflight map forward. The current snapshot is also
compared against a trusted manifest. When changes are detected in a task that
was **not** started with `--orchestrator-work`, the completion gate fails
closed.

This document explains the fail-closed behavior, what counts as a protected
path, and how to recover.

---

## The `--orchestrator-work` Flag

Pass `--orchestrator-work` to `enter-task-mode` when the task intentionally
modifies orchestrator control-plane files:

```bash
garda gate enter-task-mode \
  --task-id "T-018" \
  --task-summary "Update agent rules for new review flow" \
  --orchestrator-work
```

**Effect:** The completion gate skips the protected-path drift check for
this task.  All other gates (compile, review, doc-impact) still run
normally.

**When to use it:**

| Scenario | Use `--orchestrator-work`? |
|---|---|
| Editing files under `live/docs/agent-rules/` | Yes |
| Updating orchestrator source (`src/`, `bin/`, `dist/`) | Yes |
| Ordinary application feature work | No |
| Updating `TASK.md`, `README.md`, project docs | No |

> **Rule of thumb:** If the task changes any file listed in the protected
> paths table below, start it with `--orchestrator-work`.

---

## Protected Control-Plane Paths

The runtime hashes all files under these directory roots.  Any change
detected between preflight and completion snapshots triggers enforcement.

### Deployed workspace

| Protected root | Contents |
|---|---|
| `garda-agent-orchestrator/bin/` | CLI launcher |
| `garda-agent-orchestrator/dist/` | Compiled runtime |
| `garda-agent-orchestrator/live/docs/agent-rules/` | Materialized rule files |
| `garda-agent-orchestrator/src/bin/` | Source — bin layer |
| `garda-agent-orchestrator/src/cli/` | Source — CLI layer |
| `garda-agent-orchestrator/src/gates/` | Source — gate implementations |
| `garda-agent-orchestrator/src/gate-runtime/` | Source — gate runtime |
| `garda-agent-orchestrator/src/lifecycle/` | Source — lifecycle commands |
| `garda-agent-orchestrator/src/materialization/` | Source — materialization |
| `.agents/workflows/start-task.md` | Shared start-task router |
| `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `QWEN.md`, `.github/copilot-instructions.md`, `.windsurf/rules/rules.md`, `.junie/guidelines.md`, `.antigravity/rules.md` | Root agent entrypoints |
| `.github/agents/orchestrator.md`, `.windsurf/agents/orchestrator.md`, `.junie/agents/orchestrator.md`, `.antigravity/agents/orchestrator.md` | Provider bridges |
| `.github/agents/*.md` (managed review bridges) | Review skill bridge prompts |

### Source checkout (additional roots)

When the workspace is an orchestrator source checkout the same directories
are also protected at the repository root (`src/bin/`, `src/cli/`, …,
`bin/`, `dist/`, `live/docs/agent-rules/`).

---

## Fail-Closed Behavior

### How enforcement works

1. **Preflight** — the `enter-task-mode` gate snapshots every protected file
   (SHA-256), stores a compact aggregate digest for that snapshot, and reads
   the trusted manifest written by the last `setup`, `update`, or `reinit`.
2. **Completion** — the `completion-gate` re-scans the same files and
   compares the new aggregate digest against the preflight digest, then checks
   the current snapshot against the trusted manifest.
3. If any protected file changed **and** the task was not started with
   `--orchestrator-work`, the gate emits a hard error (in `STRICT` mode) or
   a warning (in `LOG_ONLY` mode).

### Enforcement modes

| Mode | Protected-path drift | Manifest drift |
|---|---|---|
| **`STRICT`** (default when isolation enabled) | Hard error — blocks completion | Hard error — blocks completion |
| **`LOG_ONLY`** | Warning — task may continue | Warning — task may continue |
| **Isolation disabled** | Hard error (always enforced) | Hard error (always enforced) |

> Protected-path enforcement is **always active**, even when the isolation
> sandbox feature is disabled.  The enforcement mode in
> `live/config/isolation-mode.json` only controls whether violations are
> hard errors or logged warnings.

### Error messages you may see

| Message pattern | Cause |
|---|---|
| *"Control-plane files were modified in a non-orchestrator task: …"* | A protected file changed during the task but `--orchestrator-work` was not set. |
| *"Trusted protected control-plane manifest drift detected: …"* | The trusted manifest no longer matches the on-disk files; drift appeared during the task. |
| *"Trusted protected control-plane manifest was already drifted before task start: …"* | The manifest was already out-of-date before the task began. |
| *"Trusted protected control-plane manifest is invalid: …"* | The manifest file is corrupt or has an unrecognized schema. |

---

## Remediation

### 1. Accidental modification of a protected file

You edited a control-plane file in a task that should not have touched it.

**Fix:** Revert the change, then re-run the completion gate:

```bash
git checkout -- garda-agent-orchestrator/live/docs/agent-rules/00-core.md
garda gate completion-gate --task-id "T-xxx"
```

### 2. Intentional orchestrator change without the flag

The task legitimately needs to change control-plane files but was started
without `--orchestrator-work`.

**Fix:** Re-enter task mode with the flag and re-run from preflight:

```bash
garda gate enter-task-mode \
  --task-id "T-xxx" \
  --task-summary "..." \
  --orchestrator-work
# then re-run preflight → implementation → gates as normal
```

### 3. Pre-existing manifest drift

The trusted manifest was already stale before the task started — usually
because a prior `update`, `reinit`, or manual edit did not refresh it.

**Fix:** Refresh the manifest and re-run the failing gate:

```bash
# Any of these regenerates the trusted manifest:
garda setup   --target-root "."
garda update  --target-root "." --init-answers-path "..."
garda reinit  --target-root "." --init-answers-path "..."

# Then retry
garda gate completion-gate --task-id "T-xxx"
```

### 4. Invalid or missing manifest

The manifest file does not exist or is structurally broken.

**Fix:** Same as above — run `setup`, `update`, or `reinit` to regenerate.

### 5. Switching to LOG_ONLY while investigating

If you need to unblock a task quickly while investigating:

```json
// live/config/isolation-mode.json
{
  "enabled": true,
  "enforcement": "LOG_ONLY"
}
```

Drift will be logged as a warning instead of blocking the gate.  Switch
back to `STRICT` once the root cause is resolved.

---

## Quick Diagnostic Commands

```bash
# Check current isolation status and drift
garda gate validate-isolation --repo-root "."

# Full workspace health check
garda doctor --target-root "."

# View task timeline for failure details
garda gate task-events-summary --task-id "T-xxx"
```

---

## Related Docs

- [Branch Protection and CODEOWNERS](branch-protection.md) — PR-time
  governance complement to local protected-path enforcement
- [Control-Plane Isolation Mode](control-plane-isolation.md) — sandbox
  lifecycle, manifest validation, and configuration reference
- [CLI Reference](cli-reference.md) — full gate command surface
- [Configuration](configuration.md) — token economy, output filters,
  review capabilities

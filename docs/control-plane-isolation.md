# Control-Plane Isolation Mode

## Overview

Control-plane isolation mode is an **optional operational hardening** feature
that separates the orchestrator control plane from the task worktree.  When
enabled, agents execute against a **read-only sandbox copy** of the
orchestrator bundle instead of the live runtime bundle, reducing accidental
or unintended mutation of the control plane during task execution.

The isolation mode provides two complementary layers:

1. **Sandbox execution** — a read-only copy of the orchestrator control plane
   (bin, dist, live, template) under `runtime/.isolation-sandbox/`.  Gate
   resolution and rule loading read from this sandbox rather than the live
   bundle.
2. **Manifest drift enforcement** — SHA-256 hash validation of protected
   files at preflight and completion gates.

## Same-User Limitation (Honest Disclosure)

Control-plane isolation is a practical hardening measure, **not a security
boundary**.  An agent running under the same OS user can bypass read-only
file attributes, rewrite ACLs, or replace source files before running gates.

This mode exists to:

- Separate the task worktree from the orchestrator control plane
- Make agents execute against a copied/sandboxed bundle by default
- Detect accidental drift early — before a task reaches completion
- Make unauthorized mutation visible in the task timeline
- Raise the bar for casual bypasses without pretending it's a trust anchor

If an agent **deliberately** modifies the sandbox or live protected files
and re-runs gates on the tampered runtime, isolation mode alone will not
prevent that.  Use separate OS-level sandboxing or CI-hosted gate execution
for stronger guarantees.

## Configuration

The configuration file lives at:

```
garda-agent-orchestrator/live/config/isolation-mode.json
```

Default configuration (isolation disabled):

```json
{
  "enabled": false,
  "enforcement": "LOG_ONLY",
  "require_manifest_match_before_task": true,
  "refuse_on_preflight_drift": true,
  "use_sandbox": true,
  "same_user_limitation_notice": "Control-plane isolation is a practical hardening measure, not a security boundary..."
}
```

### Configuration Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Master switch — set to `true` to activate isolation |
| `enforcement` | `"STRICT"` \| `"LOG_ONLY"` | `"LOG_ONLY"` | In `STRICT` mode, drift violations cause gate failures. In `LOG_ONLY`, drift is logged but does not block. |
| `require_manifest_match_before_task` | boolean | `true` | Refuse task start if trusted manifest is missing, invalid, or drifted |
| `refuse_on_preflight_drift` | boolean | `true` | Treat preflight-time drift as a violation |
| `use_sandbox` | boolean | `true` | When `true`, prepare and use a read-only sandbox copy for gate execution |
| `same_user_limitation_notice` | string | *(see default)* | Honest disclosure text surfaced in isolation evidence |

## How It Works

### Sandbox Lifecycle

1. **Prepare (`gate prepare-isolation`):** Copies control-plane directories
   (`bin/`, `dist/`, `live/`, `template/`, `MANIFEST.md`, `VERSION`,
   `package.json`) from the live orchestrator bundle into
   `runtime/.isolation-sandbox/`.  Excludes `node_modules/` and `runtime/`.
   Marks all copied files **read-only** (`chmod 444`).  Writes a sandbox
   manifest recording SHA-256 hashes of all copied files.

2. **Resolve:** When isolation mode is enabled and a valid sandbox exists,
   `resolveGateExecutionPath()` routes control-plane reads (rules, configs,
   templates, commands) through the sandbox copy.  Mutable runtime paths
   (`runtime/reviews/`, `runtime/task-events/`, `runtime/metrics.jsonl`)
   always resolve against the live bundle.  The isolation-mode config itself
   (`live/config/isolation-mode.json`) also reads from live to avoid circular
   resolution.

   Specific gate call sites that read from the sandbox when active:
   - `getClassificationConfig()` → `live/config/paths.json`
   - `getReviewCapabilities()` → `live/config/review-capabilities.json`
   - `getRulePackRulesRoot()` → `live/docs/agent-rules/`
   - `buildReviewContext()` → `live/docs/agent-rules/` (rule file content)
   - `resolveOutputFiltersPath()` → `live/config/output-filters.json`
   - compile-gate commands → `live/docs/agent-rules/40-commands.md`
   - token economy config → `live/config/token-economy.json`
   - scoped-diff paths config → `live/config/paths.json`
   - skill path resolution → `live/skills/*/SKILL.md`

3. **Validate (`gate validate-isolation`):** Reports sandbox existence,
   manifest validity, drift status, read-only integrity, and whether the
   sandbox is actively being used for gate execution.

4. **Completion gate:** Checks that the sandbox was not tampered with during
   task execution.  In `STRICT` mode, drift triggers a hard failure.

### What the Sandbox Contains

| Directory/File | Included | Reason |
|---|---|---|
| `bin/` | ✅ | CLI launcher |
| `dist/` | ✅ | Compiled runtime |
| `live/` | ✅ | Materialized rules, configs, docs |
| `template/` | ✅ | Template configs and rules |
| `MANIFEST.md` | ✅ | Bundle identity |
| `VERSION` | ✅ | Version marker |
| `package.json` | ✅ | Package metadata |
| `node_modules/` | ❌ | Too large, not control plane |
| `runtime/` | ❌ | Mutable state (events, reviews, metrics) |

### Mutable State Stays Live

Runtime state — task events, review artifacts, metrics — remains in the
live `runtime/` directory.  The sandbox is a **read-only control plane**,
not a full workspace fork.  This means:

- Task timeline events write to the real `runtime/task-events/`
- Review artifacts write to the real `runtime/reviews/`
- The sandbox only contains the immutable control-plane surface

### Gate Execution Flow (`resolveGateExecutionPath`)

```
    ┌───────────────────────────────────┐
    │  Is path a control-plane read?    │
    │  (live/, bin/, dist/, template/)  │
    │  No → Live bundle (always)        │
    └───────────────────────────────────┘
                     │ yes
                     ▼
    ┌───────────────────────────────────┐
    │  Isolation enabled?               │
    │  No → Live bundle root            │
    └───────────────────────────────────┘
                     │ enabled=true
                     ▼
    ┌───────────────────────────────────┐
    │  Valid sandbox exists?            │
    │  No → Live fallback               │
    └───────────────────────────────────┘
                     │ yes
                     ▼
    ┌───────────────────────────────────┐
    │  Use sandbox for this read        │
    └───────────────────────────────────┘
```

### Path Routing Summary

| Path prefix | When isolation active | Reason |
|---|---|---|
| `live/config/*` (except isolation-mode.json) | Sandbox | Gate input configs |
| `live/docs/agent-rules/*` | Sandbox | Rule files read by gates |
| `live/skills/*` | Sandbox | Skill definitions |
| `bin/`, `dist/` | Sandbox | CLI and compiled runtime |
| `template/` | Sandbox | Template files |
| `MANIFEST.md`, `VERSION`, `package.json` | Sandbox | Bundle identity |
| `live/config/isolation-mode.json` | **Live** | Meta-config (avoids circular reference) |
| `runtime/reviews/*` | **Live** | Mutable review artifacts |
| `runtime/task-events/*` | **Live** | Mutable task timelines |
| `runtime/metrics.jsonl` | **Live** | Mutable telemetry |
| `runtime/init-answers.json` | **Live** | Mutable init state |

### Orchestrator-Work Tasks

Tasks started with `--orchestrator-work` are exempt from isolation
enforcement.  This allows legitimate orchestrator maintenance tasks to
modify protected files and the live bundle without triggering violations.

For the full list of protected paths, fail-closed error messages, and
step-by-step remediation when gates block execution, see
[Orchestrator Work, Protected Paths, and Isolation Remediation](orchestrator-work-and-isolation.md).

## CLI Gates

### Prepare Isolation Sandbox

```bash
node bin/garda.js gate prepare-isolation --repo-root "." [--task-id "T-xxx"]
```

Creates or refreshes the sandbox.  Run after `setup`, `update`, or `reinit`.
Emits `ISOLATION_SANDBOX_PREPARED` timeline event when `--task-id` is given.

### Validate Isolation

```bash
node bin/garda.js gate validate-isolation --repo-root "." [--task-id "T-xxx"]
```

Reports full isolation status including sandbox state:

- `ISOLATION_MODE_ENABLED` or `ISOLATION_MODE_DISABLED`
- Enforcement level
- Manifest status (MISSING / INVALID / MATCH / DRIFT)
- Sandbox: exists, manifest valid, file count, read-only intact, drift
- Whether the sandbox is currently being used for gate resolution
- Same-user limitation notice

### Task Timeline Events

| Event | Description |
|---|---|
| `ISOLATION_SANDBOX_PREPARED` | Sandbox created or refreshed |
| `ISOLATION_MODE_VALIDATED` | Isolation checked (enabled) |
| `ISOLATION_MODE_SKIPPED` | Isolation checked (disabled) |

## Enabling Isolation Mode

1. Edit `garda-agent-orchestrator/live/config/isolation-mode.json`:

```json
{
  "enabled": true,
  "enforcement": "STRICT",
  "use_sandbox": true
}
```

2. Ensure a trusted manifest exists (run `setup`, `update`, or `reinit`)

3. Prepare the sandbox:

```bash
node bin/garda.js gate prepare-isolation --repo-root "."
```

4. Run tasks normally — isolation checks are automatic at preflight and
   completion.  Gate resolution reads from the sandbox.

## Recommended Workflows

### Development (LOG_ONLY)

During active development of the orchestrator itself, use `LOG_ONLY`
enforcement to see drift warnings without blocking:

```json
{ "enabled": true, "enforcement": "LOG_ONLY", "use_sandbox": true }
```

### Production Workspaces (STRICT)

For deployed workspaces where the orchestrator should not be modified by
task agents:

```json
{ "enabled": true, "enforcement": "STRICT", "use_sandbox": true }
```

### Without Sandbox (Validation Only)

To use only manifest drift validation without a sandbox copy:

```json
{ "enabled": true, "enforcement": "STRICT", "use_sandbox": false }
```

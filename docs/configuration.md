# Configuration

All configuration files live in `garda-agent-orchestrator/live/config/`.

The root manifest `garda.config.json` references the managed config files validated by the orchestrator and can be checked with:

```bash
node bin/garda.js gate validate-config
```

## Config Files Overview

| File | Purpose | Editable? |
|---|---|---|
| `garda.config.json` | Root config manifest referencing the 11 managed config files validated by `validate-config` | No, maintained by orchestrator |
| `token-economy.json` | Reviewer-context compaction and token savings | Yes |
| `output-filters.json` | Gate output compaction profiles (compile, test, lint, review) | Yes |
| `review-capabilities.json` | Which specialist reviews are enabled | Yes |
| `paths.json` | Preflight classification roots and trigger regexes | Yes |
| `skill-packs.json` | Installed built-in domain packs | Yes, through `garda skills add/remove` |
| `optional-skill-selection-policy.json` | Repo-local policy for preprompt-time optional skill selection (`off`, `advisory`, `required`, `strict`) | Yes |
| `isolation-mode.json` | Control-plane isolation and sandbox settings | Yes |
| `profiles.json` | Active profile selection plus built-in and user profile definitions | Yes, through `garda profile ...` |
| `review-artifact-storage.json` | Review artifact retention and storage policy | Yes, through `garda cleanup policy ...` |
| `runtime-retention.json` | Tiered runtime-retention policy for active evidence, healthy `DONE` ledger compaction, problem-task compression, confirm-only purge, and daily maintenance | Yes, through template/config review for now; `garda cleanup policy` shows it read-only |
| `workflow-config.json` | Compile-gate, full-suite, optional-check, and workflow command settings | Yes, through `garda workflow ...` and guarded UI settings |
| `skills-index.json` | Compact optional-skill discovery index; generated runtime index and not part of `garda.config.json` | No, generated from pack manifests |
| `skills-headlines.json` | Compact task-start optional-skill selection surface with installed skill headlines and pack summaries | No, generated from live skill/pack manifests |

`garda.config.json` is rewritten from the bundled template during init/reinit/update, so stale local edits do not become the long-term source of truth.
The editable live configs above are merged forward during init/reinit/update: existing live values are preserved and missing template keys are filled in.

## Validation

### CLI Gate

```bash
# Full output
node bin/garda.js gate validate-config --bundle-root garda-agent-orchestrator

# Compact (CI-friendly)
node bin/garda.js gate validate-config --compact
```

Validates the managed config files referenced by `garda.config.json` against portable JSON Schemas and runtime validators.
Exits non-zero on validation failure.

### CI Script

```bash
node scripts/validate-config.cjs
```

### JSON Schemas

Portable JSON Schema definitions (draft-07) are available for each managed config file
in `src/schemas/config-schemas.ts`. Each schema can be serialized to a `.json`
file for use with external validators, IDE autocomplete, or CI linters.

## Token Economy

Controls reviewer-context compaction and determines how aggressively context is trimmed at different task depths.

**File:** `live/config/token-economy.json`

```json
{
  "enabled": true,
  "enabled_depths": [1, 2],
  "strip_examples": true,
  "strip_code_blocks": true,
  "scoped_diffs": true,
  "compact_reviewer_output": true,
  "fail_tail_lines": 50
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master toggle for reviewer-context token economy |
| `enabled_depths` | `[1, 2]` | Depths at which context compaction applies |
| `strip_examples` | `true` | Remove verbose examples from rule context |
| `strip_code_blocks` | `true` | Compress code-block sections in rules |
| `scoped_diffs` | `true` | Use scoped diff instead of full diff |
| `compact_reviewer_output` | `true` | Apply output-filter profiles to gate output |
| `fail_tail_lines` | `50` | Max lines of compile failure output |

### Depth Behavior

| Depth | Context Scope | Token Economy | Typical Use |
|---|---|---|---|
| `1` | Minimal (core + workflow + touched module) | Full compaction | Small, low-risk, localized tasks |
| `2` | Standard (most rule files + module context) | Full compaction | Default for most tasks |
| `3` | Complete (all rules + cross-module checks) | Gate filtering only | High-risk, cross-cutting changes |

### What Stays Active Regardless of Token Economy

Shared gate output filtering (`output-filters.json`) and `fail_tail_lines` remain active even when `enabled=false` or at `depth=3`. These are independent of reviewer-context scope.

## Output Filters

Controls how gate scripts compress their stdout/stderr output before returning to the agent.

**File:** `live/config/output-filters.json`

Contains profiles for:
- **Compile success/failure** — per build tool (npm, gradle, maven, dotnet, cargo, go, tsc, generic)
- **Test success/failure** — generic test runner patterns
- **Lint success/failure** — generic lint patterns
- **Review gate success/failure** — gate verdict formatting

### Key Mechanisms

| Mechanism | Description |
|---|---|
| `drop_lines_matching` | Regex patterns; matching lines are removed |
| `keep_lines_matching` | Regex patterns; only matching lines are kept |
| `strip_ansi` | Remove ANSI color/control codes |
| `truncate_line_length` | Max characters per line (default: 240) |
| `parser.max_matches` | Max error/warning matches to keep |
| `parser.tail` | Lines from end of output to always include |
| `passthrough_ceiling` | Below this line count, output passes through unfiltered |

Success profiles typically use `drop_lines_matching: ".*"` to drop 100% of output on green builds.

## Runtime Retention

Controls how Garda-owned runtime artifacts are classified for cleanup and GC.

**File:** `live/config/runtime-retention.json`

```json
{
  "version": 1,
  "active_tasks": {
    "protect_runtime_grace_days": 7,
    "protect_current_cycle_artifacts": true
  },
  "healthy_done": {
    "compact_after_days": 30,
    "require_ledger": true,
    "retain_task_events_until_ledger_verified": true
  },
  "problem_tasks": {
    "compress_after_days": 30,
    "preserve_detailed_evidence": true
  },
  "purge": {
    "require_confirm": true
  },
  "daily_maintenance": {
    "enabled": true,
    "max_tasks_per_run": 25,
    "dry_run": true
  }
}
```

| Tier | Meaning |
|---|---|
| `active_evidence` | Current or protected task artifacts stay readable. |
| `compact_ledger_candidate` | Healthy `DONE` task artifacts may compact to `runtime/task-ledger/<task-id>.json` history only after verified ledger evidence exists. |
| `compressed_forensic_candidate` | Blocked, failed, incomplete, tampered, or ambiguous tasks keep recovery-readable evidence; only heavy forensic artifacts are compression candidates. |
| confirm-only purge | Full deletion requires an explicit confirmed cleanup/GC action; purge is not automatic. |

Clean-success compile and full-suite raw output logs may be intentionally omitted by the gates. Retained evidence still records status, duration, hashes, and line/char counts; warning, failure, timeout, and non-clean runs retain raw output.

## Review Capabilities

Controls which specialist reviews are enabled for the project.

**File:** `live/config/review-capabilities.json`

```json
{
  "code": true,
  "db": true,
  "security": true,
  "refactor": true,
  "api": true,
  "test": true,
  "performance": true,
  "infra": true,
  "dependency": true
}
```

Each top-level key toggles whether that review type may be required by preflight in this workspace.

Manage supported optional capability toggles through the CLI:
- `garda review-capabilities`
- `garda review-capabilities list`
- `garda review-capabilities enable <api|test|performance|infra|dependency>`
- `garda review-capabilities disable <api|test|performance|infra|dependency>`

The CLI validates that a matching live review skill is installed before enabling a supported optional capability. Bridge presence is surfaced separately for bridge-hosted providers, but root-entrypoint providers execute the live skill directly.

`skills-index.json` is still a generated runtime index under `live/config/`, but it is **not** part of `garda.config.json` and is **not** validated by `gate validate-config`.

## Skill Packs

Tracks which built-in domain packs are currently installed in the workspace.

**File:** `live/config/skill-packs.json`

Manage it through the CLI:
- `garda skills list`
- `garda skills add <pack-id>`
- `garda skills remove <pack-id>`
- `garda skills validate`

This file is runtime state and should normally be changed through the CLI rather than by hand.

Packs are install/discovery bundles for optional specialist skills.
They are not a second copy of baseline skills; baseline skills stay available without any pack install.

## Optional Skill Selection Policy

Controls whether `preprompt` and the task-start lifecycle derive and validate a cheap optional-skill decision from `skills-headlines.json` before implementation begins.

**File:** `live/config/optional-skill-selection-policy.json`

```json
{
  "version": 1,
  "mode": "advisory"
}
```

Modes:
- `off` disables task-start optional-skill selection.
- `advisory` computes a read-mostly selection artifact and compact preview without blocking the task.
- `required` expects a materialized, internally valid selection artifact for the current task cycle before implementation proceeds. `preprompt task` exits non-zero for that start-time blocker, and `compile-gate` or downstream review gates also refuse the current cycle when the artifact is missing or drifted.
- `strict` keeps `required` behavior and also requires explicit canonical fallback reasons whenever no optional skill is selected.

## Optional Quality Checks

Controls the advisory self-checklist gate that runs after implementation changes exist and before expensive validation gates.

**File:** `live/config/workflow-config.json`

```json
{
  "optional_quality_checks": {
    "enabled": true,
    "baseline_version": "2026-06-26.t843",
    "rules": [
      {
        "id": "code_simplification",
        "title": "Code simplification",
        "prompt": "Check whether the changed code can be simplified without weakening behavior, validation, or diagnostics.",
        "enabled": true
      }
    ]
  }
}
```

Contract:
- the mode is default-enabled when the setting is absent;
- the shipped baseline version records which default rule set was materialized;
- default rules cover simplification, project style fit, unnecessary abstraction, class/function/file growth, hardcoded values or contracts, duplicated logic or contracts, and test/verification scope;
- the current shipped baseline also includes generic checks for classifier intent edge cases, config materialization parity, control-plane action safety, artifact evidence binding, and gate-routing self-regression;
- `next-step` routes the gate after implementation and before compile, delegated review, or full-suite work when a current changed-file preflight needs checklist evidence;
- `PASS` continues the normal lifecycle, while `ACTION_REQUIRED` sends the agent back to implementation before the expensive gates run;
- disabled mode skips only the quality-checklist gate and does not replace or weaken compile-gate, full-suite validation, or independent review;
- baseline rule ids, titles, prompts, and deletion are managed by the shipped baseline; users can only toggle each baseline rule's `enabled` state;
- custom rules, disabled mode, custom rule edits, and local audit metadata fields are preserved during init/update/materialization refresh;
- update/setup refreshes shipped baseline text, adds missing shipped baseline rules, removes deprecated shipped baseline rules, and preserves each baseline rule's enabled or disabled state.

Manage the toggle and rules through the audited workflow-setting path:

```bash
node bin/garda.js workflow set --optional-checks on --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
node bin/garda.js workflow set --optional-check-rule-id custom_focus --optional-check-rule-title "Custom focus" --optional-check-rule-prompt "Check the custom concern." --optional-check-rule-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
node bin/garda.js workflow set --optional-check-rule-delete custom_focus --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
```

`garda ui --actions` exposes the same toggle and add/edit/delete controls in the workflow settings panel. The browser never writes `workflow-config.json` directly; it previews and runs the allow-listed `garda workflow set` commands with the normal typed confirmation and audit log.
Baseline rows in the UI expose only the enabled toggle; title, prompt, and delete controls are reserved for custom rules.

## Skills Index

Compact discovery metadata for optional skills.

**File:** `live/config/skills-index.json`

Used by:
- `garda skills suggest`
- the agent-init specialist-skills recommendation flow

Contract:
- this index is the discovery surface for pack suggestion and agent-init-time specialist recommendations;
- after the user selects a pack, installation should only materialize files into `live/skills/**` and must not require reading the full optional `SKILL.md`;
- full optional `SKILL.md` files must stay unopened until a selected skill is actually activated for a task or a hard activation rule requires it;
- the index is generated from pack manifests and should not be edited manually in deployed workspaces.

## Skills Headlines

Compact task-start selection metadata for already installed optional skills and available pack headlines.

**File:** `live/config/skills-headlines.json`

Used by:
- `garda preprompt task`
- task-start optional-skill selection before implementation

Contract:
- this file is the cheap surface for current-task optional-skill selection once task text and planned scope are known;
- it should be read before opening any optional `SKILL.md`;
- full optional `SKILL.md` files are opened only for skills that were actually selected for the current task;
- the file is generated from live skills and pack manifests and should not be edited manually in deployed workspaces.

## Paths Configuration

Controls preflight classification roots and regex triggers for each review type.

**File:** `live/config/paths.json`

Defines:
- **Root directories** for source code classification.
- **Trigger patterns** (regexes) that map file paths to required review types.
- **Sensitive path markers** for security, auth, payment, database, migration, and infrastructure paths.

## Compact Command Hints

Agent rules in `live/docs/agent-rules/40-commands.md` include a **Compact Command Hints** section that teaches agents to use efficient CLI flags. This reduces token consumption on everyday shell commands without any infrastructure changes.

See `template/docs/agent-rules/40-commands.md` section `## Compact Command Hints` for the full reference.

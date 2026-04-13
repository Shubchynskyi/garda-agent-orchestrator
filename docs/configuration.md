# Configuration

All configuration files live in `garda-agent-orchestrator/live/config/`.

The root manifest `garda.config.json` references the eight managed config files validated by the orchestrator and can be checked with:

```bash
node bin/garda.js gate validate-config
```

## Config Files Overview

| File | Purpose | Editable? |
|---|---|---|
| `garda.config.json` | Root config manifest referencing the eight managed config files validated by `validate-config` | No, maintained by orchestrator |
| `token-economy.json` | Reviewer-context compaction and token savings | Yes |
| `output-filters.json` | Gate output compaction profiles (compile, test, lint, review) | Yes |
| `review-capabilities.json` | Which specialist reviews are enabled | Yes |
| `paths.json` | Preflight classification roots and trigger regexes | Yes |
| `skill-packs.json` | Installed built-in domain packs | Yes, through `garda skills add/remove` |
| `isolation-mode.json` | Control-plane isolation and sandbox settings | Yes |
| `profiles.json` | Active profile selection plus built-in and user profile definitions | Yes, through `garda profile ...` |
| `review-artifact-storage.json` | Review artifact retention and storage policy | Yes, through `garda cleanup policy ...` |
| `skills-index.json` | Compact optional-skill discovery index; generated runtime index and not part of `garda.config.json` | No, generated from pack manifests |

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

Validates the eight managed config files referenced by `garda.config.json` against portable JSON Schemas and runtime validators.
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

## Skills Index

Compact discovery metadata for optional skills.

**File:** `live/config/skills-index.json`

Used by:
- `garda skills suggest`
- the agent-init specialist-skills recommendation flow

Contract:
- this index is the only file that should be read for first-pass optional-skill discovery;
- after the user selects a pack, installation should only materialize files into `live/skills/**` and must not require reading the full optional `SKILL.md`;
- full optional `SKILL.md` files must stay unopened until a selected skill is actually activated for a task or a hard activation rule requires it;
- the index is generated from pack manifests and should not be edited manually in deployed workspaces.

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

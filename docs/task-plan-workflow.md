# Task Plan Workflow

## Overview

The Garda orchestrator supports an optional **planner/executor split** where a stronger reasoning model authors a structured plan and a cheaper model executes it. The workflow is fully opt-in: when no plan artifact is present, task execution continues exactly as it does today (freeform mode).

This pattern is sometimes called **expensive-planner + cheap-executor**. The idea is to front-load the hard reasoning (scope analysis, risk assessment, step ordering) into a single planning pass, then let a cost-efficient model carry out the plan under the orchestrator's existing gate infrastructure.

## When to Use a Plan

| Scenario | Recommendation |
|---|---|
| Small docs-only or config change | Skip the plan — freeform execution is fine |
| Single-file bug fix with clear scope | Skip the plan — overhead outweighs benefit |
| Multi-file feature with dependencies | Author a plan — the executor stays on track |
| Cross-cutting refactor or migration | Author a plan — drift detection catches scope creep |
| High-risk security or data change | Author a plan at depth ≥ 2 — reviewers see the plan context |

## Artifact Schema

A task plan is a JSON file stored at:

```
<bundle>/runtime/reviews/<task-id>-task-plan.json
```

Required fields:

| Field | Type | Description |
|---|---|---|
| `schema_version` | integer | Schema version (currently `1`) |
| `task_id` | string | Task identifier (e.g. `T-048`) |
| `status` | enum | `draft`, `approved`, or `superseded` |
| `goal` | string | High-level goal the plan addresses |
| `scope_files` | string[] | Files the plan expects to create or modify |
| `risk_level` | enum | `low`, `medium`, or `high` |
| `steps` | array | Ordered execution steps (each with `id` and `title`) |

Optional fields: `validation_strategy`, `notes`, `created_by`, `created_at`, `plan_sha256`.

### Example Plan

```json
{
  "schema_version": 1,
  "task_id": "T-048",
  "status": "approved",
  "goal": "Add task-plan artifact schema and validator",
  "scope_files": [
    "src/schemas/task-plan.ts",
    "tests/node/schemas/task-plan.test.ts",
    "CHANGELOG.md"
  ],
  "risk_level": "low",
  "steps": [
    {
      "id": "define-schema",
      "title": "Define JSON Schema and TypeScript interfaces",
      "files": ["src/schemas/task-plan.ts"]
    },
    {
      "id": "add-validator",
      "title": "Add runtime validator with referential integrity checks",
      "files": ["src/schemas/task-plan.ts"],
      "depends_on": ["define-schema"]
    },
    {
      "id": "add-tests",
      "title": "Add unit tests for schema validation and edge cases",
      "files": ["tests/node/schemas/task-plan.test.ts"],
      "depends_on": ["add-validator"]
    },
    {
      "id": "update-changelog",
      "title": "Document the new artifact in CHANGELOG.md",
      "files": ["CHANGELOG.md"],
      "depends_on": ["add-tests"]
    }
  ],
  "validation_strategy": {
    "approach": "Run npm test and verify all task-plan tests pass",
    "commands": ["npm test"]
  },
  "created_by": "planner:claude-opus",
  "created_at": "2026-04-09T10:00:00Z"
}
```

## Workflow: Authoring a Plan

1. **Choose a planner model.** Use a stronger reasoning model (e.g. Claude Opus, GPT-5, o3) for the planning pass. The planner needs to understand the codebase well enough to enumerate scope files and order steps correctly.

2. **Create the plan artifact.** The planner writes a JSON file conforming to the task-plan schema. Place it at `<bundle>/runtime/reviews/<task-id>-task-plan.json`.

3. **Set status to `approved`.** Only `approved` plans are treated as guidance by the executor. A `draft` plan is ignored during gate checks; a `superseded` plan indicates a replaced version.

4. **Validate the plan.** The `validateTaskPlan()` function enforces:
   - Required fields and types.
   - `scope_files` has at least one entry.
   - `steps` has at least one entry.
   - Step `id` values are unique within the plan.
   - `depends_on` references point to existing step ids.

5. **Compute the digest.** Call `serializeTaskPlan()` to automatically embed `plan_sha256` — a SHA-256 digest of the canonical plan content (excluding the digest field itself). This digest is used for downstream integrity checks.

## Workflow: Executing a Plan

The executor model (e.g. Claude Haiku, GPT-4.1, a cheaper tier) follows the standard orchestrator lifecycle with one addition: it passes `--plan-path` at task-mode entry.

### Gate Integration

```
enter-task-mode --task-id "T-048" --plan-path "<bundle>/runtime/reviews/T-048-task-plan.json" ...
```

When `--plan-path` is supplied:
- The gate validates the plan artifact (approved status, matching `task_id`, SHA-256 integrity).
- Plan metadata (`plan_path`, `plan_sha256`, `plan_summary`) is embedded in the task-mode artifact.
- The `TASK_MODE_ENTERED` timeline event records `plan_guided: true`.
- Downstream gates (`build-review-context`, `completion-gate`) propagate plan metadata so reviewers can see whether the task is plan-guided or freeform.

### Compile Gate and Drift Detection

At compile-gate time, the orchestrator compares actual changed files against the plan's `scope_files`:

| Outcome | Status | Gate result |
|---|---|---|
| All changed files are within `scope_files` | `NO_DRIFT` | Gate passes |
| Extra files outside plan scope, no override | `REPLAN_REQUIRED` | Gate blocks |
| Extra files outside plan scope, override accepted | `PLAN_DRIFT` | Gate passes with recorded violation |
| No plan attached | `NO_PLAN` | Gate passes (freeform behavior) |

**Override syntax:**

```bash
node bin/garda.js gate compile-gate \
  --task-id "T-048" \
  --commands-path "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md" \
  --allow-plan-drift \
  --allow-plan-drift-reason "Added missing test helper that was not anticipated in the plan"
```

The override reason must be at least 12 characters. Drift overrides are recorded in compile-gate evidence under `plan_drift`.

### Reviewer Visibility

When `build-review-context` runs for each required review, it reads plan metadata from the task-mode evidence and surfaces:

- `plan.plan_guided` — whether a plan is attached.
- `plan.plan_path` — path to the plan artifact.
- `plan.plan_sha256` — digest for integrity verification.
- `plan.plan_summary` — goal summary from the plan.

Reviewers can use this context to evaluate whether the implementation matches the planned scope.

### Completion Gate

The completion gate surfaces the same plan evidence:

```
PlanGuided: true
PlanPath: garda-agent-orchestrator/runtime/reviews/T-048-task-plan.json
```

## Fallback: No Plan Present

When no `--plan-path` is passed to `enter-task-mode`:

- `plan_guided` is `false` everywhere.
- `plan` fields are `null` in all artifacts.
- Drift detection returns `NO_PLAN` and imposes no constraints.
- The full orchestrator lifecycle (preflight, compile gate, reviews, completion) runs identically to the pre-plan behavior.

No configuration changes are needed to use freeform mode — it is the default.

## Lifecycle Summary

```
┌─────────────────────────────────────────────────────┐
│  Planner (expensive model)                          │
│                                                     │
│  1. Analyze task from TASK.md                       │
│  2. Enumerate scope_files and steps                 │
│  3. Write <task-id>-task-plan.json (status=approved) │
│  4. Compute plan_sha256 via serializeTaskPlan()     │
└──────────────────────┬──────────────────────────────┘
                       │ plan artifact on disk
                       ▼
┌─────────────────────────────────────────────────────┐
│  Executor (cheap model)                             │
│                                                     │
│  1. enter-task-mode --plan-path <plan>              │
│  2. classify-change (preflight)                     │
│  3. Implement following plan steps in order         │
│  4. compile-gate → drift detection against plan     │
│     • NO_DRIFT → pass                              │
│     • REPLAN_REQUIRED → stop, request new plan     │
│     • PLAN_DRIFT + override → pass with violation  │
│  5. Reviews (plan metadata visible to reviewers)    │
│  6. completion-gate (plan evidence in output)       │
└─────────────────────────────────────────────────────┘
```

## Plan Statuses

| Status | Meaning |
|---|---|
| `draft` | Plan is being authored; not enforced by gates |
| `approved` | Plan is active; executor should follow it; drift detection is enabled |
| `superseded` | Plan has been replaced by a newer version; treated as inactive |

## Replanning

When drift detection returns `REPLAN_REQUIRED`:

1. The executor stops implementation and reports the drift (extra files outside `scope_files`).
2. The planner (or a human operator) reviews the situation.
3. Options:
   - **Replan**: Author a new plan with expanded `scope_files`, set the old plan to `superseded`, and restart execution with the new plan.
   - **Override**: Re-run the compile gate with `--allow-plan-drift --allow-plan-drift-reason "<justification>"` if the scope expansion is justified but a full replan is unnecessary.
   - **Abort**: Mark the task as `BLOCKED` if the scope expansion indicates a fundamental misunderstanding.

## Step Dependencies

Plan steps support `depends_on` references to express ordering constraints:

```json
{
  "id": "add-tests",
  "title": "Add unit tests",
  "depends_on": ["add-validator"]
}
```

The validator enforces referential integrity: every `depends_on` entry must reference an existing step `id` within the same plan. The executor should respect dependency ordering when implementing steps.

## Validation Strategy

The optional `validation_strategy` field tells the executor how to verify the implementation:

```json
{
  "validation_strategy": {
    "approach": "Run the full test suite and verify no regressions",
    "commands": ["npm test", "npm run typecheck"]
  }
}
```

This is advisory — the compile gate and mandatory test execution are still enforced by the orchestrator regardless of what the plan says.

## Security Considerations

- Plan artifacts live under `runtime/reviews/` which is gitignored by default. They are local orchestration control-plane files.
- The `plan_sha256` digest provides tamper detection but is not a security-grade trust anchor (see `docs/threat-model.md`).
- Plan artifacts should not contain secrets or credentials.
- The planner model must have sufficient context to produce accurate `scope_files`; an incomplete scope leads to avoidable `REPLAN_REQUIRED` blocks.

## Related

- [Architecture](architecture.md) — overall orchestrator design.
- [Work Example](work-example.md) — end-to-end task execution walkthrough.
- [Configuration](configuration.md) — orchestrator config reference.
- [Threat Model](threat-model.md) — trust surfaces and mitigations.

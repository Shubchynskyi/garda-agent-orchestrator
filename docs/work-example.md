# Work Example

## Creating Tasks

User asks:
> Create a task in TASK.md for feature "Invoice CSV export with email delivery".

Agent splits it into subtasks in `TASK.md`:

| ID | Status | Priority | Area | Title | Profile | Notes |
|---|---|---|---|---|---|---|
| T-201 | 🟦 TODO | P1 | backend | Add invoice CSV export API and service | strict | Requires runtime + API review path |
| T-202 | 🟦 TODO | P1 | worker | Add async email delivery job for exported CSV | strict | Requires security review for outbound attachment flow |
| T-203 | 🟦 TODO | P2 | docs | Update docs/changelog and user-facing usage notes | default | Depends on T-201 and T-202 |

## Executing a Task

User asks:
> Execute task T-201 depth=3

### Agent Lifecycle

```
 1. Read task + rules          → PLAN_CREATED
 2. Classify changes           → PREFLIGHT_CLASSIFIED (FULL_PATH, reviews: code, api)
 3. Implement code + tests     → (working...)
 4. Run compile gate           → COMPILE_GATE_PASSED ✅
 5. Launch code review         → reviewer spawned with clean context
 6. Launch API review          → reviewer spawned with clean context
 7. Review gate check          → REVIEW_GATE_FAILED ❌ (findings found)
 8. Rework code                → REWORK_STARTED
 9. Re-run compile gate        → COMPILE_GATE_PASSED ✅
10. Re-run reviews             → REVIEW_GATE_PASSED ✅
11. Doc impact gate            → DOC_IMPACT_ASSESSED ✅
12. Completion gate            → COMPLETION_GATE_PASSED ✅
13. Mark DONE                  → TASK_DONE + summary + commit suggestion
```

### Task Timeline

```bash
node garda-agent-orchestrator/bin/garda.js gate task-events-summary --task-id "T-201"
```

Example output:
```
Task: T-201
Events: 10
Timeline:
[01] 2026-03-18T10:00:00Z | PLAN_CREATED              | INFO | actor=orchestrator
[02] 2026-03-18T10:01:00Z | PREFLIGHT_CLASSIFIED      | INFO
[03] 2026-03-18T10:15:00Z | COMPILE_GATE_PASSED       | PASS
[04] 2026-03-18T10:16:00Z | REVIEW_PHASE_STARTED      | INFO
[05] 2026-03-18T10:17:00Z | REVIEW_REQUESTED          | INFO | actor=code-review
[06] 2026-03-18T10:25:00Z | REVIEW_GATE_FAILED        | FAIL
[07] 2026-03-18T10:26:00Z | REWORK_STARTED            | INFO
[08] 2026-03-18T10:40:00Z | REVIEW_GATE_PASSED        | PASS
[09] 2026-03-18T10:41:00Z | COMPLETION_GATE_PASSED    | PASS
[10] 2026-03-18T10:42:00Z | TASK_DONE                 | PASS
IntegrityStatus: VALID
```

### Depth Selection Guide

Depth is derived at runtime from the active profile.
The `TASK.md` `Profile` column controls which profile applies per task (`default` inherits the workspace active profile; explicit profile names override it).

| Depth | Use When | Reviews | Context Loaded |
|---|---|---|---|
| `depth=1` | Small, localized, low-risk changes | Minimal required | core + workflow only |
| `depth=2` | Most tasks (default) | Standard required | Most rule files |
| `depth=3` | High-risk, cross-module, security-sensitive | All required + specialists | Full rule set |

### Running a Task

```
Execute task T-001
Execute task T-001 depth=1
Execute task T-001 depth=2
Execute task T-001 depth=3
```

### Adding Specialist Skills

After init, ask your agent:
- `Show which baseline skills are already available`
- `Suggest optional packs for this task`
- `Add the java-spring pack`
- `Add the docs-process pack`

For built-in packs, the agent should use `garda skills list` / `garda skills suggest` first, then install only the selected optional packs.
For custom project-specific skills, the agent uses `live/skills/skill-builder/SKILL.md` to create specialist skill files (`skill.json` + `SKILL.md`), wire triggers, and enable capabilities.

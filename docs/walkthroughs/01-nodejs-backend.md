# Walkthrough: Node.js Backend

A typical Express/Fastify API project with npm, Jest tests, and a 2–5 person team using GitHub Copilot and Claude.

---

## Before: Project Structure

```
invoice-api/
├── src/
│   ├── routes/
│   │   ├── invoices.ts
│   │   └── users.ts
│   ├── services/
│   │   └── invoice-service.ts
│   ├── middleware/
│   │   └── auth.ts
│   └── app.ts
├── tests/
│   └── invoices.test.ts
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md
```

No agent configuration exists yet.

---

## Install

### Step 1: Run Setup

```shell
cd invoice-api
garda setup
```

The CLI asks 6 questions interactively:

| # | Question | Example Answer |
|---|---|---|
| 1 | Assistant response language | `English` |
| 2 | Default response brevity | `concise` |
| 3 | Source-of-truth entrypoint | `Claude` |
| 4 | Hard no-auto-commit guard | `yes` |
| 5 | Claude full access to orchestrator | `yes` |
| 6 | Token economy enabled | `yes` |

Answers are saved to `garda-agent-orchestrator/runtime/init-answers.json`.

### Step 2: Agent Initialization

Open your coding agent (e.g. Claude Code) and provide:

```
garda-agent-orchestrator/AGENT_INIT_PROMPT.md
```

The agent:
1. Reads `runtime/init-answers.json` (no repeated questions).
2. Asks which entrypoint files you actively use → you answer `CLAUDE.md, .github/copilot-instructions.md`.
3. Runs install and materializes `live/`.
4. Fills project context from `live/project-discovery.md`.
5. Runs `garda agent-init` (hard gate).
6. Asks the code-style policy question and records your answer in `30-code-style.md`.
7. Suggests optional skill packs — you add `node-backend`.

```shell
garda skills add node-backend --target-root "."
```

---

## After: Project Structure

```
invoice-api/
├── src/                              # ← unchanged
├── tests/                            # ← unchanged
├── garda-agent-orchestrator/       # ← new: orchestrator bundle
│   ├── bin/garda.js
│   ├── live/
│   │   ├── config/
│   │   │   ├── paths.json
│   │   │   ├── review-capabilities.json
│   │   │   ├── token-economy.json
│   │   │   ├── output-filters.json
│   │   │   ├── skill-packs.json
│   │   │   └── skills-index.json
│   │   ├── docs/
│   │   │   ├── agent-rules/          # 00-core … 90-skill-catalog
│   │   │   └── project-memory/
│   │   │       ├── context.md
│   │   │       ├── architecture.md
│   │   │       ├── conventions.md
│   │   │       ├── stack.md
│   │   │       └── decisions.md
│   │   ├── skills/
│   │   │   ├── orchestration/
│   │   │   ├── code-review/
│   │   │   ├── security-review/
│   │   │   ├── node-backend/         # ← installed optional pack
│   │   │   └── …
│   │   ├── version.json
│   │   └── USAGE.md
│   ├── runtime/
│   │   ├── init-answers.json
│   │   └── agent-init-state.json
│   ├── template/
│   ├── src/
│   ├── MANIFEST.md
│   ├── HOW_TO.md
│   └── README.md
├── CLAUDE.md                         # ← canonical entrypoint (source-of-truth)
├── TASK.md                           # ← shared task queue
├── .github/
│   ├── copilot-instructions.md       # ← active bridge (confirmed in agent init)
│   └── agents/
│       ├── orchestrator.md
│       ├── reviewer.md
│       ├── code-review.md
│       ├── security-review.md
│       └── …
├── .claude/
│   └── settings.local.json           # ← full-access setting
├── .git/hooks/
│   └── pre-commit                    # ← no-auto-commit guard
├── .gitignore                        # ← managed entries appended
├── package.json
├── tsconfig.json
└── README.md
```

### Key Points

- `CLAUDE.md` is the canonical source-of-truth; `.github/copilot-instructions.md` is a bridge redirect.
- Project memory files (`context.md`, `stack.md`, etc.) are user-owned — the orchestrator seeds them once and never overwrites.
- `.gitignore` has managed entries for `garda-agent-orchestrator/runtime/` and other agent artifacts.

---

## Example Task Execution

### Create a Task

User asks the agent:

> Create a task for "Add invoice PDF export endpoint".

The agent adds to `TASK.md`:

| ID | Status | Priority | Area | Title | Profile |
|---|---|---|---|---|---|
| T-101 | 🟦 TODO | P1 | backend | Add invoice PDF export endpoint | default |

### Execute the Task

```
Execute task T-101 strictly through the orchestrator.
```

The agent uses `garda next-step "T-101"` before the first gate and after every
suggested command. The `TASK.md` profile, active profile config, and preflight
risk decide the effective depth; user-facing task starts should not rely on
`depth=1|2|3` as a review shortcut.

#### Agent Lifecycle

```
 1. next-step                        -> enter-task-mode command
 2. enter-task-mode                  -> TASK_MODE_ENTERED
 3. next-step                        -> TASK_ENTRY rule load
 4. load-rule-pack TASK_ENTRY        -> RULE_PACK_LOADED
 5. next-step                        -> handshake + shell smoke
 6. handshake and shell smoke        -> preflight prerequisites pass
 7. next-step                        -> classify-change
 8. classify-change                  -> PREFLIGHT_CLASSIFIED (reviews: code)
 9. next-step                        -> POST_PREFLIGHT load or bind
10. POST_PREFLIGHT rule evidence     -> ready to implement
11. Implement code + tests           -> (working...)
    - src/routes/invoices.ts — new POST /invoices/:id/pdf route
    - src/services/pdf-export.ts — new service
    - tests/pdf-export.test.ts — new test file
12. next-step                        -> compile-gate
13. compile-gate                     -> COMPILE_GATE_PASSED
14. next-step                        -> full-suite-validation if enabled
15. next-step                        -> build-review-context for code
16. Launch fresh code reviewer       -> delegated reviewer with clean context
17. record-review-result             -> REVIEW_RECORDED
18. Close reviewer session           -> reviewer is not reused
19. required-reviews-check           -> REVIEW_GATE_PASSED
20. doc-impact-gate                  -> DOC_IMPACT_GATE_PASSED
21. project-memory-impact if enabled -> current evidence recorded
22. completion-gate                  -> COMPLETION_GATE_PASSED
23. next-step                        -> task-audit-summary
24. task-audit-summary               -> final closeout materialized
25. next-step                        -> DONE, then final report + commit question
```

#### Task Timeline

```shell
garda gate task-events-summary --task-id "T-101"
```

```
Task: T-101
Events: abbreviated
Timeline:
[01] 2026-03-20T09:00:00Z | PLAN_CREATED              | INFO  | actor=orchestrator
[02] 2026-03-20T09:01:00Z | PREFLIGHT_CLASSIFIED      | INFO
[03] 2026-03-20T09:20:00Z | COMPILE_GATE_PASSED       | PASS
[04] 2026-03-20T09:21:00Z | REVIEW_PHASE_STARTED      | INFO
[05] 2026-03-20T09:22:00Z | REVIEW_RECORDED           | PASS  | actor=code-review
[06] 2026-03-20T09:30:00Z | REVIEW_GATE_PASSED        | PASS
[07] 2026-03-20T09:31:00Z | DOC_IMPACT_GATE_PASSED    | PASS
[08] 2026-03-20T09:32:00Z | COMPLETION_GATE_PASSED    | PASS
[09] 2026-03-20T09:33:00Z | FINAL_CLOSEOUT_READY      | PASS
IntegrityStatus: VALID
```

The `TASK.md` row now reads:

| T-101 | DONE | P1 | backend | Add invoice PDF export endpoint | default |

---

## Update Scenario

A new orchestrator version is published. You want to upgrade.

### Check What Changed

```shell
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
```

Output shows a version comparison: current `<deployed-version>` → available `<published-version>`, with a diff of changed template files.

### Apply the Update

```shell
garda update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
```

What happens:
1. A rollback snapshot is saved to `runtime/update-rollbacks/`.
2. Bundle files under `garda-agent-orchestrator/` are synced from the new version.
3. `live/` is re-materialized (rules, config, skills).
4. `live/docs/project-memory/` is **not touched** (user-owned).
5. `runtime/init-answers.json` is reused and validated.
6. `VERSION` updates to the applied version.
7. `garda verify` runs automatically.

### Preview Without Applying

```shell
garda update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --dry-run
```

### Roll Back if Needed

```shell
garda rollback --target-root "."
```

Restores the latest saved snapshot from before the update.

---

## Uninstall

### Interactive Uninstall

```shell
garda uninstall --target-root "."
```

The CLI asks what to keep:
- Keep primary entrypoint (`CLAUDE.md`)? → **no**
- Keep `TASK.md`? → **yes** (preserve task history)
- Keep runtime artifacts? → **yes** (preserve reviews and task logs)

### Non-Interactive Uninstall

```shell
garda uninstall --target-root "." --no-prompt --keep-primary-entrypoint no --keep-task-file yes --keep-runtime-artifacts no
```

### After Uninstall

```
invoice-api/
├── src/                              # ← unchanged
├── tests/                            # ← unchanged
├── TASK.md                           # ← kept (user chose to keep)
├── package.json
├── tsconfig.json
├── .gitignore                        # ← managed entries removed
└── README.md
```

Removed:
- `garda-agent-orchestrator/` directory (bundle, `live/`, `runtime/`)
- `CLAUDE.md`, `.github/copilot-instructions.md`, `.github/agents/`
- `.claude/settings.local.json`
- `.git/hooks/pre-commit` (commit guard)
- Managed blocks in `.gitignore`

---

## Tips for Node.js Projects

- **Output filters**: `live/config/output-filters.json` includes built-in profiles for `npm` and `tsc` — compile gate output is automatically compacted.
- **Skill packs**: The `node-backend` pack adds Node-specific review guidance. Consider also `quality-architecture` for larger codebases.
- **paths.json**: Default trigger patterns already cover `src/**/*.ts` and `tests/**/*.test.ts` — adjust if your layout differs.
- **Token economy**: Fast-profile work uses heavier reviewer-context
  compaction for small bug fixes. Use the balanced/default profile for feature
  work and let `next-step` decide the effective depth from the task profile
  and preflight risk.

---

*See also: [docs/work-example.md](../work-example.md) for the generic task lifecycle reference.*

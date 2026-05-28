# Walkthrough: Solo Developer — Minimal Mode

A single developer working on a small project with one AI agent, using a `fast`
task profile for lightweight task execution.

This walkthrough applies to **any stack** — the focus is on the streamlined workflow, not language specifics.

---

## Before: Project Structure

```
my-tool/
├── src/
│   ├── cli.ts
│   └── utils.ts
├── tests/
│   └── cli.test.ts
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md
```

A small CLI utility. One developer, one agent.

---

## Install

### Step 1: Run Setup

```shell
cd my-tool
garda setup
```

Minimal answers:

| # | Question | Answer |
|---|---|---|
| 1 | Assistant response language | `English` |
| 2 | Default response brevity | `concise` |
| 3 | Source-of-truth entrypoint | `GitHubCopilot` |
| 4 | Hard no-auto-commit guard | `no` |
| 5 | Claude full access to orchestrator | `no` |
| 6 | Token economy enabled | `yes` |

### Step 2: Agent Initialization

Provide `garda-agent-orchestrator/AGENT_INIT_PROMPT.md` to GitHub Copilot.

The agent:
1. Reads init answers — source-of-truth is GitHubCopilot, so `.github/copilot-instructions.md` is the canonical entrypoint.
2. Asks which entrypoint files are active → you answer `.github/copilot-instructions.md` only.
3. Runs install and materializes `live/`.
4. Runs `garda agent-init`.
5. Suggests skill packs — you skip them (no optional packs for a small project).

---

## After: Project Structure

```
my-tool/
├── src/                              # ← unchanged
├── tests/                            # ← unchanged
├── garda-agent-orchestrator/       # ← new: orchestrator bundle
│   ├── bin/garda.js
│   ├── live/
│   │   ├── config/                   # paths, token-economy, output-filters, etc.
│   │   ├── docs/
│   │   │   ├── agent-rules/          # core rules
│   │   │   └── project-memory/       # context, stack, conventions, etc.
│   │   ├── skills/
│   │   │   ├── orchestration/
│   │   │   ├── orchestration-depth1/ # ← compact fast-profile workflow rules
│   │   │   ├── code-review/
│   │   │   ├── security-review/
│   │   │   └── …
│   │   └── version.json
│   └── runtime/
│       ├── init-answers.json
│       └── agent-init-state.json
├── TASK.md                           # ← shared task queue
├── .github/
│   ├── copilot-instructions.md       # ← canonical entrypoint
│   └── agents/
│       ├── orchestrator.md
│       ├── reviewer.md
│       └── …
├── .gitignore                        # ← managed entries appended
├── package.json
├── tsconfig.json
└── README.md
```

### Key Points

- No `CLAUDE.md`, `AGENTS.md`, or `GEMINI.md` — only the selected source-of-truth and its bridges.
- No `.claude/settings.local.json` — Claude full access was set to `no`.
- No `.git/hooks/pre-commit` — the commit guard was set to `no`.
- The `orchestration-depth1` compatibility skill provides compact workflow
  guidance for fast-profile tasks; agents should still enter tasks through
  `next-step`, not by asking the user for a raw depth value.
- The footprint is minimal: only one entrypoint, essential bridges, and the bundle.

---

## Example Task Execution — Fast Profile

### Create a Task

> Create a task for "Add --verbose flag to CLI".

| ID | Status | Priority | Area | Title | Profile |
|---|---|---|---|---|---|
| T-501 | 🟦 TODO | P2 | cli | Add --verbose flag to CLI | fast |

Small, localized, low-risk — perfect for the `fast` profile.

### Execute the Task

```
Execute task T-501 strictly through the orchestrator.
```

The agent uses `garda next-step T-501` before the first gate and after every
suggested command.

#### What The Fast Profile Means

| Aspect | Fast profile | Balanced/default profile |
|---|---|---|
| Context loaded | Compact rule context | Standard rule context |
| Token economy | Full compaction | Full compaction |
| Reviews | Minimal required | Standard required |
| Typical use | Small fixes, single-file changes | Feature work |

With a fast profile:
- Token economy applies strong compaction.
- Reviewer context is smaller, but mandatory reviews triggered by preflight still run.
- `next-step` can still route through compile, doc-impact, project-memory, completion, and task-audit closeout.

#### Agent Lifecycle

```
 1. next-step startup loop          → task-mode, rules, handshake, shell smoke
 2. classify-change                 → PREFLIGHT_CLASSIFIED (reviews: code)
 3. POST_PREFLIGHT rule evidence    → ready to implement
 4. Implement + test                → (working...)
    - src/cli.ts — add --verbose flag parsing
    - tests/cli.test.ts — add test for --verbose
 5. compile-gate                    → COMPILE_GATE_PASSED
 6. Fresh code reviewer             → REVIEW_RECORDED (PASS)
 7. required-reviews-check          → REVIEW_GATE_PASSED
 8. doc-impact-gate                 → DOC_IMPACT_GATE_PASSED
 9. project-memory-impact if enabled -> current evidence recorded
10. completion-gate                 → COMPLETION_GATE_PASSED
11. task-audit-summary              → final closeout materialized
12. next-step                       → DONE
```

Notice: fast mode reduces context and cost; it does not remove mandatory gates.
The docs decision still goes through `doc-impact-gate`, even when the decision
is `NO_DOC_UPDATES`.

#### Task Timeline

```shell
garda gate task-events-summary --task-id "T-501"
```

```
Task: T-501
Events: abbreviated
Timeline:
[01] 2026-03-23T10:00:00Z | PLAN_CREATED              | INFO  | actor=orchestrator
[02] 2026-03-23T10:01:00Z | PREFLIGHT_CLASSIFIED      | INFO
[03] 2026-03-23T10:08:00Z | COMPILE_GATE_PASSED       | PASS
[04] 2026-03-23T10:09:00Z | REVIEW_RECORDED           | PASS  | actor=code-review
[05] 2026-03-23T10:12:00Z | REVIEW_GATE_PASSED        | PASS
[06] 2026-03-23T10:13:00Z | DOC_IMPACT_GATE_PASSED    | PASS
[07] 2026-03-23T10:14:00Z | COMPLETION_GATE_PASSED    | PASS
[08] 2026-03-23T10:15:00Z | FINAL_CLOSEOUT_READY      | PASS
IntegrityStatus: VALID
```

Total time: ~13 minutes for a small CLI change with automated review.

---

## When to Use A Broader Profile

Even as a solo developer, some tasks need the `balanced` or `strict` profile:

| Scenario | Reason |
|---|---|
| New module with multiple files | Cross-file context needed |
| API endpoint with auth logic | Security review triggers |
| Database schema change | DB review triggers |
| Refactor touching >5 files | Broader review coverage |

```
Execute task T-502 strictly through the orchestrator.
```

The agent automatically loads more context and runs the required gate pipeline.

---

## Update Scenario

### Check and Apply in One Step

For a solo developer, the simplest update path:

```shell
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
```

Review the version comparison, then:

```shell
garda update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
```

What happens:
1. Rollback snapshot saved.
2. Bundle synced, `live/` re-materialized.
3. `project-memory/` untouched.
4. No skill packs to preserve (none installed).
5. `VERSION` updated.

### Roll Back

```shell
garda rollback --target-root "."
```

---

## Uninstall

### Full Removal

For a solo project, you might want a complete clean removal:

```shell
garda uninstall --target-root "." --no-prompt --keep-primary-entrypoint no --keep-task-file no --keep-runtime-artifacts no
```

### After Uninstall

```
my-tool/
├── src/                              # ← unchanged
├── tests/                            # ← unchanged
├── package.json
├── tsconfig.json
├── .gitignore                        # ← managed entries removed
└── README.md
```

The project is back to its exact original state.

---

## Tips for Solo / Minimal Workflows

- **Default to the fast profile** for most small tasks. Escalate to `balanced` or `strict` only when the change scope warrants it.
- **Skip optional skill packs** unless your project grows into a specific domain (e.g. add `node-backend` later if you add an API layer).
- **Token economy in fast mode** provides strong compaction, keeping interactions smaller while preserving mandatory reviews.
- **Single provider** means minimal file footprint — no unused entrypoints or bridge files.
- **No commit guard** is fine for solo work where you control all commits. Enable it later (`garda reinit`) if collaborators join.
- **Change init answers later** without reinstalling:
  ```shell
  garda reinit --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
  ```
- **Add skill packs later** as the project grows:
  ```shell
  garda skills list --target-root "."
  garda skills suggest --target-root "." --task-text "Add REST API" --changed-path "src/api.ts"
  garda skills add node-backend --target-root "."
  ```

---

*See also: [docs/work-example.md](../work-example.md) for the generic task lifecycle reference.*

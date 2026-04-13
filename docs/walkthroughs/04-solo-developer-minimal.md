# Walkthrough: Solo Developer — Minimal Mode

A single developer working on a small project with one AI agent, using `depth=1` for fast, lightweight task execution.

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
│   │   │   ├── orchestration-depth1/ # ← compact rules for depth=1
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
- The `orchestration-depth1` skill provides a compact workflow specifically for `depth=1` tasks.
- The footprint is minimal: only one entrypoint, essential bridges, and the bundle.

---

## Example Task Execution — depth=1

### Create a Task

> Create a task for "Add --verbose flag to CLI".

| ID | Status | Priority | Area | Title | Profile |
|---|---|---|---|---|---|
| T-501 | 🟦 TODO | P2 | cli | Add --verbose flag to CLI | fast |

Small, localized, low-risk — perfect for the `fast` profile (depth=1).

### Execute the Task

```
Execute task T-501 depth=1
```

#### What depth=1 Means

| Aspect | depth=1 | depth=2 (default) |
|---|---|---|
| Context loaded | Core + workflow only | Most rule files |
| Token economy | Full compaction | Full compaction |
| Reviews | Minimal required | Standard required |
| Typical use | Small fixes, single-file changes | Feature work |

At `depth=1`:
- The agent loads only core rules and the `orchestration-depth1` skill.
- Token economy applies full compaction — reviewer context is minimal.
- Only mandatory reviews triggered by file paths are required.

#### Agent Lifecycle (depth=1)

```
 1. Read task + rules (compact)     → PLAN_CREATED
 2. Classify changes                → PREFLIGHT_CLASSIFIED
    garda gate enter-task-mode --task-id "T-501" --task-summary "Add --verbose flag"
    garda gate load-rule-pack --task-id "T-501" --stage "TASK_ENTRY" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/00-core.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md"
    garda gate classify-change --use-staged --task-id "T-501" --task-intent "Add --verbose flag"
    garda gate load-rule-pack --task-id "T-501" --stage "POST_PREFLIGHT" --preflight-path "garda-agent-orchestrator/runtime/reviews/T-501-preflight.json" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/00-core.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/35-strict-coding-rules.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/50-structure-and-docs.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/70-security.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md"
    Result: FAST_PATH, reviews: [code]
 3. Implement + test                → (working…)
    - src/cli.ts — add --verbose flag parsing
    - tests/cli.test.ts — add test for --verbose
 4. Run compile gate                → COMPILE_GATE_PASSED ✅
    garda gate compile-gate --task-id "T-501"
 5. Code review (compact context)   → REVIEW_GATE_PASSED ✅
    garda gate required-reviews-check --task-id "T-501" --code-review-verdict "pass"
 6. Completion gate                 → COMPLETION_GATE_PASSED ✅
    garda gate completion-gate --task-id "T-501"
 7. Mark DONE                       → TASK_DONE
```

Notice: no doc-impact gate for a small change at `depth=1` when the classify-change result is `FAST_PATH`. The pipeline is shorter and faster.

#### Task Timeline

```shell
garda gate task-events-summary --task-id "T-501"
```

```
Task: T-501
Events: 6
Timeline:
[01] 2026-03-23T10:00:00Z | PLAN_CREATED              | INFO  | actor=orchestrator
[02] 2026-03-23T10:01:00Z | PREFLIGHT_CLASSIFIED      | INFO
[03] 2026-03-23T10:08:00Z | COMPILE_GATE_PASSED       | PASS
[04] 2026-03-23T10:09:00Z | REVIEW_REQUESTED          | INFO  | actor=code-review
[05] 2026-03-23T10:12:00Z | REVIEW_GATE_PASSED        | PASS
[06] 2026-03-23T10:13:00Z | TASK_DONE                 | PASS
IntegrityStatus: VALID
```

Total time: ~13 minutes for a small CLI change with automated review.

---

## When to Escalate to depth=2

Even as a solo developer, some tasks need `depth=2`:

| Scenario | Reason |
|---|---|
| New module with multiple files | Cross-file context needed |
| API endpoint with auth logic | Security review triggers |
| Database schema change | DB review triggers |
| Refactor touching >5 files | Broader review coverage |

```
Execute task T-502 depth=2
```

The agent automatically loads more context and runs the full gate pipeline.

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

- **Default to depth=1** for most small tasks. Escalate to `depth=2` only when the change scope warrants it.
- **Skip optional skill packs** unless your project grows into a specific domain (e.g. add `node-backend` later if you add an API layer).
- **Token economy at depth=1** provides maximum compaction — reviewer context is minimal, keeping interactions fast and cheap.
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

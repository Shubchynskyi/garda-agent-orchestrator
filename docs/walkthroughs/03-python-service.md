# Walkthrough: Python Service

A FastAPI microservice with Poetry, pytest, and a 1–4 person team using Claude as the sole provider.

---

## Before: Project Structure

```
order-service/
├── app/
│   ├── __init__.py
│   ├── main.py
│   ├── routers/
│   │   └── orders.py
│   ├── models/
│   │   └── order.py
│   └── db.py
├── tests/
│   ├── conftest.py
│   └── test_orders.py
├── alembic/
│   ├── alembic.ini
│   └── versions/
│       └── 001_init.py
├── pyproject.toml
├── poetry.lock
├── .gitignore
└── README.md
```

---

## Install

### Step 1: Run Setup

```shell
cd order-service
garda setup
```

Init answers for this project:

| # | Question | Answer |
|---|---|---|
| 1 | Assistant response language | `English` |
| 2 | Default response brevity | `concise` |
| 3 | Source-of-truth entrypoint | `Claude` |
| 4 | Hard no-auto-commit guard | `no` |
| 5 | Claude full access to orchestrator | `yes` |
| 6 | Token economy enabled | `yes` |

### Step 2: Agent Initialization

Provide `garda-agent-orchestrator/AGENT_INIT_PROMPT.md` to Claude Code.

The agent:
1. Reads saved init answers.
2. Asks which entrypoint files are active → you answer `CLAUDE.md` only.
3. Runs install and materializes `live/`.
4. Runs `garda agent-init`.
5. Suggests skill packs — you add `python-service`.

```shell
garda skills add python-service --target-root "."
```

### Fill Project Memory

The agent discovers your project structure and populates `live/docs/project-memory/`:

**stack.md** (example content):
```markdown
## Languages & Frameworks
- Python 3.12, FastAPI, Pydantic v2
- SQLAlchemy 2.0 + Alembic for migrations

## Infrastructure
- PostgreSQL 16, Redis for caching
- Docker Compose for local development

## Testing
- pytest with pytest-asyncio
- httpx for async endpoint tests
```

**conventions.md** (example content):
```markdown
## Code Style
- Black formatter, Ruff linter
- Type hints required on all public functions
- snake_case for modules and functions
```

These files are user-owned — the orchestrator never overwrites them after seeding.

---

## After: Project Structure

```
order-service/
├── app/                              # ← unchanged
├── tests/                            # ← unchanged
├── alembic/                          # ← unchanged
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
│   │   │   ├── agent-rules/
│   │   │   └── project-memory/
│   │   │       ├── context.md
│   │   │       ├── architecture.md
│   │   │       ├── conventions.md
│   │   │       ├── stack.md
│   │   │       └── decisions.md
│   │   ├── skills/
│   │   │   ├── orchestration/
│   │   │   ├── code-review/
│   │   │   ├── db-review/
│   │   │   ├── security-review/
│   │   │   ├── python-service/       # ← installed pack
│   │   │   └── …
│   │   └── version.json
│   └── runtime/
│       ├── init-answers.json
│       └── agent-init-state.json
├── CLAUDE.md                         # ← canonical entrypoint (sole provider)
├── TASK.md                           # ← shared task queue
├── .claude/
│   └── settings.local.json           # ← full-access setting
├── .gitignore                        # ← managed entries appended
├── pyproject.toml
├── poetry.lock
└── README.md
```

### Key Points

- Only `CLAUDE.md` was created — no bridge files for other providers since Claude is the only active agent.
- `.github/agents/` provider bridges are still created for potential future Copilot use.
- No `.git/hooks/pre-commit` — the no-auto-commit guard was set to `no`.

---

## Example Task Execution

### Create a Task

> Create a task for "Add order cancellation endpoint with refund logic".

| ID | Status | Priority | Area | Title | Profile |
|---|---|---|---|---|---|
| T-401 | 🟦 TODO | P2 | backend | Add order cancellation endpoint with refund logic | default |

### Execute the Task

```
Execute task T-401 strictly through the orchestrator.
```

The agent uses `garda next-step "T-401"` as the navigator before the first gate
and after every suggested command.

#### Agent Lifecycle

```
 1. next-step startup loop           → task-mode, rules, handshake, shell smoke
 2. classify-change                  → PREFLIGHT_CLASSIFIED (reviews: code, security)
 3. POST_PREFLIGHT rule evidence     → ready to implement
 4. Implement code + tests           → (working...)
    - app/routers/orders.py — new POST /orders/{id}/cancel endpoint
    - app/services/refund.py — new refund service module
    - tests/test_cancel_order.py — new test file
 5. Run compile gate                 → COMPILE_GATE_PASSED
    garda gate compile-gate --task-id "T-401"
    (Runs: pytest --tb=short — output filtered by generic test profile)
 6. Launch fresh code reviewer       → REVIEW_RECORDED (PASS)
 7. Launch fresh security reviewer   → REVIEW_RECORDED (PASS)
 8. required-reviews-check           → REVIEW_GATE_PASSED
 9. doc-impact-gate                  → DOC_IMPACT_GATE_PASSED
10. project-memory-impact if enabled → current evidence recorded
11. completion-gate                  → COMPLETION_GATE_PASSED
12. task-audit-summary               → final closeout materialized
13. next-step                        → DONE
```

#### Why Security Review Triggered

The classify-change gate detects refund/payment patterns in the file path and code intent. Mandatory security review applies regardless of depth. The `python-service` skill pack provides Python-specific context for the reviewer.

#### Task Timeline

```shell
garda gate task-events-summary --task-id "T-401"
```

```
Task: T-401
Events: abbreviated
Timeline:
[01] 2026-03-22T11:00:00Z | PLAN_CREATED              | INFO  | actor=orchestrator
[02] 2026-03-22T11:01:00Z | PREFLIGHT_CLASSIFIED      | INFO
[03] 2026-03-22T11:15:00Z | COMPILE_GATE_PASSED       | PASS
[04] 2026-03-22T11:16:00Z | REVIEW_PHASE_STARTED      | INFO
[05] 2026-03-22T11:17:00Z | REVIEW_RECORDED           | PASS  | actor=code-review
[06] 2026-03-22T11:18:00Z | REVIEW_RECORDED           | PASS  | actor=security-review
[07] 2026-03-22T11:28:00Z | REVIEW_GATE_PASSED        | PASS
[08] 2026-03-22T11:29:00Z | COMPLETION_GATE_PASSED    | PASS
[09] 2026-03-22T11:30:00Z | FINAL_CLOSEOUT_READY      | PASS
IntegrityStatus: VALID
```

---

## Update Scenario

### Check for Updates

```shell
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
```

Shows: current `<deployed-version>` → available `<published-version>`.

### Apply With Auto-Confirm (CI Use Case)

```shell
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --apply --no-prompt
```

This is useful in CI pipelines — it compares, applies the update, and verifies without interactive prompts.

### What Happens During Update

1. Rollback snapshot saved to `runtime/update-rollbacks/`.
2. Bundle files synced from new version.
3. `live/` re-materialized with updated rules and skills.
4. `live/docs/project-memory/` untouched.
5. `python-service` skill pack preserved.
6. `runtime/init-answers.json` reused.
7. `VERSION` updates to the applied version.

### Roll Back

```shell
garda rollback --target-root "."
```

---

## Uninstall

### Interactive

```shell
garda uninstall --target-root "."
```

Choices:
- Keep `CLAUDE.md`? → **no**
- Keep `TASK.md`? → **no**
- Keep runtime artifacts? → **no**

### After Uninstall

```
order-service/
├── app/                              # ← unchanged
├── tests/                            # ← unchanged
├── alembic/                          # ← unchanged
├── pyproject.toml
├── poetry.lock
├── .gitignore                        # ← managed entries removed
└── README.md
```

Removed:
- `garda-agent-orchestrator/` directory
- `CLAUDE.md`
- `.claude/settings.local.json`
- `.github/agents/`
- Managed blocks in `.gitignore`

The project is back to its original state with no orchestrator traces.

---

## Tips for Python Projects

- **Output filters**: The generic test profile in `live/config/output-filters.json` handles pytest output. On a green run, the compile gate returns only a pass summary.
- **Skill packs**: `python-service` adds Python-specific review guidance. Pair with `data-database` if you use Alembic or other migration frameworks.
- **paths.json**: Add trigger patterns for your migration directory (e.g. `alembic/versions/`) if the defaults don't cover it. Payment/auth path patterns are already included.
- **Alembic migrations**: Files in `alembic/versions/` trigger DB review automatically when `db/migration` trigger patterns are configured in `paths.json`.
- **Single provider**: When only one agent is active, the orchestrator creates minimal entrypoints — no unused bridge files clutter the project.

---

*See also: [docs/work-example.md](../work-example.md) for the generic task lifecycle reference.*

# Commands

Primary entry point: selected source-of-truth entrypoint for this workspace.

IMPORTANT: The user prefers running ad-hoc commands manually. Do not execute ad-hoc `task` commands (e.g., standalone `npm run build`, `npm test`, `npm run lint`) unless the prompt explicitly asks for it or a mandatory gate requires the underlying command.
Exception — mandatory gates always run: `compile-gate`, `required-reviews-check`, `doc-impact-gate`, `completion-gate`, and any other gate in the mandatory sequence must execute their underlying commands (including builds, tests, or type-checks) regardless of this preference. The preference applies only to ad-hoc command execution outside the gate pipeline.
Exception: You may run tests and iterate only when the user explicitly requests this workflow.
Canonical gate surface is `node garda-agent-orchestrator/bin/garda.js gate <name>`.
Default task loop: run `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."` before the first gate, after every suggested command, and after any gate failure. Follow its single recommended command instead of guessing from defaults, stale artifacts, or the static gate list.

### Ad-Hoc vs Mandatory Gate Commands
The "prefer manual commands" preference and mandatory gate execution are separate concerns:
- **Ad-hoc commands** (`npm run build`, `npm test`, `npm run lint` executed directly) — avoid unless the user requests them or you have an explicit justification.
- **Mandatory gate commands** (`node garda-agent-orchestrator/bin/garda.js gate compile-gate`, etc.) — always execute when required by the workflow, even when the gate internally runs `npm run build` or similar. A gate wrapping a build/test command is not an ad-hoc execution; it is lifecycle-required infrastructure.
- **Known producer-consumer validation chains** (`npm run build:node-foundation` -> direct `node --test .node-build/...`, similar generated-artifact consumers) — do not fan these out through raw shell sidecars. Use the guarded workflow path, `npm test`, or run producer then consumer strictly sequentially.

Example (materialized/deployed workspace):
```
# ✗ Ad-hoc — avoid unless requested:
npm run build
npm test

# ✓ Mandatory gate — always execute when required:
node garda-agent-orchestrator/bin/garda.js gate compile-gate --task-id "T-042" --commands-path "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md"
# compile-gate internally runs `npm run build` — that is allowed because it is gate-driven, not ad-hoc.
```

## Project Commands (Required)
Replace these defaults with repository-specific commands when the real project differs.

### Setup
```bash
npm install --prefer-offline --no-fund --no-audit
node garda-agent-orchestrator/bin/garda.js setup --target-root "."
```

### Run
```bash
node garda-agent-orchestrator/bin/garda.js status --target-root "."
node garda-agent-orchestrator/bin/garda.js agent-init --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --active-agent-files "AGENTS.md, CLAUDE.md, GEMINI.md, QWEN.md, .github/copilot-instructions.md, .windsurf/rules/rules.md, .junie/guidelines.md, .antigravity/rules.md" --project-rules-updated yes --skills-prompted yes
node garda-agent-orchestrator/bin/garda.js doctor --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
node garda-agent-orchestrator/bin/garda.js --help
```

### Skill Packs
```bash
node garda-agent-orchestrator/bin/garda.js skills list --target-root "."
node garda-agent-orchestrator/bin/garda.js skills suggest --target-root "."
node garda-agent-orchestrator/bin/garda.js skills add node-backend --target-root "."
node garda-agent-orchestrator/bin/garda.js skills validate --target-root "."
```

### Test
```bash
npm test
node --test .node-build/tests/node/packaging/pack-smoke.test.js
```

Rules:
- Direct `.node-build` test consumers are producer-consumer flows: refresh `.node-build` first with `npm run build:node-foundation` or `npm test`, then run the consumer.
- Do not launch the producer and direct `.node-build` consumer as parallel raw shell commands; that bypasses the guarded validation-chain path.

### Quality
```bash
npm run typecheck
npm run validate:version-parity
```

### Compile Gate (Mandatory)
```bash
npm run build
```

Rules:
- First non-empty non-comment line from this block is the compile gate command.
- Command must be non-interactive and must return non-zero exit code on compile failure.
- This command is executed by `node garda-agent-orchestrator/bin/garda.js gate compile-gate` before review phase.

### Build and Package
```bash
npm run build
npm pack
npm publish
```

## Compact Command Policy

Compact command usage is mandatory by default. Treat full or verbose output as an escalation step, not a starting point.

### Required Protocol
1. First pass must use compact, summary, structured (`--json`), bounded, or path-scoped output.
2. Escalate in this order only: `scan -> inspect -> debug`.
3. Use repository-wide or unbounded output only when no scoped equivalent exists or the scoped pass failed to localize the issue.
4. Full output is allowed immediately only for:
   - security, auth, secrets, migrations, or infra-sensitive diagnostics;
   - the first encounter with an unfamiliar tool output format;
   - single-target failure debugging after localization.
5. Before switching to verbose or full output, state briefly why compact output is insufficient.

### Mode Selection
| Mode | Default output policy | Expected usage |
|---|---|---|
| `scan` | compact, bounded, summary-only | quick repo or tool overview |
| `inspect` | scoped, file/path/test-target bounded | localized investigation |
| `debug` | verbose/full, local target only | reproduce or explain a known failure |
| `sensitive` | complete output, no unsafe truncation | auth, secrets, CVE, migration, infra diagnostics |

### Two-Pass Rule
1. Start with compact scan.
2. Narrow to targeted inspect.
3. Escalate to verbose/full output only for the localized target.

Examples:
- `git diff --stat` -> `git diff -- path/to/file.ts`
- `rg -l --max-count=5 pattern src/` -> `rg -C2 pattern src/feature/`
- `pytest -q --tb=short` -> `pytest tests/test_auth.py::test_refresh -vv --tb=long`

### Noisy Commands Require Justification
Do not start with noisy or unbounded commands when a compact equivalent exists.

Examples that must not be first pass without a reason:
- `git diff` without `--stat` or pathspec
- `git log --all`
- `rg` or `grep` across the entire repository without path scope
- `cat` on large files
- `docker logs` / `kubectl logs` without `--tail`
- verbose test runners on the first pass

### Version Control (git)
| Instead of | Prefer | Use case |
|---|---|---|
| `git diff` | `git diff --stat` | Scope overview |
| `git diff` | `git diff -- path/to/file.ts` | Targeted inspection |
| `git log` | `git log --oneline -n 20` | Recent history |
| `git log --all` | `git log --oneline --graph -n 30` | Branch topology |
| `git status` | `git status --short --branch` | Quick state |
| `git show <sha>` | `git show --stat <sha>` | Commit overview |
| `git stash list` | `git stash list --oneline` | Stash summary |

### Testing
| Tool | Compact flags | Notes |
|---|---|---|
| pytest | `-q --tb=short --no-header` | Add `--tb=long` only for failing test investigation |
| jest / vitest | `--silent` or `--verbose=false` | Default reporters are noisy |
| go test | `-count=1 -short` | Add `-v` only for specific test debug |
| cargo test | `-- --format=terse` | Terse hides passing tests |
| dotnet test | `--verbosity quiet` | Use `normal` on failure |
| phpunit | `--no-progress --compact` | Suppress per-test dots |

### Package Managers
| Instead of | Prefer | Saves |
|---|---|---|
| `npm install` | `npm install --prefer-offline --no-fund --no-audit` | Suppresses advisory noise |
| `npm ls` | `npm ls --depth=0` | Top-level deps only |
| `npm ls` (programmatic) | `npm ls --json --depth=0` | Structured, agent-friendly |
| `pip install -r req.txt` | `pip install -q -r req.txt` | Quiet progress bars |
| `pip list` | `pip list --format=columns` | Compact table |
| `yarn install` | `yarn install --silent` | No progress |
| `composer install` | `composer install --quiet` | No progress |

### Build, Lint & Type-Check
| Tool | Compact flags |
|---|---|
| tsc | `--noEmit --pretty false` |
| eslint | `--format=compact` |
| eslint (programmatic) | `--format=json` |
| dotnet build | `--verbosity quiet` |
| gradle | `-q` or `--console=plain` |
| mvn | `-q` (quiet) or `-B` (batch non-interactive) |
| cargo build | `--message-format=short` |

### Search & File Inspection
| Instead of | Prefer | Reason |
|---|---|---|
| `grep -r <pat> .` | `grep -rl --max-count=5 <pat> src/` | Files only, bounded, scoped |
| `rg <pat>` | `rg -l --max-count=5 <pat> src/` | Files only, bounded, scoped |
| `rg <pat>` (with context) | `rg -C2 --max-count=10 <pat> src/` | Limited context, bounded |
| `cat <large-file>` | `head -n 60 <file>` or `tail -n 60 <file>` | Targeted region |
| `find . -name "*.ts"` | `find . -name "*.ts" -not -path "*/node_modules/*"` | Exclude noise dirs |
| `ls -laR` | `ls -la src/` or `tree -L 2 src/` | Scoped, bounded depth |

### Containers & Infrastructure
| Instead of | Prefer |
|---|---|
| `docker logs <c>` | `docker logs --tail 50 <c>` |
| `kubectl logs <pod>` | `kubectl logs --tail=50 <pod>` |
| `docker ps` | `docker ps --format "table \{{.Names}}\t\{{.Status}}"` |
| `kubectl get pods` | `kubectl get pods -o wide` or `-o json` |

### When Full Output Is Required
- Diagnosing a specific test failure — use verbose mode (`--tb=long`, `-v`) for that test only.
- Debugging build/compile errors — read full compiler output, then switch back to compact.
- Security-sensitive commands — never truncate; auth, secrets, CVE, migration outputs must stay complete.
- First encounter with unfamiliar tool output — read full once, then adopt compact flags.

## Agent Gates
Canonical gate surface is the Node CLI router.

```bash
node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "<EXPLICIT_TASK_EXECUTION|TASK_CREATED_FROM_REQUEST>" --requested-depth "<1|2|3>" --task-summary "<task summary>" --start-banner "<repo-owned-banner>" --planned-changed-file "src/<planned-file>" --planned-changed-file "garda-agent-orchestrator/live/docs/agent-rules/<planned-rule>.md" --artifact-path "garda-agent-orchestrator/runtime/reviews/<task-id>-task-mode.json" --metrics-path "garda-agent-orchestrator/runtime/metrics.jsonl"
node garda-agent-orchestrator/bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "TASK_ENTRY" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/00-core.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md"
node garda-agent-orchestrator/bin/garda.js gate classify-change --changed-file "src/<example-file>" --task-intent "<task summary>" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --metrics-path "garda-agent-orchestrator/runtime/metrics.jsonl"
node garda-agent-orchestrator/bin/garda.js gate classify-change --use-staged --task-intent "<task summary>" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --metrics-path "garda-agent-orchestrator/runtime/metrics.jsonl"
node garda-agent-orchestrator/bin/garda.js gate classify-change --task-id "<task-id>" --task-mode-path "garda-agent-orchestrator/runtime/reviews/<task-id>-task-mode.json" --changed-file "src/<example-file>" --task-intent "<task summary>" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json"
node garda-agent-orchestrator/bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "POST_PREFLIGHT" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/00-core.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/35-strict-coding-rules.md"
node garda-agent-orchestrator/bin/garda.js gate compile-gate --task-id "<task-id>" --commands-path "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md"
node garda-agent-orchestrator/bin/garda.js gate required-reviews-check --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --task-id "<task-id>" --code-review-verdict "<verdict>" --db-review-verdict "<verdict>" --security-review-verdict "<verdict>" --refactor-review-verdict "<verdict>" --api-review-verdict "<verdict>" --test-review-verdict "<verdict>" --performance-review-verdict "<verdict>" --infra-review-verdict "<verdict>" --dependency-review-verdict "<verdict>"
node garda-agent-orchestrator/bin/garda.js gate required-reviews-check --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --task-id "<task-id>" --code-review-verdict "SKIPPED_BY_OVERRIDE" --skip-reviews "code" --skip-reason "1-line config hotfix; rollback plan exists"
node garda-agent-orchestrator/bin/garda.js gate doc-impact-gate --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --task-id "<task-id>" --decision "NO_DOC_UPDATES" --behavior-changed false --changelog-updated false --rationale "No behavior/contract/ops-doc impact."
node garda-agent-orchestrator/bin/garda.js gate doc-impact-gate --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --task-id "<task-id>" --decision "NO_DOC_UPDATES" --behavior-changed false --changelog-updated false --sensitive-scope-reviewed true --rationale "API trigger fired but changes are internal-only: no public contract affected."
node garda-agent-orchestrator/bin/garda.js gate completion-gate --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --task-id "<task-id>"
node garda-agent-orchestrator/bin/garda.js gate log-task-event --task-id "<task-id>" --event-type "PLAN_CREATED" --outcome "INFO" --message "<short stage message>" --actor "orchestrator"
node garda-agent-orchestrator/bin/garda.js gate task-events-summary --task-id "<task-id>"
node garda-agent-orchestrator/bin/garda.js gate task-audit-summary --task-id "<task-id>"
node garda-agent-orchestrator/bin/garda.js gate task-audit-summary --task-id "<task-id>" --as-json
node garda-agent-orchestrator/bin/garda.js gate next-step --task-id "<task-id>"
node garda-agent-orchestrator/bin/garda.js gate next-step --task-id "<task-id>" --as-json
node garda-agent-orchestrator/bin/garda.js gate build-scoped-diff --review-type "<db|security|refactor>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-scoped.diff" --metadata-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-scoped.json"
node garda-agent-orchestrator/bin/garda.js gate build-review-context --review-type "<code|db|security|refactor|api|test|performance|infra|dependency>" --depth <1|2|3> --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --scoped-diff-metadata-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-scoped.json" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-context.json"
node garda-agent-orchestrator/bin/garda.js gate record-review-result --task-id "<task-id>" --review-type "<code|db|security|refactor|api|test|performance|infra|dependency>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --review-output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-output.md" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "<agent:...>"
node garda-agent-orchestrator/bin/garda.js gate record-review-result --task-id "<task-id>" --review-type "<code|db|security|refactor|api|test|performance|infra|dependency>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --review-output-stdin --reviewer-execution-mode "delegated_subagent" --reviewer-identity "<agent:...>"
node garda-agent-orchestrator/bin/garda.js gate validate-manifest --manifest-path "garda-agent-orchestrator/MANIFEST.md"
node garda-agent-orchestrator/bin/garda.js gate human-commit --message "<message>"
```

Notes:
- Enter task mode explicitly before preflight; downstream compile/review/completion gates fail without `runtime/reviews/<task-id>-task-mode.json` and timeline event `TASK_MODE_ENTERED`.
- When the likely task file list is already known, pass repeated `--planned-changed-file` entries to `enter-task-mode`. If any planned path is under protected orchestrator roots, the gate must fail early with a remediation command that reruns the same task-mode entry with explicit `--orchestrator-work`; it must not silently auto-enable orchestrator mode.
- After opening baseline downstream rules, record them explicitly via `load-rule-pack --stage TASK_ENTRY`; `classify-change` fails without rule-pack evidence and timeline event `RULE_PACK_LOADED`.
- When task-mode evidence lives at a nondefault path, pass the same `--task-mode-path` through `classify-change`, `load-rule-pack`, `compile-gate`, `restart-coherent-cycle`, and `restart-review-cycle`; mixed paths are treated as provenance drift.
- After preflight decides the required reviews, re-run `load-rule-pack --stage POST_PREFLIGHT --preflight-path ...` with the actual downstream rule files loaded for this task.
- For one task cycle, `classify-change -> load-rule-pack --stage POST_PREFLIGHT -> compile-gate` is a strict sequence, not a parallelizable set. Use `next-step` between each transition; if a newer preflight is classified, rerun downstream gates from `load-rule-pack --stage POST_PREFLIGHT` against that latest preflight before compile.
- `record-review-result` accepts exactly one reviewer-output source: `--review-output-path` or `--review-output-stdin`.
- `--review-output-stdin` is not a bypass path: the gate must first persist raw reviewer input to `garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-output.md`, then run the same verdict, routing, receipt, and telemetry validation used for file-based ingest.
- In a dirty workspace, prefer `--use-staged` after staging task-related tracked files.
- `--use-staged` includes untracked files by default, so new files are classified even before `git add`.
- Do not use `git add -f` for ignored orchestration control-plane files (`TASK.md`, `garda-agent-orchestrator/runtime/**`, `garda-agent-orchestrator/live/docs/changes/CHANGELOG.md`); their absence from staged diff is expected.
- For maximum precision, pass planned task file list via repeated `--changed-file`.
- In a clean workspace, planned `--changed-file` preflight is only the initial scope hint before implementation. If `next-step` or `compile-gate` later reports scope drift after the real diff exists, treat that as expected planned-scope recovery: rerun the `next-step` command and follow its refresh sequence instead of hand-authoring recovery flags.
- In a clean workspace, `classify-change` can auto-detect changed files from git without additional flags.
- Compile gate is mandatory before review phase, but only run it when `next-step` reports `NextGate: compile-gate`; treat non-zero result as blocking and rerun `next-step` for recovery.
- Compile gate is strict: preflight scope drift blocks execution. Refresh the task scope through `next-step` so `classify-change`, `load-rule-pack --stage POST_PREFLIGHT`, and `compile-gate` stay bound to the same current preflight.
- Compile gate additionally validates explicit task-mode entry evidence from `enter-task-mode`.
- Compile gate additionally validates post-preflight rule-pack evidence from `load-rule-pack`.
- `required-reviews-check` additionally validates compile evidence in `runtime/task-events/<task-id>.jsonl`; without `COMPILE_GATE_PASSED` the review gate fails.
- `required-reviews-check` additionally validates explicit task-mode entry evidence (`TASK_MODE_ENTERED`) before review pass can succeed.
- `required-reviews-check` additionally validates post-preflight rule-pack evidence (`runtime/reviews/<task-id>-rule-pack.json`) before review pass can succeed.
- If explicit `--*-review-verdict` flags are omitted, `required-reviews-check` defaults the expected required verdicts from `preflight.required_reviews` for the current task cycle.
- These defaults do not relax validation: the gate still requires current-cycle artifacts, receipts, review-context bindings, and exact pass tokens; it must not auto-scan `runtime/reviews` for a convenient PASS.
- `required-reviews-check` validates workspace drift against compile evidence scope snapshot; any post-compile changes require re-run of compile gate.
- `required-reviews-check` supports audited override only for code review in tiny low-risk scopes; all other review overrides are rejected.
- `doc-impact-gate` is mandatory before completion; it writes `runtime/reviews/<task-id>-doc-impact.json`. When the preflight detected `api`, `security`, `infra`, `dependency`, or `db` triggers, `NO_DOC_UPDATES` requires `--sensitive-scope-reviewed true` with a rationale explaining why no documentation updates are needed.
- Run `build-review-context` before every required reviewer invocation, even when token economy is inactive; the generated review-context artifact is also lifecycle evidence.
- `build-review-context` writes `REVIEW_PHASE_STARTED`, `SKILL_SELECTED`, and `SKILL_REFERENCE_LOADED` automatically for the selected review skill.
- Upstream review dependencies are launch-time guards, not only gate-time guards. Do not launch a dependent downstream reviewer before the required upstream PASS artifact and receipt already exist for the same cycle.
- Parallel reviewer launch is allowed only for independent review types with no dependency edge in the current cycle; `test` is not independent when upstream non-`test` reviews are required.
- `classify-change` auto-emits `PREFLIGHT_STARTED` and, on failure, `PREFLIGHT_FAILED`; `compile-gate` auto-emits `IMPLEMENTATION_STARTED` before compile execution.
- `completion-gate` validates task-mode evidence, rule-pack evidence, compile evidence, review-gate evidence, doc-impact evidence, rework-after-failure evidence, ordered lifecycle evidence (`PREFLIGHT_CLASSIFIED`, `IMPLEMENTATION_STARTED`, `REVIEW_PHASE_STARTED`), real review-skill telemetry (`SKILL_SELECTED`, `SKILL_REFERENCE_LOADED`), required review artifacts, and best-effort task-event integrity before `DONE`.
- `build-scoped-diff` can also write `runtime/reviews/<task-id>-<review-type>-scoped.json` so reviewer prompts know whether scoped diff fell back to full diff.
- `build-review-context` writes `runtime/reviews/<task-id>-<review-type>-review-context.json` plus a sibling markdown snapshot referenced by `rule_context.artifact_path`; the JSON records selected rule pack, omitted sections, sanitized rule-context metadata, and scoped-diff fallback evidence for token economy mode.
- Classification roots and trigger regexes are configurable in `garda-agent-orchestrator/live/config/paths.json`.
- Optional specialist reviews (`api`, `test`, `performance`, `infra`, `dependency`) become required only when enabled in `garda-agent-orchestrator/live/config/review-capabilities.json`.
- Gate commands can append JSONL metrics to `garda-agent-orchestrator/runtime/metrics.jsonl` for threshold tuning.
- Task event timeline is written to `garda-agent-orchestrator/runtime/task-events/<task-id>.jsonl` (plus aggregate `all-tasks.jsonl`) with best-effort append locking for both files.
- New task-event writes include a per-task hash chain (`integrity.task_sequence`, `prev_event_sha256`, `event_sha256`) to detect local tampering, replay, and out-of-order inserts after the fact.
- Task timeline completeness is surfaced by `status` and `doctor`, not just completion-gate.
- Human-readable timeline can be generated with `node garda-agent-orchestrator/bin/garda.js gate task-events-summary`; summary output includes `IntegrityStatus`.
- Compact task audit summary can be generated with `node garda-agent-orchestrator/bin/garda.js gate task-audit-summary --task-id "<task-id>"`; it shows status, gates, changed files, evidence paths, blockers, and final closeout contract data. Use `--as-json` for structured output; on `PASS` it also materializes canonical `runtime/reviews/<task-id>-final-closeout.{json,md}` artifacts. Non-zero exit when status is not `PASS`.
- Deterministic next-step guidance can be generated with `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."`; it reports the next gate command, effective `full_suite_validation` config path/value, review execution policy, missing artifacts, and review trust status. This is the default task loop, not only a diagnostic fallback.

## Project Discovery Snapshot
- Discovery source: git_index_and_worktree
- Files considered: 515
- Detected stacks: Node.js or JavaScript, TypeScript
- Top-level directories: .agents, .claude, .github, .idea, .node-build, .pytest_cache, .review-temp, .scripts-build, .vscode, docs
- Full report: `garda-agent-orchestrator/live/project-discovery.md`

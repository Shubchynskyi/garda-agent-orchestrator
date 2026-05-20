# CLI Reference

Complete command reference for Garda Agent Orchestrator.

## Public Surface

The runtime is Node-only.

- Published command names: `garda`, `gao`, `garda-agent-orchestrator`
- Source invocation: `node bin/garda.js <command>`
- Runtime baseline: `Node.js ^22.13.0 || >=24.0.0` (Node 24 LTS primary, Node 22.13+ compatibility)
- Source installs from a git/source checkout run `npm prepare`, which builds the generated `bin/garda.js` launcher and compiled runtime before execution.

Runtime compatibility matrix:

| Node.js line | Garda 1.1.x status | Notes |
|---|---|---|
| Node 24 LTS | Supported primary runtime | Covered by `package.json` engines, CI, release validation, and cross-platform smoke. |
| Node 22.13+ LTS | Supported compatibility runtime | Covered by `package.json` engines, CI typecheck/test/release validation, runtime diagnostics, docs, and cross-platform smoke. |
| Node 23, Node 22 before 22.13, and Node 20 or older | Untested / not officially supported | Outside the tested `^22.13.0 || >=24.0.0` support matrix. Doctor warns, but runtime version mismatch alone does not block execution. |

---

## Core Commands

### `garda`

Safe overview of the current workspace.

```text
garda
```

### `garda setup`

First-run onboarding. Recommended entrypoint for end users.

```text
garda setup
garda setup --target-root "." --no-prompt --assistant-language "English" --assistant-brevity concise --source-of-truth Codex --enforce-no-auto-commit no --claude-orchestrator-full-access no --token-economy-enabled yes
```

What it does:
- deploys or refreshes `./garda-agent-orchestrator/`
- collects or accepts the 6 init answers
- writes `runtime/init-answers.json`
- runs install
- validates `MANIFEST.md`
- leaves final agent onboarding for `AGENT_INIT_PROMPT.md` and `garda agent-init`

Notes:
- `setup` supports `--active-agent-files` for fully scripted flows, but ordinary onboarding leaves explicit active-agent-file confirmation to `garda agent-init`.
- After CLI setup the workspace is still in agent handoff state, not ready for task execution.

### `garda agent-init`

Hard code-level onboarding gate. This command writes `runtime/agent-init-state.json` and blocks `Workspace ready` until it passes.

```text
garda agent-init --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --active-agent-files "AGENTS.md, CLAUDE.md" --project-rules-updated yes --skills-prompted yes
```

### `garda status`

```text
garda status --target-root "."
garda status --target-root "." --compact
garda status why-blocked --target-root "."
```

Notes:
- `status` prints the normal workspace readiness snapshot.
- While a valid `runtime/agent-init-state.json` has `ProjectMemoryInitialized=false` or `ProjectMemoryValidated=false`, `status` reports `PROJECT_MEMORY_PENDING` and prints `ProjectMemoryInitRefreshPrompt`.
- Malformed or invalid `agent-init-state.json` remains an `AGENT_STATE_INVALID` readiness problem; rerun `garda agent-init` after repair so the memory readiness fields can be trusted.
- When both `ProjectMemoryInitialized=true` and `ProjectMemoryValidated=true`, `status` treats durable project memory as already confirmed and does not recommend the expensive full init/refresh prompt again.
- In a self-hosted source checkout, `status` still shows trusted protected-manifest `DRIFT`, but when the trusted manifest itself was recorded as `is_source_checkout=true` that drift is downgraded to informational instead of forcing readiness to `false` on its own.
- `status --compact` preserves the not-ready output but reduces the green path to a single summary line: `GARDA_STATUS: ready | source=<provider>`.
- `status why-blocked` inspects `TASK.md`, task timelines, and failed gate markers to explain why `BLOCKED`, `IN_PROGRESS`, or `IN_REVIEW` tasks are stalled.
- `status why-blocked` also surfaces task-event locks that can block timeline writes and review-artifact locks that can block `runtime/reviews` artifact persistence.
- The canonical task timeline is `garda-agent-orchestrator/runtime/task-events/<task-id>.jsonl`; status rolls up derived task-event indexes rather than replacing the per-task JSONL source of truth.
- See [Operator Consistency and Recovery Runbook](operator-consistency-runbook.md) for the canonical-vs-derived model and recovery guidance.

### `garda doctor`

Runs `garda verify` plus `garda gate validate-manifest`.

```text
garda doctor --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda doctor --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --compact
garda doctor --target-root "." --cleanup-stale-locks --dry-run
garda doctor --target-root "." --cleanup-stale-locks
garda doctor explain COMPILE_GATE_FAILED
garda doctor explain --list
```

Notes:
- `doctor` remains the aggregate verify + manifest + timeline health command.
- On failure, human `doctor` output starts with a concise `Doctor Failure Summary` before the detailed evidence dump. The summary lists the primary blockers, highlights failure state, and prints the most actionable next command when a safe remediation is known, such as protected-manifest repair after operator verification.
- In a self-hosted source checkout, trusted protected-manifest `DRIFT` remains visible in `doctor`, but source-checkout drift is reported as informational unless the task-context gates classify it as real pre-start or lifecycle drift.
- `doctor --compact` preserves failure diagnostics but reduces the green path to a single line: `Doctor: PASSED | verify=PASSED | manifest=PASSED`.
- `doctor` reports task-event lock health under `garda-agent-orchestrator/runtime/task-events/*.lock`, including owner metadata, stale-vs-live assessment, and remediation guidance.
- `doctor` also reports review-artifact lock health under `garda-agent-orchestrator/runtime/reviews/*.lock`, including owner metadata, stale-vs-live assessment, and remediation guidance.
- `doctor --cleanup-stale-locks --dry-run` previews stale task-event locks and stale review-artifact locks that are safe to remove; rerun without `--dry-run` to delete only those proven-stale lock directories.
- `doctor explain <FAILURE_ID>` prints remediation steps for known failure IDs such as `TASK_MODE_NOT_ENTERED`, `COMPILE_GATE_FAILED`, and `TIMELINE_INCOMPLETE`.
- `doctor explain --list` prints the current remediation database keys.
- `doctor` uses the same runtime-consistency vocabulary as the operator runbook: canonical per-task JSONL, derived indexes, trusted protected manifest, and stale lock cleanup.
- See [Operator Consistency and Recovery Runbook](operator-consistency-runbook.md) for the operator playbook behind these diagnostics.

### `garda preprompt`

Read-only task bootstrap helper. It returns current task/workspace context together with the canonical next commands for the active lifecycle stage.

```text
garda preprompt task --task-id "T-137" --json --target-root "."
garda preprompt task --task-id "T-137" --target-root "."
```

Notes:
- `preprompt task` does not modify task state, timelines, or review artifacts.
- `preprompt task --json` reuses the current preflight artifact when present to derive required review types and the post-implementation command sequence.
- `preprompt task --json` exposes `project_memory.initialization_state` and `project_memory.init_refresh_prompt`; the top-level prompt is present only while `agent-init-state.json` is missing, invalid, or does not yet record both `ProjectMemoryInitialized=true` and `ProjectMemoryValidated=true`.
- Missing or incomplete project-memory files make `project_memory.status` partial and add warnings, but they do not by themselves set the top-level `init_refresh_prompt` when agent-init state already records validated memory.
- When the repo maps `optional-skill-selection-policy` through `garda-agent-orchestrator/live/config/garda.config.json`, `preprompt task --json` also shows `diagnostics.optional_skills`, including the policy mode, compact selection summary, selected skill ids, `selected_installed_skill_paths`, or an explicit `as_is` fallback reason. A stray policy file that is not mapped through `garda.config.json` does not activate the feature. The diagnostics reuse the current preflight scope when present and otherwise fall back to task-start context such as task summary and persisted planned scope.
- If `diagnostics.optional_skills.blocker` is present under `required` or `strict`, `preprompt task` remains read-only but exits non-zero so the startup flow cannot proceed past that blocker silently.
- If the workspace is dirty but no reusable staged scope or existing preflight scope is available, the output reports that blocker instead of inventing a misleading `--use-staged` classify command.
- Output stays bounded: review-artifact and changed-file arrays include counts plus truncation metadata instead of dumping arbitrarily large lists.

### `garda next-step`

Deterministic task navigator. Use this as the default task loop: run it before the first gate, after every suggested command, and after any gate failure.

```text
garda next-step "T-137" --target-root "."
garda next-step "T-137" --as-json --target-root "."
garda gate next-step "T-137" --repo-root "."
garda gate next-step --preflight-path "garda-agent-orchestrator/runtime/reviews/T-137-preflight.json" --repo-root "."
```

Notes:
- `next-step` reads current task events and review artifacts, then prints the current status, effective full-suite config including placement, review policy, missing artifacts, and the single next command to run.
- The command accepts either a positional task id (`T-137`), `--task-id`, or a `--preflight-path` that ends in `<task-id>-preflight.json`.
- Before the first preflight, `next-step` reuses task-mode `planned_changed_files` to print concrete `classify-change --changed-file` arguments; agents should not invent placeholder paths.
- After every suggested command completes, rerun `garda next-step "T-137"` instead of guessing gate flags, reading default templates for effective config, or starting with `compile-gate`.
- If preflight scope touches protected orchestrator control-plane files without `--orchestrator-work`, restart task mode with the exact command printed by `next-step` or by the failed preflight gate before continuing, except in application workspaces where Garda self-guard is on and `next-step` routes to `operator-maintenance`.
- In materialized/application workspaces the `garda-agent-orchestrator/` bundle is vendor/control-plane. With `garda_self_guard=on`, agents cannot self-escalate into `--orchestrator-work`; operators must run update/repair/maintenance or deliberately relax the policy with `workflow set --garda-self-guard off`.
- Review navigation uses the launch batch, not only the legacy single-review field. Human output can include `ReviewLaunchableBatch`, `BlockedReviewLanes`, and `ReviewFailedCurrent`; JSON includes `review.launchable_review_types`, `review.blocked_review_lanes`, and `review.failed_review_type`.
- `NextReview` / `review.next_review_type` remain compatibility fields for older single-lane consumers. When a launch batch contains multiple independent lanes, agents may launch those reviewers in parallel only after `next-step` says they are launchable.
- `BlockedReviewLanes` names dependency reasons such as upstream review types or `full-suite-validation`. Full-suite placement controls when that dependency appears: `after_compile_before_reviews` blocks reviewer launch after compile until current full-suite evidence exists, `before_test_review` blocks only the `test` reviewer, and `before_completion` leaves reviewer context neutral while completion still enforces the suite later.
- True docs-only scopes record `NOT_REQUIRED` full-suite evidence instead of running the configured suite, even when security-sensitive documentation still requires security review. Mixed docs plus code/test/config scopes stay on the normal full validation path.
- A failed current-cycle review takes remediation priority over downstream launch work. Fix and rerun or validly reuse the failed review as PASS before treating blocked downstream lanes as ready.
- For mandatory reviews, `next-step`, rule packs, orchestration skills, review contexts, and provider bridges expect a newly spawned clean-context reviewer for the current review context; do not reuse an existing reviewer session, and close or release the reviewer sub-agent after `record-review-result` or `record-review-receipt` persists the receipt.

### `garda debug env`

Show environment and runtime triage details for debugging CLI or workspace issues.

```text
garda debug env --target-root "."
garda debug env --target-root "." --json
```

Notes:
- `debug env` is the public `debug` subcommand surface.
- `--json` emits the same environment snapshot in machine-readable form.

### `garda stats`

Show token-overhead and runtime analytics for the workspace or a single task.

```text
garda stats --target-root "."
garda stats --target-root "." --json
garda stats "T-137" --target-root "."
garda stats --task-id "T-137" --target-root "."
garda stats "T-137" --target-root "." --json
garda stats --task-id "T-137" --target-root "." --json
```

Notes:
- A positional task id is equivalent to `--task-id` for task-specific stats.
- Task-specific stats include review attempt pass/fail/reuse/missing counts when review evidence is available; aggregate stats keep the existing aggregate schema.
- Output-compaction reporting uses `chars` as the primary unit. When a token estimate is shown, it is explicitly a secondary estimate of suppressed output, not model-token usage.
- Human-readable stats output uses color when the terminal supports it; `--json` remains uncolored.

### `garda task`

Read-only task inspection namespace. Start with a task id, then choose the view.

```text
garda task "T-137" stats --target-root "."
garda task "T-137" events --repo-root "."
garda task "T-137" events --repo-root "." --include-details
garda task "T-137" events --repo-root "." --as-json
```

Notes:
- `garda task "<task-id>" stats` routes to the same per-task analytics as `garda stats "<task-id>"`.
- `garda task "<task-id>" events` prints the task event timeline without changing lifecycle state.
- Human task event output uses color when the terminal supports it; `--as-json`, `--compact-latest-cycle`, and persisted `--output-path` output remain uncolored.
- The task namespace is inspection-only. It does not alias, replace, or modify `next-step`, and the events wrapper does not expose `--output-path`; use the explicit gate command when intentionally materializing an artifact.

### `garda html`

Write a static read-only HTML report and print a browser link.

```text
garda html --target-root "."
garda html --target-root "." --output-path "garda-agent-orchestrator/runtime/reports/garda-report.html"
garda html --target-root "." --snapshot --retain-snapshots 5
garda html --target-root "." --max-detailed-tasks 5
garda html --target-root "." --json
```

Notes:
- The report has tabs for the canonical upper `TASK.md` Active Queue, current workflow settings, and short operator instructions.
- Clicking a task row opens read-only details. Deep task details are lazy/skipped by default for static reports so large runtime histories return promptly.
- Use `--max-detailed-tasks N` to embed heavier stats, lifecycle events, audit summaries, and artifact metadata for up to N task rows in the generated snapshot.
- The command refreshes a stable latest HTML file and prints a `file://` URL. It does not start a server or mutate task lifecycle state.
- `--snapshot` writes a timestamped copy under `runtime/reports/snapshots`; `--retain-snapshots N` keeps the newest N generated snapshots.

### `garda ui`

Start a foreground localhost UI and print a browser URL.

```text
garda ui --target-root "."
garda ui --target-root "." --port 17340
garda ui --target-root "." --language ru
garda ui --target-root "." --idle-minutes 15 --idle-warning-seconds 60
garda ui --target-root "." --no-idle-shutdown
garda ui --target-root "." --actions
```

Notes:
- The server uses Node built-ins only and binds to `127.0.0.1`; it does not add Express, Vite, React, or other runtime dependencies.
- The terminal stays occupied while the UI is running. Stop it with Ctrl+C, or use the guarded Server Status stop action in the browser.
- Idle shutdown is enabled by default. The browser sends throttled activity pings, the server owns the authoritative `last_activity_at`, idle threshold, warning countdown, and shutdown deadline, and closed tabs or sleeping browsers still let the foreground process stop after the deadline.
- During the warning window the Server Status panel shows a countdown slider. Any real user activity before the deadline resets the server-side timer.
- After the local server shuts down, in-page Launch cannot work because no process remains to receive the request. Rerun `garda ui --target-root "."` from a terminal.
- The dashboard loads the canonical upper `TASK.md` queue immediately, with overview counters, task search, status/priority filters, workflow config and instructions tabs, and a task detail panel.
- The dashboard UI chrome supports English and Russian. Use `--language en` or `--language ru` for the initial language; the visible language panel stores the browser-local selection for that page. English remains the fallback/base language for missing or future packs.
- Localization covers UI chrome only. CLI commands, task IDs, config keys, enum values, file paths, raw gate/review/artifact output, and machine-readable JSON stay exact and untranslated.
- Per-task details are fetched lazily from read-only local JSON endpoints when the user clicks `Load details`, including gate timeline, blockers, review summary, and artifact links.
- By default the UI does not run shell commands, mutate task lifecycle state, edit workflow config, or write settings.
- `--actions` exposes only allow-listed Garda commands from the Actions tab. Action requests support preview mode, require typed confirmation for mutating actions such as `html-report`, and append runtime audit JSONL entries under `garda-agent-orchestrator/runtime/ui-actions/`.
- With `--actions`, the workflow tab also exposes a guarded settings editor for allow-listed safe integer workflow knobs such as full-suite output limits and project-memory retention/tuning values. The editor supports preview and execution modes, requires the exact confirmation phrase `APPLY GARDA SETTING`, and runs the existing audited `garda workflow set` command path with `--operator-confirmed yes`; it does not write `workflow-config.json` directly.
- High-risk policy switches such as full-suite enablement, review policy, scope-budget policy, review-cycle policy, and task-reset enablement remain read-only in the UI and must be changed through the explicit workflow command surface.
- Action execution requires the page's per-process request token, exact localhost `Origin`, and JSON content type; cross-origin localhost posts are rejected.
- The Actions tab does not accept arbitrary shell text; each action maps to a fixed existing Garda command.

### `garda off`

Hide managed Garda root instruction files while keeping the deployed bundle and `TASK.md` available.

### `garda on`

Restore managed Garda root instruction files after a previous `garda off`.

Temporarily hide or restore Garda-owned root agent instruction files without uninstalling the deployed bundle.

```text
garda off --target-root "." --dry-run
garda off --target-root "."
garda on --target-root "." --dry-run
garda on --target-root "."
```

Notes:
- `garda off` moves managed root agent surfaces such as `AGENTS.md`, active provider entrypoints, provider bridge profiles, and `.agents/workflows/start-task.md` into `garda-agent-orchestrator/runtime/switch/off/`.
- `garda on` restores those managed files from `runtime/switch/off/`.
- User-owned root alternatives are moved into `runtime/switch/on/` when turning Garda back on, and restored when turning it off again.
- `TASK.md` remains visible; the switch is for root agent instruction surfaces, not task queue removal.
- Setup/update/reinit keep an active managed `.agentignore` block for bulky Garda-generated artifacts while leaving command, rule, config, and explicit runtime evidence paths readable.
- `garda off` writes a separate managed `.agentignore` block pointing agents away from `garda-agent-orchestrator/`; `garda on` removes only that off-mode block and leaves the active block in place.
- Conflicts fail closed without overwriting user-authored files. Use `--dry-run` to inspect planned moves before changing a workspace.

### `garda bootstrap`

Deploy the bundle without running install.

```text
garda bootstrap
garda bootstrap --repo-url "<git-url>" --branch "<branch>"
```

### `garda install`

Deploy or refresh the orchestrator from prepared init answers.

```text
garda install --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda install --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --repo-url "<git-url>" --branch "<branch>"
```

### `garda init`

Re-materialize `live/` from an existing deployed bundle.

```text
garda init --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
```

### `garda reinit`

Change init answers without a full reinstall.

```text
garda reinit --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
```

Notes:
- `reinit` re-materializes `live/` based on new answers and enforces a hard atomic consistency invariant for the deployed bundle.
- After sync, a mandatory post-reinit invariant check proves the deployed bundle is structurally complete (includes `bin`, `dist`, `package.json`, `VERSION`, and `template`) relative to the source being applied.

### `garda verify`

Validate deployment consistency and rule contracts.

```text
garda verify --target-root "." --source-of-truth "Codex" --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda verify --target-root "." --source-of-truth "Codex" --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --compact
```

Provider values: `Claude`, `Codex`, `Cursor`, `Gemini`, `Qwen`, `GitHubCopilot`, `Windsurf`, `Junie`, `Antigravity`.

Notes:
- `verify --compact` preserves failure output but reduces the green path to `Verification: PASS | paths=<count> | violations=0`.

### `garda check-update`

Compare the current deployment with a newer npm package or a local unpacked bundle root. By default this only checks; `--apply` performs the update immediately.

```text
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --apply --no-prompt
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --dry-run
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --package-spec "garda-agent-orchestrator@latest"
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --source-path "."
```

Notes:
- By default `check-update` uses the deployed package name from `garda-agent-orchestrator/package.json` with the npm `latest` tag.
- `--package-spec` accepts npm specs such as `garda-agent-orchestrator@<target-version>`, dist-tags like `@latest`, and local tarballs like `.\garda-agent-orchestrator-<target-version>.tgz`.
- Trusted npm registry specs are resolved before apply to an exact `name@version` package with registry integrity metadata. Update and check-update output include requested, exact, resolved-version, and resolved-integrity fields when registry provenance is available.
- `--source-path` is for local testing against an unpacked repo or bundle directory.
- `--trust-override` is an explicit bypass for non-allowlisted npm specs, git sources, or local `--source-path` testing, and the public CLI only accepts it together with `--no-prompt`.
- Ordinary CLI/runtime flows ignore `GARDA_UPDATE_TRUST_OVERRIDE`; that environment variable is reserved for test-only harness paths, not for production or CI.
- `--apply` runs the full update lifecycle after bundle sync, re-materializes `live/`, applies built-in live-rule contract migrations for existing workspaces, runs verify plus manifest validation, enforces a hard atomic consistency invariant for the deployed bundle, defers `VERSION` until lifecycle success, and creates rollback artifacts for the last applied update.
- Successful apply runs also invalidate cached bundle runtime modules so long-lived host processes reload the freshly synced bundle on later commands.

### `garda update`

Apply the update workflow directly.

```text
garda update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --package-spec "garda-agent-orchestrator@latest"
garda update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --source-path "."
garda update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --dry-run
```

Notes:
- `update` always applies the update workflow unless `--dry-run` is used.
- Trusted npm registry specs are resolved before install to an exact package version with integrity metadata, and the resolved provenance is recorded in CLI output and update reports.
- Use `--trust-override --no-prompt` only when you intentionally bypass the trusted-source allowlist for a local or non-standard source; the update report records that override.
- Successful applies sync bundle files, run install, re-materialize `live/`, apply built-in live-rule contract migrations for existing workspaces, run verify plus manifest validation, and only then write the final `VERSION` marker.
- Successful applies create rollback artifacts under `garda-agent-orchestrator/runtime/update-rollbacks/` and `garda-agent-orchestrator/runtime/bundle-backups/`.
- Successful applies also invalidate cached bundle runtime modules so long-lived host processes do not keep stale command or validator code resident after the bundle changes.
- Update reports now reflect actual execution status; steps with no configured runner are reported as skipped rather than pass.
- Use `garda check-update --apply` when you want a compare-first flow with optional apply.

### `garda update git`

Apply the update workflow from a git source explicitly.

```text
garda update git --target-root "." --repo-url "https://github.com/Shubchynskyi/garda-agent-orchestrator.git"
garda update git --target-root "." --repo-url "." --check-only
garda update git --target-root "." --repo-url "." --branch "master"
garda update git
```

Notes:
- `update git` uses `git clone --depth 1` into a temp directory, then runs the same update lifecycle as npm-based `update`.
- `--check-only` compares the git source without applying it.
- Trusted git sources stay in enforced mode; if you bypass git-source trust with `--trust-override --no-prompt`, that override is recorded in CLI output and the update report.
- With no extra flags, `garda update git` targets the current directory and uses the default GitHub repository URL.
- Successful applies invalidate cached bundle runtime modules just like npm-based `update`, so long-lived host processes reload the new bundle on later commands.

### `garda rollback`

Rollback to a specific orchestrator version or restore from the latest rollback snapshot.

```text
garda rollback --target-root "."
garda rollback --target-root "." --dry-run
garda rollback --target-root "." --snapshot-path "garda-agent-orchestrator/runtime/update-rollbacks/update-20260325-114000"
garda rollback --target-root "." --to-version "<target-version>" --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda rollback --target-root "." --to-version "<target-version>" --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --source-path "."
garda rollback --target-root "." --to-version "<target-version>" --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --package-spec "garda-agent-orchestrator@<target-version>"
```

Notes:
- Without `--to-version`, `rollback` restores the latest saved pre-update workspace snapshot and, when available, the latest bundle backup created by `update` or `check-update --apply`.
- With `--to-version`, `rollback` acquires that orchestrator version, syncs the bundle, re-runs install/materialization, and updates `VERSION` only after success.
- `--init-answers-path` is required for version-based rollback because the workspace is re-materialized for the requested version.
- `--snapshot-path` applies to snapshot-mode rollback; with no `--snapshot-path`, `rollback` uses the latest saved rollback snapshot automatically.
- Older updates created before rollback metadata persistence may require manual recovery.
- Successful non-dry-run rollback also invalidates cached bundle runtime modules so later commands in the same host process reload the restored bundle instead of stale in-memory code.

### `garda cleanup`

Remove retained runtime artifacts under `garda-agent-orchestrator/runtime/` using count- and age-based retention limits. Use `--dry-run` to preview removals without deleting anything.

```text
garda cleanup --target-root "."
garda cleanup --target-root "." --dry-run
garda cleanup --target-root "." --max-age-days 14 --max-backups 5 --max-task-events 30
garda cleanup --target-root "." --max-reviews 20 --max-working-plans 50 --max-update-rollbacks 10 --max-update-reports 10 --max-bundle-backups 5
garda cleanup policy --target-root "."
garda cleanup policy edit --target-root "."
garda cleanup policy --edit --target-root "."
garda cleanup policy reset --target-root "."
garda cleanup policy --retention-mode summary --compress-after-days 14 --target-root "."
```

Notes:
- `cleanup` only operates on supported runtime artifact categories: backups, bundle-backups, task-event logs, review artifacts, Markdown working plans, update-rollbacks, and update-reports.
- `--dry-run` reports projected removals and bytes reclaimed without mutating the filesystem.
- Retention accepts both a global age limit (`--max-age-days`) and per-category count limits (`--max-backups`, `--max-task-events`, `--max-reviews`, `--max-working-plans`, `--max-update-rollbacks`, `--max-update-reports`, `--max-bundle-backups`).
- Count-based eviction uses **real filesystem recency** (file modification time), not task-id ordering. When the number of items exceeds the cap, the least recently modified entries are removed first. When modification times are equal, task-id / filename order is used as a deterministic tie-breaker.
- For review artifacts, recency is determined per task group: the most recent `mtime` among all files in a `T-xxx-*` group represents that group's freshness.
- Working-plan retention is limited to `garda-agent-orchestrator/runtime/plans/*.md` files named after canonical task IDs. Active task plans are preserved, and cleanup never targets user project `plans/` directories outside the Garda runtime path.
- `runtime/task-events/all-tasks.jsonl` is subject to aggregate line-count retention (`--max-aggregate-lines` via cleanup/gc policy). Tail pruning keeps the most recent entries and discards the oldest when the aggregate exceeds the configured cap. The file is never deleted outright by cleanup.
- `runtime/task-events/all-tasks.jsonl` is a derived aggregate index; the canonical task record remains `runtime/task-events/<task-id>.jsonl`.
- Cleanup runs under the lifecycle operation lock to avoid concurrent mutation of the same runtime state.
- `cleanup policy` shows the current persistent review-artifact storage settings from `live/config/review-artifact-storage.json`.
- `cleanup policy edit` is the dialog-first editor for retention mode, compression threshold, and receipt preservation. `cleanup policy --edit` is an alias.
- `cleanup policy reset` restores the bundled default policy template. `cleanup policy --reset` is an alias.

### `garda repair`

Inspect and repair rebuildable runtime control-plane state without hand-editing files.

```text
garda repair inspect --target-root "."
garda repair inspect --target-root "." --json
garda repair rebuild-indexes --target-root "."
garda repair rebuild-indexes --target-root "." --confirm
garda repair protected-manifest --target-root "."
garda repair protected-manifest --target-root "." --confirm
garda repair locks --target-root "."
garda repair locks --target-root "." --cleanup-stale
garda repair locks --target-root "." --cleanup-stale --confirm
```

Notes:
- `repair inspect` is read-only. It names canonical state (`runtime/task-events/<task-id>.jsonl`, review artifacts, protected manifest) separately from rebuildable derived indexes (`.timeline-summary.json`, `reviews-index.json`).
- `repair rebuild-indexes` is dry-run by default. With `--confirm`, it rebuilds `.timeline-summary.json` from canonical per-task event logs and rebuilds `runtime/reviews/reviews-index.json` from review artifact files.
- `repair protected-manifest` is dry-run by default. With `--confirm`, it refreshes the trusted protected control-plane manifest from the current workspace snapshot.
- `repair locks` inspects task-event, review-artifact, and completion-finalization lock classes. Cleanup is dry-run unless both `--cleanup-stale` and `--confirm` are provided.
- Completion-finalization locks are inspected only; they are not deleted by `repair locks` because they protect task finalization.

### `garda gc`

Extended cleanup helper with dry-run default, category filters, and `clean` alias support.

```text
garda gc --target-root "."
garda gc --target-root "." --dry-run
garda gc --target-root "." --confirm --category reviews --category task-events
garda gc --target-root "." --category plans --max-working-plans 25
garda clean --target-root "." --confirm
```

Notes:
- `gc` is dry-run by default; pass `--confirm` to apply removals.
- `clean` is a public alias for `gc`.
- `--category plans` limits `gc` to retained Markdown working plans under `garda-agent-orchestrator/runtime/plans/*.md`; active task plans are preserved.

### Task Reset Aliases

Safe aliases for the guarded task reset gate. They route directly to `garda gate task-reset` and enforce the same confirmation requirements.

```text
garda task-reset T-137 --reopen --dry-run
garda workflow set --target-root "." --task-reset-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda task-reset T-137 --discard --confirm
garda task reset T-137 --reopen --confirm
```

Notes:
- `task-reset` and `task reset` are aliases that route to the `garda gate task-reset` command.
- They route through `garda gate task-reset --task-id "<task-id>" --reopen --dry-run/--confirm --repo-root "."` or `--discard --confirm`.
- Confirmed task-reset mutations are disabled by default. `--dry-run` remains available for inspection, but `--confirm` requires an audited opt-in via `garda workflow set --task-reset-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`; manual JSON edits to `task_reset.enabled=true` are rejected unless matching workflow-set audit evidence exists.
- Task-reset-shaped near-misses (e.g., `garda taskreset`, `garda resettask`) fail early with remediation guidance before the bootstrap directory creation process.

### `garda workflow`

Show or change repo-local workflow configuration.

```text
garda workflow --target-root "."
garda workflow show --target-root "." --json
garda workflow set --target-root "." --full-suite-enabled true --full-suite-placement before_test_review --full-suite-command "npm test" --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda workflow set --target-root "." --review-execution-policy strict_sequential --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda workflow set --target-root "." --scope-budget-enabled true --scope-budget-max-review-tokens 50000 --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda workflow set --target-root "." --review-cycle-enabled true --review-cycle-max-total-non-test-reviews 30 --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda workflow set --target-root "." --review-cycle-auto-split-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda workflow set --target-root "." --task-reset-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda workflow set --target-root "." --garda-self-guard on
garda workflow set --target-root "." --garda-self-guard off --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
garda workflow explain --target-root "."
```

Notes:
- `workflow` with no subcommand behaves like `workflow show`.
- The current surface manages repo-local `full_suite_validation`, `review_execution_policy`, `scope_budget_guard`, `review_cycle_guard`, and `task_reset` settings in `live/config/workflow-config.json`.
- `workflow set` requires explicit operator approval with `--operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`; agents must not approve workflow-config mutations for themselves.
- `--garda-self-guard on` maps to `orchestrator_work_policy.mode=deny_agent_entry`; `off` maps to `require_operator_confirmation` and requires explicit operator approval.
- Supported `review_execution_policy` modes are `parallel_all`, `test_after_code`, `code_first_optional`, and `strict_sequential`.
- `parallel_all` can make code, security, refactor, API, and other specialist lanes independent. Full-suite placement still applies: `before_test_review` gates only `test`, `after_compile_before_reviews` gates all reviewers after compile, and `before_completion` defers enforcement until completion.
- Fresh materialization writes the recommended default `review_execution_policy.mode=code_first_optional`.
- Existing repos that still omit `review_execution_policy` stay on the legacy compatibility path (`test` waits for all required upstream reviews, other review types remain independent) until an operator explicitly sets one of the supported modes.
- Scope budget guard settings can be changed with `--scope-budget-enabled true|false`, `--scope-budget-action BLOCK_FOR_SPLIT|WARN_ONLY`, `--scope-budget-profiles strict,balanced`, `--scope-budget-max-files N`, `--scope-budget-max-changed-lines N`, `--scope-budget-max-required-reviews N`, and `--scope-budget-max-review-tokens N`.
- The default scope budget guard is enabled for `strict`, uses `BLOCK_FOR_SPLIT`, and limits large tasks before expensive gates with `max_files=12`, `max_changed_lines=1200`, `max_required_reviews=6`, and `max_review_tokens=50000`.
- `max_required_reviews` means required review lanes from the current preflight, not completed review attempts.
- `max_review_tokens` is a heuristic review forecast, not a measured tokenizer count; use `garda workflow explain` to show the effective workflow guard settings, behavior, and unblock options.
- Review cycle guard settings can be changed with `--review-cycle-enabled true|false`, `--review-cycle-action BLOCK_FOR_OPERATOR_DECISION|WARN_ONLY`, `--review-cycle-max-failed-non-test-reviews N`, `--review-cycle-max-total-non-test-reviews N`, `--review-cycle-excluded-review-types test`, and `--review-cycle-auto-split-enabled true|false`.
- The default review cycle guard is enabled, uses `BLOCK_FOR_OPERATOR_DECISION`, blocks when failed non-test reviews exceed `15` or total non-test review attempts exceed `30`, and excludes `test` review from counting.
- Review cycle attempts are counted from review invocation and recorded-review timeline evidence with deduplication only when both reviewer identity and review context hash match; `test` is excluded because reaching test review means upstream code-oriented review gates already allowed the task forward.
- When `review_cycle_guard.action=BLOCK_FOR_OPERATOR_DECISION`, `next-step` blocks compile, review, and full-suite continuation until the operator changes config, splits work, or otherwise chooses the recovery path.
- When `review_cycle_guard.auto_split_enabled=false` (default), `next-step` tells the agent to wait for operator direction after a blocking review-cycle violation.
- When `review_cycle_guard.auto_split_enabled=true`, `next-step` emits a dedicated auto-split prompt artifact for the agent from the bundled template at `template/docs/prompts/review-cycle-auto-split.md`. The template is materialized into `runtime/reviews/<task-id>-review-cycle-auto-split-prompt.md` only when a blocking review-cycle violation actually happens. The prompt tells the agent to preserve unfinished parent diff through the split checkpoint path, create maximally small linked parent-derived child tasks such as `<task-id>-1`, choose the next non-conflicting suffix from `TASK.md`, rerun `next-step` so the parent can move from `SPLIT_REQUIRED` to `DECOMPOSED`, and then execute those child tasks sequentially. Strict decomposition `split-required` decisions use the same linked-child routing shape but are stricter: child rows must match the recorded proposed-child list, exist in `TASK.md`, remain parent-derived, and keep profile `strict`. The prompt must not auto-commit unfinished or unreviewed work, and it must not mark the parent `DONE` merely because split work exists.
- `WARN_ONLY` does not block the next gate, but `next-step` prints the review-cycle violation under `Warnings` so the operator still sees the over-budget review cycle.
- Task reset mutations are controlled by `task_reset.enabled`, default to `false`, and can be changed with `--task-reset-enabled true|false`. Enabling task reset through `workflow set` records the audit evidence required by confirmed `garda gate task-reset` mutations.

### `garda templates`

Show, validate, and manage user-owned effective message template overrides.

```text
garda templates --target-root "."
garda templates list --target-root "."
garda templates show --template final-report --target-root "."
garda templates path --template commit-message --target-root "." --json
garda templates edit --template reviewer-prompt --target-root "."
garda templates validate --target-root "."
garda templates validate --template final-report --target-root "."
garda templates reset --template final-report --target-root "."
```

Notes:
- `templates` with no subcommand behaves like `templates list`.
- Supported template ids are `final-report`, `commit-message`, and `reviewer-prompt`.
- Built-in templates live under `template/templates/**`; user-owned overrides live under `live/templates/*.user.*`.
- `templates edit` creates the user override file when it is missing and prints the path to edit. It does not launch an editor.
- `templates validate` fails closed when an effective template removes required placeholders, edits protected Garda sections, allows auto-commit wording, or breaks the JSON contract for commit-message templates.
- `templates reset` removes only the selected user-owned override and restores the built-in effective template.

### `garda review-capabilities`

Show, list, enable, or disable repo-local optional review capabilities without hand-editing `review-capabilities.json`.

```text
garda review-capabilities --target-root "."
garda review-capabilities list --target-root "."
garda review-capabilities show --target-root "." --json
garda review-capabilities enable api test --target-root "."
garda review-capabilities disable performance --target-root "."
```

Notes:
- `review-capabilities` with no subcommand behaves like `review-capabilities show`.
- `review-capabilities list` is an alias for `review-capabilities show`.
- Supported toggle targets are `api`, `test`, `performance`, `infra`, and `dependency`.
- Enabling a capability validates that a matching live review skill is present under `live/skills/**`; bridge presence is reported separately for bridge-hosted providers, but root-entrypoint providers use the live skill directly.
- Unsupported custom live skills remain manual-only and do not become preflight-triggered review types automatically.

### `garda profile`

Manage the active workspace profile and user-defined profile presets.

```text
garda profile list --target-root "."
garda profile current --target-root "."
garda profile use strict --target-root "."
garda profile create --target-root "."
garda profile create my-profile --target-root "." --copy-from balanced --depth 2 --description "Custom profile"
garda profile delete my-profile --target-root "."
garda profile validate --target-root "."
```

Notes:
- Running `garda profile create` with no profile name in a TTY starts the full interactive profile builder.
- The interactive builder can customize depth, review policy, token economy, and skill behavior for the new profile.
- Passing `<name>` plus flags keeps `profile create` script-friendly for automation.
- Profiles are stored in `live/config/profiles.json` and preserved across init/reinit/update merges.

### `garda uninstall`

Remove the orchestrator from a project.

```text
garda uninstall --target-root "."
garda uninstall --target-root "." --no-prompt --keep-primary-entrypoint no --keep-task-file no --keep-runtime-artifacts yes
garda uninstall --target-root "." --dry-run --no-prompt --keep-primary-entrypoint no --keep-task-file no --keep-runtime-artifacts no
```

Notes:
- Uninstall removes managed blocks, bridge files, and the deployed bundle while preserving unrelated user content.
- Before destructive work, uninstall creates an internal journal snapshot and attempts automatic restore if the uninstall flow fails mid-run.
- `--skip-backups` skips the user-facing recovery backup copies; use it only when you intentionally accept losing those recovery artifacts.
- `--keep-runtime-artifacts yes` preserves runtime reports, rollback snapshots, and task-event history under `garda-agent-orchestrator/runtime/`, along with user-owned `live/docs/project-memory/**`.

### `garda skills`

Manage optional built-in domain packs and generate code-driven recommendations from the compact skills index.

```text
garda skills list --target-root "."
garda skills suggest --target-root "." --task-text "Fix slow API endpoint" --changed-path "src/api/users.ts"
garda skills add java-spring --target-root "."
garda skills remove java-spring --target-root "."
garda skills validate --target-root "."
```

Rules:
- `skills suggest` reads only `live/config/skills-index.json` to score optional skills.
- After user selection, the chosen pack is installed into `live/skills/**` without reading its full optional `SKILL.md` immediately.
- Full optional `SKILL.md` files are loaded only when a selected skill is actually activated for a task or a hard activation rule requires it.

### `garda diff-managed`

Show managed vs user-owned block ownership across workspace files.

```text
garda diff-managed --target-root "."
garda diff-managed --target-root "." --json
```

---

## Gate Commands

### `garda gate`

Canonical gate surface is `garda gate <name>` or `node bin/garda.js gate <name>`.

| Gate | Canonical invocation |
|---|---|
| Enter task mode | `garda gate enter-task-mode --task-id "T-001" --task-summary "..."` (`--orchestrator-work --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"` for tasks that modify protected control-plane paths after explicit operator approval — see [orchestrator-work-and-isolation](orchestrator-work-and-isolation.md)) |
| Restart coherent cycle | `garda gate restart-coherent-cycle --task-id "T-001" --preflight-path "garda-agent-orchestrator/runtime/reviews/T-001-preflight.json"` |
| Restart review cycle | `garda gate restart-review-cycle --task-id "T-001" --preflight-path "garda-agent-orchestrator/runtime/reviews/T-001-preflight.json" --impact-analysis "<replace with main-agent remediation impact analysis>"` |
| Load rule pack | `garda gate load-rule-pack --task-id "T-001" --stage "TASK_ENTRY" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/00-core.md"` |
| Bind rule pack to preflight | `garda gate bind-rule-pack-to-preflight --task-id "T-001" --preflight-path "garda-agent-orchestrator/runtime/reviews/T-001-preflight.json"` |
| Classify change | `garda gate classify-change --use-staged --task-id "T-001" --task-intent "..."` |
| Compile gate | `garda gate compile-gate --task-id "T-001"` |
| Optional skill activation | `garda gate activate-optional-skill --task-id "T-001" --skill-id "<selected-skill-id>"` |
| Review gate | `garda gate required-reviews-check --task-id "T-001" --code-review-verdict "..."` |
| Audited no-op | `garda gate record-no-op --task-id "T-001" --reason "Already implemented in current branch"` |
| Doc impact | `garda gate doc-impact-gate --task-id "T-001" --decision "NO_DOC_UPDATES"` |
| Project memory impact | `garda gate project-memory-impact --task-id "T-001" --preflight-path "garda-agent-orchestrator/runtime/reviews/T-001-preflight.json"` |
| Completion gate | `garda gate completion-gate --task-id "T-001"` |
| Scoped diff | `garda gate build-scoped-diff --review-type "db"` |
| Review context | `garda gate build-review-context --review-type "code" --depth 2` |
| Task events | `garda gate task-events-summary --task-id "T-001"`; use `--compact-latest-cycle` for bounded machine-readable latest-cycle JSON |
| Task audit | `garda gate task-audit-summary --task-id "T-001"`; human stdout may be colored, while `--as-json` and `--output-path` remain uncolored |
| Next step | `garda next-step "T-001"` or `garda gate next-step "T-001"` |
| Log event | `garda gate log-task-event --task-id "T-001" --event-type "..."` |
| Manifest validation | `garda gate validate-manifest --manifest-path "garda-agent-orchestrator/MANIFEST.md"` |
| Human commit | `garda gate human-commit --operator-confirmed yes --message "<message>"` |

Use `garda next-step "T-001"` as the task-loop command before and after gates; it reports the effective full-suite config including placement, review policy, missing artifacts, review trust status, and a single recommended command. Full gate examples live in `template/docs/agent-rules/40-commands.md`.

Task-start identity and preflight notes:
- `enter-task-mode` and related runtime identity checks normalize explicit provider aliases such as `github-copilot-cli` to the canonical provider id `GitHubCopilot`; artifacts record the canonical id.
- When `classify-change` receives `--task-id` but no `--output-path`, it writes the canonical task preflight artifact at `garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json`. Non-task ad hoc classification can still run without writing an artifact.
- After a preflight refresh, `next-step` distinguishes rereading rules from rebinding evidence. If the same current-cycle POST_PREFLIGHT rule files and hashes are already loaded, it may print `bind-rule-pack-to-preflight`; if required reviews, rule files, rule hashes, or task-mode cycle changed, it prints `load-rule-pack --stage POST_PREFLIGHT` so rules are read again.
- If task-mode evidence lives at a nondefault path, preserve the same `--task-mode-path` across `classify-change`, POST_PREFLIGHT `load-rule-pack`, and `bind-rule-pack-to-preflight`.
- Optional Markdown working plans live at `garda-agent-orchestrator/runtime/plans/<task-id>.md`. When present, `next-step` and `enter-task-mode` print `MarkdownWorkingPlanPath` and `MarkdownWorkingPlanSha256` for executor handoff. They are human-readable guidance only: they are not passed as `--plan-path`, are not schema-enforced, and missing files are not a gate, review, or completion blocker.
- `classify-change --force-code-review` keeps code review mandatory even when the active fast profile would otherwise lighten a true docs-only scope. Protected control-plane scopes still keep code review mandatory without the flag.

`doc-impact-gate` accepts only `DOCS_UPDATED` and `NO_DOC_UPDATES` for `--decision`. `docs_updated` is reserved for user-facing documentation. Internal closeout evidence uses explicit flags such as `--internal-changelog-updated true` and `--project-memory-updated true`; `NO_DOC_UPDATES` is fail-closed and still cannot be combined with `docs_updated`, `behavior_changed=true`, or `changelog_updated=true`.

`project-memory-impact` writes read-only impact diagnostics under `runtime/project-memory/`; update evidence is recorded with `--confirm-updated` after user-owned project memory files have been updated separately. Fresh workspaces default project-memory maintenance to `update`, and setup/update migrate the old generated `enabled=false, mode=check` default to `update` while preserving explicit existing `off`, custom `check`, `update`, or `strict` choices. After setup or update, give the agent this first-task prompt when memory may still be stale or incomplete:

```text
Initialize or refresh Garda project memory. Inspect the repository through the normal orchestrator workflow, starting with `garda-agent-orchestrator/live/docs/project-memory/README.md` and `garda-agent-orchestrator/live/docs/project-memory/compact.md`. Update only `garda-agent-orchestrator/live/docs/project-memory/*.md` files that are missing, stale, template-seeded, placeholder-only, or incomplete; keep `compact.md` concise; record confirmed stack, commands, module map, decisions, risks, and unknown/custom stack fallback from source, configs, tests, durable docs, or explicit user answers. Do not edit generated `garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md`, do not invent facts, and do not overwrite user-authored memory without preserving its facts. Record project-memory update evidence when the workflow asks for it.
```

`validate-manifest --compact` preserves failure diagnostics but reduces the green path to `MANIFEST_VALIDATION_PASSED | entries=<count>`.

Reviewer staging note:
- Keep transient reviewer source files under `garda-agent-orchestrator/runtime/tmp/reviews/<task-id>/<review-type>/review-output.md` when using `record-review-result --review-output-path`.
- If `--review-output-path` points into reviewer scratch storage, the path must encode the current task id so Garda can attribute and clean it safely.
- `build-review-context` records the fresh-context reviewer contract in `reviewer_routing`: required reviews need a new delegated reviewer session, not a reused long-lived reviewer agent. `record-review-result` prints a reviewer cleanup reminder after receipt persistence.
- `build-review-context` also prints `ReviewReuseDecision` and `ReviewReuseReason` so agents can see whether a prior PASS review was safely rebound to the current cycle or why a fresh reviewer is still required.
- Garda cleans current-task reviewer scratch artifacts deterministically after successful review recording, removes same-task leftovers on terminal `TASK_DONE` or `TASK_BLOCKED`, sweeps aged task-attributable staging files when they no longer belong to active `IN_PROGRESS` or `IN_REVIEW` tasks, and retains stale unattributed paths instead of deleting them by guesswork.

Zero-diff task contract:
- A clean-tree `classify-change` result is baseline-only evidence, not proof that the task is complete.
- `required-reviews-check` and `completion-gate` now block zero-diff implementation tasks unless the task later produces a real diff or an audited no-op artifact is recorded.
- When `completion-gate` fails on stage-sequence or coherent-cycle ordering, it now prints a ready-to-rerun `restart-coherent-cycle` command that replays `enter-task-mode -> load-rule-pack -> handshake-diagnostics -> shell-smoke-preflight -> classify-change -> load-rule-pack -> compile-gate` before reviews continue.
- `restart-review-cycle` is the narrower recovery path for review-only reruns: it classifies the remediation fix before review reuse decisions as `test_coverage_only`, `test_hook_isolation`, `api_surface`, `runtime_behavior`, `security_sensitive`, `refactor_structure`, or fail-closed `unknown`; records affected file groups and rationale; invalidates the owning review lane for targeted categories such as `test_hook_isolation` -> `code` and `refactor_structure` -> `refactor`; refreshes `classify-change -> POST_PREFLIGHT rule-pack binding -> compile-gate -> build-review-context`; prepares review contexts in dependency order; and reports `PendingReviewTypes` when downstream reviews are still blocked by missing same-cycle upstream PASS evidence. Preserved review lanes may reuse prior PASS evidence only through the normal receipt, provenance, tree-state, and scope-fingerprint checks; fail-closed categories relaunch all required review lanes.
- Use `garda gate record-no-op --task-id "<task-id>" --reason "<rationale>"` only when the task is genuinely `already done`, `no changes required`, or `audit only`.

---

## Runtime Requirements

| Component | Requirement |
|---|---|
| Public CLI and gate commands | Node.js 24 LTS primary; Node.js 22.13+ compatibility |
| Task orchestration workspace | Local Git repository with the `git` CLI available; GitHub, GitLab, or other remotes are optional |

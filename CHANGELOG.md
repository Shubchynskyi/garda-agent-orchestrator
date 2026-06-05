# Changelog

## 1.1.0

### Operator Highlights
- Added and expanded `garda ui` as a local dashboard for task inspection, workflow/settings visibility, instructions, lazy task details, and guarded safe actions.
- `next-step` is the main task-loop navigator and now prints the next mandatory command, review policy, full-suite state, missing artifacts, review trust, compact invalidation diagnostics, and clearer recovery guidance.
- Setup output now avoids internal agent-only blocks and ends with a clearer agent-init handoff, plus a recommendation to use `garda ui` for command discovery.
- Project-memory readiness and impact evidence are now visible in setup/update, status, doctor, preprompt, task audit, and final closeout.
- Agent-init now explains ordinary document path exceptions and optional skill handling more clearly, including when extra project-specific skills should be suggested or installed.
- Human output for setup, update, doctor, task events, stats, audit summary, and closeout is more readable, with colorized human surfaces where useful and clean JSON output preserved for automation.

### Install, Update, And Package Safety
- Garda now targets Node.js 24 LTS as the primary runtime and supports Node.js 22.13+ as a compatibility runtime line.
- Setup, bootstrap, install, init, and reinit can recover from stale local bundle parity when they are run from the trusted source checkout, while remote-source setup and mutating lifecycle commands still fail closed.
- Update flows now record clearer trust and provenance evidence for npm, git, local path, and trust-override sources, and successful update output focuses on the applied version and operator-facing notes.
- `garda update`, `check-update --apply`, and `update git` now print compact user-facing result/source/safety/recovery sections instead of raw diagnostic key-value dumps, while keeping detailed provenance in reports and JSON output.
- `garda update`, `check-update --apply`, and `update git` stop before mutation when Garda is switched off, directing operators to run `garda on` first.
- `garda uninstall` now removes Garda-managed `.agentignore` active/off blocks without restoring stale install-time backups over later user edits.
- The package avoids consumer install lifecycle scripts; source checkout users run `npm run build` explicitly before using the generated launcher and compiled runtime.

### Task Workflow And Closeout
- Stale preflight, compile, rule-pack, review-context, review-gate, and full-suite evidence now routes through narrower recovery chains instead of retrying stale gates.
- `TASK.md` Active Queue preservation and gate-owned status sync now reflow the canonical 9-column table into a deterministic IDEA-compatible Markdown shape while preserving row values and lower local planning blocks.
- Successful `completion-gate` output now explicitly routes agents back to `next-step` and the `task-audit-summary` closeout before final report or commit-permission flow.
- After a successful `completion-gate`, `next-step` now reports missing final closeout artifacts instead of listing the already satisfied `completion-gate` as missing while routing to `task-audit-summary`.
- Zero-diff/no-op closeout diagnostics now omit full-suite artifacts that are disabled or intentionally not required, and omit absent completion-gate evidence once the current timeline has already passed completion.
- Final closeout and commit guidance now suppress commit commands when no tracked committable changes remain.
- Task reset, split-required, decomposed parent routing, and one-shot review-cycle continuation are now gate-owned runtime evidence instead of ad hoc `TASK.md` or workflow-config edits.

### Reviews And Validation
- Mandatory reviews require delegated fresh-context reviewer evidence with explicit routing, launch, invocation, receipt, and cleanup telemetry.
- `garda doctor` now includes a report-only large-module decomposition section that highlights the largest source/test files, large declarations, and matching open follow-up tasks.
- Ready-state task recommendations in `garda status`, `garda doctor`, and `agent-init` now resolve the first executable task from the canonical `TASK.md` Active Queue instead of falling back to `T-001`; terminal-only queues now print a clear no-executable-task message.
- Antigravity generated instructions now explicitly stop instead of fabricating independent review artifacts when no real provider sub-agent launch tool is available.
- Reviewer handoffs now include prompt/template/evidence/output paths plus exact verdict-token guidance, reducing malformed review outputs.
- Reviewer launch handoffs now use an immutable `ReviewerLaunchInputArtifactPath` for artifact-path mode, keeping the prepared input hash separate from the later completed launch artifact hash.
- Fresh reviewer launch attempts now receive hash-suffixed `ReviewOutputPath` files, so retry reviewers cannot accidentally append a new report into a stale prior attempt output.
- Reviewer launch help, next-step guidance, and completion-field hints now consistently name `ReviewerLaunchInputArtifactSha256` as the value for `--launch-input-sha256`, while keeping `launch_input_sha256` and `launch_input_artifact_sha256` clearly scoped as artifact JSON fields.
- `complete-reviewer-launch --record-invocation` now prints a complete `record-review-result` handoff command with current preflight, context, output source, execution mode, reviewer identity, and repo-root flags.
- `next-step` review-reuse hints now stay conservative until `build-review-context` validates current context/reuse hash eligibility, while still showing concrete candidates when current-context evidence can be safely rebound.
- Review reuse is stricter and more useful: PASS reviews can be reused only when receipt, provenance, tree state, scope fingerprints, and current-cycle bindings prove they are still valid.
- Strict-profile reviews are more evidence-aware, so DB/API/performance/infra/dependency lanes are not forced without matching domain surface evidence.
- Reviewer contexts now show current full-suite artifact freshness and duration, and tell reviewers when a current PASS suite already covers their lane without rerunning full tests.
- `record-review-result` now preserves existing canonical raw reviewer output on failed validation and replaces raw output, materialized artifacts, receipts, and review-recorded telemetry only after the accepted review result commits successfully.
- Compile-gate now rejects full-suite/test commands in its command block, while init and project discovery suggest stack-specific compile/build/type-check commands separately from full-suite validation commands.
- Compile-gate command selection can now be configured through `workflow-config.json`, `garda workflow set --compile-gate-command`, and the local UI settings editor, while unconfigured workspaces keep the legacy `40-commands.md` fallback.
- Full-suite validation, docs-only scopes, ordinary docs, and test-only deltas now have clearer routing so unnecessary expensive review/test cycles are avoided without weakening freshness checks.
- Full-suite timeout guidance now accounts for recent high-watermark runtime instead of relying only on averages, and external timeout cleanup now terminates child process trees more reliably.
- Task timeline diagnostics in `garda status`, `garda doctor`, and `repair rebuild-indexes` now distinguish invalid filenames, legacy incomplete histories, active incomplete blockers, and integrity failures with more specific repair guidance.

### Cleanup And Runtime Retention
- `garda html` now handles large runtime histories more quickly by rendering lazy or bounded task details by default.
- Backup inventory now has a backend model over existing rollback snapshots with date, reason, size, restore target, health, and latest-10 retention defaults.
- Scheduled auto-backups can now be configured through workflow config and run through the existing daily maintenance path, disabled by default with latest-10 retention.
- Runtime cleanup now covers more generated zones, including temp, cache, report, update-temp, reviewer scratch, test scratch, metrics, and runtime tmp directories.
- Clean successful compile and full-suite runs omit heavy raw logs while retaining compact hash/count evidence; warnings, failures, and non-clean runs still keep detailed output.
- Retention and GC flows preserve active tasks and problem-task forensic evidence while allowing healthy DONE task artifacts to be compacted after ledger evidence exists.

### Release, Docs, And Package Contract
- Release validation now checks the sourceful distribution contract: published packages include the compiled runtime, canonical TypeScript source, templates, package metadata, and the public documentation surface needed by README/HOW_TO links.
- `release:preflight` now runs a short `test:release-smoke` runtime-contract suite after static readiness and before the expensive full release proof.
- Coverage scripts now use an explicit `c8` source-boundary config with `all=true`, reporting unexecuted maintained source while excluding generated build, coverage, runtime, dependency, and test trees.
- Release handoff archives now have separate `archive:source` and `archive:evidence` commands so clean source snapshots stay separate from generated proof artifacts and runtime reports.
- Package and bundle parity checks were tightened so releases can detect stale source, dist, template, package, and runtime-referenced documentation content before handoff.
- Embedded bundle parity validation now reports skipped status instead of an OK status when no parity items are checked.
- Documentation was aligned with the current Node runtime support, provider wording, lock-cleanup behavior, package files surface, and source-checkout build contract.

### Internal Hardening
- Protected control-plane checks, launcher delegation trust, offline-mode ordering, task-event integrity, update cache invalidation, and runtime lock recovery were hardened.
- Protected recovery handoff commands now include required operator-confirmation flags, so `next-step` and protected gate failures print copy-paste executable `enter-task-mode --orchestrator-work` restarts.
- Workflow-config preflight recovery now refreshes underscoped scopes when protected dirty-baseline files are still present outside the planned workflow-config change.
- Protected task-mode recovery now rebuilds planned changed-file scope from the current workspace snapshot instead of carrying stale planned files into the `enter-task-mode --orchestrator-work` restart command.
- Command dispatch, help discovery, workflow settings, profile selection, and optional-skill activation now fail closed in more ambiguous states.
- CI, release readiness, pack smoke, embedded bundle parity, and clean-worktree validation were expanded to better match the release path.

## 1.0.0
- first public Garda release
- renamed the public project line to Garda and reset the visible release history
- aligned the package version and workspace version files to `1.0.0`
- ships the current local agent orchestration runtime, gates, provider bridges, profiles, cleanup flows, and audit trail as the new baseline

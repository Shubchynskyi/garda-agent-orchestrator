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
- Successful `completion-gate` output now explicitly routes agents back to `next-step` and the `task-audit-summary` closeout before final report or commit-permission flow.
- Final closeout and commit guidance now suppress commit commands when no tracked committable changes remain.
- Task reset, split-required, decomposed parent routing, and one-shot review-cycle continuation are now gate-owned runtime evidence instead of ad hoc `TASK.md` or workflow-config edits.

### Reviews And Validation
- Mandatory reviews require delegated fresh-context reviewer evidence with explicit routing, launch, invocation, receipt, and cleanup telemetry.
- Reviewer handoffs now include prompt/template/evidence/output paths plus exact verdict-token guidance, reducing malformed review outputs.
- Review reuse is stricter and more useful: PASS reviews can be reused only when receipt, provenance, tree state, scope fingerprints, and current-cycle bindings prove they are still valid.
- Strict-profile reviews are more evidence-aware, so DB/API/performance/infra/dependency lanes are not forced without matching domain surface evidence.
- Full-suite validation, docs-only scopes, ordinary docs, and test-only deltas now have clearer routing so unnecessary expensive review/test cycles are avoided without weakening freshness checks.
- Full-suite timeout guidance now accounts for recent high-watermark runtime instead of relying only on averages, and external timeout cleanup now terminates child process trees more reliably.

### Cleanup And Runtime Retention
- `garda html` now handles large runtime histories more quickly by rendering lazy or bounded task details by default.
- Runtime cleanup now covers more generated zones, including temp, cache, report, update-temp, reviewer scratch, test scratch, metrics, and runtime tmp directories.
- Clean successful compile and full-suite runs omit heavy raw logs while retaining compact hash/count evidence; warnings, failures, and non-clean runs still keep detailed output.
- Retention and GC flows preserve active tasks and problem-task forensic evidence while allowing healthy DONE task artifacts to be compacted after ledger evidence exists.

### Release, Docs, And Package Contract
- Release validation now checks the sourceful distribution contract: published packages include the compiled runtime, canonical TypeScript source, templates, package metadata, and the public documentation surface needed by README/HOW_TO links.
- Package and bundle parity checks were tightened so releases can detect stale source, dist, template, package, and runtime-referenced documentation content before handoff.
- Documentation was aligned with the current Node runtime support, provider wording, lock-cleanup behavior, package files surface, and source-checkout build contract.

### Internal Hardening
- Protected control-plane checks, launcher delegation trust, offline-mode ordering, task-event integrity, update cache invalidation, and runtime lock recovery were hardened.
- Command dispatch, help discovery, workflow settings, profile selection, and optional-skill activation now fail closed in more ambiguous states.
- CI, release readiness, pack smoke, embedded bundle parity, and clean-worktree validation were expanded to better match the release path.

## 1.0.0
- first public Garda release
- renamed the public project line to Garda and reset the visible release history
- aligned the package version and workspace version files to `1.0.0`
- ships the current local agent orchestration runtime, gates, provider bridges, profiles, cleanup flows, and audit trail as the new baseline

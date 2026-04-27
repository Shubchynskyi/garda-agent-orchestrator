# Changelog

## Unreleased
- made task-selected profiles a real orchestrator policy source across `enter-task-mode`, `classify-change`, and `next-step`, exposing task-vs-runtime profile selection, effective depth, review policy, and token-budget impact while preserving scope-triggered review floors instead of inflating every capability-backed review
- made `next-step` commands safer to copy by avoiding stale source-checkout runtimes, exposing top-level help under parity drift, refusing to fabricate runtime provider identity from SourceOfTruth, shell-quoting generated values safely, and keeping restarted task cycles out of terminal DONE state
- made mandatory review launch guidance, rule packs, orchestration skills, provider bridges, and review contexts explicitly require fresh clean-context reviewer sessions and reviewer cleanup after receipt persistence
- bound protected control-plane preflight scopes to `--orchestrator-work` before preflight artifact writes, and taught `next-step` to generate concrete initial `classify-change` commands from task-mode planned scope
- normalized explicit provider aliases such as `github-copilot-cli` to canonical provider ids during task start and preflight routing, and made task-bound `classify-change` auto-write the canonical preflight artifact when `--output-path` is omitted
- made `next-step` the default task-loop navigator with exact copy-paste recovery commands for stale preflight/rule-pack/review-context cycles and explicit delegated review routing before review result ingestion
- split task-event append results into canonical commit status and derived-index warnings so mandatory lifecycle writes no longer fail after the per-task JSONL event is already committed
- fixed `gate human-commit --repo-root` so the gate consumes the documented repo-root option instead of forwarding it to `git commit`
- added `gate next-step` as a deterministic lifecycle navigator that reports the next mandatory command, effective full-suite configuration, review policy, missing artifacts, and review trust state for agent task runs
- blocked mandatory review preparation only when runtime identity is unresolved or still relies on canonical SourceOfTruth fallback, while keeping delegated reviewer-subagent execution valid regardless of which explicit orchestrator entry surface was used
- removed same-agent fallback from the mandatory review workflow so required reviews must come from delegated sub-agents, and deprecated fallback artifacts now degrade to unavailable trust diagnostics instead of satisfying active review summaries
- fixed localized agent reports so confirmed `agent-init` language now overrides stale setup answers, and report labels now follow the configured assistant language instead of silently falling back to English
- synced integrity-priority wording into tracked template rule sources and added contract regressions so setup or update cannot silently rematerialize stale policy text
- kept review trust summaries visible on completion and audit compatibility paths even when consuming legacy or partial review artifacts, degrading the line to explicit unavailable status instead of dropping it outright
- preserved delegated reviewer provenance when current-cycle code-review reuse binds to historical delegated receipts, and tightened reuse guards so invalid delegated or fallback identity combinations cannot be silently rebound into fresh-cycle evidence
- improved `load-rule-pack --stage POST_PREFLIGHT` failure UX by printing a ready-to-rerun remediation command with `--repo-root`, `--task-id`, `--preflight-path`, and all `--loaded-rule-file` flags
- added a version-bound update-message registry so successful updates can print unseen release notes and curated operator notes immediately
- fixed long-lived local update and rollback flows to invalidate bundle runtime module cache comprehensively so later commands reload fresh bundle code instead of mixing stale transitive modules
- added `garda preprompt task --json` as a read-only bootstrap surface for current task context, canonical next commands, and bounded lifecycle diagnostics
- added repo-local `optional-skill-selection-policy.json` plus preflight-time optional skill selection artifacts, task-mode planned-scope reuse, and compact final closeout selection summaries
- tightened optional-skill selection with conservative strong-match activation, selected skill path reporting in `preprompt task --json`, non-zero `preprompt` start-time blocking for `required|strict`, explicit repo-local opt-in, and compile/review gate enforcement for those policy modes
- added `garda review-capabilities` with `show`/`list`, `enable`, and `disable` subcommands so supported optional review toggles can be inspected or changed without hand-editing `live/config/review-capabilities.json`
- added repo-local `review_execution_policy` workflow config plus `garda workflow show|set` support so review launch ordering and downstream invalidation can be inspected or changed without manual JSON edits; fresh materialization now seeds the recommended `code_first_optional` default while legacy repos that still omit the setting remain on the compatibility path until they opt into an explicit mode
- improved orchestration lifecycle reliability with stricter gate sequencing, safer rerun and recovery flows, and completion checks based on the latest coherent cycle
- strengthened the review pipeline with earlier artifact validation, automated review materialization and ingestion, dependency-ordered reviews, and code-review reuse for test-only reruns
- tightened dirty-worktree and protected control-plane guardrails with earlier drift detection, baseline-aware ordinary-task handling, and safer orchestrator-work handoff
- hardened runtime concurrency and lock recovery across cleanup, review indexes, aggregate task logs, timeline summaries, Windows lock release, foreign-host stale locks, and build-root stale locks
- improved validation and execution correctness with preserved targeted test filters, stricter producer-consumer artifact sequencing, safer Windows shell-backed gate execution, and same-version self-hosted update refresh for live rule-contract changes
- refined operator UX with clearer onboarding and task-start guidance, profile-aware recommendations, automatic `TASK.md` status sync, and conventional commit suggestions in final reports
- reduced noisy self-hosted protected-manifest `DRIFT` diagnostics by downgrading source-checkout status/doctor drift to informational and adding explicit preflight assessment for task-context-allowed manifest drift
- made `.review-temp` a deterministic reviewer staging area by recognizing task-owned nested staging paths, cleaning successful review source artifacts reliably, and sweeping aged orphaned temp files without deleting artifacts that still belong to active tasks

## 1.0.0
- first public Garda release
- renamed the public project line to Garda and reset the visible release history
- aligned the package version and workspace version files to `1.0.0`
- ships the current local agent orchestration runtime, gates, provider bridges, profiles, cleanup flows, and audit trail as the new baseline

# Changelog

## Unreleased
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

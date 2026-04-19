# Changelog

## Unreleased
- added `garda preprompt task --json` as a read-only bootstrap surface for current task context, canonical next commands, and bounded lifecycle diagnostics
- improved orchestration lifecycle reliability with stricter gate sequencing, safer rerun and recovery flows, and completion checks based on the latest coherent cycle
- strengthened the review pipeline with earlier artifact validation, automated review materialization and ingestion, dependency-ordered reviews, and code-review reuse for test-only reruns
- tightened dirty-worktree and protected control-plane guardrails with earlier drift detection, baseline-aware ordinary-task handling, and safer orchestrator-work handoff
- hardened runtime concurrency and lock recovery across cleanup, review indexes, aggregate task logs, timeline summaries, Windows lock release, foreign-host stale locks, and build-root stale locks
- improved validation and execution correctness with preserved targeted test filters, stricter producer-consumer artifact sequencing, safer Windows shell-backed gate execution, and same-version self-hosted update refresh for live rule-contract changes
- refined operator UX with clearer onboarding and task-start guidance, profile-aware recommendations, automatic `TASK.md` status sync, and conventional commit suggestions in final reports

## 1.0.0
- first public Garda release
- renamed the public project line to Garda and reset the visible release history
- aligned the package version and workspace version files to `1.0.0`
- ships the current local agent orchestration runtime, gates, provider bridges, profiles, cleanup flows, and audit trail as the new baseline

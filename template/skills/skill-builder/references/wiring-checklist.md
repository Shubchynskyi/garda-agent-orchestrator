# Wiring Checklist

For every new live-only specialist skill:

1. Create skill files under `garda-agent-orchestrator/live/skills/<skill-name>/`, including `skill.json` and `SKILL.md`.
2. Add skill path to `garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md`.
3. Add trigger semantics to `garda-agent-orchestrator/live/skills/orchestration/references/review-trigger-matrix.md`.
4. If supported key (`api|test|performance|infra|dependency`), set flag in:
   - `garda-agent-orchestrator/live/config/review-capabilities.json`
5. If mandatory gate requested, confirm script support exists:
   - `classify-change` emits `required_reviews.<key>`
   - `required-reviews-check` validates `<Key>ReviewVerdict`
6. Run verification and manifest validation.
7. Record added skills and flags in final report.

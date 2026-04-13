---
name: skill-builder
description: Build and wire additional live-only specialist skills after initialization. Use for requests like "add new skill", "create api-review", "add test-review", "add more agents", or "extend review pipeline". Do NOT use for normal task implementation.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(*)
  - Edit
  - Write
metadata:
  author: garda-agent-orchestrator
  version: 1.0.0
  runtime_requirement: Node.js 24 baseline for public CLI and gate commands
---

# Skill Builder

Use this skill to create project-specific specialist skills in `garda-agent-orchestrator/live/skills/**` only.
Never write generated specialist skills into `garda-agent-orchestrator/template/**`.
Generated live skills must follow the same per-skill format as core skills and optional pack skills: `skill.json` + `SKILL.md` + optional `README.md` / `references/*`.
Use `references/authoring-principles.md` to keep new skills narrow, triggerable, and low-noise before writing any manifests or checklists.

## Inputs
- User-approved skill list (for example: `api-review`, `test-review`, `performance-review`, `infra-review`, `dependency-review`, or custom).
- Desired strictness (`mandatory gate` or `manual/optional review`).
- Target trigger semantics.

## Mandatory Questions
1. Which specialist skills should be added now?
2. Should each skill be `mandatory` or `optional`?
3. Should triggering be strict (high recall) or conservative (low noise)?

## Workflow
1. Load references:
   - `references/authoring-principles.md`
   - `references/skill-template.md`
   - `references/frontmatter-guide.md`
   - `references/wiring-checklist.md`
2. For each approved skill, create:
   - `garda-agent-orchestrator/live/skills/<skill-name>/skill.json`
   - `garda-agent-orchestrator/live/skills/<skill-name>/SKILL.md`
   - optional `garda-agent-orchestrator/live/skills/<skill-name>/README.md`
   - `garda-agent-orchestrator/live/skills/<skill-name>/references/<checklist>.md`
3. Update catalog:
   - append new skill path in `garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md`
4. Update trigger documentation:
   - add trigger section in `garda-agent-orchestrator/live/skills/orchestration/references/review-trigger-matrix.md`
5. Configure gate capability flags:
   - set `true` for supported skill keys in `garda-agent-orchestrator/live/config/review-capabilities.json`
   - supported keys: `api`, `test`, `performance`, `infra`, `dependency`
6. Mandatory-gate wiring rules:
   - if skill is mandatory and key is supported, ensure the `classify-change` gate emits `required_reviews.<key>` and the `required-reviews-check` gate validates `<Key>ReviewVerdict`
   - if skill is custom and unsupported by gate scripts, mark as optional review and document limitation in catalog
7. Validation:
   - run `node garda-agent-orchestrator/bin/garda.js verify --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"`
   - run `node garda-agent-orchestrator/bin/garda.js gate validate-manifest --manifest-path "garda-agent-orchestrator/MANIFEST.md"`

## Hard Stops
- Do not modify `garda-agent-orchestrator/template/**` for project-specific specialist skills.
- Do not enable capability flags for skills that were not created.
- Do not mark custom unsupported skill as mandatory gate.
- Do not leave catalog/trigger docs out of sync with created skills.

## Output Contract
- List created `live/skills/*` paths.
- List updated wiring files.
- Capability flags changed.
- Validation results (`PASS`/`FAIL`).

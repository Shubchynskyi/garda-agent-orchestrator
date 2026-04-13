---
name: adr-writer
description: >
  Write or review Architecture Decision Records (ADRs) for non-trivial
  technical choices. Activate when a task involves selecting between
  competing approaches, proposing a significant change, or documenting
  a decision already made. Trigger phrases: "write an ADR", "document
  this decision", "architecture decision record", "RFC", "design proposal".
  Negative trigger: routine bug fixes, config tweaks, or documentation
  that does not record a decision.
license: MIT
allowed-tools:
  - Read
  - Grep
  - Glob
  - Write
metadata:
  author: garda-agent-orchestrator
  version: 1.0.0
  domain: docs-process
  triggers: ADR, architecture decision, RFC, design proposal, tradeoff analysis
  role: specialist
  scope: documentation
  output-format: markdown-document
  related-skills: architecture-review, changelog-writer
---

# ADR Writer

## Core Workflow

1. **Identify the decision scope.** Confirm the specific technical choice, its boundaries, and who the stakeholders are. If the task description is vague, extract the concrete question before writing.
2. **Gather context.** Read existing ADRs (`docs/adr/`, `docs/decisions/`, or the project's convention) for numbering, format, and superseded records. Scan related source and config files to ground the decision in real constraints.
3. **Frame the problem.** Write a concise status-neutral problem statement. State what forces (requirements, constraints, risks, non-functional needs) drive the decision. Do not embed the conclusion in the framing.
4. **Enumerate options.** List at least two realistic options. For each, provide a brief description, concrete pros, concrete cons, and any supporting evidence (benchmarks, prior incidents, dependency analysis). Avoid straw-man options that exist only to be rejected.
5. **Record the decision.** State the chosen option and the primary reasons. Link consequences (positive, negative, and risks accepted) directly to the forces identified in step 3.
6. **Assign metadata.** Set the ADR number (next sequential), date, status (`proposed` | `accepted` | `deprecated` | `superseded`), and deciders. If the ADR supersedes a previous record, update the old record's status.
7. **Validate against checklist.** Walk through `references/checklist.md` before marking the ADR complete.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| ADR quality checklist | `references/checklist.md` | Writing or reviewing any ADR |

## Constraints

- Never write an ADR that frames the problem around the chosen solution (retrospective justification). The problem statement must be understandable without knowing the outcome.
- Never fabricate evidence. If benchmarks, metrics, or incident data are cited, they must reference verifiable sources or be explicitly marked as estimates.
- Do not create an ADR for trivial, easily reversible decisions (variable renames, minor dependency patches, formatting changes).
- Do not duplicate information already captured in an existing accepted ADR; instead supersede or amend it.
- Keep each ADR focused on exactly one decision. If multiple decisions are entangled, split them into separate records with cross-references.
- Preserve the project's existing ADR numbering and directory convention. Do not invent a new structure unless explicitly instructed.

## Anti-Patterns

- **Decision shopping**: listing options but making the analysis obviously biased toward a predetermined choice.
- **Missing consequences**: recording what was decided but not what changes, risks, or follow-up work the decision introduces.
- **Stale status**: leaving an ADR as `proposed` after the decision is implemented, or failing to mark it `superseded` when a newer ADR replaces it.
- **Scope creep**: turning an ADR into a full design document. An ADR captures the *why* of a choice; detailed design belongs elsewhere.

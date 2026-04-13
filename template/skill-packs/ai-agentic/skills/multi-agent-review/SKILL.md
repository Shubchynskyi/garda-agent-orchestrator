---
name: multi-agent-review
description: >
  Coordinates multiple specialized reviewer agents over one change set to produce a single trustworthy review.
  Use when a review task is decomposed into parallel specialist scopes (security, performance, correctness, style),
  when multiple sub-agents independently gather evidence, or when findings from different reviewers must be
  deduplicated, calibrated, and synthesized before a final verdict.
  Trigger phrases: multi-agent review, parallel review, reviewer fan-out, review synthesis, reviewer coordination.
  Do NOT use for single-reviewer code review or for generic agent teamwork unrelated to change-set review.
license: MIT
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(*)
  - Write
metadata:
  author: garda-agent-orchestrator
  version: 1.0.0
  domain: ai-agentic
  triggers: reviewer registry, review orchestrator, fan-out review, finding merge, severity calibration, review pipeline, agent decomposition
  role: specialist
  scope: review
  output-format: review-findings
  related-skills: tool-calling-patterns, code-review, orchestration, architecture-review
---

# Multi-Agent Review

## Core Workflow

1. **Decompose the change set into reviewer scopes.** Analyze the diff to identify distinct concern areas (e.g., security surface, data-layer changes, API contract, test coverage, performance-sensitive paths). Assign each area to exactly one primary reviewer agent; minimize scope overlap to control redundancy.
2. **Register and configure reviewer agents.** Each reviewer must declare its specialty, the file/path patterns it will inspect, the severity scale it uses, and the evidence format it will produce. Use a reviewer registry or manifest so the orchestrator can validate completeness and detect scope gaps before fan-out.
3. **Fan out for independent evidence gathering.** Dispatch all reviewers in parallel. Each reviewer operates on its assigned scope with no access to other reviewers' in-progress findings. Every finding must include: file path, line range, severity, category, a one-sentence description, and verbatim evidence (code snippet or log excerpt).
4. **Deduplicate and merge findings.** After all reviewers report, group findings by file and line range. Identify duplicates (same location + same root cause) and near-duplicates (overlapping location, related root cause). Keep the strongest evidence and the most specific description; discard weaker duplicates with a merge note.
5. **Resolve conflicts.** When two reviewers disagree on severity or recommend contradictory fixes for the same location, escalate to a conflict-resolution step: present both positions with evidence, apply the project's severity rubric, and record the resolution rationale. Never silently drop a finding to hide a conflict.
6. **Calibrate severity.** Normalize severity labels across all reviewers to one shared scale before synthesis. Align on definitions (e.g., critical = data loss or security breach path reachable from changed code; high = correctness bug affecting production path; medium = maintainability or minor risk; low = style or nit).
7. **Synthesize the final review.** Produce a single ordered findings list sorted by severity, then by file path. Append a summary section with: total finding count by severity, scopes that passed cleanly, unresolved conflicts (if any), and an explicit verdict token (`APPROVE`, `REQUEST_CHANGES`, or `ESCALATE`).

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Review orchestration checklist | `references/checklist.md` | Any multi-agent review task, reviewer pipeline change, or review-synthesis logic review |

## Constraints

- Each reviewer must operate independently during evidence gathering; sharing intermediate findings before merge introduces confirmation bias.
- Every finding requires verbatim evidence (file path, line range, code snippet or log); reject findings that contain only a description with no supporting artifact.
- Do not silently drop or downgrade a finding during deduplication; document every merge decision with a rationale.
- Conflicts between reviewers must be surfaced and resolved, not hidden; unresolved conflicts must appear in the final report.
- Do not let a single reviewer cover the entire change set; the minimum decomposition is two scopes. If the change is too small to split, this skill does not apply — use a single-reviewer code-review skill instead.
- Enforce a bounded reviewer count per review (recommend 2–5); unbounded fan-out wastes context and increases merge complexity without proportional quality gain.
- Severity labels must be calibrated to a shared scale before synthesis; mixed scales in the final report are a hard-fail.

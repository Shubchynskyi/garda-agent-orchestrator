---
name: evals-design
description: >
  Design and review evaluation suites for LLM and agent systems.
  Use when the task involves creating, extending, or reviewing eval datasets, rubrics,
  judge configs, benchmark scripts, or shipping-readiness scorecards.
  Triggers: "eval suite", "golden dataset", "rubric", "judge model", "benchmark", "scorecard".
  Negative triggers: generic unit/integration testing with no LLM or agent component.
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
  domain: ai-evals
  triggers: eval suite, golden dataset, rubric, judge model, benchmark, scorecard, regression eval
  role: specialist
  scope: design-and-review
  output-format: design-and-review
  related-skills: llm-app-basics, multi-agent-review, code-review
---

# Evals Design

## Core Workflow

1. **Scope the eval target.** Identify the exact capability, agent step, or model behaviour under test. One eval suite = one capability boundary; do not bundle unrelated capabilities.
2. **Decompose into eval dimensions.** Split the target into orthogonal axes (correctness, latency, safety, format compliance, reasoning fidelity). Each dimension gets its own rubric or scorer.
3. **Build or curate the golden dataset.** Assemble input/expected-output pairs that cover the happy path, known edge cases, adversarial inputs, and distribution-boundary examples. Tag each case with difficulty tier and category.
4. **Define pass/fail rubrics.** For each dimension write a deterministic or LLM-judge rubric with explicit criteria, score scale, and the minimum threshold that constitutes a pass. Prefer deterministic checks where feasible; reserve LLM-judge scoring for subjective or open-ended dimensions.
5. **Set regression and shipping thresholds.** Establish the numeric bar per dimension (e.g., accuracy ≥ 0.92, format compliance = 1.0). Document which thresholds block shipping and which are advisory.
6. **Implement the eval harness.** Wire datasets, scorers, and thresholds into a reproducible script or framework run. Ensure the run produces a machine-readable scorecard (JSON/CSV) plus a human summary.
7. **Run offline eval, review scorecard, decide.** Execute the suite, inspect per-case failures, update the dataset or rubric if gaps appear, and record the ship/no-ship decision with evidence.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Eval design checklist | `references/checklist.md` | Designing, extending, or reviewing any eval suite |

## Constraints

- Do not mix offline evals (batch, pre-deploy) with online evals (live traffic sampling) in the same suite definition; separate them explicitly.
- Do not use the production model as its own judge without a calibration set that quantifies self-bias.
- Do not treat aggregate pass rate alone as sufficient; always inspect per-category and per-difficulty breakdowns.
- Do not reuse training or fine-tuning data as eval cases — benchmark contamination invalidates results.
- Do not hard-code thresholds without documenting the rationale and the baseline they were derived from.
- Do not skip versioning of golden datasets; a dataset change without a version bump silently breaks regression tracking.
- Treat any eval that takes > 5 minutes or > $5 per run as high-cost and flag it for budget review before adding to CI.

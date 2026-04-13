# Evals Design Checklist

## Scope & Decomposition

- [ ] Eval target names one specific capability or agent step.
- [ ] Dimensions are orthogonal (correctness, safety, format, latency, reasoning).
- [ ] Each dimension has its own scorer/rubric — no single "overall" score without breakdown.

## Golden Dataset

- [ ] Dataset covers: happy path, edge cases, adversarial inputs, distribution boundaries.
- [ ] Every case is tagged with category and difficulty tier.
- [ ] No overlap with training/fine-tuning data (contamination check).
- [ ] Dataset is versioned; version bump required on any case add/edit/remove.
- [ ] Minimum case count per category is documented and met.

## Rubrics & Judges

- [ ] Deterministic checks used wherever output is objectively verifiable.
- [ ] LLM-judge rubrics include explicit criteria, score scale, and worked examples.
- [ ] Judge calibration set exists with human-labeled ground truth and measured agreement rate.
- [ ] Self-judge bias is quantified if the production model also serves as judge.

## Thresholds & Decisions

- [ ] Pass/fail threshold per dimension is documented with derivation rationale.
- [ ] Blocking vs advisory thresholds are distinguished.
- [ ] Regression threshold = previous release baseline ± documented tolerance.
- [ ] Ship/no-ship decision criteria are written before the eval run, not after.

## Harness & Reproducibility

- [ ] Eval script is deterministic: fixed seed, pinned model version, frozen dataset version.
- [ ] Output is a machine-readable scorecard (JSON or CSV) plus human-readable summary.
- [ ] Run cost (time, tokens, dollars) is logged and compared against budget ceiling.
- [ ] CI integration (if applicable) runs offline evals on every PR that touches prompt or model config.

## Review & Reporting

- [ ] Per-category and per-difficulty breakdowns are included — not just aggregate.
- [ ] Failure cases are individually inspected and triaged (bug vs dataset noise vs model limit).
- [ ] Scorecard diff vs previous run is generated for regression visibility.
- [ ] Residual risks and known gaps are listed explicitly in the eval report.

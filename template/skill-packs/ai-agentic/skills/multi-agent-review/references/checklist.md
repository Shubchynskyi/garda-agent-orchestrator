# Multi-Agent Review Checklist

## Scope Decomposition

- [ ] Change set is split into non-overlapping concern areas (security, correctness, performance, contracts, tests).
- [ ] Each area is assigned to exactly one primary reviewer; no scope is unassigned.
- [ ] Scope boundaries reference concrete file patterns or module paths, not vague categories.

## Reviewer Registration

- [ ] Every reviewer declares specialty, assigned paths, severity scale, and output schema.
- [ ] Reviewer registry is validated for completeness before fan-out; scope gaps are flagged.
- [ ] Reviewer count is bounded (2–5 per review); unbounded fan-out is rejected.

## Independent Evidence Gathering

- [ ] Reviewers execute in parallel without access to each other's in-progress findings.
- [ ] Each finding includes: file path, line range, severity, category, one-sentence description, and verbatim evidence.
- [ ] Findings that lack evidence artifacts are rejected before merge.

## Deduplication & Merge

- [ ] Findings are grouped by file and line range after all reviewers complete.
- [ ] Exact duplicates (same location + same root cause) are collapsed; the strongest evidence is retained.
- [ ] Near-duplicates (overlapping location, related cause) are merged with a documented rationale.
- [ ] No finding is silently dropped; every merge decision is traceable.

## Conflict Resolution

- [ ] Contradictory findings (different severity or opposing fixes for one location) are flagged explicitly.
- [ ] Resolution applies the project severity rubric and records the rationale.
- [ ] Unresolved conflicts appear in the final report rather than being hidden.

## Severity Calibration

- [ ] All reviewers use the same severity scale (critical / high / medium / low) with shared definitions.
- [ ] Severity normalization is applied before synthesis, not after.
- [ ] Mixed or undefined severity labels in the final report are a hard-fail.

## Final Synthesis

- [ ] Output is a single ordered findings list (severity descending, then file path).
- [ ] Summary includes: total counts by severity, cleanly-passed scopes, unresolved conflicts.
- [ ] Report ends with an explicit verdict token: `APPROVE`, `REQUEST_CHANGES`, or `ESCALATE`.
- [ ] Verdict is supported by evidence; an `APPROVE` with unresolved critical findings is invalid.

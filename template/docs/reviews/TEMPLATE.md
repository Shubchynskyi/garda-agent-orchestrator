# Findings-Only Review Result Contract

For every new review cycle, use the task-owned generated artifacts in
`garda-agent-orchestrator/runtime/reviews/`:

- `<task-id>-<review-type>-role-prompt.md`
- `<task-id>-<review-type>-prompt-template.md`
- `<task-id>-<review-type>-output-template.md`
- `<task-id>-<review-type>-evidence-manifest.json`

The generated output template is the immutable fill-in form and the exact
`ReviewOutputPath` is the only permitted reviewer write. Return one JSON object
with `schema_version`, task/context/tree bindings, `validation_notes`, the
complete `coverage_ledger`, severity-grouped `findings`, `residual_risks`, and
`reviewer_notes`.

The canonical machine-readable schema is
`garda-agent-orchestrator/live/schemas/review-findings-report.schema.json`.
That canonical filename is Garda-managed and is refreshed during materialization.
Keep user-owned schema extensions under a distinct filename in `live/schemas/`;
materialization preserves unrelated files in that directory.
Reviewer output must not contain verdict, pass/fail, status, downstream
disposition, policy, follow-up, or remediation fields. The orchestrator derives
lane state only after deterministic validation and locked policy disposition.

Historical heading-based review artifacts remain readable for audit and legacy
migration only. Do not use this file to create or reconstruct a historical
artifact for a new cycle.

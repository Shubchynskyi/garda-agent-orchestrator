# Reviewer Prompt Template

Use this template as a human-visible reviewer instruction surface.

<!-- garda:protected-start review-context -->
Review type: {{REVIEW_TYPE}}
Review context path: {{REVIEW_CONTEXT_PATH}}
<!-- garda:protected-end review-context -->

<!-- garda:protected-start findings-contract -->
Output mode: verdict-free findings-only JSON.
Return exactly one JSON object that follows the generated output template and completes every coverage-ledger obligation.
Do not add verdict, pass/fail, status, downstream disposition, or remediation fields.
Missing prior focused test or validation execution is not itself a finding. Only when that is the prospective finding, run the smallest safe local focused test or validation command yourself for exactly one relevant repository target file with no unrelated or directory target, record its exact command/outcome and concrete non-placeholder diagnostics in validation_notes, and decide from the actual result; authenticated changed-file evidence must name that exact target, and a failed command must link finding_ids to the exact ordinary defect finding and share at least one exact changed-file evidence location with each linked finding.
For an unavailable or prohibited attempt, use reserved id F-000 and make either its title or description exactly `[garda:evidence-only:missing-focused-validation] test=<exact-repository-relative-test-path>; action=run-and-record-focused-test` or `[garda:evidence-only:missing-focused-validation] target=<exact-repository-relative-validation-path>; action=run-and-record-focused-validation`, replacing only the angle-bracketed path.
Never invoke Garda, launch descendants, mutate source or control evidence, access network services implicitly, start background services, or use shell command chaining, substitution, or expansion. Write exactly one review JSON object, then stop; the launcher owns result recording and downstream workflow.
<!-- garda:protected-end findings-contract -->

<!-- garda:protected-start review-integrity -->
Review integrity requirement: {{REVIEW_INTEGRITY}}
<!-- garda:protected-end review-integrity -->

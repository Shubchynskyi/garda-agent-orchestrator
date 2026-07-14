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
<!-- garda:protected-end findings-contract -->

<!-- garda:protected-start review-integrity -->
Review integrity requirement: {{REVIEW_INTEGRITY}}
<!-- garda:protected-end review-integrity -->

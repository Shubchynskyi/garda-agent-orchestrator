# Runbook Quality Checklist

Use this checklist when writing or reviewing an operational runbook.

## Metadata & Classification

- [ ] Runbook type stated: incident-response, deployment, or maintenance.
- [ ] Owner team or role assigned.
- [ ] Last-verified date present and not older than the most recent related change.

## Preconditions

- [ ] Required access, roles, and credentials listed.
- [ ] Dependent services and their expected health state documented.
- [ ] Required tooling (CLI versions, scripts, dashboards) enumerated with install/access instructions.
- [ ] Environment scope specified (staging, production, or both with divergence notes).

## Steps

- [ ] Each step contains exactly one action and one verification.
- [ ] Commands are copy-pasteable or parameterized with named variables and substitution instructions.
- [ ] Expected output or observable signal described for every verification.
- [ ] Conditional branches marked explicitly with clear entry conditions.
- [ ] Steps numbered sequentially; no implicit ordering dependencies.

## Rollback & Safety

- [ ] Rollback instruction provided after every state-mutating step.
- [ ] Point-of-no-return identified and called out if one exists.
- [ ] Safe-stop points marked where the operator can pause without leaving the system in a broken state.
- [ ] If rollback is impossible for a step, that fact and the mitigation are documented.

## Verification & Completion

- [ ] Success criteria defined with concrete checks: health endpoints, metric thresholds, log patterns, or smoke tests.
- [ ] Expected values or acceptable ranges specified, not just "check that it works."
- [ ] Post-completion cleanup steps included if temporary resources were created.

## Escalation

- [ ] Escalation trigger conditions documented: time limits, error thresholds, blast-radius markers.
- [ ] Contact channels and responsible teams listed.
- [ ] Information to include in the escalation message specified.

## Consistency

- [ ] No conflicts with existing runbooks; superseded procedures updated or archived.
- [ ] Cross-references to related runbooks, alerts, or dashboards included.
- [ ] Follows project directory convention and filename pattern.

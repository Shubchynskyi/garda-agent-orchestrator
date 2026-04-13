# Postmortem Quality Checklist

Use this checklist when writing or reviewing an engineering incident postmortem.

## Metadata & Classification

- [ ] Postmortem identifier assigned, following the project's numbering convention.
- [ ] Severity level recorded and consistent with the organization's severity definitions.
- [ ] Owning team and incident commander (if applicable) listed.
- [ ] All timestamps in UTC with explicit timezone notation.
- [ ] Incident state dates captured: detection, mitigation, resolution, and postmortem completion.

## Impact

- [ ] Affected services, features, or user segments identified.
- [ ] Duration of user-facing impact stated.
- [ ] Quantitative impact data included where available (error rate, request failures, revenue, SLA/SLO breach).
- [ ] Estimates clearly marked as estimates, not presented as measurements.

## Timeline

- [ ] Chronological, timestamped entries from first anomalous signal through resolution.
- [ ] Each entry cites a verifiable source (alert ID, deploy SHA, log query, chat link).
- [ ] Gaps explicitly acknowledged rather than silently bridged.
- [ ] Detection, escalation, mitigation, and resolution moments clearly marked.

## Detection & Response

- [ ] Detection method documented (automated alert, customer report, manual observation).
- [ ] Time-to-detect and time-to-mitigate recorded.
- [ ] Response sequence described: who was paged, what actions were taken, in what order.
- [ ] Evaluation of detection timeliness included.

## Contributing Factors & Root Cause

- [ ] Proximate trigger distinguished from deeper systemic factors.
- [ ] Multiple contributing factors listed when applicable (code, config, process, capacity, dependency).
- [ ] Root cause framed as the earliest correctable factor in the causal chain.
- [ ] No single-cause narrative when evidence shows multiple interacting factors.

## Corrective Actions

- [ ] Each contributing factor has at least one corresponding action.
- [ ] Actions categorized: prevent recurrence, improve detection, reduce blast radius, or improve response.
- [ ] Each action has an owner, target date, and measurable definition of done.
- [ ] Total number of actions is realistic and prioritized; aspirational items moved to backlog.
- [ ] Follow-up review date set to verify action completion.

## Blamelessness & Tone

- [ ] No individual blame or personal attribution of fault.
- [ ] Failures framed in terms of systems, processes, and conditions.
- [ ] Language is factual and neutral; no inflammatory or minimizing phrasing.

## Consistency

- [ ] No contradictions with existing postmortems or known incident facts.
- [ ] Cross-references to related postmortems, runbooks, or ADRs included where relevant.
- [ ] Follows project directory convention and filename pattern.

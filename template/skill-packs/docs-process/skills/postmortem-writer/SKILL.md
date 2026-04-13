---
name: postmortem-writer
description: >
  Write or review blameless engineering incident postmortems. Activate when
  a task requires documenting a production incident with impact, timeline,
  detection, root-cause analysis, contributing factors, and corrective
  actions. Trigger phrases: "write a postmortem", "incident postmortem",
  "post-incident review", "outage report", "root-cause analysis".
  Negative trigger: operational runbooks (use runbook-writer), future
  architecture decisions (use adr-writer), or routine changelog entries.
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
  triggers: postmortem, incident report, root cause, outage review, post-incident review, corrective action
  role: specialist
  scope: documentation
  output-format: markdown-document
  related-skills: runbook-writer, changelog-writer, adr-writer
---

# Postmortem Writer

## Core Workflow

1. **Gather incident artifacts.** Collect all available evidence before writing: alerting history, on-call logs, status-page updates, chat transcripts, deploy logs, monitoring dashboards, and any preliminary notes. Do not rely on memory or summaries alone — reference verifiable sources.
2. **Define incident metadata.** Assign a sequential postmortem identifier following the project's convention (e.g., `PM-042`). Record severity, owning team, incident commander (if applicable), date/time of detection, mitigation, and resolution in UTC.
3. **Write the impact statement.** Quantify user-facing and business impact: affected services, error rates, duration, data integrity implications, SLA/SLO breaches, and approximate blast radius. Use measured numbers where available; mark estimates explicitly.
4. **Reconstruct the timeline.** Build a chronological, timestamped sequence from first anomalous signal through detection, response actions, mitigation, and full resolution. Each entry must cite its source (alert ID, deploy SHA, chat message link). Mark gaps explicitly rather than inventing continuity.
5. **Identify detection path and response.** Document how the incident was detected (automated alert, customer report, manual observation), the time-to-detect, and the sequence of human and automated response actions. Evaluate whether detection was timely and what could shorten it.
6. **Analyze contributing factors and root cause.** Separate the proximate trigger from deeper systemic causes. List all contributing factors (code defect, missing test, config drift, process gap, capacity limit, dependency failure). Frame root cause as the earliest correctable factor in the causal chain. Avoid single-cause narratives when multiple factors interacted.
7. **Draft corrective actions.** For each contributing factor, propose a concrete, assignable action with a clear definition of done. Categorize actions: prevent recurrence, improve detection, reduce blast radius, or improve response. Assign owners and target dates. Do not list vague improvements without exit criteria.
8. **Validate against checklist.** Walk through `references/checklist.md` before marking the postmortem complete. Verify blamelessness, evidence traceability, and action specificity.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Postmortem quality checklist | `references/checklist.md` | Writing or reviewing any incident postmortem |

## Constraints

- Never assign individual blame. Frame failures in terms of systems, processes, and conditions — not personal shortcomings. Replace "engineer X caused" with "the deployment pipeline allowed."
- Never fabricate or interpolate timeline entries. If a gap exists between known events, state "no evidence available for this interval" and note what telemetry would have helped.
- Do not conflate the proximate trigger with the root cause. A bad deploy is a trigger; the absence of canary analysis or rollback automation is a contributing factor.
- Do not list corrective actions without owners, target dates, and measurable completion criteria. Untracked follow-ups are the most common postmortem failure mode.
- Do not combine multiple unrelated incidents into a single postmortem. If incidents co-occurred, write separate documents with cross-references.
- Preserve the project's existing postmortem numbering, directory convention, and template structure. Do not invent a new layout unless explicitly instructed.

## Anti-Patterns

- **Blame narrative**: framing the postmortem around who made an error rather than what systemic conditions allowed the error to reach production.
- **Shallow root cause**: stopping at the first "what went wrong" without asking why safeguards failed. A deploy bug is not a root cause if there was no test, no canary, and no rollback gate.
- **Action graveyard**: listing 15+ corrective actions that will never be prioritized. Limit to high-impact items with realistic ownership; park aspirational items in a backlog reference.
- **Missing impact data**: describing the incident qualitatively ("some users were affected") when quantitative data is available in metrics or logs.
- **Stale postmortem**: completing the document but never revisiting corrective-action status. Include a follow-up review date.

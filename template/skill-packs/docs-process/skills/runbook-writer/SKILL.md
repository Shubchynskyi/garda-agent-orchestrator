---
name: runbook-writer
description: >
  Write or review operational runbooks for incident response, deployments,
  and recurring maintenance tasks. Activate when a task requires documenting
  a step-by-step procedure that an on-call engineer or operator will execute
  under time pressure. Trigger phrases: "write a runbook", "deployment
  runbook", "incident procedure", "ops playbook", "rollback plan".
  Negative trigger: high-level architecture docs, post-incident analysis
  (use postmortem-writer), or decision records (use adr-writer).
license: MIT
allowed-tools:
  - Read
  - Grep
  - Glob
  - Write
  - Bash(*)
metadata:
  author: garda-agent-orchestrator
  version: 1.0.0
  domain: docs-process
  triggers: runbook, playbook, incident procedure, deployment steps, maintenance, rollback, failover, on-call
  role: specialist
  scope: documentation
  output-format: markdown-document
  related-skills: postmortem-writer, changelog-writer, adr-writer
---

# Runbook Writer

## Core Workflow

1. **Classify the runbook type.** Determine whether this is an incident-response, deployment, or recurring-maintenance runbook. The type dictates which sections are mandatory (e.g., detection criteria for incidents, promotion sequence for deployments, scheduling cadence for maintenance).
2. **Define preconditions and entry criteria.** List every prerequisite: required access/roles, environment state, dependent services that must be healthy, and tooling that must be available. An operator must be able to verify all preconditions before beginning.
3. **Gather operational context.** Read existing runbooks, deployment scripts, alerting rules, and infrastructure config in the repository. Identify the real commands, endpoints, dashboards, and log queries the operator will need. Do not invent placeholder URLs or commands.
4. **Write deterministic steps.** Each step must have a single action, an expected outcome, and a verification command or observable signal. Use exact CLI commands, API calls, or console paths — never prose like "restart the service as needed." Number steps sequentially; mark conditional branches explicitly.
5. **Add rollback and safe-stop points.** After each irreversible or high-risk step, document how to revert or pause safely. State the point-of-no-return explicitly if one exists. Every rollback instruction must be as concrete as the forward step.
6. **Define verification and completion criteria.** Describe how the operator confirms the procedure succeeded: health-check commands, metric thresholds, log patterns, or user-facing smoke tests. Include expected output or value ranges.
7. **Document escalation paths.** Specify when and to whom to escalate: threshold conditions (time elapsed, error counts, blast radius), contact channels, and information to include in the escalation message.
8. **Validate against checklist.** Walk through `references/checklist.md` before marking the runbook complete.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Runbook quality checklist | `references/checklist.md` | Writing or reviewing any operational runbook |

## Constraints

- Never use placeholder or example commands (`<your-command-here>`, `TODO`). Every command must be copy-pasteable in the target environment or explicitly parameterized with named variables and a substitution note.
- Never assume implicit knowledge. If a step requires a VPN, specific IAM role, or feature flag, state it in preconditions.
- Do not merge multiple actions into a single step. One step = one action + one verification.
- Do not omit rollback for steps that mutate state (database migrations, config pushes, DNS changes). If rollback is genuinely impossible, document that fact and the mitigation.
- Do not duplicate content from an existing runbook; reference or supersede it instead.
- Keep the runbook environment-specific when environments differ (staging vs. production). Do not write a single generic procedure if commands, endpoints, or thresholds diverge.

## Anti-Patterns

- **Wall-of-prose steps**: paragraphs instead of numbered atomic actions. Operators under pressure skip or misread prose.
- **Optimistic-path only**: documenting the happy path without rollback, escalation, or failure branches.
- **Stale commands**: referencing scripts, endpoints, or dashboards that no longer exist. Always verify against the current codebase and infrastructure.
- **Implicit sequencing**: steps that silently depend on a prior step's side effect without stating the dependency. Make data flow between steps explicit.
- **Missing audience**: no stated required role or access level, leaving the operator to discover permission errors mid-incident.

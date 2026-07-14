---
name: devops-k8s
description: >
  Specialist skill for production infrastructure and delivery work. Use when a
  task touches Docker images, CI/CD, Kubernetes manifests, Helm, Terraform,
  rollout strategy, secrets/config, or operational readiness. Trigger phrases:
  "deployment", "rollout", "helm", "pipeline", "kubernetes", "GitHub Actions",
  "Terraform". Do NOT use for generic application code changes with no
  deployment, infrastructure, or runtime-operations implications.
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
  domain: infrastructure
  triggers: Docker, Kubernetes, Helm, Terraform, CI/CD, GitHub Actions, deployment, rollout, observability
  role: specialist
  scope: implementation-and-review
  output-format: plans-and-review
  related-skills: infra-review, security-review, dependency-review
---

# DevOps K8s

## Generated Findings-Only Handoff
When orchestration supplies generated role-prompt, reviewer-prompt, output-template, and evidence-manifest artifacts, those artifacts are the sole output-format authority and override legacy verdict-oriented format text below. Return exactly one findings-only JSON object, complete the entire assigned scope and every coverage-ledger obligation, and do not add verdict, pass/fail, status, downstream disposition, or remediation fields.

## Core Workflow

1. **Identify the delivery surface and promotion path.** Confirm deployment targets, environments, GitOps vs imperative apply flow, and canonical validation commands from `40-commands.md`. Determine whether the change affects image build, CI pipeline, manifest templating, cluster policy, or runtime operations before editing.
2. **Lock artifact provenance and immutability.** Prefer pinned base images, digests, immutable tags, and deterministic build inputs. A deployment artifact should be reproducible from versioned inputs; if the change depends on mutable tags or floating actions, treat that as a reliability risk.
3. **Separate config from secret and environment boundaries.** Secrets should come from secret stores or sealed resources, not inline literals. Confirm environment-specific config is explicit, least-privilege access is preserved, and a change in one environment cannot silently bleed into another.
4. **Review workload safety, not just manifest syntax.** Check probes, resource requests/limits, disruption budgets, autoscaling, affinity, and storage semantics. A manifest can be syntactically valid while still producing crash loops, thundering-herd restarts, or unsafe evictions under real load.
5. **Validate rollout and rollback behavior.** Deployment strategy, image immutability, rollback commands, and migration sequencing must be coherent. If a DB migration or schema-dependent app change is involved, verify old and new versions can coexist during rollout or document the required maintenance window.
6. **Audit pipeline permissions and determinism.** Review reusable workflows, action pinning, concurrency controls, artifact handoff, and approval gates. CI/CD changes are production code; avoid steps that are non-idempotent, over-privileged, or sensitive to ordering races.
7. **Confirm observability and ownership.** Production-facing infra changes need logs, metrics, alerts, dashboards, and an operational owner. If a rollout fails, the repository should already contain the signal and the path to rollback or triage it.
8. **Run infrastructure validation before completion.** Execute the actual lint/template/validate/plan commands from `40-commands.md` (`helm lint`, `helm template`, `kubectl --dry-run`, `terraform validate/plan`, workflow linting, etc.). Passing syntax alone is not enough; verify the intended runtime semantics.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Delivery checklist | `references/checklist.md` | Any infra or deployment feature/review |

## Mandatory Output Format

When this skill is selected for a mandatory `infra` review, return the generated output template, not a free-form summary. Treat it as an immutable fill-in form: replace placeholder lines only. Preserve these required `##` headings exactly and in this order; never add, remove, rename, reorder, or nest the required `##` headings:
1. `## Validation Notes` - concrete reviewed infrastructure files, behavior, boundaries, and verification evidence; required for PASS.
2. `## Findings by Severity` - canonical `None`, or active blocking infra findings with file references using parser-supported inline/list/subheading formats.
3. `## Deferred Findings` - canonical `None`, or accepted actionable infra follow-ups with a concrete next step and `Justification:`.
4. `## Residual Risks` - canonical `None`, or active open rollout or operations risks that remain after review.
5. `## Verdict` - exact verdict token: `INFRA REVIEW PASSED` or `INFRA REVIEW FAILED`.

Use parser-supported finding formats under `## Findings by Severity`: `- High: <file:line> <impact>; remediation: <required action>`, `High:` followed by `- <finding>`, or `### High` followed by `- <finding>`. Severity subheadings are allowed only inside `## Findings by Severity`.

Parser-valid examples:
- Validation Notes: `Reviewed src/review-parser.ts:42 and tests/review-parser.test.ts:17; checked parser-supported finding formats and rejection diagnostics.`
- Findings by Severity: `- High: src/review-parser.ts:42 drops later findings; impact: incomplete review evidence; remediation: preserve every severity entry.`
- Severity subheading: `### Medium` followed by `- tests/review-parser.test.ts:17 misses hierarchy coverage; impact: nested findings can be lost; remediation: cover severity subheadings.`
- Deferred Findings: `- [Low] docs/reviews.md:12 clarify reviewer wording. Next step: update docs in T-123. Justification: documentation-only follow-up is accepted after parser coverage.`
- Residual Risks: `- Rollout risk: legacy review artifacts may still use old wording until regenerated; mitigation: parser tests cover both canonical None and supported finding formats.`

## Scope Map

- **Build & supply chain** — base image pinning, artifact provenance, SBOM/signing, and deterministic CI inputs.
- **Cluster runtime** — workload manifests, probes, autoscaling, storage, networking, RBAC, and policy boundaries.
- **Promotion path** — chart values, GitOps/apply flow, approvals, rollout sequencing, rollback commands, and migration coordination.
- **Operability** — logs, metrics, alerts, dashboards, runbooks, and clear runtime ownership for production changes.

## High-Risk Areas

- Secrets rotation, ingress/network policy changes, cluster-scoped RBAC, stateful workloads, database migrations during rollout, and mutable image/action references should always be treated as high-risk changes.

## Failure Patterns

- **Syntax-valid but runtime-unsafe manifests**: probes, limits, affinity, or disruption budgets that pass templating but fail under load.
- **Mutable delivery inputs**: floating image tags, unpinned actions, or environment fallthrough that make a rollback irreproducible.
- **Pipeline-as-root**: CI jobs with broad credentials, no concurrency guard, and no environment boundary effectively bypass change management.
- **Schema-coupled rollout assumptions**: application and migration changes that only work if every pod flips at once.

## Exhaustive Review Contract
- Complete the entire assigned review scope before returning a verdict. A finding at any severity does not end the review.
- Continue through every in-scope file, behavior boundary, test, and applicable checklist or rule category, then report every distinct evidence-supported finding in the same result.
- Deduplicate findings that share one root cause. For every distinct finding include severity, file and line evidence, impact, and required remediation; never invent or pad findings to reach a count.
- On remediation reviews, re-sweep the complete current assigned scope instead of checking only previously reported findings.
- Validation Notes must name the files, behavior boundaries, tests, and checklist or rule categories actually reviewed.
- Do not widen the assigned scope. This is a process-completeness requirement, not a guarantee that every latent defect will be discovered.

## Constraints

- Do not commit secrets or environment-specific credentials.
- Do not use mutable tags like `latest` or unpinned CI actions in production paths.
- Do not conflate readiness and liveness checks or point both at the same expensive endpoint blindly.
- Do not widen blast radius with implicit defaults, cluster-admin permissions, or environment fallthrough behavior.
- Do not ship rollout plans that assume all nodes/pods switch at once when schema compatibility is not backward-safe.
- Treat production rollout paths, migrations, and infra access changes as high-risk.

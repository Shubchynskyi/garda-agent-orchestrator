# DevOps K8s Checklist

## Delivery Surface & Inputs

- [ ] Confirm template/render/validate/plan commands from `40-commands.md`.
- [ ] Identify whether the change affects image build, CI/CD, manifests, Terraform, or runtime operations.
- [ ] Verify images, Helm charts, Terraform modules, and GitHub Actions are pinned to deterministic versions.
- [ ] Confirm the promotion path between environments is explicit: values files, overlays, workspaces, or GitOps branches are not inferred by convention alone.

## Image & Supply Chain

- [ ] Validate base images, build args, and dependency fetch steps for provenance and reproducibility.
- [ ] Check image tags/digests, SBOM/signing steps, and artifact handoff between build and deploy stages.
- [ ] Confirm secrets are not baked into images, workflow logs, or generated manifests.

## Workload Runtime Safety

- [ ] Review secret sourcing, environment boundaries, and least-privilege access.
- [ ] Check rollout, rollback, readiness, liveness, and migration coordination semantics.
- [ ] Validate resources, autoscaling, disruption budgets, storage, and network exposure for the affected workload.
- [ ] Confirm workload identity, service account, pod security context, and filesystem permissions match least-privilege expectations.

## Networking & Policy

- [ ] Review ingress, service, DNS, and certificate implications for backward compatibility and blast radius.
- [ ] Validate RBAC, network policies, and cluster-scoped resources separately from namespace-local changes.
- [ ] Treat stateful workloads, persistent volumes, and data-plane changes as rollback-sensitive until proven otherwise.

## Rollout & Recovery

- [ ] Verify old and new versions can coexist during deployment when migrations or contract changes are involved.
- [ ] Confirm rollback commands, image/chart references, and config reversions are documented and actually usable.
- [ ] Check whether canary, blue-green, or surge settings align with the service's failure tolerance and alerting.

## Pipeline & Operability

- [ ] Confirm pipeline permissions, approvals, artifact handoff, and concurrency controls are intentional.
- [ ] Verify observability, alerts, dashboards, and runbook ownership for the changed runtime path.
- [ ] Treat IaC, pipeline, RBAC, ingress, and rollout changes as high-risk until validated against production behavior.
- [ ] Ensure post-deploy verification exists: smoke checks, health gates, synthetic probes, or manual validation criteria.

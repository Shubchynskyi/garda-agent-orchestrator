# Threat Model

This document describes the trust surfaces, threat actors, and mitigations
for the Garda Agent Orchestrator. It complements [SECURITY.md](../SECURITY.md)
(vulnerability reporting policy) and the
[Control-Plane Isolation](control-plane-isolation.md) operational guide.

---

## Scope

The threat model covers the orchestrator CLI (`bin/garda.js`), the
materialized bundle (`garda-agent-orchestrator/`), lifecycle commands
(install, update, rollback, uninstall), gate infrastructure, and the trust
chain from npm registry to local workspace execution.

Out of scope: the AI agent runtime itself (provider models, API keys,
network transport to LLM providers), CI runner infrastructure, and
operating-system-level access control.

---

## Actors

| Actor | Trust level | Examples |
|---|---|---|
| **Operator** | High | Human developer running CLI commands directly |
| **Task agent** | Medium | AI agent executing a task under orchestrator control |
| **Reviewer agent** | Medium | Delegated sub-agent running an independent review |
| **npm registry** | External | Source of the published package and its dependencies |
| **Upstream repository** | External | GitHub source repository for code and CI artifacts |
| **Local OS user** | Same-user | Any process running under the same OS account |

---

## Trust Surfaces

### 1. Install / Setup

**What happens:** `npm install garda-agent-orchestrator` fetches the
package from the npm registry, then `garda setup` or `garda init`
materializes the bundle into the project root.

| Threat | Impact | Likelihood | Mitigations |
|---|---|---|---|
| Compromised npm package (supply-chain) | Arbitrary code execution at install or first run | Low | Lockfile pinning (`package-lock.json`), npm audit, CycloneDX SBOM generation ([docs/sbom.md](sbom.md)), gitleaks secret scanning ([docs/secret-scanning.md](secret-scanning.md)) |
| Dependency confusion / typosquatting | Wrong package installed | Low | Scoped or unique package name, lockfile integrity, `npm install --prefer-offline` when possible |
| Malicious post-install script | Code execution during `npm install` | Low | npm `ignore-scripts` option, code review of `package.json` scripts, CI reproducibility checks |
| Materialization overwrites user files | Data loss or behavior change | Medium | Managed-block markers with sentinel comments, `upsertManagedBlock` preserves user content outside markers, preview/dry-run support for destructive operations |

### 2. Update / Rollback

**What happens:** `garda update` fetches a newer package version,
snapshots the current bundle for rollback, and materializes the new
version. `garda rollback` restores the previous snapshot.

| Threat | Impact | Likelihood | Mitigations |
|---|---|---|---|
| Update replaces control-plane with tampered content | Gate bypass, rule injection | Low | Trusted manifest (SHA-256 hashes of protected files written at update time), manifest drift detection at preflight and completion gates |
| Interrupted update leaves inconsistent state | Broken gates, partial materialization | Medium | Atomic temp-file writes, interruption sentinel detection, rollback snapshot preservation, `doctor` diagnosis of partial-state conditions |
| Rollback restores a vulnerable version | Known-vulnerable code re-introduced | Low | Operator responsibility; `check-update` surfaces available versions; rollback reports record the restored version |
| Stale rollback snapshot corruption | Rollback fails or restores wrong state | Low | Snapshot integrity validation at restore time, bounded retention policy via `cleanup` |

### 3. Write Surfaces (Materialization and Runtime Artifacts)

**What happens:** The orchestrator writes files to the project directory:
entrypoints, provider bridges, config files, runtime artifacts (task
events, review receipts, metrics), and managed blocks in user-owned files.

| Threat | Impact | Likelihood | Mitigations |
|---|---|---|---|
| Agent modifies control-plane files during task | Gate integrity undermined | Medium | Protected-path enforcement (SHA-256 snapshot comparison at preflight vs completion), `--orchestrator-work` opt-in for legitimate changes, fail-closed completion gate ([docs/orchestrator-work-and-isolation.md](orchestrator-work-and-isolation.md)) |
| Path traversal in artifact writes | Write outside expected directories | Low | `ensureWithinRoot()` boundary check on all artifact write paths, symlink/junction alias rejection, lexical `isSubpath()` validation |
| Review artifact tampering (post-write) | Forged review verdicts | Medium | Atomic temp-file replace under per-artifact locks, review-gate validation of artifact content and timeline hash-chain, delegated reviewer identity recorded in receipts |
| Local delegated-review launch artifact forgery | False claim that an independent reviewer was launched | Medium | Launch artifacts under `garda-agent-orchestrator/runtime/tmp/reviews/<task>/<review>/` are local convenience metadata only. Gates bind them to the current review context, routing event, prepared-launch event, launch binding, provider invocation id, and fresh-context marker, but a same-user local agent can still hand-author those files. Non-forgeable provenance requires a provider-owned host, signer, or external audit log outside the implementation agent's filesystem authority. |
| Task-event log tampering | Falsified gate evidence | Medium | Best-effort append locking, per-event `event_sha256` hash-chain, replay detection in `status`/`doctor` (procedural hardening, not a cryptographic trust anchor) |
| Managed-block injection in user files | Unexpected content in project files | Low | Sentinel-delimited managed blocks (`<!-- garda-agent-orchestrator:managed-start/end -->`), `indexOf`/`slice` marker search (no regex injection), managed content never executed as code |

### 4. Trust / Verification

**What happens:** Gates, manifests, and isolation mode form a verification
chain that attempts to ensure the orchestrator control plane has not been
tampered with during task execution.

| Threat | Impact | Likelihood | Mitigations |
|---|---|---|---|
| Same-user bypass of isolation sandbox | Agent rewrites sandbox and re-runs gates on tampered runtime | Medium | Honest limitation: isolation is practical hardening, not a security boundary (documented in [control-plane-isolation.md](control-plane-isolation.md)); OS-level sandboxing or CI-hosted gate execution recommended for stronger guarantees |
| Agent self-reviews its own changes | Reduced review independence | Medium | Mandatory reviews require fresh-context delegated reviewer sub-agents on every supported provider; `reviewer_execution_mode` recorded in review receipts; providers or bridges without delegated reviewer launch support cannot satisfy the mandatory review workflow |
| Forged gate pass artifacts | Task completes without real gate execution | Medium | Completion gate validates ordered lifecycle evidence (`TASK_MODE_ENTERED` → `RULE_PACK_LOADED` → `PREFLIGHT_CLASSIFIED` → `IMPLEMENTATION_STARTED` → `COMPILE_GATE_PASSED` → review evidence), hash-chain integrity of task-event log, preflight artifact must exist before review stage |
| Trusted manifest absent or invalid | Drift detection disabled | Low | `status` and `doctor` surface MISSING/INVALID/DRIFT manifest state; deployed-workspace DRIFT and all INVALID states still block doctor pass/readiness, while self-hosted source-checkout DRIFT is downgraded to informational unless task-context gates classify it as real pre-start or lifecycle drift; `setup`/`update`/`reinit` regenerate the trusted manifest |
| Stale or drifted CODEOWNERS / branch protection | PR-time governance gap | Low | CODEOWNERS maps protected paths to owner teams ([docs/branch-protection.md](branch-protection.md)), recommended branch-protection settings documented, local enforcement complements PR-time rules |

---

## Same-User Trust Boundary

A critical architectural constraint: the orchestrator, the task agent, and
the reviewer agent all run under the **same OS user**. This means:

- File permissions cannot enforce separation between agent and orchestrator.
- An agent with shell access can read, modify, or delete any orchestrator
  file.
- Isolation mode, protected-path enforcement, and manifest validation are
  **detection and deterrence** layers, not prevention layers.
- Local reviewer-launch artifacts are in the same trust category: they reduce
  operator error by binding a delegated-review launch to the current routing
  and review context, but they are not cryptographic proof of reviewer
  execution while the implementation agent can write the workspace.

**Implication:** The orchestrator's trust model is analogous to a linter or
CI gate — it raises the bar for accidental or casual bypasses and makes
tampering visible, but it does not provide cryptographic or OS-enforced
containment. For high-assurance environments, run gate validation in a
separate CI job or under a different OS user.

---

## Defense-in-Depth Summary

```text
Layer 1: Supply chain
  └─ Lockfile pinning, npm audit, SBOM, secret scanning, CODEOWNERS

Layer 2: Materialization integrity
  └─ Managed-block sentinels, ensureWithinRoot(), atomic writes

Layer 3: Runtime gate chain
  └─ Ordered lifecycle evidence, hash-chain task events,
     protected-path SHA-256 snapshots, manifest drift detection

Layer 4: Review independence
  └─ Delegated fresh-context sub-agents, reviewer identity in receipts,
     required-reviews-check gate, reviewer execution mode telemetry

Layer 5: Operational visibility
  └─ status/doctor diagnostics, task timeline completeness checks,
     isolation validation, control-plane drift surfacing
```

---

## Residual Risks

| Risk | Severity | Status |
|---|---|---|
| Same-user agent can bypass all local enforcement | High | Accepted — documented limitation; mitigate with CI-hosted gates or OS-level sandboxing |
| Task-event hash-chain is procedural, not cryptographic | Medium | Accepted — sufficient for tampering detection, not for non-repudiation |
| npm supply-chain compromise of transitive dependencies | Medium | Mitigated — lockfile + audit + SBOM, but residual risk remains |
| Rollback can restore known-vulnerable versions | Low | Accepted — operator responsibility; version info recorded in rollback reports |

---

## Related Documents

- [SECURITY.md](../SECURITY.md) — vulnerability reporting policy
- [Control-Plane Isolation](control-plane-isolation.md) — sandbox lifecycle
  and manifest validation
- [Orchestrator Work and Protected Paths](orchestrator-work-and-isolation.md)
  — fail-closed behavior and remediation
- [Branch Protection and CODEOWNERS](branch-protection.md) — PR-time
  governance
- [SBOM](sbom.md) — software bill of materials generation
- [Secret Scanning](secret-scanning.md) — gitleaks CI and local workflow
- [Architecture](architecture.md) — runtime model and deployment layout

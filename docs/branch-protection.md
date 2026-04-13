# Branch Protection Guidance

## Overview

The orchestrator enforces **local** protected-path integrity at task
completion time (see [Orchestrator Work and Isolation](orchestrator-work-and-isolation.md)).
GitHub **branch protection rules** and **CODEOWNERS** extend that
enforcement to the **PR-merge** boundary so that changes to critical
paths cannot land without the right approvals, passing CI, and a clean
merge target.

Together the two layers form a defence-in-depth governance model:

| Layer | When | What it guards |
|---|---|---|
| **Local protected-path enforcement** | Task completion gate | Orchestrator control-plane files in the worktree. |
| **CODEOWNERS + branch protection** | Pull request merge | The same files, plus CI workflows, security config, and package metadata. |

## Recommended Branch Protection Settings

Apply these settings to every long-lived branch (`main`, `dev`,
`release/*`) through **Settings → Branches → Branch protection rules**
in the GitHub repository.

### Required Checks

| Setting | Recommended value | Rationale |
|---|---|---|
| **Require status checks to pass before merging** | ✅ Enabled | Prevents merging when CI is red. |
| **Require branches to be up to date before merging** | ✅ Enabled | Ensures the PR branch includes the latest target commits. |
| **Status checks that are required** | `ci` (the main CI workflow) | At minimum, the primary build/test workflow must pass. |

### Required Reviews

| Setting | Recommended value | Rationale |
|---|---|---|
| **Require pull request reviews before merging** | ✅ Enabled | At least one human or designated reviewer must approve. |
| **Required number of approvals** | `1` (increase for high-risk branches) | Balances velocity with oversight. |
| **Dismiss stale pull request approvals when new commits are pushed** | ✅ Enabled | Forces re-review after changes. |
| **Require review from Code Owners** | ✅ Enabled | Enforces CODEOWNERS approval for protected paths. |

### Merge Restrictions

| Setting | Recommended value | Rationale |
|---|---|---|
| **Require signed commits** | Optional | Useful for supply-chain assurance but may add contributor friction. |
| **Require linear history** | Optional | Keeps the commit graph clean when squash/rebase merge is preferred. |
| **Include administrators** | ✅ Enabled | Prevents admin bypass of protection rules. |
| **Restrict who can push to matching branches** | ✅ Enabled | Limits direct pushes to the CI bot and release automation only. |

### Force Push and Deletion

| Setting | Recommended value | Rationale |
|---|---|---|
| **Allow force pushes** | ❌ Disabled | Protects branch history from rewriting. |
| **Allow deletions** | ❌ Disabled | Prevents accidental branch deletion. |

## CODEOWNERS Integration

The repository includes a `.github/CODEOWNERS` file whose path patterns
mirror the orchestrator's local protected-path list. When **Require
review from Code Owners** is enabled in branch protection, GitHub
automatically requests reviews from the listed owners for any PR that
touches those paths.

### Covered paths

- **Orchestrator runtime** — `runtime/`,
  `garda-agent-orchestrator/runtime/`,
  `live/docs/agent-rules/`,
  `garda-agent-orchestrator/live/docs/agent-rules/`,
  `live/config/`,
  `garda-agent-orchestrator/live/config/`,
  `live/skills/`,
  `garda-agent-orchestrator/live/skills/`
- **Source checkout roots** — `src/`, `garda-agent-orchestrator/src/`,
  `bin/`, `garda-agent-orchestrator/bin/`, `dist/`,
  `garda-agent-orchestrator/dist/`, `template/`,
  `garda-agent-orchestrator/template/`
- **CI workflows** — `.github/workflows/`
- **Security config** — `SECURITY.md`, `.gitleaks.toml`
- **Agent entrypoints** — `.github/copilot-instructions.md`,
  `.github/agents/`, `.agents/`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`
- **Package metadata** — `package.json`, `package-lock.json`,
  `tsconfig*.json`

### Customising owners

This checkout uses `@Shubchynskyi` in `.github/CODEOWNERS`. If you fork
the repository, replace that owner handle with your actual GitHub team
handle or individual user handles. Multiple owners can be listed
space-separated:

```text
src/   @your-org/core-team @your-username
```

## How the Two Layers Complement Each Other

```
Developer workstation          GitHub PR
┌──────────────────────┐       ┌────────────────────────────┐
│ Task agent runs       │       │ PR opened against main      │
│ ↓                     │       │ ↓                           │
│ enter-task-mode       │       │ CI status checks run        │
│ ↓                     │       │ ↓                           │
│ implementation        │       │ CODEOWNERS matched          │
│ ↓                     │       │ ↓                           │
│ completion-gate       │──PR──▶│ Required reviews requested  │
│ (protected-path check)│       │ ↓                           │
│                       │       │ Approvals + checks pass     │
│                       │       │ ↓                           │
│                       │       │ Merge allowed               │
└──────────────────────┘       └────────────────────────────┘
```

The local gate catches accidental control-plane drift **before** the PR
is even created.  Branch protection and CODEOWNERS catch anything that
bypasses or post-dates the local gate.

## Quick Setup Checklist

1. [ ] Confirm `.github/CODEOWNERS` exists and paths are correct.
2. [ ] Confirm the owner handles in `.github/CODEOWNERS` match this
   checkout or your fork's maintainers.
3. [ ] Enable **Require pull request reviews before merging** on target branches.
4. [ ] Enable **Require review from Code Owners**.
5. [ ] Add the main CI workflow as a **required status check**.
6. [ ] Enable **Dismiss stale approvals when new commits are pushed**.
7. [ ] Enable **Include administrators** to prevent bypass.
8. [ ] Disable **Allow force pushes** and **Allow deletions**.

## Related Docs

- [Orchestrator Work and Isolation](orchestrator-work-and-isolation.md) — local
  protected-path enforcement, `--orchestrator-work` flag, remediation
- [Control-Plane Isolation Mode](control-plane-isolation.md) — sandbox
  execution, manifest drift enforcement
- [Secret Scanning](secret-scanning.md) — gitleaks CI integration
- [SBOM](sbom.md) — supply-chain transparency
- [CLI Reference](cli-reference.md) — gate command surface

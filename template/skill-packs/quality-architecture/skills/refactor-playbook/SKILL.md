---
name: refactor-playbook
description: >
  Guides behavior-preserving refactors through invariant locking, characterization tests,
  seam creation, disciplined decomposition order, and strict separation of semantic and
  structural changes. Use when a task requires extracting modules, reducing complexity,
  decoupling components, consolidating duplicated logic, or restructuring legacy code
  without altering observable behavior.
  Trigger phrases: refactor, extract module, decompose, restructure, simplify, consolidate,
  reduce complexity, decouple, technical debt, untangle.
  Do NOT use for greenfield design, full rewrites, or changes that intentionally alter
  external behavior (use feature skills or architecture-review instead).
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
  domain: quality
  triggers: extract, decompose, split, inline, move, rename, simplify, consolidate, decouple, technical debt
  role: specialist
  scope: implementation
  output-format: code-and-review
  related-skills: code-review, architecture-review, testing-strategy
---

# Refactor Playbook

## Core Workflow

1. **Lock invariants before touching code.** Identify the observable behaviors that must not change. Run the existing test suite and record the baseline result. If coverage is weak around the target area, write characterization tests that capture current input → output pairs, side effects, and error paths before any refactor begins.
2. **Identify seams.** Locate the narrowest points where the target code interacts with the rest of the system — function boundaries, interface implementations, dependency injection sites, event emitters, or I/O adapters. These seams define safe cut lines for extraction and substitution.
3. **Plan decomposition order.** Work leaf-to-root: refactor the most independent unit first, then its immediate dependents. Never refactor a heavily-depended-upon module and its consumers in the same change. Write the order down before starting; deviate only if a blocker is discovered.
4. **Separate structural from semantic changes.** Each commit (or logical change unit) must be purely structural (moves, renames, extract-method/class, re-exports) **or** purely semantic (logic changes, signature updates, new behavior). Never mix the two in one commit. This makes each step independently reviewable and revertible.
5. **Move in small verified steps.** After every atomic move — extract function, introduce parameter object, replace conditional with polymorphism — re-run the relevant tests. Do not batch multiple refactor mechanics into a single untested leap.
6. **Preserve public API surface.** If the refactored module has external consumers, maintain the existing public API via re-exports or thin adapter wrappers until all consumers migrate. Deprecate explicitly; do not silently remove.
7. **Confirm rollback posture.** Before completing, verify that reverting the most recent commit restores a green test suite. If the refactor spans multiple commits, verify each intermediate commit is independently revertible and leaves the codebase in a working state.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Refactor safety checklist | `references/checklist.md` | Any behavior-preserving refactor or extraction task |

## Constraints

- Do not combine a refactor with a feature addition or bug fix in the same change unit; land the refactor first, then build on the cleaned structure.
- Do not delete or rename a public symbol without confirming zero external references or providing a re-export bridge.
- Do not skip characterization tests when existing coverage is insufficient for the target area.
- Do not refactor a module and its dependents simultaneously; finish and verify the inner module first.
- Do not perform speculative generalization (adding extension points, abstractions, or parameters "for the future") as part of a refactor task.
- Treat any refactor that changes observable error messages, log formats, or metric names as a semantic change and handle it in a separate commit with explicit justification.

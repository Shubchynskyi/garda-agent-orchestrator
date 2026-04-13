---
name: frontend-react
description: >
  Specialist skill for production React frontends. Use when a task touches
  React components, hooks, routing, client-side data flows, forms, state
  management, accessibility, or performance-sensitive UI changes. Trigger
  phrases: "component", "hook", "state", "form", "router", "React",
  "useEffect", "query cache". Do NOT use for generic CSS-only tweaks with no
  React interaction or state implications, or for Next.js routing/rendering
  work that belongs to `nextjs-app`.
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
  domain: frontend
  triggers: React, TypeScript UI, component, hooks, routing, accessibility, state, forms, query cache
  role: specialist
  scope: implementation-and-review
  output-format: code-and-review
  related-skills: code-review, frontend-accessibility, performance-review
---

# Frontend React

## Core Workflow

1. **Identify the host runtime and app shape.** Confirm the router, design-system constraints, data-fetching layer, and canonical build/test commands from `40-commands.md`. Distinguish a generic React SPA from framework-specific work (Next.js, Remix) before changing routing or rendering assumptions.
2. **Define component and state ownership.** Keep each component focused on rendering plus local interaction, and keep shared state in the narrowest viable owner: local state first, then lifted state, then context/store only when multiple branches truly need shared ownership. Avoid writing to state from broad component trees without a clear source of truth.
3. **Audit hooks and effect discipline.** Components must stay render-pure. `useEffect` is for synchronizing with external systems, not deriving state that should come from render, memoization, or selectors. Check dependency arrays, cleanup behavior, event listeners, timers, and stale-closure risks before accepting a hook-heavy change.
4. **Review async data and transitions.** Every changed data path needs explicit loading, empty, error, retry, and success behavior. Confirm cache invalidation, optimistic updates, and refetch triggers are intentional. If one user action fans out to multiple data updates, make sure the UI cannot briefly show contradictory state.
5. **Validate forms and interaction contracts.** Controlled/uncontrolled strategy must be consistent. Confirm form validation timing, submit disabling, error presentation, and accessible labeling are all intentional. Custom controls must preserve keyboard and screen-reader behavior, not just click behavior.
6. **Check routing, auth, and cache boundaries.** Route changes, auth gates, query-parameter handling, and cache keys are contract-sensitive. Confirm navigation preserves expected state, invalidates stale data, and does not break deep links or back-button behavior.
7. **Review performance and bundle risk.** Confirm keys are stable, rerender scope is bounded, and expensive trees are memoized only where measurement justifies it. Watch for large dependency additions, client-only bundles that should stay lazy-loaded, and hydration/runtime boundaries when the host supports SSR.
8. **Validate with the real frontend command set.** Run lint, type-check, tests, and build commands from `40-commands.md`. When the change touches interaction-heavy flows, prefer tests that assert user-visible transitions rather than only snapshot output.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Delivery checklist | `references/checklist.md` | Any React feature or review |

## High-Risk Areas

- Routing/auth flows, form submission, query-cache invalidation, SSR/hydration boundaries, and virtualized or very large lists are high-risk because regressions often appear only under real interaction timing.

## Constraints

- Do not hide state mutations in broad component trees or implicit context write paths.
- Do not use `useEffect` for pure derivation that belongs in render, selectors, or memoization.
- Do not ship inaccessible custom controls or untested state transitions.
- Do not duplicate derived state in multiple hooks or stores without a strict synchronization reason.
- Do not add optimistic updates without an explicit rollback/error path.
- Treat routing, auth flows, caching, and form behavior as contract-sensitive changes.

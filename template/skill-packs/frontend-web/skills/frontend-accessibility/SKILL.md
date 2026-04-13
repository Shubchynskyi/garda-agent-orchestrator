---
name: frontend-accessibility
description: >
  Reviews and hardens web UI for keyboard operability, semantic HTML, ARIA contracts,
  focus management, dynamic-content announcements, form/error accessibility, dialog
  behaviour, and data-table markup. Use when a task creates or modifies components,
  pages, design-system primitives, forms, modals, menus, data tables, or toast/alert
  patterns. Trigger phrases: "accessibility review", "a11y", "keyboard flow",
  "screen reader", "WCAG", "focus trap", "aria".
  Do NOT use for pure styling changes with no structural, interactive, or semantic
  impact, or for backend-only work.
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
  triggers: accessibility, a11y, WCAG, ARIA, keyboard navigation, screen reader, focus management, semantic HTML
  role: specialist
  scope: review-and-implementation
  output-format: review-findings
  related-skills: code-review, frontend-react, testing-strategy
---

# Frontend Accessibility

## Core Workflow

1. **Map interactive surfaces.** Identify every interactive element in the changed files: links, buttons, form controls, custom widgets, dialogs, menus, tabs, disclosures, and data tables. List each with its current HTML element and any ARIA role override.
2. **Verify semantic foundation.** Confirm native HTML elements are used before reaching for ARIA. A `<button>` must not be a `<div onClick>`; a navigation list must use `<nav>` + `<ul>`; headings must follow a logical level sequence without skipping. Flag every case where a generic element (`div`, `span`) receives an interactive role without the required keyboard contract.
3. **Audit keyboard operability.** Trace the Tab order through the component or page. Confirm every interactive element is reachable, operable with Enter/Space (buttons), Arrow keys (menus, tabs, radio groups, sliders), and Escape (dialogs, popovers). Verify that no keyboard trap exists and that skip-link or landmark navigation allows bypassing repeated blocks.
4. **Validate ARIA contracts.** For every ARIA role, verify all required states and properties are present and updated dynamically: `aria-expanded` toggles on disclosure triggers, `aria-selected`/`aria-current` reflects active selection, `aria-controls`/`aria-labelledby`/`aria-describedby` point to existing IDs. Ensure `aria-hidden="true"` is never set on focusable elements.
5. **Review focus management.** After route changes, modal open/close, inline content insertion, or item deletion, confirm focus moves to a logical target. Dialogs must trap focus while open and restore focus to the trigger on close. Confirm `tabindex="-1"` is used for programmatic focus targets, and `tabindex` values greater than 0 are absent.
6. **Check forms and error handling.** Verify every input has a visible, programmatically associated label (`<label for>` or `aria-labelledby`). Confirm error messages are linked to their control via `aria-describedby`, inline validation changes announce via `aria-live` or `role="alert"`, and required fields declare `aria-required="true"` or the `required` attribute.
7. **Inspect dynamic content and live regions.** Confirm toast notifications, status messages, and inline updates use `aria-live="polite"` (or `"assertive"` only when immediate attention is warranted) with `aria-atomic` set correctly. Verify the live region container exists in the DOM before content is injected.
8. **Evaluate data tables.** Confirm data tables use `<table>`, `<thead>`, `<th scope>`, and `<caption>` or `aria-label`. Sortable columns must expose sort state via `aria-sort`. Ensure layout tables are not marked with `role="table"` or `<table>` semantics.
9. **Acknowledge automation limits.** Automated tooling (axe-core, Lighthouse, jest-axe) catches roughly 30–40% of real accessibility defects. After running available automated checks, explicitly list which aspects still require manual or assistive-technology verification: reading order, meaningful focus sequence, live-region timing, and correct announcement phrasing.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Accessibility review checklist | `references/checklist.md` | Any UI component, page, or design-system change |

## Constraints

- Do not approve a custom interactive widget that lacks a complete keyboard contract matching its ARIA role.
- Do not accept `aria-label` as a substitute for visible text when visible text is feasible; screen-reader-only text must be a last resort.
- Do not add `role="presentation"` or `aria-hidden="true"` to elements that contain focusable children.
- Do not rely solely on colour to convey state (error, active, disabled); always pair with text, icon, or pattern.
- Do not dismiss automated-tool passes as proof of accessibility; explicitly state which checks remain manual.
- Treat removal of an existing accessible name, landmark, or live region as a regression and a hard-fail finding.
- Do not introduce positive `tabindex` values; use DOM order or `tabindex="0"` / `tabindex="-1"` only.

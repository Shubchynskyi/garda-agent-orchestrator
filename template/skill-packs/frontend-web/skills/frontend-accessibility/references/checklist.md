# Frontend Accessibility Checklist

## Semantic HTML

- [ ] Interactive elements use native HTML (`<button>`, `<a>`, `<input>`, `<select>`) before ARIA.
- [ ] Headings follow a logical hierarchy with no skipped levels.
- [ ] Page landmarks (`<main>`, `<nav>`, `<aside>`, `<header>`, `<footer>`) are present and unique or labelled.
- [ ] Lists use `<ul>`/`<ol>` + `<li>`; description pairs use `<dl>`.

## Keyboard Operability

- [ ] Every interactive element is reachable via Tab in a logical order.
- [ ] Buttons activate with Enter and Space; links activate with Enter.
- [ ] Composite widgets (menus, tabs, radio groups, tree views) support Arrow-key navigation.
- [ ] Escape closes the topmost layer (dialog, popover, dropdown).
- [ ] No keyboard trap exists; focus can always leave and return.
- [ ] Skip link or landmark navigation allows bypassing repeated blocks.

## ARIA Contracts

- [ ] Every element with an ARIA role exposes all required states and properties.
- [ ] `aria-expanded`, `aria-selected`, `aria-checked`, `aria-pressed` toggle dynamically.
- [ ] `aria-controls`, `aria-labelledby`, `aria-describedby`, `aria-owns` point to existing DOM IDs.
- [ ] `aria-hidden="true"` is never set on focusable elements or their ancestors.
- [ ] No redundant ARIA roles on native elements (`role="button"` on `<button>`).

## Accessible Names & Descriptions

- [ ] Every interactive element has a non-empty accessible name (visible label, `aria-label`, or `aria-labelledby`).
- [ ] Visible text is preferred over `aria-label`; screen-reader-only text is a last resort.
- [ ] Icons-only buttons have an accessible name via `aria-label` or visually-hidden text.
- [ ] Images have `alt` text (or `alt=""` with `aria-hidden="true"` if purely decorative).

## Focus Management

- [ ] After modal open, focus moves to the dialog or its first interactive element.
- [ ] After modal close, focus returns to the triggering element.
- [ ] After route navigation, focus moves to the main content or page heading.
- [ ] After inline content insertion or deletion, focus moves to a logical target.
- [ ] No positive `tabindex` values (only `0` or `-1`).
- [ ] Dialogs trap focus while open; focus does not escape to background content.

## Forms & Error Handling

- [ ] Every input has a visible, programmatically associated label (`<label for>` or `aria-labelledby`).
- [ ] Required fields declare `required` or `aria-required="true"`.
- [ ] Error messages are linked to their control via `aria-describedby`.
- [ ] Inline validation changes announce via `aria-live` or `role="alert"`.
- [ ] Form submission errors provide a summary and allow keyboard navigation to each error.
- [ ] Disabled controls use the `disabled` attribute, not just visual styling.

## Dynamic Content & Live Regions

- [ ] Status messages, toasts, and inline updates use `aria-live="polite"`.
- [ ] `aria-live="assertive"` is reserved for urgent, time-sensitive alerts only.
- [ ] Live-region container exists in the DOM before content is injected.
- [ ] `aria-atomic` is set appropriately (full region re-read vs. partial update).
- [ ] Loading indicators announce state changes to assistive technology.

## Data Tables

- [ ] Data tables use `<table>`, `<thead>`, `<tbody>`, `<th scope="col|row">`.
- [ ] Tables have `<caption>` or `aria-label` describing their purpose.
- [ ] Sortable columns expose sort state via `aria-sort="ascending|descending|none"`.
- [ ] Layout tables do not use `<table>` semantics or `role="table"`.

## Colour & Visual

- [ ] Information is not conveyed by colour alone; text, icons, or patterns supplement it.
- [ ] Text meets minimum contrast ratios (4.5:1 normal text, 3:1 large text).
- [ ] Focus indicators are visible and meet 3:1 contrast against adjacent colours.
- [ ] UI adapts to `prefers-reduced-motion` for users who disable animations.

## Automated & Manual Testing

- [ ] Automated checks (axe-core, Lighthouse, jest-axe) pass with no critical violations.
- [ ] Manual keyboard walkthrough completed for all changed interactive flows.
- [ ] Findings explicitly note which checks require assistive-technology verification (reading order, announcement phrasing, live-region timing).

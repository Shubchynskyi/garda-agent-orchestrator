# Frontend React Checklist

## Runtime Surface & Boundaries

- [ ] Confirm the canonical lint, type-check, test, and build commands from `40-commands.md`.
- [ ] Identify the router, query/data layer, form library, and design-system constraints before editing.
- [ ] Verify component ownership and shared-state boundaries are explicit.
- [ ] Check whether the change affects SSR, hydration, route-level code splitting, or client-only rendering.

## Hooks & Local State

- [ ] Review `useEffect` usage for stale closures, missing cleanup, and accidental render-time derivation.
- [ ] Confirm `useMemo`, `useCallback`, and derived state are used only when they reduce real rerender or recomputation cost.
- [ ] Validate context/provider boundaries so shared state does not silently widen rerender scope.

## Data Fetching & Mutations

- [ ] Confirm loading, empty, error, retry, and success states exist for changed async flows.
- [ ] Check cache invalidation, optimistic updates, and rollback behavior for user-visible mutations.
- [ ] Review request deduplication, cancellation, and race handling for rapid navigation or repeated user actions.

## Forms, UX & Accessibility

- [ ] Review accessibility, focus order, labels, live regions, and keyboard behavior.
- [ ] Validate form submission, inline validation, disabled states, and error presentation.
- [ ] Confirm toasts, modals, and async affordances communicate progress and failure without trapping focus.

## Performance & Delivery

- [ ] Review rerender scope, key stability, virtualization, and whether memoization or code splitting is justified by the changed path.
- [ ] Check asset loading, bundle splitting, and route prefetch behavior when layout or navigation changes.
- [ ] Treat design-system token changes, shared hooks, and provider reordering as high-blast-radius edits.

## Tests & Release Safety

- [ ] Add or update component, integration, and e2e tests when the task changes interaction or routing behavior.
- [ ] Cover negative states: failed mutation, validation error, empty result, and permission-driven UI branching.
- [ ] Note rollout assumptions when the UI depends on a staged backend or API change.

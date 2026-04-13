# Testing Strategy Checklist

## Risk Framing

- [ ] Identify changed modules and rank them by blast radius (shared > leaf).
- [ ] Confirm existing test coverage for every changed public contract.
- [ ] State explicitly which changed paths need no new tests and document the rationale.

## Coverage Mix

- [ ] Verify contract or API tests exist for any modified interface or schema.
- [ ] Verify integration tests exist for persistence, external calls, and multi-module flows.
- [ ] Check that unit tests cover pure-logic branches and edge cases only; avoid redundant layer overlap.

## Fixtures & Flakiness

- [ ] Validate fixture data reflects current production shapes (nullable fields, enums, realistic IDs).
- [ ] Scan for flakiness vectors: time-sensitive assertions, shared state, network calls, and ordering dependencies.
- [ ] Remove or quarantine known-flaky tests instead of skipping them silently.

## Negative Paths & Recovery

- [ ] Make sure at least one test exercises the expected failure mode for each changed public contract.
- [ ] Check retry exhaustion, timeout, validation-error, and permission-denied behavior where those cases matter.
- [ ] Prefer deterministic fault injection over ad hoc sleeps or brittle environment toggles.

## CI & Decision Output

- [ ] Confirm CI runs the recommended test set and fails on regressions.
- [ ] Record whether smoke, canary, or post-deploy validation is needed for the changed risk surface.
- [ ] Make the final recommendation explicit: required tests, optional tests, and accepted gaps.

# Refactor Safety Checklist

## Pre-Refactor Safety

- [ ] Existing test suite passes at the current commit (baseline recorded).
- [ ] Target area has sufficient test coverage; characterization tests added where gaps exist.
- [ ] Observable behaviors to preserve are explicitly listed (outputs, side effects, error contracts).
- [ ] Refactor scope is bounded; unrelated improvements are deferred to a follow-up.

## Seam Identification

- [ ] Interaction points between the target code and the rest of the system are mapped.
- [ ] Each seam is narrow enough to serve as a safe extraction or substitution boundary.
- [ ] Dependency direction at each seam is documented (who calls whom, who owns the interface).

## Decomposition Order

- [ ] Decomposition sequence is leaf-to-root; most-independent units are refactored first.
- [ ] No change modifies a module and its consumers in the same step.
- [ ] Order is written down before work begins; deviations are justified.

## Change Separation

- [ ] Each commit is purely structural (move, rename, extract) or purely semantic (logic change).
- [ ] No commit mixes a refactor mechanic with a feature addition or bug fix.
- [ ] Re-exports or adapter wrappers preserve the existing public API until consumers migrate.

## Incremental Verification

- [ ] Tests re-run after every atomic refactor step; no untested multi-step leaps.
- [ ] Type-check and lint pass at each intermediate commit.
- [ ] No new warnings, deprecations, or test skips introduced by the refactor.

## Rollback Readiness

- [ ] Each intermediate commit leaves the codebase in a buildable, test-passing state.
- [ ] Reverting the latest commit restores a green test suite.
- [ ] No irreversible side effects (data migrations, external API changes) bundled with the refactor.

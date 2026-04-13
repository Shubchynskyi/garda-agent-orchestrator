# Dependency Review Checklist

## Versioning and Upgrade Scope
- Validate major-version upgrades and range widening explicitly.
- Validate removed packages are not still required by runtime or build scripts.
- Validate lockfile changes match manifest intent.

## Supply Chain and Integrity
- Validate new dependencies have a trusted source and clear ownership.
- Validate integrity/pin files remain deterministic.
- Validate no unexpected registry or source override was introduced.

## Compatibility and Rollout Risk
- Validate build, runtime, and test compatibility assumptions.
- Validate migration or release-note evidence for breaking changes.
- Validate operational impact for transitive upgrades in production paths.

## Checklist Row Template
```text
| rule_id | status | evidence |
|---------|--------|----------|
| DEP-MAJOR-UPGRADE | PASS | package.json:18 |
```

## Dependency Rule IDs
- `DEP-MAJOR-UPGRADE`
- `DEP-LOCKFILE-DETERMINISM`
- `DEP-SUPPLY-CHAIN-PROVENANCE`
- `DEP-BREAKING-CHANGE-EVIDENCE`
- `DEP-RUNTIME-COMPATIBILITY`

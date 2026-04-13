# Refactor Review Checklist

## Behavior Preservation
- Validate unchanged public API contracts unless explicitly documented.
- Validate unchanged domain behavior for core business flows.
- Validate backward compatibility for config, events, and DTO mappings.

## Structural Quality
- Validate SRP and separation of concerns improved or preserved.
- Validate complexity or coupling did not increase on hot paths.
- Validate duplicated logic was reduced without hidden side effects.
- Validate refactor did not leave unused imports, stale variables, or dead helpers in changed scope.
- If IntelliJ IDEA / JetBrains inspections, Qodana, compiler, or linter warnings are available for changed files, treat unresolved warnings as findings unless explicitly justified.

## Safety and Test Adequacy
- Validate tests cover refactored behavior-critical paths.
- Validate edge-case handling remained intact after extraction or renaming.
- Validate no silent behavior drift in exception handling or transaction flow.

## Checklist Row Template
```text
| rule_id | status | evidence |
|---------|--------|----------|
| REF-BEHAVIOR-PRESERVATION | PASS | backend/.../OrderService.java:88 |
```

## Refactor Rule IDs
- `REF-BEHAVIOR-PRESERVATION`
- `REF-CONTRACT-COMPATIBILITY`
- `REF-COMPLEXITY-NONREGRESSION`
- `REF-COUPLING-REDUCTION`
- `REF-NO-UNUSED-IMPORTS`
- `REF-NO-UNUSED-VARIABLES`
- `REF-INSPECTION-WARNINGS`
- `REF-TEST-ADEQUACY`

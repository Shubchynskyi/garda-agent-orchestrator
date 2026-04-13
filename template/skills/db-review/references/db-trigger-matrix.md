# DB Trigger Matrix

## Canonical Trigger Source
DB trigger conditions are defined only in:
`garda-agent-orchestrator/live/skills/orchestration/references/review-trigger-matrix.md`

Do not duplicate trigger patterns in this file.

## DB Rule IDs
- `DB-MIGRATIONS`
- `DB-N-PLUS-ONE`
- `DB-INDEX-BACKED`
- `DB-MODULE-BOUNDARIES`
- `QG-TRANSACTIONS`

## Checklist Row Template
```text
| rule_id | status | evidence |
|---------|--------|----------|
| DB-INDEX-BACKED | FAIL | backend/catalog-module/.../ProductRepository.java:88 |
```





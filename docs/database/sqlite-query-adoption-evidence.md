# SQLite Query Adoption Evidence

Status: T-1000-4 benchmark record, 2026-08-03.

The measurements below compare canonical file readers and the derived SQLite
query boundary in the same Node process and worktree. Each warm result uses 10
discarded warmups and 30 recorded samples. Values are local evidence, not
cross-machine latency claims.

## Environment

| Field | Value |
|---|---|
| Base Git revision | `799669a3` plus the T-1000-4 worktree |
| OS | Microsoft Windows 11 Home 10.0.26200 (build 26200) |
| CPU | Intel Core Ultra 9 275HX |
| Storage | NVMe Samsung SSD 990 PRO 4TB |
| Node | 24.11.1 |
| Embedded SQLite | 3.50.4 |
| Journal | WAL |
| Process count during evidence capture | 353 |
| Stress database recovery unit | 53,755,904-byte main, 0-byte WAL, 32,768-byte SHM |

The stress aggregation plan used the covering lifecycle-event primary-key
index (`SCAN lifecycle_events USING COVERING INDEX
sqlite_autoindex_lifecycle_events_2`).

## Results

| Path | Fixture | Canonical p95 | Routed/SQLite p95 | Result |
|---|---:|---:|---:|---|
| Task queue lookup | 50 tasks | 0.497 ms | 36.583 ms | SQLite rejected; file reader retained |
| Task queue lookup | 1,000 tasks | 1.535 ms | 41.677 ms | SQLite rejected; file reader retained |
| Bulk task activity aggregation | 50 tasks / 5,000 events | 11.745 ms | 13.105 ms routed file fallback | +1.360 ms; within the 5 ms Typical allowance |
| Bulk task activity aggregation | 1,000 tasks / 100,000 events | 235.621 ms | 120.128 ms SQLite | 49.0% lower p95; adopted |
| Canonical event append | focused fixture | 59.944 ms | 39.997 ms with projection scheduling | no measured p95 regression |

The bulk router counts only task-event directory entries before selecting a
backend. Fewer than 200 per-task event streams stay on the canonical reader and
do not pay SQLite open, filesystem-locality, or connection-lease cost. At or
above that boundary, a compatible, ready, generation-current, source-current
catalog may serve the aggregate. Missing, stale, changed, locked, incompatible,
or corrupt catalogs select the canonical fallback.

## Adopted And Rejected Paths

- Adopted: bulk dashboard task-activity summaries and the same queue-status
  index used only when a retention preview itself contains at least 200 task
  candidates. Empty and smaller previews read the canonical task queue directly,
  even when the wider workspace contains 200 or more task-event streams.
- Retained on files: navigator/task status, focused task history, focused
  review/receipt lookup, and small-project reports. Their file readers were
  faster than opening a coordinated read-only SQLite connection.
- Available behind the repository boundary: typed task, lifecycle, review,
  receipt, artifact, ledger, retention, metric, and aggregate queries. Consumers
  may activate them only after their own workload passes the same parity and
  latency policy.

Cleanup deletion is never authorized by the aggregate. The SQLite result is a
queue-status hint only; the existing canonical event integrity, runtime
activity, ledger, age, root-confinement, preview, and confirmation checks remain
mandatory.

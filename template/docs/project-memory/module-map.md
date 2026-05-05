# Module Map

Map stable repository areas to ownership, purpose, and usual verification. Prefer paths and boundaries that help agents inspect the right files quickly.

## Areas
| Area | Paths | Purpose | Read with |
|---|---|---|---|
| Core domain |  |  | `architecture.md`, `risks.md` |
| Application entrypoints |  |  | `commands.md` |
| Tests |  |  | `commands.md`, `conventions.md` |
| Configuration |  |  | `stack.md`, `risks.md` |
| Documentation |  |  | `decisions.md` |

## Generated Or Vendor Paths
- 

## Unknown Or Custom Stack Fallback
- If no known stack pack fits, derive the map from manifest files, build scripts, lockfiles, top-level directories, and test locations.
- Record only confirmed facts here; leave uncertain findings as questions until verified.

# CLI Path Input Containment

Garda classifies every path-shaped CLI option before a command may use it. The
canonical machine-readable inventory is
`src/core/cli-path-input-policy.ts`; tests scan CLI source so adding a new
path-shaped flag without an explicit classification fails.

## Policy Classes

| Class | Contract |
|---|---|
| `workspace-contained` | The path must remain under `--repo-root`, `--target-root`, or the current working directory. Existing symlinks and Windows junctions are resolved before the command continues. Missing output paths are checked through their nearest existing ancestor. |
| `workspace-expression` | The value is a repository-relative path or glob expression and is validated by its owning domain parser rather than dereferenced as one literal path. |
| `root-anchor` | The operator is selecting the root that establishes the containment boundary. |
| `external-allowed` | The command intentionally consumes an operator-selected path outside the workspace. |
| `contextual` | The same flag has command-specific policy. Its owning command must apply the stricter rule at the read/write boundary. |
| `path-metadata` | The value describes a path for routing or allowlisted metadata but is not dereferenced. |
| `non-filesystem` | The flag name contains `path`, `file`, `dir`, or `root`, but its value is not a filesystem path. |

## External And Contextual Exceptions

- `--source-path` may reference an unpacked update bundle outside the target
  workspace.
- `--snapshot-path` may reference an operator-owned rollback snapshot outside
  the target workspace.
- `--chdir` is controlled by the command being executed and is not interpreted
  as a Garda artifact path.
- `--output-path` is contextual: gate outputs stay repository-contained, while
  `garda html --output-path` intentionally permits an operator-selected report
  destination.
- `--repo-root`, `--target-root`, and `--bundle-root` establish roots; they are
  not children of a pre-existing workspace boundary.

No exception permits a workspace-contained input to traverse through a
repo-local symlink or junction to an external target. Validation errors report
only the option and path boundary; file contents are never included.

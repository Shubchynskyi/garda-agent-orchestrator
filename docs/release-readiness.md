# Release Readiness

This tracked checklist is the release-cut source of truth for static readiness.
Local `TASK.md` and `TASK_DONE.md` files are intentionally gitignored operator
queues and must not be treated as publish blockers by release validation.

## 1.2.0

- [x] Package metadata is aligned to `1.2.0` in `package.json`, `package-lock.json`, and `VERSION`.
- [x] `.github/workflows/publish.yml` is the primary tag-driven release workflow for `v*` tags and runs on GitHub-hosted Ubuntu with Node 24.
- [x] The publish workflow validates tag/version parity, runs `npm ci`, runs `npm run release:preflight`, and records `npm pack --dry-run` output before any stage-publish job can start.
- [x] The `publish` job targets the GitHub Environment `npm-release`, uses `permissions: contents: read, id-token: write`, disables package-manager cache, upgrades npm CLI to `11.15.0+`, reruns release proof before staging, and stages with plain `npm stage publish` through npm Trusted Publishing/OIDC.
- [x] The `npm-release` GitHub Environment setup is documented as release-tag restricted to `v*`; GitHub required reviewers are optional and not required for the solo maintainer release path.
- [x] npmjs.com Trusted Publisher settings are documented as GitHub Actions publisher `Shubchynskyi` / `garda-agent-orchestrator` / `publish.yml`, Environment `npm-release`, and allowed action `npm stage publish`.
- [x] npm-side staged approval with maintainer 2FA is documented before the staged package becomes public.
- [x] Post-verification hardening is documented: set Publishing access to `Require two-factor authentication and disallow tokens` and remove obsolete publish tokens only after Trusted Publishing staged publish succeeds.
- [x] Release operators are told not to claim provenance until npm shows package provenance/attestation evidence for the public package.
- [x] Post-publish verification includes npm `latest`, package integrity/provenance visibility, and `npx --yes garda-agent-orchestrator@1.2.0 --version`.
- [x] Published tarballs use the compiled-only runtime surface: `dist/**`, `bin/garda.js`, templates, metadata, and public docs remain, while `src/**`, `tests/**`, `.node-build/**`, and `.scripts-build/**` are excluded and package smoke proves install/invoke without consumer build tooling.
- [x] Release preflight writes and validates an offline deterministic package-surface artifact against the tracked explicit baseline; intentional material growth requires a reviewed baseline update with an audit rationale.

### Offline package-surface contract

`npm run validate:package-surface` is the final `release:preflight` step. It builds
the publish runtime, materializes the same legacy compatibility document used by
`prepack`, and inspects `npm pack --dry-run --json --ignore-scripts`. It neither
contacts Socket nor requires a Socket token or any other release-scoring network
service. The current deterministic JSON artifact is written to the gitignored
`garda-agent-orchestrator/runtime/release/package-surface-current.json` path.

The tracked reference is
`config/release-package-surface-baseline.json`. The comparison contract is:

- `fileCount` and `unpackedSizeBytes` may grow only by the numeric allowances in
  the baseline. The default reviewed allowances are 10 files and 256 KiB.
- npm lifecycle scripts are recorded as a sorted name-to-command map. Any add,
  removal, or command change fails the comparison.
- executable `.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, and `.mts` files are scanned
  for the lexical signals `child_process`, `exec`/`execFile` variants, `fetch`,
  `node:fs` or `fs.` use, `readFile` variants, and `writeFile` variants. The
  baseline allows no unreviewed signal-count growth.
- The sorted packed path-and-size manifest is SHA-256 bound in the current
  artifact. An explicitly supplied prior artifact can replace the baseline with
  `--prior-artifact <path>` and uses the conservative default growth allowances.

These lexical counts are review prompts, not vulnerability findings. A failure
means inspect the package diff; it does not assert that the matched code is
unsafe. For intentional growth, refresh the tracked baseline only with the
explicit audited command and commit the rationale with the resulting diff:

```powershell
node scripts/node-foundation/build-scripts.cjs validate-release.js package-surface-baseline --confirm-baseline-update --rationale "Describe the reviewed package growth"
```

The command never silently updates the baseline: both the confirmation flag and
a non-empty rationale are mandatory. External Socket scores remain advisory and
may temporarily move because of signals such as `recentlyPublished`; their
availability and score are not release gates.

## 1.1.0

- [x] Update provenance and self-update trust policy are documented and validated.
- [x] Protected control-plane strict scanning has explicit symlink and cache trust contracts.
- [x] Review follow-up materialization does not invalidate unchanged review scope.
- [x] Delegation target validation checks package identity and path containment.
- [x] Trusted source-checkout setup and bootstrap commands can repair source/bundle parity.
- [x] Sourceful package distribution policy is documented and enforced.
- [x] Release docs, package metadata, manifest, provider wording, and runtime wording are aligned.
- [x] Completion-gate success routes agents to final closeout before commit guidance.
- [x] Pre-release audit separated release proof from readiness-validator false negatives.
- [x] Release-readiness validation uses git-tracked checklist state instead of local task queues.
- [x] CI smoke validation accepts multiline lifecycle run scripts without weakening matrix checks.
- [x] Release preflight runs a short runtime-contract smoke suite before the expensive full proof.
- [x] Residual release-security baseline labels existing security checks as blocking or informational and reports action-pinning and update-source policy diagnostics without adding a duplicate pipeline.

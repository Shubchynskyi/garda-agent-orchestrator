# Software Bill of Materials (SBOM)

This repository generates a [CycloneDX](https://cyclonedx.org/) Software
Bill of Materials (SBOM) as part of its CI pipeline. The SBOM enumerates
every direct and transitive npm dependency so that downstream consumers
can audit the supply chain.

## How It Works

| Layer | Purpose |
|---|---|
| **SBOM generation (this doc)** | Enumerates all dependencies in a machine-readable format. |
| **npm audit (`security.yml`)** | Blocks on high-severity known vulnerabilities. |
| **OSV scan (`security.yml`)** | Scans against the open-source vulnerability database. |
| **Secret scanning (`secret-scanning.yml`)** | Prevents secrets from entering the repository. |

Together these layers form a defence-in-depth supply-chain security
posture: the SBOM provides transparency while audit and vulnerability
scans enforce known-good baselines.

## CI Integration

The GitHub Actions workflow `.github/workflows/sbom.yml` generates the
SBOM automatically on:

- every push to `main`, `master`, `dev`, and `release/**` branches;
- every push of a version tag (`v*`);
- every pull request targeting those branches;
- manual `workflow_dispatch`.

### What the workflow does

1. Checks out the repository.
2. Installs production and development dependencies via `npm ci`.
3. Runs `@cyclonedx/cyclonedx-npm` to produce a CycloneDX 1.5 JSON file
   (`sbom.cdx.json`) with reproducible output.
4. Uploads the SBOM as a GitHub Actions artifact (`sbom-cyclonedx`) with
   90-day retention.

## Local Usage

### Generate an SBOM locally

```bash
# Using npx (no global install required)
npx @cyclonedx/cyclonedx-npm --output-file sbom.cdx.json --spec-version 1.5 --output-reproducible

# Or install globally first
npm install -g @cyclonedx/cyclonedx-npm
cyclonedx-npm --output-file sbom.cdx.json --spec-version 1.5 --output-reproducible
```

The generated `sbom.cdx.json` contains every component resolved from
`package-lock.json` including name, version, purl, hashes, and license
metadata.

### Validate the SBOM

Use the CycloneDX CLI to validate the generated file:

```bash
# Install the validator
npm install -g @cyclonedx/cyclonedx-cli

# Validate
cyclonedx-cli validate --input-file sbom.cdx.json --input-format json --input-version v1_5
```

### View the SBOM

For a quick human-readable summary, pipe through `jq`:

```bash
# List all component names and versions
jq '.components[] | {name, version}' sbom.cdx.json

# Count total components
jq '.components | length' sbom.cdx.json
```

## Output Format

The SBOM uses the **CycloneDX 1.5** JSON specification. Key sections:

| Section | Content |
|---|---|
| `metadata` | Tool identity, timestamp, component (this package). |
| `components` | All direct and transitive npm dependencies with purl, version, hashes, and licenses. |
| `dependencies` | Dependency graph edges between components. |

## Configuration

The SBOM generation uses `@cyclonedx/cyclonedx-npm` with these flags:

| Flag | Purpose |
|---|---|
| `--output-file sbom.cdx.json` | Output path for the generated SBOM. |
| `--spec-version 1.5` | Target CycloneDX specification version. |
| `--output-reproducible` | Omit timestamps and UUIDs for deterministic output. |

No additional configuration file is needed. The tool reads
`package-lock.json` directly.

## Troubleshooting

| Symptom | Action |
|---|---|
| `sbom.cdx.json` not generated | Ensure `npm ci` ran successfully first so `node_modules/` and `package-lock.json` are present. |
| Missing components in SBOM | Run `npm ci` (not `npm install`) to ensure the lock file is honoured exactly. |
| Validation errors | Check that the spec version flag matches the validator version (`v1_5` for 1.5). |
| CI artifact missing | Check that `if-no-files-found: error` surfaced a failure in the upload step. |

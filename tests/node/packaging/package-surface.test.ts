import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildPackageSurfaceArtifact,
    comparePackageSurface,
    createPackageSurfaceBaseline,
    formatPackageSurfaceComparison,
    parseNpmPackReport,
    parsePackageSurfaceCliOptions,
    updatePackageSurfaceBaseline,
    validatePackageSurface
} from '../../../scripts/node-foundation/validate-release';
import type {
    NpmPackReport,
    PackageSurfaceAllowedGrowth,
    PackageSurfaceArtifact
} from '../../../scripts/node-foundation/validate-release';

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function createFixture(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-package-surface-'));
    writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({
        name: 'fixture-package',
        version: '1.2.3',
        scripts: {
            postpack: 'node cleanup.cjs',
            prepack: 'node build.cjs'
        }
    }, null, 2));
    writeFile(
        path.join(repoRoot, 'dist', 'runtime.js'),
        "const fs = require('node:fs');\nfs.readFileSync('input');\nfetch('https://example.invalid');\n"
    );
    writeFile(
        path.join(repoRoot, 'bin', 'cli.cjs'),
        "const childProcess = require('node:child_process');\nconst filesystem = require('fs');\nchildProcess.execFileSync('node');\n"
    );
    writeFile(path.join(repoRoot, 'README.md'), '# Fixture\nwriteFile is documentation only.\n');
    return repoRoot;
}

function buildPackReport(overrides: Partial<NpmPackReport> = {}): NpmPackReport {
    return {
        name: 'fixture-package',
        version: '1.2.3',
        filename: 'fixture-package-1.2.3.tgz',
        entryCount: 4,
        unpackedSize: 420,
        files: [
            { path: 'README.md', size: 42 },
            { path: 'bin/cli.cjs', size: 88 },
            { path: 'dist/runtime.js', size: 190 },
            { path: 'package.json', size: 100 }
        ],
        ...overrides
    };
}

const ZERO_GROWTH: PackageSurfaceAllowedGrowth = Object.freeze({
    fileCount: 0,
    unpackedSizeBytes: 0,
    riskSignals: Object.freeze({
        child_process: 0,
        exec: 0,
        fetch: 0,
        fs: 0,
        readFile: 0,
        writeFile: 0
    })
});

test('published package surface includes review catalog defaults and public guidance', () => {
    const repoRoot = process.cwd();
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
        files: string[];
    };

    assert.ok(packageJson.files.includes('template'));
    for (const relativePath of [
        'template/config/review-catalog.json',
        'template/docs/agent-rules/80-task-workflow.md',
        'docs/configuration.md',
        'docs/cli-reference.md',
        'docs/compatibility-matrix.md'
    ]) {
        assert.ok(fs.existsSync(path.join(repoRoot, relativePath)), `${relativePath} should be package-visible`);
    }
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(repoRoot, 'template', 'config', 'review-catalog.json'), 'utf8')),
        { version: 1, custom_review_types: [] }
    );
});

test('buildPackageSurfaceArtifact deterministically measures packed files, lifecycle scripts, and executable lexical signals', () => {
    const repoRoot = createFixture();
    try {
        const artifact = buildPackageSurfaceArtifact(repoRoot, buildPackReport());

        assert.deepEqual(artifact.package, { name: 'fixture-package', version: '1.2.3' });
        assert.equal(artifact.metrics.fileCount, 4);
        assert.equal(artifact.metrics.unpackedSizeBytes, 420);
        assert.deepEqual(artifact.metrics.lifecycleScripts, {
            postpack: 'node cleanup.cjs',
            prepack: 'node build.cjs'
        });
        assert.deepEqual(artifact.metrics.riskSignals, {
            child_process: 1,
            exec: 1,
            fetch: 1,
            fs: 3,
            readFile: 1,
            writeFile: 0
        });
        assert.match(artifact.packedFileManifestSha256, /^[a-f0-9]{64}$/u);

        const reversedReport = buildPackReport({ files: [...buildPackReport().files].reverse() });
        assert.deepEqual(buildPackageSurfaceArtifact(repoRoot, reversedReport), artifact);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('buildPackageSurfaceArtifact does not treat documentation text as executable risk signals', () => {
    const repoRoot = createFixture();
    try {
        const artifact = buildPackageSurfaceArtifact(repoRoot, buildPackReport());
        assert.equal(artifact.metrics.riskSignals.writeFile, 0);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('buildPackageSurfaceArtifact rejects inconsistent or unsafe npm pack reports', () => {
    const repoRoot = createFixture();
    try {
        assert.throws(
            () => buildPackageSurfaceArtifact(repoRoot, buildPackReport({ entryCount: 5 })),
            /entryCount=5 does not match files.length=4/u
        );
        assert.throws(
            () => buildPackageSurfaceArtifact(repoRoot, buildPackReport({
                files: [{ path: '../outside.js', size: 420 }],
                entryCount: 1
            })),
            /unsafe packed file path/u
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('buildPackageSurfaceArtifact rejects executable files reached through a linked parent outside the repository', () => {
    const repoRoot = createFixture();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-package-surface-outside-'));
    try {
        const outsideFile = path.join(outsideRoot, 'outside.js');
        writeFile(outsideFile, "require('node:child_process');\n");
        const linkedParent = path.join(repoRoot, 'linked-dist');
        fs.symlinkSync(outsideRoot, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
        const size = Buffer.byteLength(fs.readFileSync(outsideFile));

        assert.throws(
            () => buildPackageSurfaceArtifact(repoRoot, buildPackReport({
                entryCount: 1,
                unpackedSize: size,
                files: [{ path: 'linked-dist/outside.js', size }]
            })),
            /resolves outside the repository through a linked path/u
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

test('parseNpmPackReport accepts lifecycle output before one final npm JSON report', () => {
    const report = buildPackReport();
    const output = [
        'SCRIPTS_BUILD_REUSE accepted',
        'Generated legacy package compatibility template',
        JSON.stringify([report], null, 2)
    ].join('\n');

    assert.deepEqual(parseNpmPackReport(output), report);
    assert.throws(() => parseNpmPackReport('build complete\nnot-json'), /valid npm pack JSON array/u);
    assert.throws(
        () => parseNpmPackReport(`${JSON.stringify([report])}\n${JSON.stringify([report])}`),
        /exactly one final package report/u
    );
});

test('comparePackageSurface accepts deltas within an explicit baseline allowance', () => {
    const repoRoot = createFixture();
    try {
        const reference = buildPackageSurfaceArtifact(repoRoot, buildPackReport());
        const baseline = createPackageSurfaceBaseline(reference, {
            rationale: 'Initial compiled-only release surface.',
            allowedGrowth: {
                ...ZERO_GROWTH,
                fileCount: 2,
                unpackedSizeBytes: 64
            }
        });
        const current: PackageSurfaceArtifact = {
            ...reference,
            metrics: {
                ...reference.metrics,
                fileCount: reference.metrics.fileCount + 2,
                unpackedSizeBytes: reference.metrics.unpackedSizeBytes + 64
            }
        };

        const result = comparePackageSurface(current, baseline, 'config/release-package-surface-baseline.json');
        assert.equal(result.passed, true, formatPackageSurfaceComparison(result));
        assert.equal(result.referenceKind, 'baseline');
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('comparePackageSurface fails material bloat, lifecycle drift, and lexical risk-signal growth with actionable diagnostics', () => {
    const repoRoot = createFixture();
    try {
        const reference = buildPackageSurfaceArtifact(repoRoot, buildPackReport());
        const baseline = createPackageSurfaceBaseline(reference, {
            rationale: 'Lock the reviewed surface.',
            allowedGrowth: ZERO_GROWTH
        });
        const current: PackageSurfaceArtifact = {
            ...reference,
            metrics: {
                fileCount: reference.metrics.fileCount + 1,
                unpackedSizeBytes: reference.metrics.unpackedSizeBytes + 1,
                lifecycleScripts: {
                    ...reference.metrics.lifecycleScripts,
                    install: 'node install.cjs'
                },
                riskSignals: {
                    ...reference.metrics.riskSignals,
                    exec: reference.metrics.riskSignals.exec + 1
                }
            }
        };

        const result = comparePackageSurface(current, baseline, 'config/release-package-surface-baseline.json');
        const output = formatPackageSurfaceComparison(result);
        assert.equal(result.passed, false);
        assert.match(output, /fileCount current=5 reference=4 growth=1 allowed=0/u);
        assert.match(output, /unpackedSizeBytes current=421 reference=420 growth=1 allowed=0/u);
        assert.match(output, /lifecycleScripts changed: added install=node install\.cjs/u);
        assert.match(output, /riskSignals\.exec current=2 reference=1 growth=1 allowed=0/u);
        assert.match(output, /package-surface-baseline --confirm-baseline-update --rationale/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('an explicitly supplied prior artifact uses conservative default growth limits', () => {
    const repoRoot = createFixture();
    try {
        const reference = buildPackageSurfaceArtifact(repoRoot, buildPackReport());
        const current: PackageSurfaceArtifact = {
            ...reference,
            metrics: {
                ...reference.metrics,
                riskSignals: {
                    ...reference.metrics.riskSignals,
                    child_process: reference.metrics.riskSignals.child_process + 1
                }
            }
        };
        const result = comparePackageSurface(current, reference, 'artifacts/prior-package-surface.json');

        assert.equal(result.referenceKind, 'prior-artifact');
        assert.equal(result.passed, false);
        assert.match(formatPackageSurfaceComparison(result), /riskSignals\.child_process/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('baseline updates require an explicit confirmation and non-empty audit rationale', () => {
    const repoRoot = createFixture();
    const baselinePath = path.join(repoRoot, 'config', 'baseline.json');
    try {
        const artifact = buildPackageSurfaceArtifact(repoRoot, buildPackReport());
        assert.throws(
            () => updatePackageSurfaceBaseline(baselinePath, artifact, {
                confirmed: false,
                rationale: 'Intentional release growth.',
                allowedGrowth: ZERO_GROWTH
            }),
            /--confirm-baseline-update/u
        );
        assert.throws(
            () => updatePackageSurfaceBaseline(baselinePath, artifact, {
                confirmed: true,
                rationale: '   ',
                allowedGrowth: ZERO_GROWTH
            }),
            /--rationale/u
        );
        assert.throws(
            () => createPackageSurfaceBaseline(artifact, {
                rationale: 'Invalid allowance.',
                allowedGrowth: { ...ZERO_GROWTH, fileCount: -1 }
            }),
            /allowedGrowth\.fileCount/u
        );

        const baseline = updatePackageSurfaceBaseline(baselinePath, artifact, {
            confirmed: true,
            rationale: 'Intentional release growth.',
            allowedGrowth: ZERO_GROWTH
        });
        assert.deepEqual(JSON.parse(fs.readFileSync(baselinePath, 'utf8')), baseline);
        assert.equal(fs.readFileSync(baselinePath, 'utf8').endsWith('\n'), true);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validation rejects artifact outputs that could overwrite repository or reference files before packing', () => {
    const repoRoot = createFixture();
    try {
        assert.throws(
            () => validatePackageSurface(repoRoot, { outputPath: 'package.json' }),
            /--output must be a JSON file inside/u
        );
        assert.throws(
            () => validatePackageSurface(repoRoot, {
                baselinePath: 'garda-agent-orchestrator/runtime/release/current.json',
                outputPath: 'garda-agent-orchestrator/runtime/release/current.json'
            }),
            /cannot overwrite the baseline/u
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validatePackageSurface completes the offline package collection workflow and cleans compatibility output', {
    timeout: 120_000
}, () => {
    const repoRoot = process.cwd();
    const relativeOutputPath = `garda-agent-orchestrator/runtime/release/package-surface-e2e-${process.pid}.json`;
    const outputPath = path.join(repoRoot, relativeOutputPath);
    const compatibilityPath = path.join(repoRoot, 'template', 'CLAUDE.md');
    assert.equal(fs.existsSync(compatibilityPath), false, 'integration test requires a clean compatibility-file boundary');
    fs.rmSync(outputPath, { force: true });
    try {
        const result = validatePackageSurface(repoRoot, { outputPath: relativeOutputPath });
        const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as PackageSurfaceArtifact;

        assert.equal(result.passed, true, formatPackageSurfaceComparison(result));
        assert.ok(artifact.metrics.fileCount > 0);
        assert.match(artifact.packedFileManifestSha256, /^[a-f0-9]{64}$/u);
        assert.equal(fs.existsSync(compatibilityPath), false, 'normal collection must remove compatibility output');
    } finally {
        fs.rmSync(outputPath, { force: true });
        fs.rmSync(compatibilityPath, { force: true });
    }
});

test('package-surface CLI options reject silent baseline refreshes and ambiguous references', () => {
    assert.deepEqual(parsePackageSurfaceCliOptions([]), {
        baselinePath: null,
        outputPath: null,
        priorArtifactPath: null,
        confirmBaselineUpdate: false,
        rationale: null
    });
    assert.throws(
        () => parsePackageSurfaceCliOptions(['--baseline', 'baseline.json', '--prior-artifact', 'prior.json']),
        /cannot be used together/u
    );
    assert.throws(() => parsePackageSurfaceCliOptions(['--confirm-baseline-update']), /only valid for package-surface-baseline/u);
    assert.throws(
        () => parsePackageSurfaceCliOptions(['--baseline', '../unrelated.json'], 'baseline-update'),
        /--baseline is read-only and is not valid for package-surface-baseline/u
    );
    assert.throws(() => parsePackageSurfaceCliOptions(['--unknown']), /Unknown package-surface option/u);
});

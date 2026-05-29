import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    formatReleaseReadinessResult,
    RELEASE_VALIDATION_COMMANDS,
    RELEASE_VALIDATION_COMMAND_HANDLERS,
    resolveReleaseValidationCommand,
    runReleaseValidationCli,
    validateReleaseReadiness
} from '../../../scripts/node-foundation/validate-release';

const RELEASE_BLOCKERS = Object.freeze([
    'T-385',
    'T-371',
    'T-328',
    'T-329',
    'T-330',
    'T-331',
    'T-332',
    'T-333',
    'T-334',
    'T-319',
    'T-320',
    'T-455',
    'T-456',
    'T-321',
    'T-326',
    'T-270',
    'T-290',
    'T-309',
    'T-238'
]);

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function runGit(repoRoot: string, args: string[]): void {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
}

function initializeGitIndex(repoRoot: string): void {
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['add', '.']);
}

function buildPackageJson(): string {
    return JSON.stringify({
        name: 'garda-agent-orchestrator',
        version: '1.1.0',
        scripts: {
            'validate:version-parity': 'node scripts/node-foundation/build-scripts.cjs validate-release.js',
            'validate:embedded-bundle-parity': 'node scripts/node-foundation/build-scripts.cjs validate-release.js embedded-bundle-parity',
            'validate:clean-worktree': 'node scripts/node-foundation/build-scripts.cjs validate-release.js clean-worktree',
            'validate:release-readiness': 'node scripts/node-foundation/build-scripts.cjs validate-release.js release-readiness',
            lint: 'eslint "src/**/*.ts" "tests/node/**/*.ts" "scripts/node-foundation/**/*.ts"',
            coverage: 'c8 --reporter=text --reporter=lcov npm test',
            'coverage:fast': 'c8 --reporter=text --reporter=lcov npm run test:fast',
            'audit:prod': 'npm audit --omit=dev',
            quality: 'npm run typecheck && npm run lint && npm run coverage && npm run audit:prod',
            'quality:fast': 'npm run typecheck && npm run lint && npm run coverage:fast && npm run audit:prod',
            'validate:release': 'npm run validate:clean-worktree && npm run validate:version-parity && npm run build && npm run validate:embedded-bundle-parity && npm run quality && npm run test:packaging && npm run validate:clean-worktree',
            'validate:release:fast': 'npm run validate:clean-worktree && npm run validate:version-parity && npm run build && npm run validate:embedded-bundle-parity && npm run quality:fast && npm run test:packaging && npm run validate:clean-worktree',
            'release:preflight': 'npm run validate:release-readiness && npm run validate:release',
            prepack: 'npm run validate:clean-worktree && npm run build:publish-runtime && npm run validate:clean-worktree && node scripts/package-legacy-entrypoint-compat.cjs create',
            'test:unit': 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/core',
            'test:gates': 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates',
            'test:cli': 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/cli',
            'test:lifecycle': 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/lifecycle',
            'test:bin': 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/bin',
            'test:packaging': 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/packaging/pack-smoke.test.ts',
            'test:full': 'node scripts/node-foundation/build-scripts.cjs test.js',
            'test:fast': 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/core'
        },
        files: [
            'bin',
            'dist',
            'src',
            'template',
            'package.json',
            'MANIFEST.md',
            'SECURITY.md',
            'README.md',
            'HOW_TO.md',
            'CHANGELOG.md',
            'docs/architecture.md',
            'docs/cli-reference.md',
            'docs/configuration.md',
            'docs/node-platform-foundation.md',
            'docs/operator-consistency-runbook.md',
            'docs/release-readiness.md',
            'docs/sbom.md',
            'docs/threat-model.md',
            'docs/work-example.md',
            'VERSION'
        ]
    }, null, 2);
}

function buildReleaseChecklist(openItem?: string): string {
    const checklistItems = RELEASE_BLOCKERS.map((taskId) => {
        const status = taskId === openItem ? ' ' : 'x';
        return `- [${status}] ${taskId} fixture release blocker`;
    }).join('\n');
    return [
        '# Release Readiness',
        '',
        'This tracked checklist is the release-cut source of truth for readiness.',
        '',
        '## 1.1.0',
        '',
        checklistItems,
        '',
        '## 1.2.0'
    ].join('\n');
}

interface BuildCiWorkflowOptions {
    includeNodeVersionInJobs?: boolean;
    smokeSteps?: string;
}

function buildCiWorkflow(options: BuildCiWorkflowOptions = {}): string {
    const includeNode = options.includeNodeVersionInJobs !== false;
    const smokeSteps = options.smokeSteps || '    - run: $CLI setup\n    - run: $CLI update git\n    - run: $CLI doctor\n    - run: $CLI uninstall';

    return [
        'validate-release:',
        '  name: Release Validation / ${{ matrix.os }} / Node ${{ matrix.node-version }}',
        '  strategy:',
        '    matrix:',
        includeNode ? '      node-version:\n        - \'22.13.0\'\n        - \'24\'' : '',
        '      os:',
        '        - ubuntu-latest',
        '        - windows-latest',
        '  steps:',
        '    - run: npm run validate:release:fast',
        'test-unit:',
        '  strategy:',
        '    matrix:',
        includeNode ? '      node-version:\n        - \'22.13.0\'\n        - \'24\'' : '',
        '  steps:',
        '    - run: npm run test:unit',
        'test-gates:',
        '  strategy:',
        '    matrix:',
        includeNode ? '      node-version:\n        - \'22.13.0\'\n        - \'24\'' : '',
        '  steps:',
        '    - run: npm run test:gates',
        '      env:',
        '        GARDA_NODE_FOUNDATION_TEST_SHARDS: 2',
        'test-cli:',
        '  strategy:',
        '    matrix:',
        includeNode ? '      node-version:\n        - \'22.13.0\'\n        - \'24\'' : '',
        '  steps:',
        '    - run: npm run test:cli',
        'test-lifecycle:',
        '  strategy:',
        '    matrix:',
        includeNode ? '      node-version:\n        - \'22.13.0\'\n        - \'24\'' : '',
        '  steps:',
        '    - run: npm run test:lifecycle',
        'test-bin:',
        '  strategy:',
        '    matrix:',
        includeNode ? '      node-version:\n        - \'22.13.0\'\n        - \'24\'' : '',
        '  steps:',
        '    - run: npm run test:bin',
        'smoke:',
        '  strategy:',
        '    matrix:',
        includeNode ? '      node-version:\n        - \'22.13.0\'\n        - \'24\'' : '',
        '      os:',
        '        - ubuntu-latest',
        '        - windows-latest',
        '        - macos-latest',
        '  steps:',
        smokeSteps
    ].filter(Boolean).join('\n');
}

function createReadinessFixture(openChecklistItem?: string): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-release-readiness-'));

    writeFile(path.join(repoRoot, 'package.json'), buildPackageJson());
    writeFile(path.join(repoRoot, 'TASK.md'), '# Local task queue is not release truth.\n');
    writeFile(path.join(repoRoot, 'SECURITY.md'), '# Security\n');
    writeFile(
        path.join(repoRoot, 'MANIFEST.md'),
        [
            '- package.json',
            '- SECURITY.md',
            '- README.md',
            '- HOW_TO.md',
            '- CHANGELOG.md',
            '- docs/architecture.md',
            '- docs/cli-reference.md',
            '- docs/configuration.md',
            '- docs/node-platform-foundation.md',
            '- docs/operator-consistency-runbook.md',
            '- docs/release-readiness.md',
            '- docs/work-example.md',
            '- docs/threat-model.md',
            '- docs/sbom.md'
        ].join('\n')
    );
    writeFile(path.join(repoRoot, 'VERSION'), '1.1.0\n');
    writeFile(path.join(repoRoot, 'README.md'), '# Readme\n');
    writeFile(path.join(repoRoot, 'HOW_TO.md'), '# How To\n');
    writeFile(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n');
    writeFile(path.join(repoRoot, 'docs', 'architecture.md'), '# Architecture\n');
    writeFile(path.join(repoRoot, 'docs', 'configuration.md'), '# Configuration\n');
    writeFile(path.join(repoRoot, 'docs', 'work-example.md'), '# Work Example\n');
    writeFile(path.join(repoRoot, 'docs', 'threat-model.md'), '# Threat Model\n');
    writeFile(path.join(repoRoot, 'docs', 'sbom.md'), '# SBOM\n');
    writeFile(path.join(repoRoot, 'docs', 'release-readiness.md'), buildReleaseChecklist(openChecklistItem));
    writeFile(path.join(repoRoot, 'docs', 'operator-consistency-runbook.md'), '# Runbook\n');
    writeFile(
        path.join(repoRoot, 'docs', 'cli-reference.md'),
        [
            'garda doctor',
            'garda gate validate-manifest',
            'runtime/task-events/<task-id>.jsonl'
        ].join('\n')
    );
    writeFile(
        path.join(repoRoot, 'docs', 'run-methods.md'),
        [
            'npm run validate:release',
            'node .\\bin\\garda.js gate validate-manifest --manifest-path MANIFEST.md'
        ].join('\n')
    );
    writeFile(
        path.join(repoRoot, 'docs', 'node-platform-foundation.md'),
        [
            '### npm run validate:release',
            'The cross-platform lifecycle smoke proves update runtime behavior.'
        ].join('\n')
    );
    writeFile(
        path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
        buildCiWorkflow()
    );

    initializeGitIndex(repoRoot);

    return repoRoot;
}

test('release readiness passes when package, CI, docs, security, and checklist contracts are present', () => {
    const repoRoot = createReadinessFixture();
    try {
        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, true, output);
        assert.deepEqual(result.openReleaseChecklistItems, []);
        assert.match(output, /RELEASE_READINESS_OK/);
        assert.match(output, /ReleaseNotesInput:/);
        assert.match(output, /Validation command: npm run release:preflight/);
        assert.match(output, /Readiness alignment:/);
        assert.doesNotMatch(output, /Security\/audit proof:/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails while a tracked 1.1.0 checklist item remains open', () => {
    const repoRoot = createReadinessFixture('T-319');
    try {
        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.deepEqual(result.openReleaseChecklistItems, ['T-319 fixture release blocker']);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.match(output, /OpenReleaseChecklistItems: T-319 fixture release blocker/);
        assert.ok(
            result.violations.includes('release-blockers: tracked Release 1.1.0 readiness checklist is complete')
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness does not read local TASK.md as release blocker truth', () => {
    const repoRoot = createReadinessFixture();
    try {
        fs.unlinkSync(path.join(repoRoot, 'TASK.md'));

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, true, output);
        assert.match(output, /ReleaseChecklistItems: 19/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails closed when the tracked checklist is missing', () => {
    const repoRoot = createReadinessFixture();
    try {
        fs.unlinkSync(path.join(repoRoot, 'docs', 'release-readiness.md'));

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.match(output, /Missing tracked release checklist: docs\/release-readiness\.md/);
        assert.ok(
            result.violations.includes('release-blockers: tracked Release 1.1.0 readiness checklist is complete')
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails closed when the checklist exists but is untracked', () => {
    const repoRoot = createReadinessFixture();
    try {
        runGit(repoRoot, ['rm', '--cached', '--', 'docs/release-readiness.md']);

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.match(output, /Untracked release checklist: docs\/release-readiness\.md/);
        assert.ok(
            result.violations.includes('release-blockers: tracked Release 1.1.0 readiness checklist is complete')
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness matches exact tracked checklist version heading', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, 'docs', 'release-readiness.md'),
            [
                '# Release Readiness',
                '',
                '## 1.1.0-alpha',
                '',
                '- [x] prerelease checklist must not satisfy 1.1.0',
                '',
                '## 1.1.0',
                '',
                '- [ ] final release checklist item'
            ].join('\n')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /ReleaseChecklistItems: 1/);
        assert.match(output, /OpenReleaseChecklistItems: final release checklist item/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness accepts multiline CI lifecycle smoke run steps', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
            buildCiWorkflow({
                smokeSteps: [
                    '    - name: lifecycle smoke',
                    '      run: |',
                    '        $CLI setup --target-root "$SMOKE_DIR"',
                    '        $CLI update git --target-root "$SMOKE_DIR"',
                    '        $CLI doctor --target-root "$SMOKE_DIR"',
                    '        $CLI uninstall --target-root "$SMOKE_DIR"'
                ].join('\n')
            })
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, true, output);
        assert.match(output, /RELEASE_READINESS_OK/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness accepts multiline CI lifecycle smoke run steps with chomping indicators', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
            buildCiWorkflow({
                smokeSteps: [
                    '    - name: lifecycle smoke',
                    '      run: |-',
                    '        $CLI setup --target-root "$SMOKE_DIR"',
                    '        $CLI update git --target-root "$SMOKE_DIR"',
                    '        $CLI doctor --target-root "$SMOKE_DIR"',
                    '        $CLI uninstall --target-root "$SMOKE_DIR"'
                ].join('\n')
            })
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, true, output);
        assert.match(output, /RELEASE_READINESS_OK/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects commented or echoed CI lifecycle smoke markers', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
            buildCiWorkflow({
                smokeSteps: [
                    '    - name: lifecycle smoke',
                    '      run: |',
                    '        # $CLI setup --target-root "$SMOKE_DIR"',
                    '        echo "$CLI update git --target-root $SMOKE_DIR"',
                    '        $CLI doctor --target-root "$SMOKE_DIR"',
                    '        $CLI uninstall --target-root "$SMOKE_DIR"'
                ].join('\n')
            })
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.ok(result.violations.some(v => v.startsWith('ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects CI lifecycle smoke markers inside heredoc payloads', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
            buildCiWorkflow({
                smokeSteps: [
                    '    - name: lifecycle smoke',
                    '      run: |',
                    "        cat <<'EOF'",
                    '        $CLI setup --target-root "$SMOKE_DIR"',
                    '        $CLI update git --target-root "$SMOKE_DIR"',
                    '        $CLI doctor --target-root "$SMOKE_DIR"',
                    '        $CLI uninstall --target-root "$SMOKE_DIR"',
                    '        EOF'
                ].join('\n')
            })
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.ok(result.violations.some(v => v.startsWith('ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when Node matrix markers are outside required CI jobs', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
            buildCiWorkflow({ includeNodeVersionInJobs: false })
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.ok(result.violations.some(v => v.startsWith('ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when shipped security docs are missing from MANIFEST', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(path.join(repoRoot, 'MANIFEST.md'), '- package.json\n- SECURITY.md\n');

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.ok(
            result.violations.includes('security: quality keeps production audit in the release chain and security document surface is package/manifest aligned')
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when SECURITY.md is missing from filesystem', () => {
    const repoRoot = createReadinessFixture();
    try {
        fs.unlinkSync(path.join(repoRoot, 'SECURITY.md'));

        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.includes('security:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when docs/threat-model.md is missing from filesystem', () => {
    const repoRoot = createReadinessFixture();
    try {
        fs.unlinkSync(path.join(repoRoot, 'docs', 'threat-model.md'));

        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.includes('security:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when docs/sbom.md is missing from filesystem', () => {
    const repoRoot = createReadinessFixture();
    try {
        fs.unlinkSync(path.join(repoRoot, 'docs', 'sbom.md'));

        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.includes('security:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when SECURITY.md is missing from package.json files', () => {
    const repoRoot = createReadinessFixture();
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
        pkg.files = pkg.files.filter((f: string) => f !== 'SECURITY.md');
        writeFile(path.join(repoRoot, 'package.json'), JSON.stringify(pkg, null, 2));

        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.includes('security:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when sourceful package surface omits src', () => {
    const repoRoot = createReadinessFixture();
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
        pkg.files = pkg.files.filter((f: string) => f !== 'src');
        writeFile(path.join(repoRoot, 'package.json'), JSON.stringify(pkg, null, 2));

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.ok(result.violations.some(v => v.includes('sourceful runtime, and linked public-doc contracts')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when package files omit a README-linked public doc', () => {
    const repoRoot = createReadinessFixture();
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
        pkg.files = pkg.files.filter((f: string) => f !== 'docs/cli-reference.md');
        writeFile(path.join(repoRoot, 'package.json'), JSON.stringify(pkg, null, 2));

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.ok(result.violations.some(v => v.includes('linked public-doc contracts')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when MANIFEST omits a README-linked public doc', () => {
    const repoRoot = createReadinessFixture();
    try {
        const manifest = fs.readFileSync(path.join(repoRoot, 'MANIFEST.md'), 'utf8');
        writeFile(
            path.join(repoRoot, 'MANIFEST.md'),
            manifest
                .split(/\r?\n/u)
                .filter(line => !line.includes('docs/cli-reference.md'))
                .join('\n')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.ok(result.violations.some(v => v.includes('linked public-doc contracts')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when package files include node test build output', () => {
    const repoRoot = createReadinessFixture();
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
        pkg.files.push('.node-build');
        writeFile(path.join(repoRoot, 'package.json'), JSON.stringify(pkg, null, 2));

        const result = validateReleaseReadiness(repoRoot);

        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.includes('sourceful runtime, and linked public-doc contracts')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release validation command dispatch accepts only the fixed command allow-list', () => {
    assert.deepEqual(
        [...RELEASE_VALIDATION_COMMANDS],
        ['version-parity', 'clean-worktree', 'embedded-bundle-parity', 'release-readiness']
    );
    assert.equal(resolveReleaseValidationCommand(undefined), 'version-parity');
    assert.equal(resolveReleaseValidationCommand(' release-readiness '), 'release-readiness');
    assert.equal(resolveReleaseValidationCommand('release-readiness && npm publish'), null);
    assert.equal(resolveReleaseValidationCommand('$(npm publish)'), null);
    assert.deepEqual(Object.keys(RELEASE_VALIDATION_COMMAND_HANDLERS), [...RELEASE_VALIDATION_COMMANDS]);
});

test('release validation CLI dispatch rejects unknown raw argv before handler lookup', () => {
    const originalExit = process.exit;
    const originalError = console.error;
    const errors: string[] = [];
    let exitCode: string | number | null | undefined = null;

    try {
        console.error = (message?: unknown) => {
            errors.push(String(message));
        };
        process.exit = ((code?: string | number | null | undefined) => {
            exitCode = code;
            throw new Error('process.exit');
        }) as typeof process.exit;

        assert.throws(() => {
            runReleaseValidationCli('release-readiness && npm publish');
        }, /process\.exit/);

        assert.equal(exitCode, 1);
        assert.match(errors.join('\n'), /Unknown validate-release command/);
        assert.match(errors.join('\n'), /version-parity\|clean-worktree\|embedded-bundle-parity\|release-readiness/);
    } finally {
        process.exit = originalExit;
        console.error = originalError;
    }
});

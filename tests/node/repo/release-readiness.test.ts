import test from 'node:test';
import assert from 'node:assert/strict';
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
            'audit:prod': 'npm audit --omit=dev',
            quality: 'npm run typecheck && npm run lint && npm run coverage && npm run audit:prod',
            'validate:release': 'npm run validate:clean-worktree && npm run validate:version-parity && npm run build && npm run validate:embedded-bundle-parity && npm run quality && node --test .node-build/tests/node/packaging/pack-smoke.test.js && npm run validate:clean-worktree',
            'release:preflight': 'npm run validate:release-readiness && npm run validate:release',
            prepack: 'npm run validate:clean-worktree && npm run build:publish-runtime && npm run validate:clean-worktree && node scripts/package-legacy-entrypoint-compat.cjs create'
        },
        files: [
            'bin',
            'dist',
            'template',
            'package.json',
            'MANIFEST.md',
            'SECURITY.md',
            'docs/operator-consistency-runbook.md',
            'docs/sbom.md',
            'docs/threat-model.md',
            'VERSION'
        ]
    }, null, 2);
}

function buildTaskMarkdown(openTaskId?: string): string {
    const queueRows = RELEASE_BLOCKERS.map((taskId) => {
        const status = taskId === openTaskId ? '🟦 TODO' : '🟩 DONE';
        return `| ${taskId} | ${status} | P0 | test/${taskId.toLowerCase()} | ${taskId} title | gpt-5.4 | 2026-05-09 | strict | fixture |`;
    }).join('\n');
    const releaseBullets = RELEASE_BLOCKERS
        .map((taskId) => `- \`${taskId}\` — fixture blocker — профиль: \`strict\`.`)
        .join('\n');

    return [
        '## Active Queue',
        '| ID | Status | Priority | Slug | Title | Model | Created | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        queueRows,
        '| T-244 | 🟦 TODO | P0 | release/110-final-readiness-gate | Final readiness | gpt-5.4 | 2026-05-09 | strict | fixture |',
        '',
        '### Релиз 1.1.0 — текущий hardening и ускорение дальнейшей работы',
        '',
        'Порядок соответствует верхней `Active Queue`; эти задачи идут перед финальным `T-244`:',
        releaseBullets,
        '- `T-244` — добавить финальный gate готовности `1.1.0` — профиль: `strict`.',
        '',
        '### Релиз 1.2.0 — безопасность, runtime и release hardening'
    ].join('\n');
}

function createReadinessFixture(openTaskId?: string): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-release-readiness-'));

    writeFile(path.join(repoRoot, 'package.json'), buildPackageJson());
    writeFile(path.join(repoRoot, 'TASK.md'), buildTaskMarkdown(openTaskId));
    writeFile(path.join(repoRoot, 'SECURITY.md'), '# Security\n');
    writeFile(
        path.join(repoRoot, 'MANIFEST.md'),
        [
            '- package.json',
            '- SECURITY.md',
            '- docs/threat-model.md',
            '- docs/sbom.md'
        ].join('\n')
    );
    writeFile(path.join(repoRoot, 'VERSION'), '1.1.0\n');
    writeFile(path.join(repoRoot, 'docs', 'threat-model.md'), '# Threat Model\n');
    writeFile(path.join(repoRoot, 'docs', 'sbom.md'), '# SBOM\n');
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
        [
            'validate-release:',
            '  name: Release Validation / ${{ matrix.os }}',
            '  strategy:',
            '    matrix:',
            '      os:',
            '        - ubuntu-latest',
            '        - windows-latest',
            '  steps:',
            '    - run: npm run validate:release',
            'smoke:',
            '  strategy:',
            '    matrix:',
            '      os:',
            '        - ubuntu-latest',
            '        - windows-latest',
            '        - macos-latest',
            '  steps:',
            '    - run: $CLI setup',
            '    - run: $CLI update git',
            '    - run: $CLI doctor',
            '    - run: $CLI uninstall'
        ].join('\n')
    );

    return repoRoot;
}

test('release readiness passes when package, CI, docs, security, and blocker contracts are present', () => {
    const repoRoot = createReadinessFixture();
    try {
        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, true, output);
        assert.deepEqual(result.openBlockerTaskIds, []);
        assert.match(output, /RELEASE_READINESS_OK/);
        assert.match(output, /ReleaseNotesInput:/);
        assert.match(output, /Validation command: npm run release:preflight/);
        assert.match(output, /Readiness alignment:/);
        assert.doesNotMatch(output, /Security\/audit proof:/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails while a required 1.1.0 blocker remains open', () => {
    const repoRoot = createReadinessFixture('T-319');
    try {
        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.deepEqual(result.openBlockerTaskIds, ['T-319']);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.match(output, /OpenBlockers: T-319/);
        assert.ok(result.violations.includes('release-blockers: all required Release 1.1.0 blocker tasks before T-244 are closed'));
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

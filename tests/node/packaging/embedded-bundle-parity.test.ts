import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import {
    EMBEDDED_BUNDLE_PARITY_ITEMS,
    formatEmbeddedBundleParityResult,
    validateEmbeddedBundleParity
} from '../../../scripts/node-foundation/validate-release';

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function seedSurfaceItem(rootPath: string, item: string, label: string): void {
    if (item === 'bin') {
        writeFile(path.join(rootPath, item, 'garda.js'), `console.log("${label} bin");\n`);
        return;
    }
    if (item === 'dist') {
        writeFile(path.join(rootPath, item, 'src', 'index.js'), `module.exports = "${label} dist";\n`);
        return;
    }
    if (item === 'src') {
        writeFile(path.join(rootPath, item, 'index.ts'), `export const label = "${label} src";\n`);
        return;
    }
    if (item === 'template') {
        writeFile(path.join(rootPath, item, 'AGENTS.md'), `# ${label} template\n`);
        return;
    }
    writeFile(path.join(rootPath, item), `${label} ${item}\n`);
}

function createParityFixture(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-embedded-parity-'));
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');

    for (const item of EMBEDDED_BUNDLE_PARITY_ITEMS) {
        seedSurfaceItem(repoRoot, item, 'root');
        fs.cpSync(path.join(repoRoot, item), path.join(bundleRoot, item), { recursive: true });
    }
    writeFile(path.join(repoRoot, 'VERSION'), '1.0.0\n');
    writeFile(path.join(bundleRoot, 'VERSION'), '1.0.0\n');

    return repoRoot;
}

function runGit(repoRoot: string, args: string[]): void {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('validateEmbeddedBundleParity passes for identical generated bundle surface', () => {
    const repoRoot = createParityFixture();
    try {
        const result = validateEmbeddedBundleParity(repoRoot);
        assert.equal(result.passed, true, formatEmbeddedBundleParityResult(result));
        assert.equal(result.bundlePresent, true);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateEmbeddedBundleParity allows omitted generated bundle', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-embedded-parity-omitted-'));
    try {
        const result = validateEmbeddedBundleParity(repoRoot);
        const output = formatEmbeddedBundleParityResult(result);
        assert.equal(result.passed, true, output);
        assert.equal(result.bundlePresent, false);
        assert.match(output, /RELEASE_EMBEDDED_BUNDLE_PARITY_SKIPPED/);
        assert.doesNotMatch(output, /RELEASE_EMBEDDED_BUNDLE_PARITY_OK/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateEmbeddedBundleParity treats gitignored generated bundle as omitted release surface', () => {
    const repoRoot = createParityFixture();
    try {
        writeFile(path.join(repoRoot, '.gitignore'), 'garda-agent-orchestrator/\n');
        runGit(repoRoot, ['-c', 'init.defaultBranch=main', 'init']);
        writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), 'console.log("stale ignored bundle");\n');

        const result = validateEmbeddedBundleParity(repoRoot);
        const output = formatEmbeddedBundleParityResult(result);

        assert.equal(result.passed, true, output);
        assert.equal(result.bundlePresent, true);
        assert.equal(result.bundleIgnoredByGit, true);
        assert.equal(result.items.length, 0);
        assert.match(output, /RELEASE_EMBEDDED_BUNDLE_PARITY_SKIPPED/);
        assert.doesNotMatch(output, /RELEASE_EMBEDDED_BUNDLE_PARITY_OK/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('formatEmbeddedBundleParityResult reports skipped parity when no items are checked', () => {
    const repoRoot = createParityFixture();
    try {
        const result = validateEmbeddedBundleParity(repoRoot, []);
        const output = formatEmbeddedBundleParityResult(result);

        assert.equal(result.passed, true, output);
        assert.equal(result.bundlePresent, true);
        assert.equal(result.items.length, 0);
        assert.match(output, /RELEASE_EMBEDDED_BUNDLE_PARITY_SKIPPED/);
        assert.doesNotMatch(output, /RELEASE_EMBEDDED_BUNDLE_PARITY_OK/);
        assert.match(output, /ParityStatus: SKIPPED \(no embedded bundle parity items checked\)/);
        assert.match(output, /CheckedItems: 0/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateEmbeddedBundleParity fails on root-only source changes', () => {
    const repoRoot = createParityFixture();
    try {
        writeFile(path.join(repoRoot, 'src', 'validators', 'status.ts'), 'export const changed = true;\n');
        const result = validateEmbeddedBundleParity(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some((violation) => violation.includes('src: hash mismatch')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateEmbeddedBundleParity fails on root-only dist changes', () => {
    const repoRoot = createParityFixture();
    try {
        writeFile(path.join(repoRoot, 'dist', 'src', 'validators', 'status.js'), 'exports.changed = true;\n');
        const result = validateEmbeddedBundleParity(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some((violation) => violation.includes('dist: hash mismatch')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateEmbeddedBundleParity fails when runtime-referenced docs are missing from bundle', () => {
    const repoRoot = createParityFixture();
    try {
        fs.rmSync(path.join(repoRoot, 'garda-agent-orchestrator', 'docs'), { recursive: true, force: true });
        const result = validateEmbeddedBundleParity(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(
            result.violations.some((violation) =>
                violation.includes('docs/operator-consistency-runbook.md: missing root=true bundle=false')
            )
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateEmbeddedBundleParity fails when equal VERSION hides different files', () => {
    const repoRoot = createParityFixture();
    try {
        writeFile(path.join(repoRoot, 'bin', 'garda.js'), 'console.log("new launcher");\n');
        const result = validateEmbeddedBundleParity(repoRoot);
        assert.equal(result.passed, false);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim(), '1.0.0');
        assert.equal(
            fs.readFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'VERSION'), 'utf8').trim(),
            '1.0.0'
        );
        assert.ok(result.violations.some((violation) => violation.includes('bin: hash mismatch')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildReleaseArchivePlan,
    createReleaseArchive
} from '../../../scripts/node-foundation/archive-release';

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

function hashFile(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createArchiveFixture(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-release-archive-'));

    writeFile(path.join(repoRoot, 'package.json'), '{"name":"fixture"}\n');
    writeFile(path.join(repoRoot, 'src', 'index.ts'), 'export const value = 1;\n');
    writeFile(path.join(repoRoot, 'docs', 'run-methods.md'), '# Run\n');
    writeFile(path.join(repoRoot, 'node_modules', 'platform-package', 'index.js'), 'generated dependency\n');
    writeFile(path.join(repoRoot, '.node-build', 'src', 'index.js'), 'generated build\n');
    writeFile(path.join(repoRoot, '.scripts-build', 'scripts', 'tool.js'), 'generated script build\n');
    writeFile(path.join(repoRoot, 'coverage', 'lcov.info'), 'TN:\n');
    writeFile(path.join(repoRoot, 'dist', 'src', 'index.js'), 'generated runtime\n');
    writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-final-user-report.md'), 'report\n');
    writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-review-context.md'), 'generated context\n');
    writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-scoped-diff-summary.json'), '{}\n');
    writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', 'T-001.jsonl'), '{}\n');
    writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'manual-validation', 'T-001', 'npm-test.log'), 'ok\n');
    writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json'), '{"Secret":"no"}\n');
    writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', '.env'), 'SECRET=no\n');

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['add', '.']);

    return repoRoot;
}

test('source release archive plan is tracked-source only and excludes generated runtime noise', () => {
    const repoRoot = createArchiveFixture();
    try {
        const plan = buildReleaseArchivePlan('source', repoRoot, path.join(repoRoot, 'release-archives', 'source.tar'));
        const entries = plan.entries.map((entry) => entry.relativePath);

        assert.deepEqual(entries, [
            'docs/run-methods.md',
            'package.json',
            'src/index.ts'
        ]);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('evidence release archive plan is allowlisted evidence only and skips secrets', () => {
    const repoRoot = createArchiveFixture();
    try {
        const plan = buildReleaseArchivePlan('evidence', repoRoot, path.join(repoRoot, 'release-archives', 'evidence.tar'));
        const entries = plan.entries.map((entry) => entry.relativePath);

        assert.deepEqual(entries, [
            'coverage/lcov.info',
            'garda-agent-orchestrator/runtime/manual-validation/T-001/npm-test.log',
            'garda-agent-orchestrator/runtime/reviews/T-001-final-user-report.md',
            'garda-agent-orchestrator/runtime/task-events/T-001.jsonl'
        ]);
        assert.ok(!entries.some((entry) => entry.includes('init-answers')));
        assert.ok(!entries.some((entry) => entry.endsWith('/.env')));
        assert.ok(!entries.some((entry) => entry.endsWith('-review-context.md')));
        assert.ok(!entries.some((entry) => entry.endsWith('-scoped-diff-summary.json')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('evidence release archive plan fails closed on credential-like content', () => {
    const repoRoot = createArchiveFixture();
    try {
        writeFile(
            path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'manual-validation', 'T-001', 'token.log'),
            'AUTH_TOKEN=abcd1234abcd1234abcd1234\n'
        );

        assert.throws(
            () => buildReleaseArchivePlan('evidence', repoRoot, path.join(repoRoot, 'release-archives', 'evidence.tar')),
            /credential-like content/u
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('evidence release archive plan scans oversized credential-like text evidence', () => {
    const repoRoot = createArchiveFixture();
    try {
        writeFile(
            path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'manual-validation', 'T-001', 'large.log'),
            `${'x'.repeat(1024 * 1024 + 32)}\nAUTH_TOKEN=abcd1234abcd1234abcd1234\n`
        );

        assert.throws(
            () => buildReleaseArchivePlan('evidence', repoRoot, path.join(repoRoot, 'release-archives', 'evidence.tar')),
            /credential-like content/u
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release archive output is deterministic for unchanged inputs', () => {
    const repoRoot = createArchiveFixture();
    try {
        const firstPath = path.join(repoRoot, 'release-archives', 'source-1.tar');
        const secondPath = path.join(repoRoot, 'release-archives', 'source-2.tar');

        const firstPlan = createReleaseArchive('source', repoRoot, firstPath);
        const secondPlan = createReleaseArchive('source', repoRoot, secondPath);

        assert.equal(firstPlan.entries.length, 3);
        assert.equal(secondPlan.entries.length, 3);
        assert.equal(hashFile(firstPath), hashFile(secondPath));
        assert.ok(fs.statSync(firstPath).size > 1024);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

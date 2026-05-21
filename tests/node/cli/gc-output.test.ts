import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function isWorkspaceRoot(candidate: string): boolean {
    return fs.existsSync(path.join(candidate, 'package.json'))
        && fs.existsSync(path.join(candidate, 'VERSION'))
        && fs.existsSync(path.join(candidate, 'bin', 'garda.js'))
        && fs.existsSync(path.join(candidate, 'src', 'index.ts'));
}

function findRepoRoot(): string {
    const cwd = path.resolve(process.cwd());
    if (isWorkspaceRoot(cwd)) {
        return cwd;
    }

    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (isWorkspaceRoot(current)) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error('Cannot resolve repo root from ' + __dirname);
}

const REPO_ROOT = findRepoRoot();
const CLI_ENTRY = path.join(REPO_ROOT, 'bin', 'garda.js');
const NEUTRAL_CWD = path.join(REPO_ROOT, 'tests');

function writeFixture(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

test('gc keeps review artifacts when summary storage would target a task without a verified ledger', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-gc-cli-'));
    try {
        const bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        const reviewsDir = path.join(bundleRoot, 'runtime', 'reviews');
        writeFixture(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        writeFixture(path.join(bundleRoot, 'live', 'config', 'review-artifact-storage.json'), JSON.stringify({
            retention_mode: 'summary',
            compress_after_days: 0,
            compression_format: 'gzip',
            preserve_gate_receipts: true,
            gate_receipt_suffixes: ['-task-mode.json']
        }, null, 2));
        writeFixture(path.join(reviewsDir, 'T-099-task-mode.json'), '{}');
        writeFixture(path.join(reviewsDir, 'T-099-code-review-context.json'), '{}');

        const result = spawnSync(process.execPath, [
            CLI_ENTRY,
            'gc',
            '--target-root', tmpDir,
            '--confirm',
            '--category', 'reviews'
        ], {
            cwd: NEUTRAL_CWD,
            encoding: 'utf8',
            timeout: 30_000
        });

        const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
        assert.equal(result.status, 0, combined);
        assert.ok(combined.includes('Nothing to clean up.'), combined);
        assert.ok(fs.existsSync(path.join(reviewsDir, 'T-099-task-mode.json')));
        assert.ok(fs.existsSync(path.join(reviewsDir, 'T-099-code-review-context.json')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('cleanup accepts --max-aggregate-lines and prunes aggregate task log', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-cleanup-cli-'));
    try {
        const bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        const eventsDir = path.join(bundleRoot, 'runtime', 'task-events');
        writeFixture(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        fs.mkdirSync(eventsDir, { recursive: true });
        const lines = Array.from({ length: 25 }, (_, i) => JSON.stringify({ seq: i }));
        fs.writeFileSync(path.join(eventsDir, 'all-tasks.jsonl'), lines.join('\n') + '\n', 'utf8');

        const result = spawnSync(process.execPath, [
            CLI_ENTRY,
            'cleanup',
            '--target-root', tmpDir,
            '--max-aggregate-lines', '10'
        ], {
            cwd: NEUTRAL_CWD,
            encoding: 'utf8',
            timeout: 30_000
        });

        const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
        assert.equal(result.status, 0, combined);
        const remaining = fs.readFileSync(path.join(eventsDir, 'all-tasks.jsonl'), 'utf8')
            .split('\n')
            .filter(Boolean);
        assert.equal(remaining.length, 10);
        assert.equal(JSON.parse(remaining[0]).seq, 15);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('gc accepts --max-aggregate-lines and prunes aggregate task log', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-gc-agg-cli-'));
    try {
        const bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        const eventsDir = path.join(bundleRoot, 'runtime', 'task-events');
        writeFixture(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        fs.mkdirSync(eventsDir, { recursive: true });
        const lines = Array.from({ length: 25 }, (_, i) => JSON.stringify({ seq: i }));
        fs.writeFileSync(path.join(eventsDir, 'all-tasks.jsonl'), lines.join('\n') + '\n', 'utf8');

        const result = spawnSync(process.execPath, [
            CLI_ENTRY,
            'gc',
            '--target-root', tmpDir,
            '--confirm',
            '--category', 'task-events',
            '--max-aggregate-lines', '10'
        ], {
            cwd: NEUTRAL_CWD,
            encoding: 'utf8',
            timeout: 30_000
        });

        const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
        assert.equal(result.status, 0, combined);
        const remaining = fs.readFileSync(path.join(eventsDir, 'all-tasks.jsonl'), 'utf8')
            .split('\n')
            .filter(Boolean);
        assert.equal(remaining.length, 10);
        assert.equal(JSON.parse(remaining[0]).seq, 15);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('gc accepts --max-metrics-lines and prunes metrics log', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-gc-metrics-cli-'));
    try {
        const bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        const runtimeDir = path.join(bundleRoot, 'runtime');
        writeFixture(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        fs.mkdirSync(runtimeDir, { recursive: true });
        const lines = Array.from({ length: 25 }, (_, i) => JSON.stringify({ seq: i }));
        fs.writeFileSync(path.join(runtimeDir, 'metrics.jsonl'), lines.join('\n') + '\n', 'utf8');

        const result = spawnSync(process.execPath, [
            CLI_ENTRY,
            'gc',
            '--target-root', tmpDir,
            '--confirm',
            '--category', 'metrics',
            '--max-metrics-lines', '10'
        ], {
            cwd: NEUTRAL_CWD,
            encoding: 'utf8',
            timeout: 30_000
        });

        const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
        assert.equal(result.status, 0, combined);
        assert.ok(combined.includes('Pruned metrics log:'), combined);
        const remaining = fs.readFileSync(path.join(runtimeDir, 'metrics.jsonl'), 'utf8')
            .split('\n')
            .filter(Boolean);
        assert.equal(remaining.length, 10);
        assert.equal(JSON.parse(remaining[0]).seq, 15);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('cleanup accepts --max-metrics-lines and reports metrics-only pruning', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-cleanup-metrics-cli-'));
    try {
        const bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        const runtimeDir = path.join(bundleRoot, 'runtime');
        writeFixture(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        fs.mkdirSync(runtimeDir, { recursive: true });
        const lines = Array.from({ length: 25 }, (_, i) => JSON.stringify({ seq: i }));
        fs.writeFileSync(path.join(runtimeDir, 'metrics.jsonl'), lines.join('\n') + '\n', 'utf8');

        const result = spawnSync(process.execPath, [
            CLI_ENTRY,
            'cleanup',
            '--target-root', tmpDir,
            '--max-metrics-lines', '10'
        ], {
            cwd: NEUTRAL_CWD,
            encoding: 'utf8',
            timeout: 30_000
        });

        const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
        assert.equal(result.status, 0, combined);
        assert.ok(combined.includes('Pruned metrics log:'), combined);
        assert.ok(!combined.includes('Nothing to clean up.'), combined);
        const remaining = fs.readFileSync(path.join(runtimeDir, 'metrics.jsonl'), 'utf8')
            .split('\n')
            .filter(Boolean);
        assert.equal(remaining.length, 10);
        assert.equal(JSON.parse(remaining[0]).seq, 15);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

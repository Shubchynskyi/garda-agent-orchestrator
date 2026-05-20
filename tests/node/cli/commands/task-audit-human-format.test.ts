import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { colorizeTaskAuditSummaryText } from '../../../../src/cli/commands/task-audit-human-format';
import { handleTaskAuditSummary } from '../../../../src/cli/commands/gate-task-handlers';
import { DEFAULT_BUNDLE_NAME } from '../../../../src/core/constants';

function hasAnsi(value: string): boolean {
    return /\x1B\[[0-9;?]*[ -/]*[@-~]/.test(value);
}

function stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function withColorEnv<T>(env: { NO_COLOR?: string | undefined; FORCE_COLOR?: string | undefined }, action: () => T): T {
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    try {
        if (env.NO_COLOR === undefined) {
            delete process.env.NO_COLOR;
        } else {
            process.env.NO_COLOR = env.NO_COLOR;
        }
        if (env.FORCE_COLOR === undefined) {
            delete process.env.FORCE_COLOR;
        } else {
            process.env.FORCE_COLOR = env.FORCE_COLOR;
        }
        return action();
    } finally {
        if (previousNoColor === undefined) {
            delete process.env.NO_COLOR;
        } else {
            process.env.NO_COLOR = previousNoColor;
        }
        if (previousForceColor === undefined) {
            delete process.env.FORCE_COLOR;
        } else {
            process.env.FORCE_COLOR = previousForceColor;
        }
    }
}

async function captureStdout(action: () => void | Promise<void>): Promise<string> {
    const chunks: string[] = [];
    const originalWrite = process.stdout.write;
    const previousExitCode = process.exitCode;
    try {
        process.exitCode = 0;
        process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((err?: Error) => void), callback?: (err?: Error) => void): boolean => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
            const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
            if (cb) cb();
            return true;
        }) as typeof process.stdout.write;
        await action();
    } finally {
        process.stdout.write = originalWrite;
        process.exitCode = previousExitCode;
    }
    return chunks.join('');
}

function makeRepoRoot(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-audit-color-'));
    fs.mkdirSync(path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'task-events'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews'), { recursive: true });
    return repoRoot;
}

test('colorizeTaskAuditSummaryText highlights pass, blocked, and missing evidence in human audit output only when color is enabled', () => {
    const plain = [
        'Task: T-001',
        'Status: PASS',
        'Status: BLOCKED',
        'Events: 12',
        'Integrity: PASS',
        '',
        'Gates:',
        '  [+] compile-gate (2026-05-08T10:00:00.000Z)',
        '  [X] review-gate (2026-05-08T10:01:00.000Z)',
        '',
        'Evidence (1 present, 1 absent):',
        '  [+] compile-gate: /repo/runtime/reviews/T-001-compile-gate.json',
        '  [ ] security-review: /repo/runtime/reviews/T-001-security.md',
        '',
        'Blockers:',
        '  [!] completion-gate: blocked until required review passes',
        '',
        'FinalReportContract: NOT_READY',
        'FinalCloseout: READY (MATERIALIZED)',
        '  Review trust: INDEPENDENT_AUDITED via DELEGATED_SUBAGENT.',
        '  Review integrity: INDEPENDENT_REVIEW_ATTESTED; completion_allowed=yes.',
        '  Suppressed output (char-aware subset): ~420 chars (full-suite validation output ~420 chars). Suppressed output estimate: ~105 tokens.'
    ].join('\n');

    const colored = withColorEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => colorizeTaskAuditSummaryText(plain));
    assert.equal(hasAnsi(colored), true);
    assert.ok(colored.includes('\x1b[32mPASS\x1b[0m'));
    assert.ok(colored.includes('\x1b[31mBLOCKED\x1b[0m'));
    assert.ok(colored.includes('\x1b[2m[ ]\x1b[0m'));
    assert.ok(colored.includes('\x1b[33m[!]\x1b[0m'));
    assert.ok(colored.includes('\x1b[32m  Suppressed output (char-aware subset): ~420 chars (full-suite validation output ~420 chars). Suppressed output estimate: ~105 tokens.\x1b[0m'));
    assert.equal(stripAnsi(colored), plain);

    const noColor = withColorEnv({ NO_COLOR: '1', FORCE_COLOR: '1' }, () => colorizeTaskAuditSummaryText(plain));
    assert.equal(hasAnsi(noColor), false);
    assert.equal(noColor, plain);
});

test('handleTaskAuditSummary colors human stdout but leaves json and output-path output plain', async () => {
    const repoRoot = makeRepoRoot();

    const human = await withColorEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => captureStdout(() => handleTaskAuditSummary([
        '--task-id', 'T-900',
        '--repo-root', repoRoot
    ])));
    assert.equal(hasAnsi(human), true);
    assert.ok(stripAnsi(human).includes('FinalReportContract:'));

    const json = await withColorEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => captureStdout(() => handleTaskAuditSummary([
        '--task-id', 'T-900',
        '--repo-root', repoRoot,
        '--as-json'
    ])));
    assert.equal(hasAnsi(json), false);
    assert.equal(JSON.parse(json).task_id, 'T-900');

    const outputPath = path.join(repoRoot, 'audit.txt');
    const stdoutWithOutputPath = await withColorEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => captureStdout(() => handleTaskAuditSummary([
        '--task-id', 'T-900',
        '--repo-root', repoRoot,
        '--output-path', outputPath
    ])));
    assert.equal(hasAnsi(stdoutWithOutputPath), false);
    assert.equal(hasAnsi(fs.readFileSync(outputPath, 'utf8')), false);
});

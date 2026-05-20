import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { colorizeTaskEventsSummaryText } from '../../../../src/cli/commands/task-events-human-format';
import { handleTaskEventsSummary } from '../../../../src/cli/commands/gate-task-handlers';
import { DEFAULT_BUNDLE_NAME } from '../../../../src/core/constants';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';

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
    try {
        process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((err?: Error) => void), callback?: (err?: Error) => void): boolean => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
            const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
            if (cb) cb();
            return true;
        }) as typeof process.stdout.write;
        await action();
    } finally {
        process.stdout.write = originalWrite;
    }
    return chunks.join('');
}

function makeRepoRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-events-color-'));
}

test('colorizeTaskEventsSummaryText highlights human task timeline output only when color is enabled', () => {
    const plain = [
        'Task: T-001',
        'Source: /repo/garda-agent-orchestrator/runtime/task-events/T-001.jsonl',
        'Events: 2',
        'IntegrityStatus: PASS',
        'Suppressed output (char-aware subset): ~420 chars (full-suite validation output ~420 chars). Suppressed output estimate: ~105 tokens.',
        '',
        'Timeline:',
        '[01] 2026-05-08T10:00:00.000Z | COMPILE_GATE_PASSED | PASS | actor=gate | Compile passed.',
        '[02] 2026-05-08T10:01:00.000Z | REVIEW_GATE_FAILED | FAIL | actor=gate | Review failed.'
    ].join('\n');

    const colored = withColorEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => colorizeTaskEventsSummaryText(plain));
    assert.equal(hasAnsi(colored), true);
    assert.ok(colored.includes('\x1b[32mSuppressed output (char-aware subset): ~420 chars (full-suite validation output ~420 chars). Suppressed output estimate: ~105 tokens.\x1b[0m'));
    assert.equal(stripAnsi(colored), plain);

    const noColor = withColorEnv({ NO_COLOR: '1', FORCE_COLOR: '1' }, () => colorizeTaskEventsSummaryText(plain));
    assert.equal(hasAnsi(noColor), false);
    assert.equal(noColor, plain);
});

test('handleTaskEventsSummary colors stdout human output but leaves json and output-path artifacts plain', async () => {
    const repoRoot = makeRepoRoot();
    const orchestratorRoot = path.join(repoRoot, DEFAULT_BUNDLE_NAME);
    appendTaskEvent(orchestratorRoot, 'T-900', 'TASK_MODE_ENTERED', 'PASS', 'Task mode entered.', {}, { passThru: true });
    appendTaskEvent(orchestratorRoot, 'T-900', 'REVIEW_GATE_FAILED', 'FAIL', 'Review gate failed.', { artifact_path: 'runtime/reviews/T-900-review-gate.json' }, { passThru: true });

    const human = await withColorEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => captureStdout(() => handleTaskEventsSummary([
        '--task-id', 'T-900',
        '--repo-root', repoRoot
    ])));
    assert.equal(hasAnsi(human), true);
    assert.ok(stripAnsi(human).includes('REVIEW_GATE_FAILED | FAIL'));

    const json = await withColorEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => captureStdout(() => handleTaskEventsSummary([
        '--task-id', 'T-900',
        '--repo-root', repoRoot,
        '--as-json'
    ])));
    assert.equal(hasAnsi(json), false);
    assert.ok(JSON.parse(json).timeline.length >= 2);

    const compactJson = await withColorEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => captureStdout(() => handleTaskEventsSummary([
        '--task-id', 'T-900',
        '--repo-root', repoRoot,
        '--compact-latest-cycle'
    ])));
    assert.equal(hasAnsi(compactJson), false);
    assert.ok(JSON.parse(compactJson).latest_cycle.cycle_event_count >= 2);

    const outputPath = path.join(repoRoot, 'timeline.txt');
    const stdoutWithOutputPath = await withColorEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => captureStdout(() => handleTaskEventsSummary([
        '--task-id', 'T-900',
        '--repo-root', repoRoot,
        '--output-path', outputPath
    ])));
    assert.equal(hasAnsi(stdoutWithOutputPath), false);
    assert.equal(hasAnsi(fs.readFileSync(outputPath, 'utf8')), false);
});

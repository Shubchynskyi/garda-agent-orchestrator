import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { getRepoRoot } from '../../../scripts/node-foundation/build';

function writeTextFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function parseSerializedRanges(logPath: string): Array<{ pid: number; acquiredAt: number; releasedAt: number; }> {
    const ranges = new Map<number, { acquiredAt?: number; releasedAt?: number }>();
    const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
        const [eventType, pidText, timestampText] = line.trim().split(/\s+/);
        const pid = Number(pidText);
        const timestamp = Number(timestampText);
        assert.ok(Number.isInteger(pid) && pid > 0, `Unexpected pid in log line: ${line}`);
        assert.ok(Number.isFinite(timestamp) && timestamp > 0, `Unexpected timestamp in log line: ${line}`);

        const current = ranges.get(pid) || {};
        if (eventType === 'start' || eventType === 'acquired') {
            current.acquiredAt = timestamp;
        } else if (eventType === 'end' || eventType === 'released') {
            current.releasedAt = timestamp;
        } else {
            assert.fail(`Unexpected event type in log line: ${line}`);
        }
        ranges.set(pid, current);
    }

    return Array.from(ranges.entries())
        .map(([pid, range]) => ({
            pid,
            acquiredAt: Number(range.acquiredAt),
            releasedAt: Number(range.releasedAt)
        }))
        .sort((left, right) => left.acquiredAt - right.acquiredAt);
}

function assertSerializedRanges(logPath: string, expectedCount: number): void {
    const ranges = parseSerializedRanges(logPath);
    assert.equal(ranges.length, expectedCount, `Expected ${expectedCount} serialized workers`);

    for (const range of ranges) {
        assert.ok(Number.isFinite(range.acquiredAt) && range.acquiredAt > 0, 'Missing acquired/start timestamp');
        assert.ok(Number.isFinite(range.releasedAt) && range.releasedAt >= range.acquiredAt, 'Missing released/end timestamp');
    }

    for (let index = 1; index < ranges.length; index += 1) {
        assert.ok(
            ranges[index].acquiredAt >= ranges[index - 1].releasedAt,
            `Worker ${ranges[index].pid} overlapped worker ${ranges[index - 1].pid}`
        );
    }
}

function runWorker(command: string, args: string[], options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
} = {}): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });

        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr || `${path.basename(command)} exited with code ${code}`));
        });
    });
}

function createBuildScriptsFixture(repoRoot: string): string {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-fixture-'));
    const fixtureRoot = path.join(tempRoot, 'repo');
    const relativePaths = [
        'package.json',
        'VERSION',
        'tsconfig.scripts.json',
        'src/bin',
        'scripts/node-foundation'
    ];

    fs.mkdirSync(fixtureRoot, { recursive: true });
    for (const relativePath of relativePaths) {
        fs.cpSync(path.join(repoRoot, relativePath), path.join(fixtureRoot, relativePath), { recursive: true });
    }

    const realNodeModules = path.join(repoRoot, 'node_modules');
    const fixtureNodeModules = path.join(fixtureRoot, 'node_modules');
    if (fs.existsSync(realNodeModules) && !fs.existsSync(fixtureNodeModules)) {
        fs.symlinkSync(realNodeModules, fixtureNodeModules, 'junction');
    }

    return tempRoot;
}

test('withBuildRootLock serializes concurrent workers without leaving lock directories', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-lock-'));
    const buildRoot = path.join(tempRoot, '.node-build');
    const eventLogPath = path.join(tempRoot, 'build-root-events.log');
    const buildModulePath = path.resolve(__dirname, '../../../scripts/node-foundation/build.js');
    const workerScript = [
        "const fs = require('node:fs');",
        "const { withBuildRootLock } = require(process.argv[1]);",
        "const buildRoot = process.argv[2];",
        "const eventLogPath = process.argv[3];",
        "const holdMs = Number(process.argv[4] || '0');",
        "function record(label) { fs.appendFileSync(eventLogPath, `${label} ${process.pid} ${Date.now()}\\n`, 'utf8'); }",
        "withBuildRootLock(buildRoot, () => {",
        "  record('start');",
        "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);",
        "  record('end');",
        "});"
    ].join('\n');

    try {
        await Promise.all([
            runWorker(process.execPath, ['--input-type=commonjs', '--eval', workerScript, buildModulePath, buildRoot, eventLogPath, '400']),
            runWorker(process.execPath, ['--input-type=commonjs', '--eval', workerScript, buildModulePath, buildRoot, eventLogPath, '400'])
        ]);

        assertSerializedRanges(eventLogPath, 2);
        assert.ok(!fs.existsSync(`${buildRoot}.lock`), 'build root lock directory must be removed after workers finish');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('build-scripts wrapper serializes concurrent workers and leaves a usable scripts build', async () => {
    const repoRoot = getRepoRoot();
    const tempRoot = createBuildScriptsFixture(repoRoot);
    const fixtureRoot = path.join(tempRoot, 'repo');
    const tracePath = path.join(tempRoot, 'wrapper-lock-trace.log');
    const wrapperPath = path.join(fixtureRoot, 'scripts', 'node-foundation', 'build-scripts.cjs');

    try {
        await Promise.all([
            runWorker(process.execPath, [wrapperPath], {
                cwd: fixtureRoot,
                env: {
                    ...process.env,
                    GARDA_BUILD_SCRIPTS_LOCK_HOLD_MS: '300',
                    GARDA_BUILD_SCRIPTS_TRACE_FILE: tracePath
                }
            }),
            runWorker(process.execPath, [wrapperPath], {
                cwd: fixtureRoot,
                env: {
                    ...process.env,
                    GARDA_BUILD_SCRIPTS_LOCK_HOLD_MS: '300',
                    GARDA_BUILD_SCRIPTS_TRACE_FILE: tracePath
                }
            })
        ]);

        assertSerializedRanges(tracePath, 2);
        assert.ok(fs.existsSync(path.join(fixtureRoot, '.scripts-build', 'scripts', 'node-foundation', 'build.js')));
        assert.ok(fs.existsSync(path.join(fixtureRoot, 'bin', 'garda.js')));
        assert.ok(!fs.existsSync(path.join(fixtureRoot, '.scripts-build.lock')), 'wrapper lock directory must be removed after build');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

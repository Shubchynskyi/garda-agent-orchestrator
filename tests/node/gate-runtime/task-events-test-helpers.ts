import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

export function resolveTaskEventsModulePath() {
    return path.resolve(__dirname, '../../../src/gate-runtime/task-events.js');
}

export function runConcurrentAppendWorker(
    modulePath: string,
    orchestratorRoot: string,
    startSignalPath: string,
    attempts: number,
    delayMs: number,
    aggregateMaxLines?: number
) {
    return new Promise<void>((resolve, reject) => {
        const workerScript = [
            "const fs = require('node:fs');",
            "const { appendTaskEventAsync } = require(process.argv[1]);",
            "const orchestratorRoot = process.argv[2];",
            "const startSignalPath = process.argv[3];",
            "const attempts = Number.parseInt(process.argv[4], 10);",
            "const delayMs = Number.parseInt(process.argv[5], 10);",
            "const aggregateMaxLinesArg = process.argv[6];",
            "const aggregateMaxLines = aggregateMaxLinesArg ? Number.parseInt(aggregateMaxLinesArg, 10) : null;",
            "const sleepArray = new Int32Array(new SharedArrayBuffer(4));",
            "while (!fs.existsSync(startSignalPath)) { Atomics.wait(sleepArray, 0, 0, 10); }",
            "(async () => {",
            "  for (let index = 0; index < attempts; index += 1) {",
            "    const options = { passThru: true, lockTimeoutMs: 30000, lockRetryMs: 1, preWriteDelayMs: delayMs };",
            "    if (Number.isFinite(aggregateMaxLines)) { options.aggregateMaxLines = aggregateMaxLines; }",
            "    const result = await appendTaskEventAsync(orchestratorRoot, 'T-CONCURRENT', 'test', 'PASS', `Event ${index + 1}`, { worker: process.pid, attempt: index }, options);",
            "    if (!result || (Array.isArray(result.warnings) && result.warnings.length > 0)) {",
            "      const warningText = result && Array.isArray(result.warnings) ? result.warnings.join('; ') : 'appendTaskEventAsync returned null';",
            "      throw new Error(warningText);",
            "    }",
            "  }",
            "})().catch((error) => {",
            "  process.stderr.write(String(error && error.stack ? error.stack : error));",
            "  process.exitCode = 1;",
            "});"
        ].join('\n');

        const child = spawn(process.execPath, [
            '--input-type=commonjs',
            '--eval',
            workerScript,
            modulePath,
            orchestratorRoot,
            startSignalPath,
            String(attempts),
            String(delayMs),
            aggregateMaxLines == null ? '' : String(aggregateMaxLines)
        ], {
            stdio: ['ignore', 'pipe', 'pipe']
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
            reject(new Error(stderr || `append worker exited with code ${code}`));
        });
    });
}

export function runConcurrentPruneWorker(
    modulePath: string,
    eventsRoot: string,
    startSignalPath: string,
    attempts: number,
    maxLines: number
) {
    return new Promise<void>((resolve, reject) => {
        const workerScript = [
            "const fs = require('node:fs');",
            "const { pruneAggregateLogLocked } = require(process.argv[1]);",
            "const eventsRoot = process.argv[2];",
            "const startSignalPath = process.argv[3];",
            "const attempts = Number.parseInt(process.argv[4], 10);",
            "const maxLines = Number.parseInt(process.argv[5], 10);",
            "const sleepArray = new Int32Array(new SharedArrayBuffer(4));",
            "while (!fs.existsSync(startSignalPath)) { Atomics.wait(sleepArray, 0, 0, 10); }",
            "try {",
            "  for (let index = 0; index < attempts; index += 1) {",
            "    pruneAggregateLogLocked(eventsRoot, maxLines, { timeoutMs: 30000, retryMs: 1 });",
            "    Atomics.wait(sleepArray, 0, 0, 5);",
            "  }",
            "} catch (error) {",
            "  process.stderr.write(String(error && error.stack ? error.stack : error));",
            "  process.exitCode = 1;",
            "}"
        ].join('\n');

        const child = spawn(process.execPath, [
            '--input-type=commonjs',
            '--eval',
            workerScript,
            modulePath,
            eventsRoot,
            startSignalPath,
            String(attempts),
            String(maxLines)
        ], {
            stdio: ['ignore', 'pipe', 'pipe']
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
            reject(new Error(stderr || `prune worker exited with code ${code}`));
        });
    });
}

export async function holdTaskEventLockInChildProcess(lockPath: string, holdMs: number): Promise<() => Promise<void>> {
    const workerScript = [
        "const fs = require('node:fs');",
        "const os = require('node:os');",
        "const path = require('node:path');",
        "const lockPath = process.argv[1];",
        "const holdMs = Number.parseInt(process.argv[2], 10);",
        "fs.mkdirSync(lockPath, { recursive: true });",
        "fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({",
        "  pid: process.pid,",
        "  hostname: os.hostname(),",
        "  created_at_utc: new Date().toISOString()",
        "}, null, 2) + '\\n', 'utf8');",
        "setTimeout(() => {",
        "  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}",
        "  process.exit(0);",
        "}, holdMs);"
    ].join('\n');

    const child = spawn(process.execPath, [
        '--input-type=commonjs',
        '--eval',
        workerScript,
        lockPath,
        String(holdMs)
    ], {
        stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
    });

    await new Promise<void>((resolve, reject) => {
        const ownerPath = path.join(lockPath, 'owner.json');
        const deadline = Date.now() + 1000;
        const timer = setInterval(() => {
            if (fs.existsSync(ownerPath)) {
                clearInterval(timer);
                resolve();
                return;
            }
            if (Date.now() >= deadline) {
                clearInterval(timer);
                reject(new Error(stderr || 'Timed out waiting for child task-event lock holder'));
            }
        }, 10);
        child.once('error', (error) => {
            clearInterval(timer);
            reject(error);
        });
        child.once('exit', (code) => {
            if (!fs.existsSync(ownerPath) && code !== 0) {
                clearInterval(timer);
                reject(new Error(stderr || `task-event lock holder exited with code ${code}`));
            }
        });
    });

    return async function cleanup(): Promise<void> {
        if (!child.killed && child.exitCode === null) {
            child.kill();
        }
        await new Promise<void>((resolve) => {
            child.once('exit', () => resolve());
            setTimeout(resolve, 250);
        });
    };
}

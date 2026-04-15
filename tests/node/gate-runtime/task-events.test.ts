import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { redactHostname } from '../../../src/core/redaction';
import {
    assertValidTaskId,
    appendMandatoryTaskEvent,
    appendMandatoryTaskEventAsync,
    buildEventIntegrityHash,
    cleanupStaleTaskEventLocks,
    normalizeIntegrityValue,
    inspectTaskEventFile,
    appendTaskEvent,
    appendTaskEventAsync,
    readTaskEventAppendState,
    scanTaskEventLocks,
    forEachJsonlLine,
    pruneAggregateLog,
    pruneAggregateLogLocked
} from '../../../src/gate-runtime/task-events';
import { stringSha256 } from '../../../src/gate-runtime/hash';

function resolveTaskEventsModulePath() {
    return path.resolve(__dirname, '../../../src/gate-runtime/task-events.js');
}

function runConcurrentAppendWorker(
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

function runConcurrentPruneWorker(
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

async function holdTaskEventLockInChildProcess(lockPath: string, holdMs: number): Promise<() => Promise<void>> {
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

// --- assertValidTaskId ---

test('assertValidTaskId accepts valid IDs', () => {
    assert.equal(assertValidTaskId('T-001'), 'T-001');
    assert.equal(assertValidTaskId('my_task.v2'), 'my_task.v2');
    assert.equal(assertValidTaskId('  T-001  '), 'T-001');
});

test('assertValidTaskId rejects empty', () => {
    assert.throws(() => assertValidTaskId(''), /must not be empty/);
    assert.throws(() => assertValidTaskId('   '), /must not be empty/);
});

test('assertValidTaskId rejects invalid chars', () => {
    assert.throws(() => assertValidTaskId('task with spaces'), /invalid characters/);
    assert.throws(() => assertValidTaskId('task/slash'), /invalid characters/);
});

test('assertValidTaskId rejects too-long IDs', () => {
    assert.throws(() => assertValidTaskId('a'.repeat(129)), /128 characters or fewer/);
});

// --- normalizeIntegrityValue ---

test('normalizeIntegrityValue sorts object keys', () => {
    const result = normalizeIntegrityValue({ b: 2, a: 1 }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(result), ['a', 'b']);
});

test('normalizeIntegrityValue handles nested objects', () => {
    const result = normalizeIntegrityValue({ z: { b: 2, a: 1 }, a: 0 }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(result), ['a', 'z']);
    assert.deepEqual(Object.keys(result.z as Record<string, unknown>), ['a', 'b']);
});

test('normalizeIntegrityValue handles arrays', () => {
    const result = normalizeIntegrityValue([3, 1, 2]);
    assert.deepEqual(result, [3, 1, 2]); // order preserved
});

test('normalizeIntegrityValue converts Date to ISO string', () => {
    const d = new Date('2024-01-15T10:30:00Z');
    const result = normalizeIntegrityValue(d) as string;
    assert.equal(typeof result, 'string');
    assert.match(result, /2024-01-15/);
});

test('normalizeIntegrityValue passes through primitives', () => {
    assert.equal(normalizeIntegrityValue(42), 42);
    assert.equal(normalizeIntegrityValue('hello'), 'hello');
    assert.equal(normalizeIntegrityValue(true), true);
    assert.equal(normalizeIntegrityValue(null), null);
});

test('normalizeIntegrityValue forward-slashes backslash strings', () => {
    assert.equal(normalizeIntegrityValue('runtime\\task-events\\log.jsonl'), 'runtime/task-events/log.jsonl');
    assert.equal(normalizeIntegrityValue('C:\\Users\\dev\\project'), 'C:/Users/dev/project');
    // Already-forward-slashed strings are unchanged
    assert.equal(normalizeIntegrityValue('runtime/task-events/log.jsonl'), 'runtime/task-events/log.jsonl');
});

test('normalizeIntegrityValue forward-slashes paths inside nested objects and arrays', () => {
    const input = {
        path: 'src\\gate-runtime\\task-events.ts',
        nested: { deep: 'a\\b\\c' },
        list: ['x\\y', 'already/fine']
    };
    const result = normalizeIntegrityValue(input) as Record<string, unknown>;
    assert.equal(result.path, 'src/gate-runtime/task-events.ts');
    assert.equal((result.nested as Record<string, unknown>).deep, 'a/b/c');
    assert.equal((result.list as unknown[])[0], 'x/y');
    assert.equal((result.list as unknown[])[1], 'already/fine');
});

// --- cross-platform integrity hash regression ---

test('buildEventIntegrityHash produces identical hash for Windows and Unix paths', () => {
    const unixEvent = {
        timestamp_utc: '2024-06-01T12:00:00.000Z',
        task_id: 'T-090',
        event_type: 'gate_pass',
        outcome: 'PASS',
        actor: 'verify',
        message: 'runtime/task-events/T-090.task-event.jsonl',
        details: { source: 'src/gate-runtime/task-events.ts' },
        integrity: { schema_version: 1, task_sequence: 1, prev_event_sha256: null }
    };
    const windowsEvent = {
        timestamp_utc: '2024-06-01T12:00:00.000Z',
        task_id: 'T-090',
        event_type: 'gate_pass',
        outcome: 'PASS',
        actor: 'verify',
        message: 'runtime\\task-events\\T-090.task-event.jsonl',
        details: { source: 'src\\gate-runtime\\task-events.ts' },
        integrity: { schema_version: 1, task_sequence: 1, prev_event_sha256: null }
    };
    const unixHash = buildEventIntegrityHash(unixEvent);
    const windowsHash = buildEventIntegrityHash(windowsEvent);
    assert.equal(unixHash, windowsHash, 'Windows and Unix path variants must produce the same integrity hash');
});

// --- buildEventIntegrityHash ---

test('buildEventIntegrityHash produces a 64-char lowercase hex string', () => {
    const event = {
        timestamp_utc: '2024-01-15T10:30:00.000Z',
        task_id: 'T-001',
        event_type: 'gate_start',
        outcome: 'PASS',
        actor: 'gate',
        message: 'Test event',
        details: null,
        integrity: {
            schema_version: 1,
            task_sequence: 1,
            prev_event_sha256: null
        }
    };
    const hash = buildEventIntegrityHash(event) as string;
    assert.match(hash, /^[0-9a-f]{64}$/);
});

test('buildEventIntegrityHash strips event_sha256 before hashing', () => {
    const eventWithout = {
        task_id: 'T-001',
        integrity: {
            schema_version: 1,
            task_sequence: 1,
            prev_event_sha256: null
        }
    };
    const hashWithout = buildEventIntegrityHash(eventWithout);

    const eventWith = {
        task_id: 'T-001',
        integrity: {
            schema_version: 1,
            task_sequence: 1,
            prev_event_sha256: null,
            event_sha256: 'should_be_stripped'
        }
    };
    const hashWith = buildEventIntegrityHash(eventWith);

    assert.equal(hashWith, hashWithout);
});

test('buildEventIntegrityHash is deterministic', () => {
    const event = {
        task_id: 'T-001',
        event_type: 'test',
        outcome: 'PASS',
        integrity: { schema_version: 1, task_sequence: 1, prev_event_sha256: null }
    };
    const hash1 = buildEventIntegrityHash(event);
    const hash2 = buildEventIntegrityHash(event);
    assert.equal(hash1, hash2);
});

test('buildEventIntegrityHash cross-validates with Python canonical form', () => {
    // The canonical JSON for Python uses sorted keys and compact separators
    // This test verifies that the Node implementation produces the same canonical form
    const event = {
        task_id: 'T-001',
        event_type: 'gate_start',
        integrity: {
            schema_version: 1,
            task_sequence: 1,
            prev_event_sha256: null
        }
    };
    const hash = buildEventIntegrityHash(event);
    // Manually compute what Python would do:
    const normalized = normalizeIntegrityValue({
        task_id: 'T-001',
        event_type: 'gate_start',
        integrity: {
            schema_version: 1,
            task_sequence: 1,
            prev_event_sha256: null
        }
    });
    const payload = JSON.stringify(normalized);
    const expected = stringSha256(payload);
    assert.equal(hash, expected);
});

// --- inspectTaskEventFile ---

test('inspectTaskEventFile returns MISSING for non-existent file', () => {
    const result = inspectTaskEventFile('/nonexistent/file.jsonl', 'T-001');
    assert.equal(result.status, 'MISSING');
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0], /not found/);
});

test('inspectTaskEventFile returns EMPTY for empty file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-task-events-'));
    try {
        const filePath = path.join(tempDir, 'empty.jsonl');
        fs.writeFileSync(filePath, '', 'utf8');
        const result = inspectTaskEventFile(filePath, 'T-001');
        assert.equal(result.status, 'EMPTY');
        assert.equal(result.matching_events, 0);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('inspectTaskEventFile validates integrity chain', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-task-events-'));
    try {
        const filePath = path.join(tempDir, 'test.jsonl');

        // Build a valid chain of 3 events
        const events: Array<Record<string, unknown>> = [];
        for (let i = 0; i < 3; i++) {
            const event: Record<string, unknown> = {
                timestamp_utc: new Date().toISOString(),
                task_id: 'T-001',
                event_type: 'test',
                outcome: 'PASS',
                actor: 'gate',
                message: `Event ${i + 1}`,
                details: null,
                integrity: {
                    schema_version: 1,
                    task_sequence: i + 1,
                    prev_event_sha256: i === 0 ? null : (events[i - 1].integrity as Record<string, unknown>).event_sha256
                } as Record<string, unknown>
            };
            (event.integrity as Record<string, unknown>).event_sha256 = buildEventIntegrityHash(event);
            events.push(event);
        }

        const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
        fs.writeFileSync(filePath, content, 'utf8');

        const result = inspectTaskEventFile(filePath, 'T-001');
        assert.equal(result.status, 'PASS');
        assert.equal(result.matching_events, 3);
        assert.equal(result.integrity_event_count, 3);
        assert.equal(result.violations.length, 0);
        assert.equal(result.first_integrity_sequence, 1);
        assert.equal(result.last_integrity_sequence, 3);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('inspectTaskEventFile detects tampered event', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-task-events-'));
    try {
        const filePath = path.join(tempDir, 'tampered.jsonl');
        const event: Record<string, unknown> = {
            timestamp_utc: new Date().toISOString(),
            task_id: 'T-001',
            event_type: 'test',
            outcome: 'PASS',
            integrity: {
                schema_version: 1,
                task_sequence: 1,
                prev_event_sha256: null
            } as Record<string, unknown>
        };
        (event.integrity as Record<string, unknown>).event_sha256 = buildEventIntegrityHash(event);
        // Tamper
        event.message = 'tampered!';

        fs.writeFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');
        const result = inspectTaskEventFile(filePath, 'T-001');
        assert.equal(result.status, 'FAILED');
        assert.ok(result.violations.some(v => v.includes('event_sha256 mismatch')));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('inspectTaskEventFile detects foreign task_id', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-task-events-'));
    try {
        const filePath = path.join(tempDir, 'foreign.jsonl');
        const event: Record<string, unknown> = {
            task_id: 'T-999',
            event_type: 'test',
            integrity: { schema_version: 1, task_sequence: 1, prev_event_sha256: null } as Record<string, unknown>
        };
        (event.integrity as Record<string, unknown>).event_sha256 = buildEventIntegrityHash(event);
        fs.writeFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');

        const result = inspectTaskEventFile(filePath, 'T-001');
        assert.equal(result.task_id_mismatches, 1);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('inspectTaskEventFile handles LEGACY_ONLY status', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-task-events-'));
    try {
        const filePath = path.join(tempDir, 'legacy.jsonl');
        const event = { task_id: 'T-001', event_type: 'test', outcome: 'PASS' };
        fs.writeFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');

        const result = inspectTaskEventFile(filePath, 'T-001');
        assert.equal(result.status, 'LEGACY_ONLY');
        assert.equal(result.legacy_event_count, 1);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('inspectTaskEventFile handles PASS_WITH_LEGACY_PREFIX', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-task-events-'));
    try {
        const filePath = path.join(tempDir, 'mixed.jsonl');
        // Legacy event first
        const legacy = { task_id: 'T-001', event_type: 'legacy' };
        // Then integrity event
        const integrityEvent: Record<string, unknown> = {
            task_id: 'T-001',
            event_type: 'test',
            integrity: { schema_version: 1, task_sequence: 2, prev_event_sha256: null } as Record<string, unknown>
        };
        (integrityEvent.integrity as Record<string, unknown>).event_sha256 = buildEventIntegrityHash(integrityEvent);

        const content = [JSON.stringify(legacy), JSON.stringify(integrityEvent)].join('\n') + '\n';
        fs.writeFileSync(filePath, content, 'utf8');

        const result = inspectTaskEventFile(filePath, 'T-001');
        assert.equal(result.status, 'PASS_WITH_LEGACY_PREFIX');
        assert.equal(result.legacy_event_count, 1);
        assert.equal(result.integrity_event_count, 1);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

// --- appendTaskEvent ---

test('appendTaskEvent creates chain with correct integrity', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-'));
    try {
        // Simulate orchestrator root structure
        const orchestratorRoot = tempDir;

        // Append 3 events
        for (let i = 0; i < 3; i++) {
            appendTaskEvent(orchestratorRoot, 'T-TEST', 'test', 'PASS', `Event ${i + 1}`, { step: i }, { passThru: true });
        }

        // Verify the file exists and has integrity chain
        const eventFile = path.join(orchestratorRoot, 'runtime', 'task-events', 'T-TEST.jsonl');
        assert.ok(fs.existsSync(eventFile));

        const result = inspectTaskEventFile(eventFile, 'T-TEST');
        assert.equal(result.status, 'PASS');
        assert.equal(result.matching_events, 3);
        assert.equal(result.integrity_event_count, 3);
        assert.equal(result.violations.length, 0);

        // Also verify all-tasks.jsonl
        const allTasksFile = path.join(orchestratorRoot, 'runtime', 'task-events', 'all-tasks.jsonl');
        assert.ok(fs.existsSync(allTasksFile));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent returns null for empty taskId', () => {
    assert.equal(appendTaskEvent('/tmp', '', 'test', 'PASS', 'msg', null), null);
});

test('appendTaskEvent preserves integrity under concurrent process writes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-concurrent-'));
    const modulePath = resolveTaskEventsModulePath();
    const startSignalPath = path.join(tempDir, 'start.signal');
    const workerCount = 3;
    const attemptsPerWorker = 3;

    try {
        const workers = [];
        for (let index = 0; index < workerCount; index += 1) {
            workers.push(
                runConcurrentAppendWorker(
                    modulePath,
                    tempDir,
                    startSignalPath,
                    attemptsPerWorker,
                    10
                )
            );
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
        fs.writeFileSync(startSignalPath, 'go\n', 'utf8');
        await Promise.all(workers);

        const expectedCount = workerCount * attemptsPerWorker;
        const eventFile = path.join(tempDir, 'runtime', 'task-events', 'T-CONCURRENT.jsonl');
        const allTasksFile = path.join(tempDir, 'runtime', 'task-events', 'all-tasks.jsonl');
        const result = inspectTaskEventFile(eventFile, 'T-CONCURRENT');
        const aggregateLines = fs.readFileSync(allTasksFile, 'utf8').split('\n').filter((line) => line.trim());

        assert.equal(result.status, 'PASS');
        assert.equal(result.matching_events, expectedCount);
        assert.equal(result.integrity_event_count, expectedCount);
        assert.equal(result.violations.length, 0);
        assert.equal(aggregateLines.length, expectedCount);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent removes orphaned task lock when owner pid is no longer alive', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-orphan-lock-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TEST.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');

        const result = appendTaskEvent(
            tempDir,
            'T-TEST',
            'test',
            'PASS',
            'Recovered from orphaned lock',
            { recovered: true },
            {
                passThru: true,
                lockTimeoutMs: 250,
                lockRetryMs: 5,
                lockStaleMs: 60000
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 0);
        assert.ok(fs.existsSync(path.join(eventsRoot, 'T-TEST.jsonl')));
        assert.ok(!fs.existsSync(lockPath), 'orphaned lock should be removed and released');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent does not reclaim aged foreign-host lock without explicit override', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-foreign-lock-'));
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TEST.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999,
            hostname: 'remote-build-host',
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = appendTaskEvent(
            tempDir,
            'T-TEST',
            'test',
            'PASS',
            'Should not reclaim foreign-host lock by default',
            null,
            {
                passThru: true,
                lockTimeoutMs: 75,
                lockRetryMs: 5
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 1);
        assert.match(result!.warnings[0], /GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1/);
        assert.ok(result!.warnings[0].includes(`owner_hostname=${redactHostname('remote-build-host')}`));
        assert.doesNotMatch(result!.warnings[0], /remote-build-host/);
        assert.ok(!fs.existsSync(path.join(eventsRoot, 'T-TEST.jsonl')), 'blocked write must not append any task-event file');
        assert.ok(fs.existsSync(lockPath), 'aged foreign-host lock should remain without explicit override');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent reclaims aged foreign-host lock when explicit override is enabled', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-foreign-lock-'));
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = '1';
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TEST.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999,
            hostname: 'remote-build-host',
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = appendTaskEvent(
            tempDir,
            'T-TEST',
            'test',
            'PASS',
            'Recovered aged foreign-host lock',
            { recovered: true },
            {
                passThru: true,
                lockTimeoutMs: 250,
                lockRetryMs: 5
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 0);
        assert.ok(fs.existsSync(path.join(eventsRoot, 'T-TEST.jsonl')));
        assert.ok(!fs.existsSync(lockPath), 'aged foreign-host lock should be reclaimed and released');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent timeout warning includes lock owner diagnostics', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-live-lock-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TEST.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');

        const result = appendTaskEvent(
            tempDir,
            'T-TEST',
            'test',
            'PASS',
            'Should time out on active lock',
            null,
            {
                passThru: true,
                lockTimeoutMs: 50,
                lockRetryMs: 5,
                lockStaleMs: 60000
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 1);
        assert.match(result!.warnings[0], /Timed out acquiring file lock/);
        assert.match(result!.warnings[0], /owner_pid=/);
        assert.match(result!.warnings[0], /owner_alive=yes/);
        assert.match(result!.warnings[0], /owner_metadata_status=ok/);
        assert.ok(result!.warnings[0].includes('runtime/task-events/.T-TEST.lock'));
        assert.ok(!result!.warnings[0].includes(lockPath.replace(/\\/g, '/')));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent tolerates missing lock owner metadata', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-owner-race-'));

    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TEST.lock');
        fs.mkdirSync(lockPath, { recursive: true });

        const result = appendTaskEvent(
            tempDir,
            'T-TEST',
            'test',
            'PASS',
            'Should time out on active lock with missing owner metadata',
            null,
            {
                passThru: true,
                lockTimeoutMs: 50,
                lockRetryMs: 5,
                lockStaleMs: 60000
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 1);
        assert.match(result!.warnings[0], /Timed out acquiring file lock/);
        assert.match(result!.warnings[0], /owner_metadata_status=missing/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendMandatoryTaskEvent throws with detailed error when lock acquisition times out', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-mandatory-lock-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TEST.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');

        assert.throws(
            () => appendMandatoryTaskEvent(
                tempDir,
                'T-TEST',
                'TASK_MODE_ENTERED',
                'PASS',
                'Should fail on active lock',
                null,
                {
                    lockTimeoutMs: 50,
                    lockRetryMs: 5,
                    lockStaleMs: 60000
                }
            ),
            /Mandatory lifecycle event 'TASK_MODE_ENTERED' append failed:.*owner_pid=.*owner_alive=yes/
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('scanTaskEventLocks reports active and stale task-event locks only', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-scan-locks-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const staleLockPath = path.join(eventsRoot, '.T-005.lock');
        const activeLockPath = path.join(eventsRoot, '.all-tasks.lock');
        const reviewsLockPath = path.join(tempDir, 'runtime', 'reviews', '.ignored.lock');
        fs.mkdirSync(staleLockPath, { recursive: true });
        fs.mkdirSync(activeLockPath, { recursive: true });
        fs.mkdirSync(reviewsLockPath, { recursive: true });
        fs.writeFileSync(path.join(staleLockPath, 'owner.json'), JSON.stringify({
            pid: 999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(path.join(activeLockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');

        const result = scanTaskEventLocks(tempDir, { staleMs: 60000 });
        assert.equal(result.locks.length, 2);
        assert.equal(result.stale_count, 1);
        assert.equal(result.active_count, 1);
        assert.ok(result.subsystem_scope_note.includes('runtime/reviews/'));
        assert.ok(result.locks.some((lock) => lock.lock_name === '.T-005.lock' && lock.status === 'STALE'));
        assert.ok(result.locks.some((lock) => lock.lock_name === '.all-tasks.lock' && lock.status === 'ACTIVE'));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('cleanupStaleTaskEventLocks removes only stale locks and supports dry-run', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-cleanup-locks-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const staleLockPath = path.join(eventsRoot, '.T-005.lock');
        const activeLockPath = path.join(eventsRoot, '.all-tasks.lock');
        fs.mkdirSync(staleLockPath, { recursive: true });
        fs.mkdirSync(activeLockPath, { recursive: true });
        fs.writeFileSync(path.join(staleLockPath, 'owner.json'), JSON.stringify({
            pid: 999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(path.join(activeLockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');

        const dryRun = cleanupStaleTaskEventLocks(tempDir, { dryRun: true, staleMs: 60000 });
        assert.deepEqual(dryRun.removable_stale_locks, ['.T-005.lock']);
        assert.deepEqual(dryRun.removed_locks, []);
        assert.ok(fs.existsSync(staleLockPath));

        const applied = cleanupStaleTaskEventLocks(tempDir, { dryRun: false, staleMs: 60000 });
        assert.deepEqual(applied.removed_locks, ['.T-005.lock']);
        assert.deepEqual(applied.retained_live_locks, ['.all-tasks.lock']);
        assert.ok(!fs.existsSync(staleLockPath));
        assert.ok(fs.existsSync(activeLockPath));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

// --- readTaskEventAppendState ---

test('readTaskEventAppendState returns empty state for missing file', () => {
    const state = readTaskEventAppendState('/nonexistent/file.jsonl', 'T-001');
    assert.equal(state.matching_events, 0);
    assert.equal(state.parse_errors, 0);
    assert.equal(state.last_integrity_sequence, null);
    assert.equal(state.last_event_sha256, null);
});

test('readTaskEventAppendState uses streaming fallback for legacy events', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-state-stream-'));
    try {
        const filePath = path.join(tempDir, 'legacy.jsonl');
        const events = [
            { task_id: 'T-001', event_type: 'test', outcome: 'PASS' },
            { task_id: 'T-001', event_type: 'test2', outcome: 'PASS' }
        ];
        fs.writeFileSync(filePath, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

        const state = readTaskEventAppendState(filePath, 'T-001');
        assert.equal(state.matching_events, 2);
        assert.equal(state.parse_errors, 0);
        assert.equal(state.last_integrity_sequence, null);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('readTaskEventAppendState streaming fallback counts parse errors', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-state-err-'));
    try {
        const filePath = path.join(tempDir, 'bad.jsonl');
        fs.writeFileSync(filePath, 'NOT JSON\n{"task_id":"T-001","event_type":"x"}\n', 'utf8');

        const state = readTaskEventAppendState(filePath, 'T-001');
        assert.equal(state.matching_events, 1);
        assert.equal(state.parse_errors, 1);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

// --- forEachJsonlLine ---

test('forEachJsonlLine iterates non-empty lines with correct line numbers', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-jsonl-iter-'));
    try {
        const filePath = path.join(tempDir, 'test.jsonl');
        fs.writeFileSync(filePath, '{"a":1}\n\n{"b":2}\n{"c":3}\n', 'utf8');

        const collected: Array<{ line: string; num: number }> = [];
        forEachJsonlLine(filePath, (line, num) => {
            collected.push({ line, num });
        });

        assert.equal(collected.length, 3);
        assert.equal(collected[0].line, '{"a":1}');
        assert.equal(collected[0].num, 1);
        assert.equal(collected[1].line, '{"b":2}');
        assert.equal(collected[1].num, 3);
        assert.equal(collected[2].line, '{"c":3}');
        assert.equal(collected[2].num, 4);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('forEachJsonlLine returns 0 for missing file', () => {
    const count = forEachJsonlLine('/nonexistent/path.jsonl', () => {});
    assert.equal(count, 0);
});

test('forEachJsonlLine returns 0 for empty file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-jsonl-empty-'));
    try {
        const filePath = path.join(tempDir, 'empty.jsonl');
        fs.writeFileSync(filePath, '', 'utf8');
        const count = forEachJsonlLine(filePath, () => {});
        assert.equal(count, 0);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('forEachJsonlLine supports early stop via false return', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-jsonl-stop-'));
    try {
        const filePath = path.join(tempDir, 'stop.jsonl');
        fs.writeFileSync(filePath, '{"a":1}\n{"b":2}\n{"c":3}\n', 'utf8');

        const collected: string[] = [];
        forEachJsonlLine(filePath, (line) => {
            collected.push(line);
            if (collected.length >= 2) return false;
        });

        assert.equal(collected.length, 2);
        assert.equal(collected[0], '{"a":1}');
        assert.equal(collected[1], '{"b":2}');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('forEachJsonlLine handles file without trailing newline', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-jsonl-notrail-'));
    try {
        const filePath = path.join(tempDir, 'notrail.jsonl');
        fs.writeFileSync(filePath, '{"a":1}\n{"b":2}', 'utf8');

        const collected: string[] = [];
        forEachJsonlLine(filePath, (line) => {
            collected.push(line);
        });

        assert.equal(collected.length, 2);
        assert.equal(collected[1], '{"b":2}');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('forEachJsonlLine handles large files with many lines', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-jsonl-large-'));
    try {
        const filePath = path.join(tempDir, 'large.jsonl');
        const lineCount = 5000;
        const lines: string[] = [];
        for (let i = 0; i < lineCount; i++) {
            lines.push(JSON.stringify({ index: i, padding: 'x'.repeat(100) }));
        }
        fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

        let count = 0;
        let lastIndex = -1;
        forEachJsonlLine(filePath, (line) => {
            count++;
            const parsed = JSON.parse(line);
            lastIndex = parsed.index;
        });

        assert.equal(count, lineCount);
        assert.equal(lastIndex, lineCount - 1);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

// --- UTF-8 chunk-boundary safety ---

test('forEachJsonlLine preserves multi-byte UTF-8 at chunk boundary', () => {
    // Ж (U+0416) is 2 bytes in UTF-8: 0xD0 0x96
    // Build a file where a multi-byte character straddles a chunk boundary
    // by making the first line exactly fill a chunk minus 1 byte, so the 2-byte
    // Ж on the next line is split across two reads.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-jsonl-utf8-'));
    try {
        const filePath = path.join(tempDir, 'utf8.jsonl');
        // Construct file as raw bytes to control exact byte layout.
        // Line 1 payload: {"v":"<ASCII padding>"}\n — sized so the total byte length
        // up to and including the newline equals exactly CHUNK_SIZE - 1.
        // Then line 2 starts with a multi-byte char: {"k":"Ж"}\n
        // With a small chunk size we can simulate the boundary easily.
        const line2 = '{"k":"Ж"}\n';
        const line2Bytes = Buffer.from(line2, 'utf8');
        // Use the chunk size constant (64 KiB) to force a split.
        // Line1 must consume exactly (65536 - 1) bytes including the trailing \n.
        const prefix = '{"v":"';
        const suffix = '"}\n';
        const paddingNeeded = 65536 - 1 - Buffer.byteLength(prefix, 'utf8') - Buffer.byteLength(suffix, 'utf8');
        const line1 = prefix + 'A'.repeat(paddingNeeded) + suffix;
        const line1Bytes = Buffer.from(line1, 'utf8');
        // Verify our math: first chunk read (64KiB) gets line1Bytes + 1 byte of line2Bytes
        assert.equal(line1Bytes.length, 65535, 'line1 should be exactly 65535 bytes');
        fs.writeFileSync(filePath, Buffer.concat([line1Bytes, line2Bytes]));

        const collected: string[] = [];
        forEachJsonlLine(filePath, (line) => {
            collected.push(line);
        });

        assert.equal(collected.length, 2);
        // The critical assertion: Ж must not be corrupted to replacement characters
        assert.equal(collected[1], '{"k":"Ж"}');
        const parsed = JSON.parse(collected[1]);
        assert.equal(parsed.k, 'Ж');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('forEachJsonlLine preserves 3-byte and 4-byte UTF-8 at chunk boundaries', () => {
    // € (U+20AC) is 3 bytes: 0xE2 0x82 0xAC
    // 𐍈 (U+10348) is 4 bytes: 0xF0 0x90 0x8D 0x88
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-jsonl-utf8-mb-'));
    try {
        const filePath = path.join(tempDir, 'utf8mb.jsonl');
        const line2 = '{"price":"€100","symbol":"𐍈"}\n';
        const line2Bytes = Buffer.from(line2, 'utf8');
        const prefix = '{"v":"';
        const suffix = '"}\n';
        // Fill first chunk to exactly 65536 - 2 so that 2 of line2's first 3-byte char's bytes are in chunk 1
        const paddingNeeded = 65536 - 2 - Buffer.byteLength(prefix, 'utf8') - Buffer.byteLength(suffix, 'utf8');
        const line1 = prefix + 'B'.repeat(paddingNeeded) + suffix;
        const line1Bytes = Buffer.from(line1, 'utf8');
        assert.equal(line1Bytes.length, 65534);
        fs.writeFileSync(filePath, Buffer.concat([line1Bytes, line2Bytes]));

        const collected: string[] = [];
        forEachJsonlLine(filePath, (line) => {
            collected.push(line);
        });

        assert.equal(collected.length, 2);
        const parsed = JSON.parse(collected[1]);
        assert.equal(parsed.price, '€100');
        assert.equal(parsed.symbol, '𐍈');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('readTaskEventAppendState preserves multi-byte UTF-8 in tail-read (fast path)', () => {
    // Reproduces the reported false event_sha256 mismatch: if Ж is corrupted
    // to replacement chars, the hash computed on the parsed event won't match
    // the stored hash.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-tail-utf8-'));
    try {
        const taskId = 'T-UTF8';
        const payload = { task_id: taskId, gate: 'test', status: 'PASS', detail: 'Содержит Ж кириллицу' };
        const eventObj: Record<string, unknown> = { ...payload };
        // Add integrity block like appendTaskEvent would
        const eventSha256 = buildEventIntegrityHash(eventObj as Record<string, unknown>);
        assert.ok(eventSha256, 'hash must be computed');
        eventObj.integrity = { task_sequence: 1, event_sha256: eventSha256 };

        const eventLine = JSON.stringify(eventObj);
        // Build a file with filler to push the last line past the tail chunk boundary (4096 bytes)
        const fillerLine = JSON.stringify({ task_id: taskId, gate: 'filler', status: 'PASS', detail: 'x'.repeat(4000) });
        const content = fillerLine + '\n' + eventLine + '\n';
        const eventFile = path.join(tempDir, 'task-events', `${taskId}.jsonl`);
        fs.mkdirSync(path.dirname(eventFile), { recursive: true });
        fs.writeFileSync(eventFile, content, 'utf8');

        const state = readTaskEventAppendState(eventFile, taskId);
        assert.equal(state.last_event_sha256, eventSha256);
        assert.equal(state.matching_events, 1);
        assert.equal(state.parse_errors, 0);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('inspectTaskEventFile preserves multi-byte UTF-8 across chunk boundaries', () => {
    // End-to-end: write events with Cyrillic, verify no integrity violations
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-inspect-utf8-'));
    try {
        const taskId = 'T-INTEG-UTF8';
        // Build a chain of events containing multi-byte UTF-8 with integrity hashes
        const events: string[] = [];
        let prevHash: string | null = null;
        for (let i = 1; i <= 3; i++) {
            const payload: Record<string, unknown> = {
                task_id: taskId,
                gate: 'test',
                status: 'PASS',
                detail: `Событие ${i} — проверка целостности Ж€𐍈`
            };
            const integrityBlock: Record<string, unknown> = {
                task_sequence: i,
                prev_event_sha256: prevHash
            };
            payload.integrity = integrityBlock;
            const hash = buildEventIntegrityHash(payload);
            assert.ok(hash);
            integrityBlock.event_sha256 = hash;
            events.push(JSON.stringify(payload));
            prevHash = hash;
        }

        // Pad first event line to force chunk boundary split within multi-byte chars
        const paddingNeeded = 65536 - Buffer.byteLength(events[0], 'utf8') - 1; // -1 for \n
        if (paddingNeeded > 0) {
            // Insert a large filler event before the real events
            const filler: Record<string, unknown> = {
                task_id: taskId, gate: 'filler', status: 'PASS',
                detail: 'x'.repeat(paddingNeeded - 80) // approximate to push past boundary
            };
            events.unshift(JSON.stringify(filler));
        }

        const eventFile = path.join(tempDir, `${taskId}.jsonl`);
        fs.writeFileSync(eventFile, events.join('\n') + '\n', 'utf8');

        const result = inspectTaskEventFile(eventFile, taskId);
        assert.equal(result.parse_errors, 0, `parse errors: ${result.violations.join('; ')}`);
        // No integrity violations related to hash mismatch
        const hashViolations = result.violations.filter(v => v.includes('hash'));
        assert.equal(hashViolations.length, 0, `hash violations: ${hashViolations.join('; ')}`);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('readLastNonEmptyLine (via readTaskEventAppendStateFast) handles Cyrillic at tail chunk boundary', () => {
    // Direct regression test for the Ж -> ├Р├Ц corruption.
    // The tail reader uses 4096-byte chunks. Place a Cyrillic-heavy JSON line
    // so that the last line's multi-byte characters span the 4096-byte boundary
    // from end of file.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-tail-boundary-'));
    try {
        const taskId = 'T-TAIL';
        // Build the target last line with known Cyrillic content
        const cyrillicDetail = 'ЖЖЖЖЖЖЖЖЖЖ'.repeat(10); // 100 Cyrillic Ж chars = 200 bytes
        const lastEvent: Record<string, unknown> = {
            task_id: taskId, gate: 'g', status: 'PASS', detail: cyrillicDetail,
            integrity: { task_sequence: 1 }
        };
        const hash = buildEventIntegrityHash(lastEvent);
        (lastEvent.integrity as Record<string, unknown>).event_sha256 = hash;
        const lastLine = JSON.stringify(lastEvent);
        const lastLineBytes = Buffer.from(lastLine + '\n', 'utf8');

        // Filler to push the last line so it starts inside the 4096-byte window
        // but its beginning is in the previous chunk.
        // File size = filler + lastLineBytes; we want lastLineBytes to straddle 4096.
        const fillerSize = 4096 - Math.floor(lastLineBytes.length / 2);
        const fillerPayload = JSON.stringify({ task_id: taskId, gate: 'filler', status: 'PASS', detail: 'f'.repeat(Math.max(1, fillerSize - 80)) });
        // Ensure filler + '\n' is roughly fillerSize bytes
        const content = Buffer.concat([
            Buffer.from(fillerPayload + '\n', 'utf8'),
            lastLineBytes
        ]);

        const eventFile = path.join(tempDir, `${taskId}.jsonl`);
        fs.mkdirSync(path.dirname(eventFile), { recursive: true });
        fs.writeFileSync(eventFile, content);

        const state = readTaskEventAppendState(eventFile, taskId);
        assert.ok(state.last_event_sha256, 'should have extracted event_sha256');
        assert.equal(state.last_event_sha256, hash, 'hash must match — no UTF-8 corruption');
        assert.equal(state.parse_errors, 0);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

// --- bounded waiting and contention telemetry ---

test('appendTaskEvent includes lock_telemetry in result', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-lock-telemetry-'));
    try {
        const result = appendTaskEvent(
            tempDir,
            'T-TELEM',
            'test',
            'PASS',
            'Telemetry check',
            null,
            { passThru: true }
        );

        assert.ok(result !== null);
        assert.ok(result!.lock_telemetry != null, 'lock_telemetry must be present');
        assert.equal(typeof result!.lock_telemetry!.task_lock_retries, 'number');
        assert.equal(typeof result!.lock_telemetry!.task_lock_elapsed_ms, 'number');
        assert.equal(typeof result!.lock_telemetry!.aggregate_lock_retries, 'number');
        assert.equal(typeof result!.lock_telemetry!.aggregate_lock_elapsed_ms, 'number');
        assert.equal(result!.lock_telemetry!.task_lock_retries, 0, 'no contention expected');
        assert.equal(result!.lock_telemetry!.aggregate_lock_retries, 0, 'no contention expected');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent timeout includes retry count in diagnostic', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-retry-diagnostic-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TEST.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        const result = appendTaskEvent(
            tempDir,
            'T-TEST',
            'test',
            'PASS',
            'Should include retry count in timeout',
            null,
            {
                passThru: true,
                lockTimeoutMs: 80,
                lockRetryMs: 5,
                lockStaleMs: 60000
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 1);
        assert.match(result!.warnings[0], /retries=/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('task-events module avoids Atomics.wait and uses async timer-based waiting', () => {
    const facadePath = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'gate-runtime', 'task-events.ts');
    const lockingPath = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'gate-runtime', 'task-events-locking.ts');
    const strippedFacade = fs.readFileSync(facadePath, 'utf8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
    const strippedLocking = fs.readFileSync(lockingPath, 'utf8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');

    assert.equal(
        /Atomics\.wait\s*\(/.test(strippedFacade),
        false,
        'task-events.ts must not use Atomics.wait on the main thread'
    );
    assert.equal(
        /while\s*\(\s*Date\.now\(\)\s*</.test(strippedFacade),
        false,
        'task-events.ts must not contain a Date.now() busy-wait spin loop'
    );
    assert.equal(
        /setTimeout\s*\(/.test(strippedLocking),
        true,
        'task-events-locking.ts should use setTimeout-backed async waiting for lock retries'
    );
});

test('appendTaskEvent sync path fails fast on self-owned active lock without waiting', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-retry-cap-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TEST.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        const startedAt = Date.now();
        const result = appendTaskEvent(
            tempDir,
            'T-TEST',
            'test',
            'PASS',
            'Should fail fast on live lock',
            null,
            {
                passThru: true,
                lockTimeoutMs: 600000,
                lockRetryMs: 1,
                lockStaleMs: 60000
            }
        );
        const elapsedMs = Date.now() - startedAt;

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 1);
        assert.match(result!.warnings[0], /wait_strategy=immediate_fail/);
        assert.match(result!.warnings[0], /retries=0/);
        assert.ok(elapsedMs < 250, `sync append should fail fast, got ${elapsedMs} ms`);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent sync path waits through short-lived external contention', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-sync-contention-'));
    const lockPath = path.join(tempDir, 'runtime', 'task-events', '.T-SYNC-WAIT.lock');
    let cleanupChild: (() => Promise<void>) | null = null;
    try {
        cleanupChild = await holdTaskEventLockInChildProcess(lockPath, 120);
        const startedAt = Date.now();
        const result = appendTaskEvent(
            tempDir,
            'T-SYNC-WAIT',
            'test',
            'PASS',
            'Should wait for short-lived external lock',
            null,
            {
                passThru: true,
                lockTimeoutMs: 1000,
                lockRetryMs: 20,
                lockStaleMs: 60000
            }
        );
        const elapsedMs = Date.now() - startedAt;

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 0, 'sync append should succeed after bounded wait');
        assert.ok(elapsedMs >= 80, `sync append should wait for external owner, got ${elapsedMs} ms`);
        assert.ok((result!.lock_telemetry?.task_lock_retries || 0) > 0, 'telemetry should record sync retries');
        assert.notEqual(result!.lock_telemetry?.task_lock_contention_level, 'none');
    } finally {
        if (cleanupChild) {
            await cleanupChild();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEventAsync reports non-zero telemetry after contended lock acquisition', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-contention-telemetry-'));
    let cleanupChild: (() => Promise<void>) | null = null;
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-TELEM.lock');
        cleanupChild = await holdTaskEventLockInChildProcess(lockPath, 120);

        const result = await appendTaskEventAsync(
            tempDir,
            'T-TELEM',
            'test',
            'PASS',
            'Should succeed after contention',
            null,
            {
                passThru: true,
                lockTimeoutMs: 5000,
                lockRetryMs: 5,
                lockStaleMs: 60000
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 0, 'Should succeed without warnings');
        assert.ok(result!.lock_telemetry != null, 'lock_telemetry must be present');
        assert.ok(result!.lock_telemetry!.task_lock_retries > 0, 'Should have non-zero retries after contention');
        assert.ok(result!.lock_telemetry!.task_lock_elapsed_ms > 0, 'Should have non-zero elapsed time after contention');
    } finally {
        if (cleanupChild) {
            await cleanupChild();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEventAsync does not reclaim aged foreign-host lock without explicit override', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-async-foreign-lock-'));
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-ASYNC.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999,
            hostname: 'remote-build-host',
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = await appendTaskEventAsync(
            tempDir,
            'T-ASYNC',
            'test',
            'PASS',
            'Should not reclaim foreign-host lock by default',
            null,
            {
                passThru: true,
                lockTimeoutMs: 75,
                lockRetryMs: 5
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 1);
        assert.match(result!.warnings[0], /GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1/);
        assert.ok(result!.warnings[0].includes(`owner_hostname=${redactHostname('remote-build-host')}`));
        assert.doesNotMatch(result!.warnings[0], /remote-build-host/);
        assert.ok(!fs.existsSync(path.join(eventsRoot, 'T-ASYNC.jsonl')), 'blocked async write must not append any task-event file');
        assert.ok(fs.existsSync(lockPath), 'aged foreign-host lock should remain without explicit override');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEventAsync reclaims aged foreign-host lock when explicit override is enabled', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-append-async-foreign-lock-'));
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = '1';
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, '.T-ASYNC.lock');
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999,
            hostname: 'remote-build-host',
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = await appendTaskEventAsync(
            tempDir,
            'T-ASYNC',
            'test',
            'PASS',
            'Recovered aged foreign-host lock',
            { recovered: true },
            {
                passThru: true,
                lockTimeoutMs: 250,
                lockRetryMs: 5
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 0);
        assert.ok(fs.existsSync(path.join(eventsRoot, 'T-ASYNC.jsonl')));
        assert.ok(!fs.existsSync(lockPath), 'aged foreign-host lock should be reclaimed and released');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

// --- aggregate (all-tasks) lock contention ---

test('appendTaskEventAsync waits for aggregate lock and records contention telemetry when .all-tasks.lock is held', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-aggregate-contention-'));
    let cleanupChild: (() => Promise<void>) | null = null;
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const aggregateLockPath = path.join(eventsRoot, '.all-tasks.lock');
        cleanupChild = await holdTaskEventLockInChildProcess(aggregateLockPath, 140);

        const startedAt = Date.now();
        const result = await appendTaskEventAsync(
            tempDir,
            'T-AGG-CONTEND',
            'test',
            'PASS',
            'Aggregate append should wait for the aggregate lock',
            null,
            {
                passThru: true,
                lockTimeoutMs: 5000,
                lockRetryMs: 5,
                lockStaleMs: 60000
            }
        );
        const elapsedMs = Date.now() - startedAt;

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 0, 'aggregate append should wait instead of warning');
        assert.ok(result!.lock_telemetry != null, 'lock_telemetry must be present');
        assert.equal(result!.lock_telemetry!.task_lock_retries, 0, 'task lock should acquire on first attempt');
        assert.equal(
            result!.lock_telemetry!.aggregate_append_mode, 'locked',
            'aggregate append mode should record serialized append'
        );
        assert.ok(result!.lock_telemetry!.aggregate_lock_retries > 0, 'aggregate lock should show contention');
        assert.ok(
            result!.lock_telemetry!.aggregate_lock_elapsed_ms >= 100 || elapsedMs >= 100,
            `aggregate append should wait for held lock (telemetry=${result!.lock_telemetry!.aggregate_lock_elapsed_ms}, elapsed=${elapsedMs})`
        );

        const taskFile = path.join(eventsRoot, 'T-AGG-CONTEND.jsonl');
        const allTasksFile = path.join(eventsRoot, 'all-tasks.jsonl');
        assert.ok(fs.existsSync(taskFile), 'task event file must exist');
        assert.ok(fs.existsSync(allTasksFile), 'all-tasks aggregate file must exist');
        const taskLines = fs.readFileSync(taskFile, 'utf8').split('\n').filter((l) => l.trim());
        const aggLines = fs.readFileSync(allTasksFile, 'utf8').split('\n').filter((l) => l.trim());
        assert.equal(taskLines.length, 1, 'exactly one task event line');
        assert.equal(aggLines.length, 1, 'exactly one aggregate event line');
    } finally {
        if (cleanupChild) {
            await cleanupChild();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEventAsync warns instead of bypassing held aggregate lock when timeout expires', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-timeout-'));
    let cleanupChild: (() => Promise<void>) | null = null;
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const aggregateLockPath = path.join(eventsRoot, '.all-tasks.lock');
        cleanupChild = await holdTaskEventLockInChildProcess(aggregateLockPath, 220);

        const result = await appendTaskEventAsync(
            tempDir,
            'T-AGG-TIMEOUT',
            'test',
            'PASS',
            'Aggregate append should not bypass a timed-out lock',
            null,
            {
                passThru: true,
                lockTimeoutMs: 40,
                lockRetryMs: 5,
                lockStaleMs: 60000
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 1, 'aggregate timeout should surface as a warning');
        assert.match(result!.warnings[0], /aggregate append\/prune failed/i);
        assert.match(result!.warnings[0], /\.all-tasks\.lock/i);
        assert.match(result!.warnings[0], /timeout_ms=/i);
        assert.ok(result!.integrity !== null, 'task integrity should still be set');

        const taskFile = path.join(eventsRoot, 'T-AGG-TIMEOUT.jsonl');
        assert.ok(fs.existsSync(taskFile), 'task event file must exist');
        const allTasksFile = path.join(eventsRoot, 'all-tasks.jsonl');
        assert.ok(!fs.existsSync(allTasksFile), 'aggregate file must not be written through a bypass path');
    } finally {
        if (cleanupChild) {
            await cleanupChild();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent reports aggregate_append_mode=locked in lock_telemetry', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-mode-'));
    try {
        const result = appendTaskEvent(
            tempDir,
            'T-AGG-MODE',
            'test',
            'PASS',
            'Check aggregate append mode telemetry',
            null,
            { passThru: true }
        );

        assert.ok(result !== null);
        assert.ok(result!.lock_telemetry != null, 'lock_telemetry must be present');
        assert.equal(
            result!.lock_telemetry!.aggregate_append_mode, 'locked',
            'default append mode should be locked'
        );
        assert.equal(
            result!.lock_telemetry!.aggregate_lock_retries, 0,
            'aggregate lock retries should be 0 without contention'
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent sync aggregate append warns instead of bypassing held .all-tasks.lock', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-sync-lockfree-'));
    let cleanupChild: (() => Promise<void>) | null = null;
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const aggregateLockPath = path.join(eventsRoot, '.all-tasks.lock');
        cleanupChild = await holdTaskEventLockInChildProcess(aggregateLockPath, 220);

        const result = appendTaskEvent(
            tempDir,
            'T-SYNC-LOCKFREE',
            'test',
            'PASS',
            'Sync aggregate append should not bypass a held lock',
            null,
            {
                passThru: true,
                lockTimeoutMs: 50,
                lockRetryMs: 5,
                lockStaleMs: 60000
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 1, 'timed-out sync aggregate append should warn');
        assert.match(result!.warnings[0], /aggregate append\/prune failed/i);
        assert.match(result!.warnings[0], /\.all-tasks\.lock/i);
        assert.match(result!.warnings[0], /timeout_ms=/i);
        assert.ok(result!.integrity !== null, 'task integrity should be set');

        const allTasksFile = path.join(eventsRoot, 'all-tasks.jsonl');
        assert.ok(!fs.existsSync(allTasksFile), 'all-tasks aggregate file must not be written through a bypass path');
    } finally {
        if (cleanupChild) {
            await cleanupChild();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent triggers locked prune when aggregate log exceeds size threshold', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-locked-prune-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        fs.mkdirSync(eventsRoot, { recursive: true });
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');

        // Pre-fill the aggregate log with enough data to exceed the prune threshold
        // aggregateMaxLines=5 means threshold ~ 5 * 512 = 2560 bytes
        const bigLine = JSON.stringify({
            timestamp_utc: new Date().toISOString(),
            task_id: 'T-FILL',
            event_type: 'filler',
            outcome: 'PASS',
            actor: 'test',
            message: 'x'.repeat(400),
            details: null
        });
        const lines = [];
        for (let i = 0; i < 20; i++) {
            lines.push(bigLine);
        }
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = appendTaskEvent(
            tempDir,
            'T-PRUNE-TRIGGER',
            'test',
            'PASS',
            'Should trigger pruning with locked mode',
            null,
            {
                passThru: true,
                aggregateMaxLines: 5
            }
        );

        assert.ok(result !== null);
        assert.equal(result!.warnings.length, 0, 'append should succeed');
        assert.equal(result!.lock_telemetry!.aggregate_append_mode, 'locked_prune',
            'should report locked_prune when pruning was triggered');
        assert.ok(result!.aggregate_retention != null, 'aggregate_retention should be present');
        assert.ok(result!.aggregate_retention!.pruned, 'should have pruned');
        assert.ok(
            result!.aggregate_retention!.lines_after <= 5,
            `pruned lines should be at most 5 (got ${result!.aggregate_retention!.lines_after})`
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEventAsync preserves concurrent aggregate entries when each append triggers locked pruning', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-concurrent-prune-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');
        const modulePath = resolveTaskEventsModulePath();
        const startSignalPath = path.join(tempDir, 'start.signal');
        const workerCount = 4;
        const attemptsPerWorker = 10;
        const aggregateMaxLines = 260;
        fs.mkdirSync(eventsRoot, { recursive: true });

        const fillerLines = Array.from({ length: 320 }, (_, index) =>
            JSON.stringify({
                timestamp_utc: new Date().toISOString(),
                task_id: `T-FILL-${index}`,
                event_type: 'filler',
                outcome: 'PASS',
                actor: 'test',
                message: 'y'.repeat(700),
                details: { index }
            })
        );
        fs.writeFileSync(allTasksPath, fillerLines.join('\n') + '\n', 'utf8');

        const workers = Array.from({ length: workerCount }, () =>
            runConcurrentAppendWorker(
                modulePath,
                tempDir,
                startSignalPath,
                attemptsPerWorker,
                1,
                aggregateMaxLines
            )
        );

        fs.writeFileSync(startSignalPath, 'go\n', 'utf8');
        await Promise.all(workers);

        const expectedAppends = workerCount * attemptsPerWorker;
        const taskFile = path.join(eventsRoot, 'T-CONCURRENT.jsonl');
        const taskLines = fs.readFileSync(taskFile, 'utf8')
            .split('\n')
            .filter((line) => line.trim());
        assert.equal(taskLines.length, expectedAppends, 'per-task log should retain every concurrent append');

        const aggregateEntries = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as { task_id?: string });
        const concurrentEntries = aggregateEntries.filter((entry) => entry.task_id === 'T-CONCURRENT');
        assert.equal(
            concurrentEntries.length,
            expectedAppends,
            'aggregate log should retain every concurrent append even while pruning'
        );
        assert.ok(
            aggregateEntries.length <= aggregateMaxLines,
            `aggregate log should remain pruned to ${aggregateMaxLines} lines (got ${aggregateEntries.length})`
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEventAsync preserves concurrent aggregate entries while pruneAggregateLogLocked runs in parallel', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-append-vs-prune-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');
        const modulePath = resolveTaskEventsModulePath();
        const startSignalPath = path.join(tempDir, 'start-prune.signal');
        const workerCount = 4;
        const attemptsPerWorker = 10;
        const pruneAttempts = 8;
        const aggregateMaxLines = 260;
        fs.mkdirSync(eventsRoot, { recursive: true });

        const fillerLines = Array.from({ length: 320 }, (_, index) =>
            JSON.stringify({
                timestamp_utc: new Date().toISOString(),
                task_id: `T-PRUNE-FILL-${index}`,
                event_type: 'filler',
                outcome: 'PASS',
                actor: 'test',
                message: 'z'.repeat(900),
                details: { index }
            })
        );
        fs.writeFileSync(allTasksPath, fillerLines.join('\n') + '\n', 'utf8');

        const appendWorkers = Array.from({ length: workerCount }, () =>
            runConcurrentAppendWorker(
                modulePath,
                tempDir,
                startSignalPath,
                attemptsPerWorker,
                1,
                aggregateMaxLines
            )
        );
        const pruneWorker = runConcurrentPruneWorker(
            modulePath,
            eventsRoot,
            startSignalPath,
            pruneAttempts,
            aggregateMaxLines
        );

        fs.writeFileSync(startSignalPath, 'go\n', 'utf8');
        await Promise.all([...appendWorkers, pruneWorker]);

        const expectedAppends = workerCount * attemptsPerWorker;
        const taskFile = path.join(eventsRoot, 'T-CONCURRENT.jsonl');
        const taskLines = fs.readFileSync(taskFile, 'utf8')
            .split('\n')
            .filter((line) => line.trim());
        assert.equal(taskLines.length, expectedAppends, 'per-task log should retain every append during prune overlap');

        const aggregateEntries = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as { task_id?: string });
        const concurrentEntries = aggregateEntries.filter((entry) => entry.task_id === 'T-CONCURRENT');
        assert.equal(
            concurrentEntries.length,
            expectedAppends,
            'aggregate log should retain every append even when pruneAggregateLogLocked runs in parallel'
        );
        assert.ok(
            aggregateEntries.length <= aggregateMaxLines,
            `aggregate log should remain pruned to ${aggregateMaxLines} lines (got ${aggregateEntries.length})`
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('task-event modules keep helper-only shared dependencies', () => {
    const taskEventsRoot = path.resolve(process.cwd(), 'src/gate-runtime');
    const helperSource = fs.readFileSync(path.join(taskEventsRoot, 'task-events-helpers.ts'), 'utf8');
    const ioSource = fs.readFileSync(path.join(taskEventsRoot, 'task-events-io.ts'), 'utf8');
    const integritySource = fs.readFileSync(path.join(taskEventsRoot, 'task-events-integrity.ts'), 'utf8');

    assert.doesNotMatch(
        helperSource,
        /from\s+['"]\.\/task-events-(?!helpers)[^'"]+['"]/,
        'task-events-helpers.ts must stay independent from other task-event modules'
    );
    assert.match(
        ioSource,
        /from\s+['"]\.\/task-events-helpers['"]/,
        'task-events-io.ts must consume shared helpers through task-events-helpers.ts'
    );
    assert.doesNotMatch(
        ioSource,
        /from\s+['"]\.\/task-events-integrity['"]/,
        'task-events-io.ts must not import task-events-integrity.ts'
    );
    assert.match(
        integritySource,
        /from\s+['"]\.\/task-events-helpers['"]/,
        'task-events-integrity.ts must consume shared helpers through task-events-helpers.ts'
    );
    assert.doesNotMatch(
        integritySource,
        /from\s+['"]\.\/task-events-io['"]/,
        'task-events-integrity.ts must not import task-events-io.ts'
    );
});

// ---------------------------------------------------------------------------
// Aggregate log retention tests
// ---------------------------------------------------------------------------

test('pruneAggregateLog returns no-op for missing file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-missing-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        const result = pruneAggregateLog(allTasksPath, 100);
        assert.equal(result.pruned, false);
        assert.equal(result.lines_before, 0);
        assert.equal(result.lines_after, 0);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLog returns no-op for empty file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-empty-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        fs.writeFileSync(allTasksPath, '', 'utf8');
        const result = pruneAggregateLog(allTasksPath, 100);
        assert.equal(result.pruned, false);
        assert.equal(result.lines_before, 0);
        assert.equal(result.lines_after, 0);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLog returns no-op when lines are within limit', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-noop-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 5 }, (_, i) =>
            JSON.stringify({ task_id: `T-${i}`, event: 'test' })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');
        const result = pruneAggregateLog(allTasksPath, 10);
        assert.equal(result.pruned, false);
        assert.equal(result.lines_before, 5);
        assert.equal(result.lines_after, 5);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLog keeps most recent lines when over limit', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-trim-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 20 }, (_, i) =>
            JSON.stringify({ seq: i, task_id: `T-${i}` })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = pruneAggregateLog(allTasksPath, 5);
        assert.equal(result.pruned, true);
        assert.equal(result.lines_before, 20);
        assert.equal(result.lines_after, 5);

        // Verify retained lines are the last 5
        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 5);
        for (let i = 0; i < 5; i++) {
            const parsed = JSON.parse(remaining[i]);
            assert.equal(parsed.seq, 15 + i, `retained line ${i} should be seq ${15 + i}`);
        }
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLog accepts knownLineCount to skip counting', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-known-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 10 }, (_, i) =>
            JSON.stringify({ seq: i })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = pruneAggregateLog(allTasksPath, 3, 10);
        assert.equal(result.pruned, true);
        assert.equal(result.lines_before, 10);
        assert.equal(result.lines_after, 3);

        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 3);
        assert.equal(JSON.parse(remaining[0]).seq, 7);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLog with maxLines=0 disables pruning', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-disabled-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        fs.writeFileSync(allTasksPath, '{"line":1}\n{"line":2}\n', 'utf8');
        const result = pruneAggregateLog(allTasksPath, 0);
        assert.equal(result.pruned, false);
        assert.equal(result.lines_before, 0);
        assert.equal(result.lines_after, 0);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLog handles file with only newlines gracefully', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-newlines-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        fs.writeFileSync(allTasksPath, '\n\n\n', 'utf8');
        const result = pruneAggregateLog(allTasksPath, 5);
        assert.equal(result.pruned, false);
        assert.equal(result.lines_before, 0);
        assert.equal(result.lines_after, 0);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLogLocked prunes under filesystem lock', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-locked-'));
    try {
        const eventsRoot = path.join(tempDir, 'task-events');
        fs.mkdirSync(eventsRoot, { recursive: true });
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');
        const lines = Array.from({ length: 15 }, (_, i) =>
            JSON.stringify({ seq: i })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = pruneAggregateLogLocked(eventsRoot, 5);
        assert.equal(result.pruned, true);
        assert.equal(result.lines_before, 15);
        assert.equal(result.lines_after, 5);

        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 5);
        assert.equal(JSON.parse(remaining[0]).seq, 10);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLogLocked no-op when file is within limit', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-locked-noop-'));
    try {
        const eventsRoot = path.join(tempDir, 'task-events');
        fs.mkdirSync(eventsRoot, { recursive: true });
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');
        fs.writeFileSync(allTasksPath, '{"a":1}\n{"a":2}\n', 'utf8');

        const result = pruneAggregateLogLocked(eventsRoot, 100);
        assert.equal(result.pruned, false);
        assert.equal(result.lines_before, 2);
        assert.equal(result.lines_after, 2);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent prunes aggregate when aggregateMaxLines exceeded', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-append-prune-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        fs.mkdirSync(eventsRoot, { recursive: true });
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');

        // Pre-populate with lines whose total size exceeds the size trigger (4MB).
        const bigPayload = 'x'.repeat(600);
        const preLines = Array.from({ length: 8000 }, (_, i) =>
            JSON.stringify({ seq: i, data: bigPayload })
        );
        fs.writeFileSync(allTasksPath, preLines.join('\n') + '\n', 'utf8');

        const result = appendTaskEvent(
            tempDir,
            'T-AGG-PRUNE',
            'test',
            'PASS',
            'trigger prune',
            {},
            { passThru: true, eventsRoot, aggregateMaxLines: 5000 }
        );

        assert.ok(result !== null, 'append result must not be null');
        if (result!.aggregate_retention) {
            assert.equal(result!.aggregate_retention.pruned, true, 'aggregate should be pruned');
            assert.ok(result!.aggregate_retention.lines_after <= 5000,
                `lines_after should be <= 5000 (got ${result!.aggregate_retention.lines_after})`);
        }

        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.ok(remaining.length <= 5001, `aggregate should have at most 5001 lines (got ${remaining.length})`);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent does not prune when aggregateMaxLines is 0 (disabled)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-noprune-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        fs.mkdirSync(eventsRoot, { recursive: true });
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');
        const preLines = Array.from({ length: 100 }, (_, i) =>
            JSON.stringify({ seq: i })
        );
        fs.writeFileSync(allTasksPath, preLines.join('\n') + '\n', 'utf8');

        const result = appendTaskEvent(
            tempDir,
            'T-AGG-NOPRUNE',
            'test',
            'PASS',
            'no prune',
            {},
            { passThru: true, eventsRoot, aggregateMaxLines: 0 }
        );

        assert.ok(result !== null);
        assert.equal(result!.aggregate_retention, undefined, 'no retention info when disabled');

        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 101, 'all original lines plus new append');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEventAsync prunes aggregate when aggregateMaxLines exceeded', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-async-prune-'));
    try {
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        fs.mkdirSync(eventsRoot, { recursive: true });
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');

        const bigPayload = 'x'.repeat(600);
        const preLines = Array.from({ length: 8000 }, (_, i) =>
            JSON.stringify({ seq: i, data: bigPayload })
        );
        fs.writeFileSync(allTasksPath, preLines.join('\n') + '\n', 'utf8');

        const result = await appendTaskEventAsync(
            tempDir,
            'T-AGG-ASYNC-PRUNE',
            'test',
            'PASS',
            'trigger async prune',
            {},
            { passThru: true, eventsRoot, aggregateMaxLines: 5000 }
        );

        assert.ok(result !== null, 'async append result must not be null');
        if (result!.aggregate_retention) {
            assert.equal(result!.aggregate_retention.pruned, true, 'aggregate should be pruned');
            assert.ok(result!.aggregate_retention.lines_after <= 5000,
                `lines_after should be <= 5000 (got ${result!.aggregate_retention.lines_after})`);
        }

        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.ok(remaining.length <= 5001, `aggregate should have at most 5001 lines (got ${remaining.length})`);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('pruneAggregateLog preserves valid JSON on each retained line', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agg-prune-json-'));
    try {
        const allTasksPath = path.join(tempDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 30 }, (_, i) =>
            JSON.stringify({ timestamp_utc: new Date().toISOString(), task_id: `T-${i}`, event_type: 'test', outcome: 'PASS', actor: 'gate', message: `Event ${i}`, details: { num: i } })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = pruneAggregateLog(allTasksPath, 10);
        assert.equal(result.pruned, true);
        assert.equal(result.lines_after, 10);

        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());

        for (let i = 0; i < remaining.length; i++) {
            let parsed: unknown;
            assert.doesNotThrow(() => { parsed = JSON.parse(remaining[i]); },
                `Line ${i} must be valid JSON`);
            const obj = parsed as Record<string, unknown>;
            assert.ok(obj.task_id, `Line ${i} must have task_id`);
        }
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

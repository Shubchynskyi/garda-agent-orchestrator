import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    assertValidTaskId,
    appendTaskEvent,
    buildEventIntegrityHash,
    inspectTaskEventFile,
    normalizeIntegrityValue,
    readTaskEventAppendState,
    forEachJsonlLine
} from '../../../src/gate-runtime/task-events';
import { collectTimelineSummaryForDoctor } from '../../../src/gate-runtime/timeline-summary';
import { stringSha256 } from '../../../src/gate-runtime/hash';

// ---------------------------------------------------------------------------
// assertValidTaskId
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// normalizeIntegrityValue
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// buildEventIntegrityHash — cross-platform regression
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// buildEventIntegrityHash
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// inspectTaskEventFile
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// appendTaskEvent — basic chain and null guard
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// appendTaskEvent — summary updates
// ---------------------------------------------------------------------------

test('appendTaskEvent summary updates auto-detect code_changed from preflight when reviews are not required', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-summary-code-changed-'));
    try {
        const reviewsDir = path.join(tempDir, 'runtime', 'reviews');
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(
            path.join(reviewsDir, 'T-TEST-preflight.json'),
            JSON.stringify({
                task_id: 'T-TEST',
                scope_category: 'code',
                changed_files: ['src/small-fast-path.ts'],
                metrics: {
                    changed_lines_total: 8,
                    code_like_changed_count: 1,
                    runtime_code_like_changed_count: 1
                },
                required_reviews: {
                    code: false,
                    test: false
                },
                triggers: {
                    runtime_code_changed: true
                }
            }, null, 2),
            'utf8'
        );

        const result = appendTaskEvent(
            tempDir,
            'T-TEST',
            'TASK_MODE_ENTERED',
            'PASS',
            'Seed summary update',
            null,
            { passThru: true }
        );

        assert.ok(result !== null);
        const summaryPath = path.join(eventsRoot, '.timeline-summary.json');
        assert.ok(fs.existsSync(summaryPath));
        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as {
            entries?: Record<string, { code_changed?: boolean }>;
        };
        assert.equal(summary.entries?.['T-TEST']?.code_changed, true);
        const doctorSummary = collectTimelineSummaryForDoctor(tempDir);
        assert.equal(doctorSummary.evidence.length, 1);
        assert.equal(doctorSummary.evidence[0].task_id, 'T-TEST');
        assert.equal(doctorSummary.evidence[0].code_changed, true);

        fs.writeFileSync(path.join(reviewsDir, 'T-TEST-preflight.json'), '{invalid json', 'utf8');
        const secondResult = appendTaskEvent(
            tempDir,
            'T-TEST',
            'PLAN_CREATED',
            'INFO',
            'Reuse existing summary code_changed flag',
            null,
            { passThru: true }
        );

        assert.ok(secondResult !== null);
        const refreshedSummary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as {
            entries?: Record<string, { code_changed?: boolean }>;
        };
        assert.equal(refreshedSummary.entries?.['T-TEST']?.code_changed, true);
        const refreshedDoctorSummary = collectTimelineSummaryForDoctor(tempDir);
        assert.equal(refreshedDoctorSummary.evidence.length, 1);
        assert.equal(refreshedDoctorSummary.evidence[0].task_id, 'T-TEST');
        assert.equal(refreshedDoctorSummary.evidence[0].code_changed, true);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent summary updates preserve code_changed=false for docs-only no-review preflight', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-summary-non-code-'));
    try {
        const reviewsDir = path.join(tempDir, 'runtime', 'reviews');
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(
            path.join(reviewsDir, 'T-DOCS-preflight.json'),
            JSON.stringify({
                task_id: 'T-DOCS',
                scope_category: 'docs',
                changed_files: ['docs/usage.md'],
                metrics: {
                    changed_lines_total: 12,
                    code_like_changed_count: 0,
                    runtime_code_like_changed_count: 0
                },
                required_reviews: {
                    code: false,
                    test: false
                },
                triggers: {
                    runtime_code_changed: false
                }
            }, null, 2),
            'utf8'
        );

        const result = appendTaskEvent(
            tempDir,
            'T-DOCS',
            'TASK_MODE_ENTERED',
            'PASS',
            'Seed non-code summary update',
            null,
            { passThru: true }
        );

        assert.ok(result !== null);
        const summaryPath = path.join(eventsRoot, '.timeline-summary.json');
        assert.ok(fs.existsSync(summaryPath));
        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as {
            entries?: Record<string, { code_changed?: boolean }>;
        };
        assert.equal(summary.entries?.['T-DOCS']?.code_changed, false);
        const doctorSummary = collectTimelineSummaryForDoctor(tempDir);
        assert.equal(doctorSummary.evidence.length, 1);
        assert.equal(doctorSummary.evidence[0].task_id, 'T-DOCS');
        assert.equal(doctorSummary.evidence[0].code_changed, false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent does not refresh summary for telemetry-only non-lifecycle events', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-summary-skip-telemetry-'));
    try {
        const reviewsDir = path.join(tempDir, 'runtime', 'reviews');
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(
            path.join(reviewsDir, 'T-TEST-preflight.json'),
            JSON.stringify({
                task_id: 'T-TEST',
                scope_category: 'code',
                changed_files: ['src/small-fast-path.ts'],
                metrics: {
                    changed_lines_total: 8,
                    code_like_changed_count: 1,
                    runtime_code_like_changed_count: 1
                },
                required_reviews: {
                    code: false,
                    test: false
                },
                triggers: {
                    runtime_code_changed: true
                }
            }, null, 2),
            'utf8'
        );

        appendTaskEvent(
            tempDir,
            'T-TEST',
            'TASK_MODE_ENTERED',
            'PASS',
            'Seed summary update',
            null,
            { passThru: true }
        );

        const summaryPath = path.join(eventsRoot, '.timeline-summary.json');
        const before = fs.readFileSync(summaryPath, 'utf8');

        const result = appendTaskEvent(
            tempDir,
            'T-TEST',
            'SKILL_SELECTED',
            'INFO',
            'Telemetry-only event should not rewrite summary',
            { skill_id: 'code-review' },
            { passThru: true }
        );

        assert.ok(result !== null);
        const after = fs.readFileSync(summaryPath, 'utf8');
        assert.equal(after, before);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appendTaskEvent summary uses PREFLIGHT_CLASSIFIED code_changed hint when preflight is unreadable', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-summary-preflight-hint-'));
    try {
        const reviewsDir = path.join(tempDir, 'runtime', 'reviews');
        const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(path.join(reviewsDir, 'T-HINT-preflight.json'), '{invalid json', 'utf8');

        const result = appendTaskEvent(
            tempDir,
            'T-HINT',
            'PREFLIGHT_CLASSIFIED',
            'INFO',
            'Seed summary from lifecycle hint',
            { code_changed: true },
            { passThru: true }
        );

        assert.ok(result !== null);
        const summaryPath = path.join(eventsRoot, '.timeline-summary.json');
        assert.ok(fs.existsSync(summaryPath));
        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as {
            entries?: Record<string, { code_changed?: boolean }>;
        };
        assert.equal(summary.entries?.['T-HINT']?.code_changed, true);
        const doctorSummary = collectTimelineSummaryForDoctor(tempDir);
        assert.equal(doctorSummary.evidence.length, 1);
        assert.equal(doctorSummary.evidence[0].task_id, 'T-HINT');
        assert.equal(doctorSummary.evidence[0].code_changed, true);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// readTaskEventAppendState
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// forEachJsonlLine
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// UTF-8 chunk-boundary safety
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Module dependency constraints
// ---------------------------------------------------------------------------

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

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    __setTimelineSummaryTestHooks,
    getTimelineSummaryLockPath,
    getTimelineSummaryPath,
    pruneTimelineSummaryEntries,
    readTimelineSummaryIndex,
    writeTimelineSummaryIndex,
    isTimelineSummaryEntryCurrent,
    buildTimelineSummaryEntry,
    updateTimelineSummaryForTask,
    collectTimelineSummaryForStatus,
    collectTimelineSummaryForDoctor,
    type TimelineSummaryIndex,
    type TimelineSummaryEntry
} from '../../../src/gate-runtime/timeline-summary';
import {
    acquireFilesystemLock,
    releaseFilesystemLock
} from '../../../src/gate-runtime/task-events-locking';

function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-summary-test-'));
}

function removeTempDir(dirPath: string): void {
    fs.rmSync(dirPath, { recursive: true, force: true });
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForChildExit(child: childProcess.ChildProcess): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk) => {
            stderr += chunk;
        });
        child.once('error', reject);
        child.once('exit', (code) => {
            resolve({ code, stderr });
        });
    });
}

const SUMMARY_VERSION = 2;

const ALL_MANDATORY_NON_CODE = [
    'TASK_MODE_ENTERED',
    'RULE_PACK_LOADED',
    'HANDSHAKE_DIAGNOSTICS_RECORDED',
    'SHELL_SMOKE_PREFLIGHT_RECORDED',
    'PREFLIGHT_CLASSIFIED',
    'IMPLEMENTATION_STARTED',
    'COMPILE_GATE_PASSED',
    'REVIEW_PHASE_STARTED',
    'REVIEW_GATE_PASSED',
    'COMPLETION_GATE_PASSED'
];

const ALL_MANDATORY_CODE_CHANGE = [
    'TASK_MODE_ENTERED',
    'RULE_PACK_LOADED',
    'HANDSHAKE_DIAGNOSTICS_RECORDED',
    'SHELL_SMOKE_PREFLIGHT_RECORDED',
    'PREFLIGHT_CLASSIFIED',
    'IMPLEMENTATION_STARTED',
    'COMPILE_GATE_PASSED',
    'REVIEW_PHASE_STARTED',
    'REVIEW_GATE_PASSED',
    'COMPLETION_GATE_PASSED'
];

function writeTimeline(dirPath: string, taskId: string, eventTypes: string[]): string {
    const eventsDir = path.join(dirPath, 'runtime', 'task-events');
    fs.mkdirSync(eventsDir, { recursive: true });
    const timelinePath = path.join(eventsDir, `${taskId}.jsonl`);
    const lines = eventTypes.map((et) => JSON.stringify({
        timestamp_utc: new Date().toISOString(),
        task_id: taskId,
        event_type: et,
        outcome: 'PASS',
        actor: 'gate',
        message: 'test',
        details: {}
    }));
    fs.writeFileSync(timelinePath, lines.join('\n') + '\n', 'utf8');
    return timelinePath;
}

function writePreflight(dirPath: string, taskId: string, changedFilesCount: number): void {
    const reviewsDir = path.join(dirPath, 'runtime', 'reviews');
    fs.mkdirSync(reviewsDir, { recursive: true });
    const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
    const content = {
        changed_files: Array.from({ length: changedFilesCount }, (_, i) => `file${i}.ts`),
        metrics: { changed_lines_total: changedFilesCount > 0 ? 10 : 0 }
    };
    fs.writeFileSync(preflightPath, JSON.stringify(content), 'utf8');
}

function writeDocsOnlyPreflight(dirPath: string, taskId: string): void {
    const reviewsDir = path.join(dirPath, 'runtime', 'reviews');
    fs.mkdirSync(reviewsDir, { recursive: true });
    const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
    const content = {
        task_id: taskId,
        changed_files: ['docs/runbook.md'],
        metrics: {
            changed_lines_total: 10
        },
        required_reviews: {
            code: false,
            test: false
        }
    };
    fs.writeFileSync(preflightPath, JSON.stringify(content), 'utf8');
}

function writeWorkflowConfig(dirPath: string, enabled: boolean): void {
    const configDir = path.join(dirPath, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, 'workflow-config.json'),
        JSON.stringify({
            full_suite_validation: {
                enabled,
                command: 'npm test'
            }
        }, null, 2),
        'utf8'
    );
}

describe('gate-runtime/timeline-summary', () => {

    it('uses the lightweight preflight code-change helper instead of importing completion.ts', () => {
        const source = fs.readFileSync(path.resolve(process.cwd(), 'src/gate-runtime/timeline-summary.ts'), 'utf8');
        assert.match(source, /from\s+['"]\.\.\/gates\/preflight\/preflight-code-change['"]/);
        assert.doesNotMatch(source, /from\s+['"]\.\.\/gates\/completion['"]/);
    });

    describe('getTimelineSummaryPath', () => {
        it('returns path to .timeline-summary.json in the events root', () => {
            const result = getTimelineSummaryPath('/foo/runtime/task-events');
            assert.equal(result, path.join('/foo/runtime/task-events', '.timeline-summary.json'));
        });
    });

    describe('readTimelineSummaryIndex', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('returns null when file does not exist', () => {
            assert.equal(readTimelineSummaryIndex(tempDir), null);
        });

        it('returns null for invalid JSON', () => {
            fs.writeFileSync(path.join(tempDir, '.timeline-summary.json'), 'not json', 'utf8');
            assert.equal(readTimelineSummaryIndex(tempDir), null);
        });

        it('returns null for incompatible version', () => {
            const index = { version: 99, updated_at_utc: new Date().toISOString(), entries: {} };
            fs.writeFileSync(path.join(tempDir, '.timeline-summary.json'), JSON.stringify(index), 'utf8');
            assert.equal(readTimelineSummaryIndex(tempDir), null);
        });

        it('reads a valid summary index', () => {
            const index: TimelineSummaryIndex = {
                version: SUMMARY_VERSION,
                updated_at_utc: new Date().toISOString(),
                entries: {
                    'T-001': {
                        task_id: 'T-001',
                        file_size_bytes: 100,
                        file_mtime_ms: 123456,
                        code_changed: false,
                        completeness_status: 'COMPLETE',
                        events_found: ['TASK_MODE_ENTERED'],
                        events_missing: [],
                        completeness_violations: [],
                        integrity_status: 'PASSED',
                        events_scanned: 1,
                        integrity_event_count: 1,
                        integrity_violations: []
                    }
                }
            };
            fs.writeFileSync(path.join(tempDir, '.timeline-summary.json'), JSON.stringify(index), 'utf8');
            const result = readTimelineSummaryIndex(tempDir);
            assert.notEqual(result, null);
            assert.equal(result!.version, SUMMARY_VERSION);
            assert.ok(result!.entries['T-001']);
            assert.equal(result!.entries['T-001'].task_id, 'T-001');
        });
    });

    describe('writeTimelineSummaryIndex', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('writes a valid summary index that can be read back', () => {
            const index: TimelineSummaryIndex = {
                version: SUMMARY_VERSION,
                updated_at_utc: new Date().toISOString(),
                entries: {}
            };
            writeTimelineSummaryIndex(tempDir, index);
            const result = readTimelineSummaryIndex(tempDir);
            assert.notEqual(result, null);
            assert.equal(result!.version, SUMMARY_VERSION);
        });
    });

    describe('pruneTimelineSummaryEntries', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('prunes stale legacy entries even when sibling legacy rows are malformed', () => {
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsRoot, { recursive: true });

            writeTimeline(tempDir, 'T-002', ALL_MANDATORY_NON_CODE);

            fs.writeFileSync(
                getTimelineSummaryPath(eventsRoot),
                JSON.stringify({
                    version: 1,
                    updated_at_utc: new Date().toISOString(),
                    entries: {
                        'T-001': {
                            task_id: 'T-001',
                            file_size_bytes: 100,
                            file_mtime_ms: 0,
                            code_changed: false,
                            completeness_status: 'COMPLETE',
                            events_found: [],
                            events_missing: [],
                            completeness_violations: [],
                            integrity_status: 'PASSED',
                            events_scanned: 1,
                            integrity_event_count: 1,
                            integrity_violations: []
                        },
                        'BROKEN': {
                            task_id: 'BROKEN',
                            file_size_bytes: 'bad-size'
                        },
                        'T-002': {
                            task_id: 'T-002',
                            file_size_bytes: 100,
                            file_mtime_ms: 0,
                            code_changed: false,
                            completeness_status: 'COMPLETE',
                            events_found: [],
                            events_missing: [],
                            completeness_violations: [],
                            integrity_status: 'PASSED',
                            events_scanned: 1,
                            integrity_event_count: 1,
                            integrity_violations: []
                        }
                    }
                }, null, 2) + '\n',
                'utf8'
            );

            pruneTimelineSummaryEntries(eventsRoot);

            const updated = readTimelineSummaryIndex(eventsRoot);
            assert.notEqual(updated, null);
            assert.ok(!updated!.entries['T-001']);
            assert.ok(!updated!.entries.BROKEN);
            assert.ok(updated!.entries['T-002']);
        });
    });

    describe('isTimelineSummaryEntryCurrent', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('returns true when size and mtime match', () => {
            const filePath = path.join(tempDir, 'test.jsonl');
            fs.writeFileSync(filePath, 'hello\n', 'utf8');
            const stat = fs.statSync(filePath);
            const entry: TimelineSummaryEntry = {
                task_id: 'T-001',
                file_size_bytes: stat.size,
                file_mtime_ms: Math.floor(stat.mtimeMs),
                code_changed: false,
                completeness_status: 'COMPLETE',
                events_found: [],
                events_missing: [],
                completeness_violations: [],
                integrity_status: 'PASSED',
                events_scanned: 0,
                integrity_event_count: 0,
                integrity_violations: []
            };
            assert.equal(isTimelineSummaryEntryCurrent(entry, filePath), true);
        });

        it('returns false when size differs', () => {
            const filePath = path.join(tempDir, 'test.jsonl');
            fs.writeFileSync(filePath, 'hello\n', 'utf8');
            const stat = fs.statSync(filePath);
            const entry: TimelineSummaryEntry = {
                task_id: 'T-001',
                file_size_bytes: stat.size + 100,
                file_mtime_ms: Math.floor(stat.mtimeMs),
                code_changed: false,
                completeness_status: 'COMPLETE',
                events_found: [],
                events_missing: [],
                completeness_violations: [],
                integrity_status: 'PASSED',
                events_scanned: 0,
                integrity_event_count: 0,
                integrity_violations: []
            };
            assert.equal(isTimelineSummaryEntryCurrent(entry, filePath), false);
        });

        it('returns false when file does not exist', () => {
            const entry: TimelineSummaryEntry = {
                task_id: 'T-001',
                file_size_bytes: 10,
                file_mtime_ms: 123456,
                code_changed: false,
                completeness_status: 'COMPLETE',
                events_found: [],
                events_missing: [],
                completeness_violations: [],
                integrity_status: 'PASSED',
                events_scanned: 0,
                integrity_event_count: 0,
                integrity_violations: []
            };
            assert.equal(isTimelineSummaryEntryCurrent(entry, path.join(tempDir, 'missing.jsonl')), false);
        });

        it('keeps historical completed entries current when the live full-suite toggle changes later', () => {
            const timelinePath = path.join(tempDir, 'test.jsonl');
            fs.writeFileSync(timelinePath, 'hello\n', 'utf8');
            const stat = fs.statSync(timelinePath);
            const entry: TimelineSummaryEntry = {
                task_id: 'T-001',
                file_size_bytes: stat.size,
                file_mtime_ms: Math.floor(stat.mtimeMs),
                code_changed: false,
                full_suite_validation_required: false,
                completeness_status: 'COMPLETE',
                events_found: ['COMPLETION_GATE_PASSED'],
                events_missing: [],
                completeness_violations: [],
                integrity_status: 'PASSED',
                events_scanned: 1,
                integrity_event_count: 1,
                integrity_violations: []
            };
            assert.equal(isTimelineSummaryEntryCurrent(entry, timelinePath, true), true);
        });
    });

    describe('buildTimelineSummaryEntry', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('builds a complete entry for a valid timeline', () => {
            const timelinePath = writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            const entry = buildTimelineSummaryEntry(timelinePath, 'T-001', false);
            assert.notEqual(entry, null);
            assert.equal(entry!.task_id, 'T-001');
            assert.equal(entry!.completeness_status, 'COMPLETE');
            assert.equal(entry!.events_missing.length, 0);
            assert.ok(entry!.file_size_bytes > 0);
            assert.ok(entry!.events_scanned > 0);
        });

        it('builds an incomplete entry for a partial timeline', () => {
            const timelinePath = writeTimeline(tempDir, 'T-002', ['TASK_MODE_ENTERED']);
            const entry = buildTimelineSummaryEntry(timelinePath, 'T-002', false);
            assert.notEqual(entry, null);
            assert.equal(entry!.completeness_status, 'INCOMPLETE');
            assert.ok(entry!.events_missing.length > 0);
        });

        it('returns null when file does not exist', () => {
            const result = buildTimelineSummaryEntry(path.join(tempDir, 'missing.jsonl'), 'T-003', false);
            assert.equal(result, null);
        });
    });

    describe('updateTimelineSummaryForTask', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('creates the summary index when it does not exist', () => {
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
            updateTimelineSummaryForTask(eventsRoot, 'T-001', false);

            const index = readTimelineSummaryIndex(eventsRoot);
            assert.notEqual(index, null);
            assert.ok(index!.entries['T-001']);
            assert.equal(index!.entries['T-001'].completeness_status, 'COMPLETE');
        });

        it('adds a new entry to an existing summary', () => {
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            writeTimeline(tempDir, 'T-002', ['TASK_MODE_ENTERED']);
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');

            updateTimelineSummaryForTask(eventsRoot, 'T-001', false);
            updateTimelineSummaryForTask(eventsRoot, 'T-002', false);

            const index = readTimelineSummaryIndex(eventsRoot);
            assert.notEqual(index, null);
            assert.ok(index!.entries['T-001']);
            assert.ok(index!.entries['T-002']);
            assert.equal(index!.entries['T-001'].completeness_status, 'COMPLETE');
            assert.equal(index!.entries['T-002'].completeness_status, 'INCOMPLETE');
        });

        it('updates an existing entry when timeline changes', () => {
            writeTimeline(tempDir, 'T-001', ['TASK_MODE_ENTERED']);
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');

            updateTimelineSummaryForTask(eventsRoot, 'T-001', false);
            let index = readTimelineSummaryIndex(eventsRoot);
            assert.equal(index!.entries['T-001'].completeness_status, 'INCOMPLETE');

            // Rewrite the timeline with all mandatory events
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            updateTimelineSummaryForTask(eventsRoot, 'T-001', false);

            index = readTimelineSummaryIndex(eventsRoot);
            assert.equal(index!.entries['T-001'].completeness_status, 'COMPLETE');
        });

        it('retries when another writer clobbers the freshly written entry', () => {
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
            const summaryPath = getTimelineSummaryPath(eventsRoot);
            let clobbered = false;

            try {
                __setTimelineSummaryTestHooks({
                    afterWrite() {
                        if (!clobbered) {
                        clobbered = true;
                        const staleIndex: TimelineSummaryIndex = {
                            version: SUMMARY_VERSION,
                            updated_at_utc: new Date().toISOString(),
                            entries: {
                                'T-001': {
                                    task_id: 'T-001',
                                    file_size_bytes: 0,
                                    file_mtime_ms: 0,
                                    code_changed: false,
                                    completeness_status: 'INCOMPLETE',
                                    events_found: ['TASK_MODE_ENTERED'],
                                    events_missing: ['RULE_PACK_LOADED'],
                                    completeness_violations: ['clobbered'],
                                    integrity_status: 'PASSED',
                                    events_scanned: 1,
                                    integrity_event_count: 1,
                                    integrity_violations: [],
                                    written_at_ms: 1
                                }
                            }
                        };
                        fs.writeFileSync(summaryPath, JSON.stringify(staleIndex, null, 2) + '\n', 'utf8');
                    }
                    }
                });

                updateTimelineSummaryForTask(eventsRoot, 'T-001', false);
            } finally {
                __setTimelineSummaryTestHooks(null);
            }

            assert.equal(clobbered, true);
            const index = readTimelineSummaryIndex(eventsRoot);
            assert.notEqual(index, null);
            assert.equal(index!.entries['T-001'].completeness_status, 'COMPLETE');
            assert.ok((index!.entries['T-001'].written_at_ms || 0) > 1);
            assert.equal(index!.entries['T-001'].events_missing.length, 0);
        });

        it('does not restore a stale entry when cleanup deletes the timeline before merge', () => {
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
            const timelinePath = path.join(eventsRoot, 'T-001.jsonl');
            let cleanupSimulated = false;

            updateTimelineSummaryForTask(eventsRoot, 'T-001', false);

            try {
                __setTimelineSummaryTestHooks({
                    beforeMerge(root) {
                        if (cleanupSimulated) return;
                        cleanupSimulated = true;
                        fs.unlinkSync(timelinePath);
                        pruneTimelineSummaryEntries(root);
                    }
                });

                updateTimelineSummaryForTask(eventsRoot, 'T-001', false);
            } finally {
                __setTimelineSummaryTestHooks(null);
            }

            assert.equal(cleanupSimulated, true);
            const index = readTimelineSummaryIndex(eventsRoot);
            assert.ok(!index?.entries['T-001']);
        });

        it('waits behind the summary lock before updating and still skips a deleted timeline', async () => {
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
            const timelinePath = path.join(eventsRoot, 'T-001.jsonl');
            const lockPath = getTimelineSummaryLockPath(eventsRoot);
            const modulePath = path.resolve(__dirname, '../../../src/gate-runtime/timeline-summary.js');
            const { handle } = acquireFilesystemLock(lockPath, {
                timeoutMs: 2_000,
                retryMs: 10
            });

            try {
                const child = childProcess.spawn(process.execPath, [
                    '-e',
                    [
                        'const timelineSummary = require(process.argv[1]);',
                        'timelineSummary.updateTimelineSummaryForTask(process.argv[2], process.argv[3], false);'
                    ].join(' '),
                    modulePath,
                    eventsRoot,
                    'T-001'
                ], {
                    cwd: tempDir,
                    stdio: ['ignore', 'ignore', 'pipe'],
                    windowsHide: true
                });

                await sleep(75);
                assert.equal(child.exitCode, null, 'update must still be waiting on the held summary lock');
                assert.equal(fs.existsSync(getTimelineSummaryPath(eventsRoot)), false,
                    'summary must not be written while another holder owns the summary lock');

                fs.unlinkSync(timelinePath);
                releaseFilesystemLock(handle);

                const { code, stderr } = await waitForChildExit(child);
                assert.equal(code, 0, stderr || 'child update should complete successfully after lock release');

                const index = readTimelineSummaryIndex(eventsRoot);
                assert.ok(!index?.entries['T-001'],
                    'deleted timeline must not be reintroduced after waiting on the summary lock');
            } finally {
                releaseFilesystemLock(handle);
            }
        });
    });

    describe('collectTimelineSummaryForStatus', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('returns zero counts when no events directory exists', () => {
            const bundlePath = path.join(tempDir, 'garda-agent-orchestrator');
            fs.mkdirSync(bundlePath, { recursive: true });
            const result = collectTimelineSummaryForStatus(bundlePath);
            assert.equal(result.taskCount, 0);
            assert.equal(result.healthy, 0);
            assert.equal(result.warnings.length, 0);
        });

        it('counts healthy timelines from summary cache', () => {
            const bundlePath = tempDir;
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');

            // Pre-populate the summary (simulating write-side behavior)
            updateTimelineSummaryForTask(eventsRoot, 'T-001', false);

            const result = collectTimelineSummaryForStatus(bundlePath);
            assert.equal(result.taskCount, 1);
            assert.equal(result.healthy, 1);
            assert.equal(result.warnings.length, 0);
        });

        it('warns about incomplete timelines from summary cache', () => {
            const bundlePath = tempDir;
            writeTimeline(tempDir, 'T-001', ['TASK_MODE_ENTERED']);
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');

            updateTimelineSummaryForTask(eventsRoot, 'T-001', false);

            const result = collectTimelineSummaryForStatus(bundlePath);
            assert.equal(result.taskCount, 1);
            assert.equal(result.healthy, 0);
            assert.ok(result.warnings.some(w => w.includes('Incomplete timeline')));
        });

        it('falls back to full read when summary cache is missing', () => {
            const bundlePath = tempDir;
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);

            // No summary cache written — should still work via fallback
            const result = collectTimelineSummaryForStatus(bundlePath);
            assert.equal(result.taskCount, 1);
            assert.equal(result.healthy, 1);
            assert.equal(result.warnings.length, 0);
        });

        it('falls back to full read when summary entry is stale', () => {
            const bundlePath = tempDir;
            writeTimeline(tempDir, 'T-001', ['TASK_MODE_ENTERED']);
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');

            updateTimelineSummaryForTask(eventsRoot, 'T-001', false);

            // Rewrite timeline to make the cache stale
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);

            const result = collectTimelineSummaryForStatus(bundlePath);
            assert.equal(result.taskCount, 1);
            assert.equal(result.healthy, 1);
            assert.equal(result.warnings.length, 0);
        });

        it('handles multiple tasks with mixed health', () => {
            const bundlePath = tempDir;
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            writeTimeline(tempDir, 'T-002', ['TASK_MODE_ENTERED']);
            writeTimeline(tempDir, 'T-003', ALL_MANDATORY_NON_CODE);
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');

            updateTimelineSummaryForTask(eventsRoot, 'T-001', false);
            updateTimelineSummaryForTask(eventsRoot, 'T-002', false);
            updateTimelineSummaryForTask(eventsRoot, 'T-003', false);

            const result = collectTimelineSummaryForStatus(bundlePath);
            assert.equal(result.taskCount, 3);
            assert.equal(result.healthy, 2);
            assert.equal(result.warnings.length, 1);
            assert.ok(result.warnings[0].includes('T-002'));
        });

        it('warns about empty timelines', () => {
            const bundlePath = tempDir;
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsRoot, { recursive: true });
            fs.writeFileSync(path.join(eventsRoot, 'T-001.jsonl'), '', 'utf8');

            const result = collectTimelineSummaryForStatus(bundlePath);
            assert.equal(result.taskCount, 1);
            assert.equal(result.healthy, 0);
            assert.ok(result.warnings.some(w => w.includes('Empty timeline')));
        });

        it('ignores all-tasks.jsonl', () => {
            const bundlePath = tempDir;
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsRoot, { recursive: true });
            fs.writeFileSync(path.join(eventsRoot, 'all-tasks.jsonl'), 'data\n', 'utf8');

            const result = collectTimelineSummaryForStatus(bundlePath);
            assert.equal(result.taskCount, 0);
        });
    });

    describe('collectTimelineSummaryForDoctor', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('returns empty evidence when no events directory exists', () => {
            const bundlePath = path.join(tempDir, 'garda-agent-orchestrator');
            fs.mkdirSync(bundlePath, { recursive: true });
            const result = collectTimelineSummaryForDoctor(bundlePath);
            assert.equal(result.evidence.length, 0);
            assert.equal(result.warnings.length, 0);
        });

        it('returns detailed evidence from summary cache', () => {
            const bundlePath = tempDir;
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');

            updateTimelineSummaryForTask(eventsRoot, 'T-001', false);

            const result = collectTimelineSummaryForDoctor(bundlePath);
            assert.equal(result.evidence.length, 1);
            assert.equal(result.evidence[0].task_id, 'T-001');
            assert.equal(result.evidence[0].completeness_status, 'COMPLETE');
            assert.ok(result.evidence[0].events_scanned > 0);
            // Legacy events (no integrity blocks) → integrity_event_count is 0
            assert.equal(result.evidence[0].integrity_event_count, 0);
            assert.equal(result.evidence[0].status, 'LEGACY_ONLY');
        });

        it('falls back to full validation when cache is missing', () => {
            const bundlePath = tempDir;
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);

            const result = collectTimelineSummaryForDoctor(bundlePath);
            assert.equal(result.evidence.length, 1);
            assert.equal(result.evidence[0].task_id, 'T-001');
            assert.equal(result.evidence[0].completeness_status, 'COMPLETE');
        });

        it('warns about integrity failures from cache', () => {
            const bundlePath = tempDir;
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsRoot, { recursive: true });

            // Write a timeline with bad integrity (duplicate hashes etc.)
            writeTimeline(tempDir, 'T-001', ['TASK_MODE_ENTERED']);

            updateTimelineSummaryForTask(eventsRoot, 'T-001', false);

            const result = collectTimelineSummaryForDoctor(bundlePath);
            assert.equal(result.evidence.length, 1);
            // The timeline is incomplete but integrity should still be checked
            assert.ok(result.evidence[0].completeness_status === 'INCOMPLETE');
            assert.ok(result.warnings.some(w => w.includes('T-001')));
        });

        it('returns evidence for stale entries via fallback', () => {
            const bundlePath = tempDir;
            writeTimeline(tempDir, 'T-001', ['TASK_MODE_ENTERED']);
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');

            updateTimelineSummaryForTask(eventsRoot, 'T-001', false);

            // Modify the timeline making the cache stale
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);

            const result = collectTimelineSummaryForDoctor(bundlePath);
            assert.equal(result.evidence.length, 1);
            assert.equal(result.evidence[0].completeness_status, 'COMPLETE');
            assert.equal(result.warnings.length, 0);
        });

        it('ignores old summary-cache versions and falls back to fresh doctor evidence', () => {
            const bundlePath = tempDir;
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            writeDocsOnlyPreflight(tempDir, 'T-001');
            writeTimelineSummaryIndex(eventsRoot, {
                version: 1,
                updated_at_utc: new Date().toISOString(),
                entries: {
                    'T-001': {
                        task_id: 'T-001',
                        file_size_bytes: 0,
                        file_mtime_ms: 0,
                        code_changed: true,
                        completeness_status: 'INCOMPLETE',
                        events_found: ['TASK_MODE_ENTERED'],
                        events_missing: ['PREFLIGHT_CLASSIFIED'],
                        completeness_violations: ['stale summary entry'],
                        integrity_status: 'PASSED',
                        events_scanned: 1,
                        integrity_event_count: 0,
                        integrity_violations: []
                    }
                }
            });

            const result = collectTimelineSummaryForDoctor(bundlePath);
            assert.equal(result.evidence.length, 1);
            assert.equal(result.evidence[0].task_id, 'T-001');
            assert.equal(result.evidence[0].completeness_status, 'COMPLETE');
            assert.equal(result.evidence[0].code_changed, false);
            assert.equal(result.warnings.length, 0);
        });
    });

    describe('read-only contract', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('collectTimelineSummaryForStatus does not write summary files', () => {
            const bundlePath = tempDir;
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
            const summaryPath = path.join(eventsRoot, '.timeline-summary.json');

            // Ensure no summary exists before
            assert.equal(fs.existsSync(summaryPath), false);

            collectTimelineSummaryForStatus(bundlePath);

            // Summary should NOT have been created by the read-only path
            assert.equal(fs.existsSync(summaryPath), false);
        });

        it('collectTimelineSummaryForDoctor does not write summary files', () => {
            const bundlePath = tempDir;
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
            const summaryPath = path.join(eventsRoot, '.timeline-summary.json');

            assert.equal(fs.existsSync(summaryPath), false);

            collectTimelineSummaryForDoctor(bundlePath);

            assert.equal(fs.existsSync(summaryPath), false);
        });
    });

    describe('cache invalidation / refresh', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('new task added after summary creation is detected by status', () => {
            const bundlePath = tempDir;
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');

            updateTimelineSummaryForTask(eventsRoot, 'T-001', false);

            // Add a new timeline not yet in the summary
            writeTimeline(tempDir, 'T-002', ALL_MANDATORY_NON_CODE);

            const result = collectTimelineSummaryForStatus(bundlePath);
            assert.equal(result.taskCount, 2);
            assert.equal(result.healthy, 2);
        });

        it('removed task is excluded even if summary still has entry', () => {
            const bundlePath = tempDir;
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            writeTimeline(tempDir, 'T-002', ALL_MANDATORY_NON_CODE);
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');

            updateTimelineSummaryForTask(eventsRoot, 'T-001', false);
            updateTimelineSummaryForTask(eventsRoot, 'T-002', false);

            // Remove T-002 timeline
            fs.unlinkSync(path.join(eventsRoot, 'T-002.jsonl'));

            const result = collectTimelineSummaryForStatus(bundlePath);
            assert.equal(result.taskCount, 1);
            assert.equal(result.healthy, 1);
        });

        it('code_changed flag does not downgrade a timeline that already satisfies the canonical lifecycle', () => {
            const bundlePath = tempDir;
            // Write a timeline with only non-code mandatory events
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);

            // No preflight = code_changed=false → should be COMPLETE
            const result1 = collectTimelineSummaryForStatus(bundlePath);
            assert.equal(result1.healthy, 1);

            // Add a preflight that says code changed
            writePreflight(tempDir, 'T-001', 5);

            // Canonical lifecycle evidence is already complete, so health should remain green
            const result2 = collectTimelineSummaryForStatus(bundlePath);
            assert.equal(result2.healthy, 1);
            assert.equal(result2.warnings.length, 0);
        });

        it('docs-only preflight keeps canonical non-code timelines healthy without recorded reviews', () => {
            const bundlePath = tempDir;
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            writeDocsOnlyPreflight(tempDir, 'T-001');

            const result = collectTimelineSummaryForStatus(bundlePath);
            assert.equal(result.taskCount, 1);
            assert.equal(result.healthy, 1);
            assert.equal(result.warnings.length, 0);
        });

        it('ignores old summary-cache versions and falls back to fresh timeline validation', () => {
            const bundlePath = tempDir;
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            writeDocsOnlyPreflight(tempDir, 'T-001');
            writeTimelineSummaryIndex(eventsRoot, {
                version: 1,
                updated_at_utc: new Date().toISOString(),
                entries: {
                    'T-001': {
                        task_id: 'T-001',
                        file_size_bytes: 0,
                        file_mtime_ms: 0,
                        code_changed: true,
                        completeness_status: 'INCOMPLETE',
                        events_found: ['TASK_MODE_ENTERED'],
                        events_missing: ['PREFLIGHT_CLASSIFIED'],
                        completeness_violations: ['stale summary entry'],
                        integrity_status: 'PASSED',
                        events_scanned: 1,
                        integrity_event_count: 0,
                        integrity_violations: []
                    }
                }
            });

            const result = collectTimelineSummaryForStatus(bundlePath);
            assert.equal(result.taskCount, 1);
            assert.equal(result.healthy, 1);
            assert.equal(result.warnings.length, 0);
        });

        it('keeps historical completed timelines healthy when the live full-suite toggle is enabled later', () => {
            const bundlePath = tempDir;
            const eventsRoot = path.join(tempDir, 'runtime', 'task-events');

            writeWorkflowConfig(bundlePath, false);
            writeTimeline(tempDir, 'T-001', ALL_MANDATORY_NON_CODE);
            updateTimelineSummaryForTask(eventsRoot, 'T-001', false);

            writeWorkflowConfig(bundlePath, true);

            const result = collectTimelineSummaryForStatus(bundlePath);
            assert.equal(result.taskCount, 1);
            assert.equal(result.healthy, 1);
            assert.equal(result.warnings.length, 0);
        });
    });
});

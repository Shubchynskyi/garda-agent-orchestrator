import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    getCompletenessCachePath,
    readCompletenessSummary,
    writeCompletenessSummary,
    isCompletenessSummaryCurrent,
    validateTimelineCompletenessWithCache,
    type TimelineCompletenessSummary
} from '../../../src/gate-runtime/timeline-completeness-cache';

const CACHE_VERSION = 2;

const COMPLETE_NON_CODE_EVENTS = [
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

function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-cache-test-'));
}

function removeTempDir(dirPath: string): void {
    fs.rmSync(dirPath, { recursive: true, force: true });
}

function writeTimeline(dirPath: string, taskId: string, eventTypes: string[]): string {
    const eventsDir = path.join(dirPath, 'runtime', 'task-events');
    fs.mkdirSync(eventsDir, { recursive: true });
    const timelinePath = path.join(eventsDir, `${taskId}.jsonl`);
    const lines = eventTypes.map((et, idx) => JSON.stringify({
        timestamp_utc: new Date().toISOString(),
        task_id: taskId,
        event_type: et,
        outcome: 'PASS',
        actor: 'gate',
        message: 'test',
        details: {},
        integrity: { schema_version: 1, task_sequence: idx + 1, prev_event_sha256: null }
    }));
    fs.writeFileSync(timelinePath, lines.join('\n') + '\n', 'utf8');
    return timelinePath;
}

describe('gate-runtime/timeline-completeness-cache', () => {

    describe('getCompletenessCachePath', () => {
        it('derives cache path from timeline JSONL path', () => {
            const result = getCompletenessCachePath('/events/T-001.jsonl');
            assert.equal(result, path.join('/events', 'T-001.completeness.json'));
        });

        it('handles Windows-style paths', () => {
            const result = getCompletenessCachePath('C:\\events\\T-002.jsonl');
            assert.equal(result, path.win32.join('C:\\events', 'T-002.completeness.json'));
        });
    });

    describe('readCompletenessSummary', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('returns null for missing file', () => {
            assert.equal(readCompletenessSummary(path.join(tempDir, 'missing.json')), null);
        });

        it('returns null for invalid JSON', () => {
            const p = path.join(tempDir, 'bad.json');
            fs.writeFileSync(p, 'not json', 'utf8');
            assert.equal(readCompletenessSummary(p), null);
        });

        it('returns null for incompatible cache_version', () => {
            const p = path.join(tempDir, 'old.json');
            fs.writeFileSync(p, JSON.stringify({
                cache_version: 99,
                task_id: 'T-001',
                timeline_size_bytes: 100,
                timeline_mtime_ms: 123,
                code_changed: false,
                status: 'COMPLETE',
                events_found: [],
                events_missing: [],
                violations: []
            }), 'utf8');
            assert.equal(readCompletenessSummary(p), null);
        });

        it('returns valid summary for correct cache', () => {
            const p = path.join(tempDir, 'ok.json');
            const summary: TimelineCompletenessSummary = {
                cache_version: CACHE_VERSION,
                task_id: 'T-001',
                timeline_size_bytes: 200,
                timeline_mtime_ms: 1000,
                code_changed: true,
                status: 'COMPLETE',
                events_found: ['TASK_MODE_ENTERED'],
                events_missing: [],
                violations: []
            };
            fs.writeFileSync(p, JSON.stringify(summary), 'utf8');
            const result = readCompletenessSummary(p);
            assert.ok(result);
            assert.equal(result.task_id, 'T-001');
            assert.equal(result.status, 'COMPLETE');
            assert.equal(result.code_changed, true);
        });

        it('returns null when required fields are missing', () => {
            const p = path.join(tempDir, 'partial.json');
            fs.writeFileSync(p, JSON.stringify({ cache_version: CACHE_VERSION }), 'utf8');
            assert.equal(readCompletenessSummary(p), null);
        });
    });

    describe('writeCompletenessSummary', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('writes and reads back a summary', () => {
            const p = path.join(tempDir, 'write.json');
            const summary: TimelineCompletenessSummary = {
                cache_version: CACHE_VERSION,
                task_id: 'T-042',
                timeline_size_bytes: 500,
                timeline_mtime_ms: 2000,
                code_changed: false,
                status: 'INCOMPLETE',
                events_found: ['TASK_MODE_ENTERED'],
                events_missing: ['COMPLETION_GATE_PASSED'],
                violations: ['missing event']
            };
            writeCompletenessSummary(p, summary);
            const readBack = readCompletenessSummary(p);
            assert.ok(readBack);
            assert.equal(readBack.task_id, 'T-042');
            assert.equal(readBack.status, 'INCOMPLETE');
            assert.deepStrictEqual(readBack.events_missing, ['COMPLETION_GATE_PASSED']);
        });

        it('creates parent directories if needed', () => {
            const deep = path.join(tempDir, 'a', 'b', 'c', 'summary.json');
            const summary: TimelineCompletenessSummary = {
                cache_version: CACHE_VERSION,
                task_id: 'T-001',
                timeline_size_bytes: 0,
                timeline_mtime_ms: 0,
                code_changed: false,
                status: 'MISSING_TIMELINE',
                events_found: [],
                events_missing: [],
                violations: []
            };
            writeCompletenessSummary(deep, summary);
            assert.ok(fs.existsSync(deep));
        });
    });

    describe('isCompletenessSummaryCurrent', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('returns true when size, mtime, and codeChanged match', () => {
            const filePath = path.join(tempDir, 'timeline.jsonl');
            fs.writeFileSync(filePath, 'line1\nline2\n', 'utf8');
            const stat = fs.statSync(filePath);
            const summary: TimelineCompletenessSummary = {
                cache_version: CACHE_VERSION,
                task_id: 'T-001',
                timeline_size_bytes: stat.size,
                timeline_mtime_ms: Math.floor(stat.mtimeMs),
                code_changed: true,
                status: 'COMPLETE',
                events_found: [],
                events_missing: [],
                violations: []
            };
            assert.equal(isCompletenessSummaryCurrent(summary, filePath, true), true);
        });

        it('returns false when file size differs', () => {
            const filePath = path.join(tempDir, 'timeline.jsonl');
            fs.writeFileSync(filePath, 'line1\n', 'utf8');
            const stat = fs.statSync(filePath);
            const summary: TimelineCompletenessSummary = {
                cache_version: CACHE_VERSION,
                task_id: 'T-001',
                timeline_size_bytes: stat.size + 100,
                timeline_mtime_ms: Math.floor(stat.mtimeMs),
                code_changed: false,
                status: 'COMPLETE',
                events_found: [],
                events_missing: [],
                violations: []
            };
            assert.equal(isCompletenessSummaryCurrent(summary, filePath, false), false);
        });

        it('returns false when codeChanged differs', () => {
            const filePath = path.join(tempDir, 'timeline.jsonl');
            fs.writeFileSync(filePath, 'data\n', 'utf8');
            const stat = fs.statSync(filePath);
            const summary: TimelineCompletenessSummary = {
                cache_version: CACHE_VERSION,
                task_id: 'T-001',
                timeline_size_bytes: stat.size,
                timeline_mtime_ms: Math.floor(stat.mtimeMs),
                code_changed: true,
                status: 'COMPLETE',
                events_found: [],
                events_missing: [],
                violations: []
            };
            assert.equal(isCompletenessSummaryCurrent(summary, filePath, false), false);
        });

        it('returns false when file does not exist', () => {
            const summary: TimelineCompletenessSummary = {
                cache_version: CACHE_VERSION,
                task_id: 'T-001',
                timeline_size_bytes: 50,
                timeline_mtime_ms: 1000,
                code_changed: false,
                status: 'COMPLETE',
                events_found: [],
                events_missing: [],
                violations: []
            };
            assert.equal(
                isCompletenessSummaryCurrent(summary, path.join(tempDir, 'gone.jsonl'), false),
                false
            );
        });

        it('keeps historical completed summaries current when the live full-suite toggle changes later', () => {
            const filePath = path.join(tempDir, 'timeline.jsonl');
            fs.writeFileSync(filePath, 'data\n', 'utf8');
            const stat = fs.statSync(filePath);
            const summary: TimelineCompletenessSummary = {
                cache_version: CACHE_VERSION,
                task_id: 'T-001',
                timeline_size_bytes: stat.size,
                timeline_mtime_ms: Math.floor(stat.mtimeMs),
                code_changed: false,
                full_suite_validation_required: false,
                status: 'COMPLETE',
                events_found: ['COMPLETION_GATE_PASSED'],
                events_missing: [],
                violations: []
            };
            assert.equal(
                isCompletenessSummaryCurrent(summary, filePath, { codeChanged: false, fullSuiteValidationEnabled: true }),
                true
            );
        });
    });

    describe('validateTimelineCompletenessWithCache', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('returns MISSING_TIMELINE for non-existent file and does not write cache', () => {
            const missing = path.join(tempDir, 'runtime', 'task-events', 'T-MISS.jsonl');
            const result = validateTimelineCompletenessWithCache(missing, 'T-MISS', false);
            assert.equal(result.status, 'MISSING_TIMELINE');
            assert.ok(!result.timeline_exists);
            const cachePath = getCompletenessCachePath(missing);
            assert.ok(!fs.existsSync(cachePath));
        });

        it('populates cache on first call and uses cache on second call', () => {
            const timelinePath = writeTimeline(tempDir, 'T-CACHE', COMPLETE_NON_CODE_EVENTS);
            const cachePath = getCompletenessCachePath(timelinePath);

            // First call: cache miss, full read
            assert.ok(!fs.existsSync(cachePath));
            const r1 = validateTimelineCompletenessWithCache(timelinePath, 'T-CACHE', false);
            assert.equal(r1.status, 'COMPLETE');
            assert.equal(r1.events_missing.length, 0);
            assert.ok(fs.existsSync(cachePath));

            // Second call: cache hit
            const r2 = validateTimelineCompletenessWithCache(timelinePath, 'T-CACHE', false);
            assert.equal(r2.status, 'COMPLETE');
            assert.equal(r2.events_missing.length, 0);
        });

        it('invalidates cache when timeline is modified', () => {
            const timelinePath = writeTimeline(tempDir, 'T-STALE', COMPLETE_NON_CODE_EVENTS);

            // Populate cache
            const r1 = validateTimelineCompletenessWithCache(timelinePath, 'T-STALE', false);
            assert.equal(r1.status, 'COMPLETE');

            // Append to timeline to change size/mtime
            fs.appendFileSync(timelinePath, JSON.stringify({
                timestamp_utc: new Date().toISOString(),
                task_id: 'T-STALE',
                event_type: 'STATUS_CHANGED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'extra',
                details: {}
            }) + '\n', 'utf8');

            // Cache should be stale; result should still be valid
            const r2 = validateTimelineCompletenessWithCache(timelinePath, 'T-STALE', false);
            assert.equal(r2.status, 'COMPLETE');
            assert.ok(r2.timeline_exists);
        });

        it('invalidates cache when codeChanged flag changes', () => {
            const timelinePath = writeTimeline(tempDir, 'T-FLAG', COMPLETE_NON_CODE_EVENTS);
            const cachePath = getCompletenessCachePath(timelinePath);

            // Populate with codeChanged=false
            const r1 = validateTimelineCompletenessWithCache(timelinePath, 'T-FLAG', false);
            assert.equal(r1.status, 'COMPLETE');

            // Same file but different codeChanged flag; cache should invalidate and rewrite metadata
            const r2 = validateTimelineCompletenessWithCache(timelinePath, 'T-FLAG', true);
            assert.equal(r2.status, 'COMPLETE');
            const refreshed = readCompletenessSummary(cachePath);
            assert.ok(refreshed);
            assert.equal(refreshed.code_changed, true);
        });

        it('returns INCOMPLETE for incomplete timeline and caches that state', () => {
            const partialEvents = [
                'TASK_MODE_ENTERED', 'RULE_PACK_LOADED'
            ];
            const timelinePath = writeTimeline(tempDir, 'T-PART', partialEvents);
            const cachePath = getCompletenessCachePath(timelinePath);

            const result = validateTimelineCompletenessWithCache(timelinePath, 'T-PART', false);
            assert.equal(result.status, 'INCOMPLETE');
            assert.ok(result.events_missing.includes('COMPLETION_GATE_PASSED'));

            // Cache should reflect incomplete status
            const cached = readCompletenessSummary(cachePath);
            assert.ok(cached);
            assert.equal(cached.status, 'INCOMPLETE');
        });

        it('tolerates corrupted cache file and falls back to full read', () => {
            const timelinePath = writeTimeline(tempDir, 'T-CORRUPT', COMPLETE_NON_CODE_EVENTS);
            const cachePath = getCompletenessCachePath(timelinePath);

            // Write garbage to cache
            fs.mkdirSync(path.dirname(cachePath), { recursive: true });
            fs.writeFileSync(cachePath, '{{{{not json', 'utf8');

            const result = validateTimelineCompletenessWithCache(timelinePath, 'T-CORRUPT', false);
            assert.equal(result.status, 'COMPLETE');
        });

        it('handles task_id mismatch in cache by re-reading', () => {
            const timelinePath = writeTimeline(tempDir, 'T-ID1', COMPLETE_NON_CODE_EVENTS);
            const cachePath = getCompletenessCachePath(timelinePath);

            // Populate cache for T-ID1
            validateTimelineCompletenessWithCache(timelinePath, 'T-ID1', false);
            const cachedBefore = readCompletenessSummary(cachePath);
            assert.ok(cachedBefore);
            assert.equal(cachedBefore.task_id, 'T-ID1');

            // Call with different task_id; should ignore the stale cache and re-read
            const result = validateTimelineCompletenessWithCache(timelinePath, 'T-ID2', false);
            assert.equal(result.task_id, 'T-ID2');

            // Cache should now be updated to T-ID2
            const cachedAfter = readCompletenessSummary(cachePath);
            assert.ok(cachedAfter);
            assert.equal(cachedAfter.task_id, 'T-ID2');
        });

        it('invalidates cache on mtime-only change (same file size)', () => {
            const timelinePath = writeTimeline(tempDir, 'T-MTIME', COMPLETE_NON_CODE_EVENTS);
            const cachePath = getCompletenessCachePath(timelinePath);

            // Populate cache
            const r1 = validateTimelineCompletenessWithCache(timelinePath, 'T-MTIME', false);
            assert.equal(r1.status, 'COMPLETE');
            const cachedBefore = readCompletenessSummary(cachePath);
            assert.ok(cachedBefore);
            const origMtime = cachedBefore.timeline_mtime_ms;

            // Touch the file with a different mtime but same content (same size)
            const futureTime = new Date(Date.now() + 60000);
            fs.utimesSync(timelinePath, futureTime, futureTime);

            // Verify the cache recognizes staleness
            const stat = fs.statSync(timelinePath);
            const newMtime = Math.floor(stat.mtimeMs);
            assert.notEqual(newMtime, origMtime);
            assert.equal(
                isCompletenessSummaryCurrent(cachedBefore, timelinePath, false),
                false
            );

            // Re-validate with cache; should fall back to full read and update cache
            const r2 = validateTimelineCompletenessWithCache(timelinePath, 'T-MTIME', false);
            assert.equal(r2.status, 'COMPLETE');
            const cachedAfter = readCompletenessSummary(cachePath);
            assert.ok(cachedAfter);
            assert.equal(cachedAfter.timeline_mtime_ms, newMtime);
        });

        it('proves cache hit skips full re-read by verifying cache file is not rewritten', () => {
            const timelinePath = writeTimeline(tempDir, 'T-PROOF', COMPLETE_NON_CODE_EVENTS);
            const cachePath = getCompletenessCachePath(timelinePath);

            // First call: populates cache
            validateTimelineCompletenessWithCache(timelinePath, 'T-PROOF', false);
            assert.ok(fs.existsSync(cachePath));
            const cacheMtimeBefore = fs.statSync(cachePath).mtimeMs;

            // Wait a small amount to ensure mtime resolution can differ
            const start = Date.now();
            while (Date.now() - start < 50) { /* busy wait */ }

            // Second call: cache hit — cache file should NOT be rewritten
            const r2 = validateTimelineCompletenessWithCache(timelinePath, 'T-PROOF', false);
            assert.equal(r2.status, 'COMPLETE');
            const cacheMtimeAfter = fs.statSync(cachePath).mtimeMs;
            assert.equal(cacheMtimeAfter, cacheMtimeBefore, 'Cache file should not be rewritten on cache hit');
        });

        it('readOnly=true does not write a cache file on cache miss', () => {
            const timelinePath = writeTimeline(tempDir, 'T-RO', COMPLETE_NON_CODE_EVENTS);
            const cachePath = getCompletenessCachePath(timelinePath);

            const result = validateTimelineCompletenessWithCache(timelinePath, 'T-RO', false, true);
            assert.equal(result.status, 'COMPLETE');
            assert.ok(!fs.existsSync(cachePath), 'Cache file must not be created in readOnly mode');
        });

        it('readOnly=true still uses existing cache for reads', () => {
            const timelinePath = writeTimeline(tempDir, 'T-RO2', COMPLETE_NON_CODE_EVENTS);
            const cachePath = getCompletenessCachePath(timelinePath);

            // First call with readOnly=false populates the cache
            validateTimelineCompletenessWithCache(timelinePath, 'T-RO2', false, false);
            assert.ok(fs.existsSync(cachePath));

            // Second call with readOnly=true should still return correct result from cache
            const r2 = validateTimelineCompletenessWithCache(timelinePath, 'T-RO2', false, true);
            assert.equal(r2.status, 'COMPLETE');
        });

        it('rejects cached summaries from the previous lifecycle contract version', () => {
            const timelinePath = writeTimeline(tempDir, 'T-OLD', COMPLETE_NON_CODE_EVENTS);
            const cachePath = getCompletenessCachePath(timelinePath);
            const stat = fs.statSync(timelinePath);
            fs.writeFileSync(cachePath, JSON.stringify({
                cache_version: 1,
                task_id: 'T-OLD',
                timeline_size_bytes: stat.size,
                timeline_mtime_ms: Math.floor(stat.mtimeMs),
                code_changed: false,
                status: 'COMPLETE',
                events_found: ['TASK_MODE_ENTERED'],
                events_missing: [],
                violations: []
            }, null, 2), 'utf8');

            const result = validateTimelineCompletenessWithCache(timelinePath, 'T-OLD', false);
            assert.equal(result.status, 'COMPLETE');
            const refreshed = readCompletenessSummary(cachePath);
            assert.ok(refreshed);
            assert.equal(refreshed.cache_version, CACHE_VERSION);
            assert.ok(refreshed.events_found.includes('PREFLIGHT_CLASSIFIED'));
            assert.ok(refreshed.events_found.includes('IMPLEMENTATION_STARTED'));
        });
    });
});

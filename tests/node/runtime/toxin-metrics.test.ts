import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    TOXIN_METRIC_TYPES,
    DEFAULT_METRICS_MAX_LINES,
    collectDiskArtifactSummaries,
    countStaleLocks,
    collectNoisyArtifacts,
    estimateGateEventCount,
    countCleanupCandidates,
    collectToxinSnapshot,
    recordToxinMetricsSnapshot,
    buildToxinStatusSummary,
    formatToxinSummaryLines,
    pruneMetricsFile,
    snapshotToMetricEntries,
    appendToxinMetrics,
    countFileLinesStreaming,
    type ToxinSnapshot,
    type ToxinMetricEntry
} from '../../../src/runtime/toxin-metrics';

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-toxin-test-'));
}

function makeRuntimeDir(tmpDir: string): string {
    const runtimeRoot = path.join(tmpDir, 'runtime');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    return runtimeRoot;
}

// ── Constants & Exports ──────────────────────────────────────────────

test('TOXIN_METRIC_TYPES exposes exactly five metric types', () => {
    assert.equal(TOXIN_METRIC_TYPES.length, 5);
    assert.ok(TOXIN_METRIC_TYPES.includes('disk_artifact_growth'));
    assert.ok(TOXIN_METRIC_TYPES.includes('stale_locks'));
    assert.ok(TOXIN_METRIC_TYPES.includes('cleanup_candidates'));
    assert.ok(TOXIN_METRIC_TYPES.includes('gate_overhead'));
    assert.ok(TOXIN_METRIC_TYPES.includes('noisy_outputs'));
});

test('TOXIN_METRIC_TYPES is frozen', () => {
    assert.ok(Object.isFrozen(TOXIN_METRIC_TYPES));
});

test('DEFAULT_METRICS_MAX_LINES is a positive number', () => {
    assert.equal(typeof DEFAULT_METRICS_MAX_LINES, 'number');
    assert.ok(DEFAULT_METRICS_MAX_LINES > 0);
});

// ── collectDiskArtifactSummaries ─────────────────────────────────────

test('collectDiskArtifactSummaries returns empty array for empty runtime', () => {
    const tmpDir = makeTmpDir();
    try {
        const runtimeRoot = makeRuntimeDir(tmpDir);
        const result = collectDiskArtifactSummaries(runtimeRoot);
        assert.ok(Array.isArray(result));
        assert.equal(result.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('collectDiskArtifactSummaries counts files and bytes in known subdirs', () => {
    const tmpDir = makeTmpDir();
    try {
        const runtimeRoot = makeRuntimeDir(tmpDir);
        const reviewsDir = path.join(runtimeRoot, 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(path.join(reviewsDir, 'test.json'), '{"ok":true}', 'utf8');
        fs.writeFileSync(path.join(reviewsDir, 'other.json'), '{"data":"value"}', 'utf8');

        const result = collectDiskArtifactSummaries(runtimeRoot);
        assert.equal(result.length, 1);
        assert.equal(result[0].directory, 'reviews');
        assert.equal(result[0].file_count, 2);
        assert.ok(result[0].total_bytes > 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('collectDiskArtifactSummaries ignores non-standard subdirs', () => {
    const tmpDir = makeTmpDir();
    try {
        const runtimeRoot = makeRuntimeDir(tmpDir);
        fs.mkdirSync(path.join(runtimeRoot, 'custom-dir'), { recursive: true });
        fs.writeFileSync(path.join(runtimeRoot, 'custom-dir', 'data.txt'), 'hello', 'utf8');

        const result = collectDiskArtifactSummaries(runtimeRoot);
        assert.equal(result.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── countStaleLocks ──────────────────────────────────────────────────

test('countStaleLocks returns 0 when no locks exist', () => {
    const tmpDir = makeTmpDir();
    try {
        const runtimeRoot = makeRuntimeDir(tmpDir);
        fs.mkdirSync(path.join(runtimeRoot, 'task-events'), { recursive: true });
        // countStaleLocks delegates to scanTaskEventLocks which needs an orchestrator root
        // Pass the tmpDir as orchestrator root (it has runtime/task-events)
        fs.writeFileSync(path.join(tmpDir, 'MANIFEST.md'), '# Manifest', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0', 'utf8');
        assert.equal(countStaleLocks(tmpDir), 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('countStaleLocks returns 0 for missing task-events dir', () => {
    const tmpDir = makeTmpDir();
    try {
        makeRuntimeDir(tmpDir);
        fs.writeFileSync(path.join(tmpDir, 'MANIFEST.md'), '# Manifest', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0', 'utf8');
        assert.equal(countStaleLocks(tmpDir), 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── collectNoisyArtifacts ────────────────────────────────────────────

test('collectNoisyArtifacts returns zeros when no oversized artifacts', () => {
    const tmpDir = makeTmpDir();
    try {
        const runtimeRoot = makeRuntimeDir(tmpDir);
        const reviewsDir = path.join(runtimeRoot, 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(path.join(reviewsDir, 'small.json'), '{}', 'utf8');

        const result = collectNoisyArtifacts(runtimeRoot);
        assert.equal(result.count, 0);
        assert.equal(result.bytes, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('collectNoisyArtifacts detects oversized files', () => {
    const tmpDir = makeTmpDir();
    try {
        const runtimeRoot = makeRuntimeDir(tmpDir);
        const reviewsDir = path.join(runtimeRoot, 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        // Create a file larger than 512KB
        const bigContent = 'x'.repeat(600 * 1024);
        fs.writeFileSync(path.join(reviewsDir, 'big.json'), bigContent, 'utf8');
        fs.writeFileSync(path.join(reviewsDir, 'small.json'), '{}', 'utf8');

        const result = collectNoisyArtifacts(runtimeRoot);
        assert.equal(result.count, 1);
        assert.ok(result.bytes >= 600 * 1024);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('collectNoisyArtifacts returns zeros for missing reviews dir', () => {
    const tmpDir = makeTmpDir();
    try {
        const runtimeRoot = makeRuntimeDir(tmpDir);
        const result = collectNoisyArtifacts(runtimeRoot);
        assert.equal(result.count, 0);
        assert.equal(result.bytes, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── estimateGateEventCount ────────────────────────────────────────────

test('estimateGateEventCount returns 0 for empty task-events', () => {
    const tmpDir = makeTmpDir();
    try {
        const runtimeRoot = makeRuntimeDir(tmpDir);
        fs.mkdirSync(path.join(runtimeRoot, 'task-events'), { recursive: true });
        assert.equal(estimateGateEventCount(runtimeRoot), 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('estimateGateEventCount estimates line count from file size', () => {
    const tmpDir = makeTmpDir();
    try {
        const runtimeRoot = makeRuntimeDir(tmpDir);
        const eventsDir = path.join(runtimeRoot, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        // Write content large enough for estimation
        const event = JSON.stringify({ timestamp_utc: '2026-01-01T00:00:00Z', task_id: 'T-001', event_type: 'TEST', outcome: 'PASS', actor: 'gate', message: 'test event', details: {} });
        fs.writeFileSync(path.join(eventsDir, 'T-001.jsonl'), event + '\n' + event + '\n', 'utf8');
        fs.writeFileSync(path.join(eventsDir, 'all-tasks.jsonl'), event + '\n', 'utf8');

        const result = estimateGateEventCount(runtimeRoot);
        assert.ok(result >= 1); // Estimation is approximate
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── countCleanupCandidates ───────────────────────────────────────────

test('countCleanupCandidates returns zeros when no old items', () => {
    const tmpDir = makeTmpDir();
    try {
        const runtimeRoot = makeRuntimeDir(tmpDir);
        const backupsDir = path.join(runtimeRoot, 'backups');
        fs.mkdirSync(backupsDir, { recursive: true });
        fs.writeFileSync(path.join(backupsDir, 'recent.json'), '{}', 'utf8');

        const result = countCleanupCandidates(runtimeRoot, 30);
        assert.equal(result.count, 0);
        assert.equal(result.bytes, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('countCleanupCandidates detects old items beyond max age', () => {
    const tmpDir = makeTmpDir();
    try {
        const runtimeRoot = makeRuntimeDir(tmpDir);
        const backupsDir = path.join(runtimeRoot, 'backups');
        fs.mkdirSync(backupsDir, { recursive: true });
        const filePath = path.join(backupsDir, 'old.json');
        fs.writeFileSync(filePath, '{"old":true}', 'utf8');
        // Set mtime to 60 days ago
        const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        fs.utimesSync(filePath, oldTime, oldTime);

        const result = countCleanupCandidates(runtimeRoot, 30);
        assert.equal(result.count, 1);
        assert.ok(result.bytes > 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── collectToxinSnapshot ─────────────────────────────────────────────

test('collectToxinSnapshot returns all fields for a minimal repo', () => {
    const tmpDir = makeTmpDir();
    try {
        // Create a minimal bundle structure
        fs.writeFileSync(path.join(tmpDir, 'MANIFEST.md'), '# Manifest', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0', 'utf8');
        const runtimeRoot = path.join(tmpDir, 'runtime');
        fs.mkdirSync(runtimeRoot, { recursive: true });

        const snapshot = collectToxinSnapshot(tmpDir);

        assert.ok(snapshot.timestamp_utc);
        assert.ok(Array.isArray(snapshot.runtime_disk));
        assert.equal(typeof snapshot.runtime_total_bytes, 'number');
        assert.equal(typeof snapshot.stale_lock_count, 'number');
        assert.equal(typeof snapshot.cleanup_candidate_count, 'number');
        assert.equal(typeof snapshot.cleanup_candidate_bytes, 'number');
        assert.equal(typeof snapshot.noisy_artifact_count, 'number');
        assert.equal(typeof snapshot.noisy_artifact_bytes, 'number');
        assert.equal(typeof snapshot.gate_event_count, 'number');
        assert.equal(typeof snapshot.metrics_file_lines, 'number');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('collectToxinSnapshot respects explicit legacy bundle root and metrics path', () => {
    const tmpDir = makeTmpDir();
    try {
        const legacyBundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        const legacyRuntimeRoot = path.join(legacyBundleRoot, 'runtime');
        fs.mkdirSync(path.join(legacyBundleRoot, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(legacyRuntimeRoot, 'reviews'), { recursive: true });
        fs.writeFileSync(path.join(legacyBundleRoot, 'MANIFEST.md'), '# Manifest', 'utf8');
        fs.writeFileSync(path.join(legacyBundleRoot, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(legacyBundleRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');
        fs.writeFileSync(path.join(legacyBundleRoot, 'bin', 'garda.js'), '', 'utf8');
        fs.writeFileSync(path.join(legacyRuntimeRoot, 'reviews', 'big.json'), 'x'.repeat(600 * 1024), 'utf8');
        const legacyMetricsPath = path.join(legacyRuntimeRoot, 'metrics.jsonl');
        const rootMetricsPath = path.join(tmpDir, 'runtime', 'metrics.jsonl');
        fs.mkdirSync(path.dirname(rootMetricsPath), { recursive: true });
        fs.writeFileSync(legacyMetricsPath, '{"legacy":1}\n{"legacy":2}\n', 'utf8');
        fs.writeFileSync(rootMetricsPath, '{"root":1}\n', 'utf8');

        const snapshot = collectToxinSnapshot(tmpDir, {
            bundleRoot: legacyBundleRoot,
            metricsPath: legacyMetricsPath
        });

        assert.equal(snapshot.noisy_artifact_count, 1);
        assert.equal(snapshot.metrics_file_lines, 2);
        assert.ok(snapshot.runtime_total_bytes >= 600 * 1024);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('collectToxinSnapshot fast path preserves helper semantics across mixed runtime tree', () => {
    const tmpDir = makeTmpDir();
    try {
        fs.writeFileSync(path.join(tmpDir, 'MANIFEST.md'), '# Manifest', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0', 'utf8');
        const runtimeRoot = makeRuntimeDir(tmpDir);

        const reviewsDir = path.join(runtimeRoot, 'reviews');
        fs.mkdirSync(path.join(reviewsDir, 'nested'), { recursive: true });
        fs.writeFileSync(path.join(reviewsDir, 'top-big.json'), 'x'.repeat(600 * 1024), 'utf8');
        fs.writeFileSync(path.join(reviewsDir, 'nested', 'deep-big.json'), 'y'.repeat(600 * 1024), 'utf8');

        const eventsDir = path.join(runtimeRoot, 'task-events');
        fs.mkdirSync(path.join(eventsDir, 'nested'), { recursive: true });
        const event = JSON.stringify({
            timestamp_utc: '2026-01-01T00:00:00Z',
            task_id: 'T-001',
            event_type: 'TEST',
            outcome: 'PASS',
            actor: 'gate',
            message: 'test event',
            details: { padding: 'z'.repeat(500) }
        });
        fs.writeFileSync(path.join(eventsDir, 'T-001.jsonl'), `${event}\n${event}\n`, 'utf8');
        fs.writeFileSync(path.join(eventsDir, 'nested', 'T-999.jsonl'), `${event}\n${event}\n`, 'utf8');
        fs.writeFileSync(path.join(eventsDir, 'all-tasks.jsonl'), `${event}\n`, 'utf8');

        const backupsDir = path.join(runtimeRoot, 'backups');
        fs.mkdirSync(path.join(backupsDir, 'old-backup', 'nested'), { recursive: true });
        fs.writeFileSync(path.join(backupsDir, 'old-backup', 'nested', 'data.bin'), 'backup-data', 'utf8');
        const oldBackupTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        fs.utimesSync(path.join(backupsDir, 'old-backup'), oldBackupTime, oldBackupTime);

        const reportsDir = path.join(runtimeRoot, 'update-reports');
        fs.mkdirSync(reportsDir, { recursive: true });
        const oldReportPath = path.join(reportsDir, 'old-report.md');
        fs.writeFileSync(oldReportPath, '# old report', 'utf8');
        fs.utimesSync(oldReportPath, oldBackupTime, oldBackupTime);

        const snapshot = collectToxinSnapshot(tmpDir);
        const expectedDisk = collectDiskArtifactSummaries(runtimeRoot);
        const expectedNoisy = collectNoisyArtifacts(runtimeRoot);
        const expectedGateEvents = estimateGateEventCount(runtimeRoot);
        const expectedCleanup = countCleanupCandidates(runtimeRoot, 30);

        assert.deepEqual(snapshot.runtime_disk, expectedDisk);
        assert.equal(snapshot.runtime_total_bytes, expectedDisk.reduce((sum, item) => sum + item.total_bytes, 0));
        assert.equal(snapshot.noisy_artifact_count, expectedNoisy.count);
        assert.equal(snapshot.noisy_artifact_bytes, expectedNoisy.bytes);
        assert.equal(snapshot.gate_event_count, expectedGateEvents);
        assert.equal(snapshot.cleanup_candidate_count, expectedCleanup.count);
        assert.equal(snapshot.cleanup_candidate_bytes, expectedCleanup.bytes);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('recordToxinMetricsSnapshot appends toxin entries and prunes metrics file', () => {
    const tmpDir = makeTmpDir();
    try {
        fs.writeFileSync(path.join(tmpDir, 'MANIFEST.md'), '# Manifest', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'bin', 'garda.js'), '', 'utf8');
        const runtimeRoot = path.join(tmpDir, 'runtime');
        fs.mkdirSync(path.join(runtimeRoot, 'reviews'), { recursive: true });
        fs.writeFileSync(path.join(runtimeRoot, 'reviews', 'big.json'), 'x'.repeat(600 * 1024), 'utf8');
        const metricsPath = path.join(runtimeRoot, 'metrics.jsonl');
        fs.writeFileSync(metricsPath, '{"existing":1}\n{"existing":2}\n', 'utf8');

        const snapshot = recordToxinMetricsSnapshot(tmpDir, { maxLines: 6 });
        const lines = fs.readFileSync(metricsPath, 'utf8').split('\n').filter(Boolean);
        const parsedLines = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

        assert.equal(snapshot.noisy_artifact_count, 1);
        assert.equal(lines.length, 6);
        assert.ok(parsedLines.some((entry) => entry.metric_type === 'disk_artifact_growth'));
        assert.ok(parsedLines.some((entry) => entry.metric_type === 'noisy_outputs'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── buildToxinStatusSummary ──────────────────────────────────────────

test('buildToxinStatusSummary returns clean summary for healthy snapshot', () => {
    const snapshot: ToxinSnapshot = {
        timestamp_utc: new Date().toISOString(),
        runtime_disk: [{ directory: 'reviews', file_count: 5, total_bytes: 4096 }],
        runtime_total_bytes: 4096,
        stale_lock_count: 0,
        cleanup_candidate_count: 0,
        cleanup_candidate_bytes: 0,
        noisy_artifact_count: 0,
        noisy_artifact_bytes: 0,
        gate_event_count: 10,
        metrics_file_lines: 50
    };

    const summary = buildToxinStatusSummary(snapshot);
    assert.equal(summary.warnings.length, 0);
    assert.equal(summary.stale_lock_count, 0);
    assert.equal(summary.cleanup_candidate_count, 0);
    assert.equal(summary.gate_event_count, 10);
    assert.ok(summary.runtime_total_label.includes('KB') || summary.runtime_total_label.includes('B'));
});

test('buildToxinStatusSummary emits warnings for stale locks', () => {
    const snapshot: ToxinSnapshot = {
        timestamp_utc: new Date().toISOString(),
        runtime_disk: [],
        runtime_total_bytes: 0,
        stale_lock_count: 3,
        cleanup_candidate_count: 0,
        cleanup_candidate_bytes: 0,
        noisy_artifact_count: 0,
        noisy_artifact_bytes: 0,
        gate_event_count: 0,
        metrics_file_lines: 0
    };

    const summary = buildToxinStatusSummary(snapshot);
    assert.ok(summary.warnings.length > 0);
    assert.ok(summary.warnings.some(w => w.includes('stale lock')));
});

test('buildToxinStatusSummary emits warnings for cleanup candidates', () => {
    const snapshot: ToxinSnapshot = {
        timestamp_utc: new Date().toISOString(),
        runtime_disk: [],
        runtime_total_bytes: 0,
        stale_lock_count: 0,
        cleanup_candidate_count: 5,
        cleanup_candidate_bytes: 1024 * 1024,
        noisy_artifact_count: 0,
        noisy_artifact_bytes: 0,
        gate_event_count: 0,
        metrics_file_lines: 0
    };

    const summary = buildToxinStatusSummary(snapshot);
    assert.ok(summary.warnings.some(w => w.includes('cleanup candidate')));
});

test('buildToxinStatusSummary emits warnings for noisy artifacts', () => {
    const snapshot: ToxinSnapshot = {
        timestamp_utc: new Date().toISOString(),
        runtime_disk: [],
        runtime_total_bytes: 0,
        stale_lock_count: 0,
        cleanup_candidate_count: 0,
        cleanup_candidate_bytes: 0,
        noisy_artifact_count: 2,
        noisy_artifact_bytes: 2 * 1024 * 1024,
        gate_event_count: 0,
        metrics_file_lines: 0
    };

    const summary = buildToxinStatusSummary(snapshot);
    assert.ok(summary.warnings.some(w => w.includes('oversized artifact')));
});

test('buildToxinStatusSummary emits warnings when metrics file exceeds limit', () => {
    const snapshot: ToxinSnapshot = {
        timestamp_utc: new Date().toISOString(),
        runtime_disk: [],
        runtime_total_bytes: 0,
        stale_lock_count: 0,
        cleanup_candidate_count: 0,
        cleanup_candidate_bytes: 0,
        noisy_artifact_count: 0,
        noisy_artifact_bytes: 0,
        gate_event_count: 0,
        metrics_file_lines: DEFAULT_METRICS_MAX_LINES + 100
    };

    const summary = buildToxinStatusSummary(snapshot);
    assert.ok(summary.warnings.some(w => w.includes('metrics.jsonl')));
});

// ── formatToxinSummaryLines ──────────────────────────────────────────

test('formatToxinSummaryLines produces expected structure', () => {
    const snapshot: ToxinSnapshot = {
        timestamp_utc: new Date().toISOString(),
        runtime_disk: [{ directory: 'reviews', file_count: 3, total_bytes: 2048 }],
        runtime_total_bytes: 2048,
        stale_lock_count: 1,
        cleanup_candidate_count: 0,
        cleanup_candidate_bytes: 0,
        noisy_artifact_count: 0,
        noisy_artifact_bytes: 0,
        gate_event_count: 5,
        metrics_file_lines: 20
    };

    const summary = buildToxinStatusSummary(snapshot);
    const lines = formatToxinSummaryLines(summary);

    assert.ok(lines.length >= 3);
    assert.ok(lines[0].startsWith('RuntimeDisk:'));
    assert.ok(lines[1].includes('GateEvents: ~'));
    assert.ok(lines[1].includes('StaleLocks:'));
    assert.ok(lines[2].includes('MetricsLines:'));
    assert.ok(summary.warnings.some((warning) => warning.includes('run garda gc to preview')));
});

// ── pruneMetricsFile ─────────────────────────────────────────────────

test('pruneMetricsFile returns pruned=false for missing file', () => {
    const result = pruneMetricsFile('/nonexistent/path/metrics.jsonl', 100);
    assert.equal(result.pruned, false);
    assert.equal(result.linesBefore, 0);
});

test('pruneMetricsFile does nothing when under limit', () => {
    const tmpDir = makeTmpDir();
    try {
        const metricsPath = path.join(tmpDir, 'metrics.jsonl');
        fs.writeFileSync(metricsPath, '{"a":1}\n{"b":2}\n{"c":3}\n', 'utf8');

        const result = pruneMetricsFile(metricsPath, 10);
        assert.equal(result.pruned, false);
        assert.equal(result.linesBefore, 3);
        assert.equal(result.linesAfter, 3);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('pruneMetricsFile keeps only last N lines when over limit', () => {
    const tmpDir = makeTmpDir();
    try {
        const metricsPath = path.join(tmpDir, 'metrics.jsonl');
        const lines = Array.from({ length: 20 }, (_, i) => JSON.stringify({ index: i }));
        fs.writeFileSync(metricsPath, lines.join('\n') + '\n', 'utf8');

        const result = pruneMetricsFile(metricsPath, 5);
        assert.equal(result.pruned, true);
        assert.equal(result.linesBefore, 20);
        assert.equal(result.linesAfter, 5);

        const remaining = fs.readFileSync(metricsPath, 'utf8').split('\n').filter(Boolean);
        assert.equal(remaining.length, 5);
        const firstKept = JSON.parse(remaining[0]);
        assert.equal(firstKept.index, 15);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── snapshotToMetricEntries ──────────────────────────────────────────

test('snapshotToMetricEntries produces one entry per metric type', () => {
    const snapshot: ToxinSnapshot = {
        timestamp_utc: '2026-01-01T00:00:00.000Z',
        runtime_disk: [],
        runtime_total_bytes: 1024,
        stale_lock_count: 2,
        cleanup_candidate_count: 1,
        cleanup_candidate_bytes: 512,
        noisy_artifact_count: 3,
        noisy_artifact_bytes: 768,
        gate_event_count: 10,
        metrics_file_lines: 50
    };

    const entries = snapshotToMetricEntries(snapshot);
    assert.equal(entries.length, 5);
    const types = entries.map(e => e.metric_type).sort();
    assert.deepEqual(types, [
        'cleanup_candidates',
        'disk_artifact_growth',
        'gate_overhead',
        'noisy_outputs',
        'stale_locks'
    ]);

    for (const entry of entries) {
        assert.equal(entry.timestamp_utc, '2026-01-01T00:00:00.000Z');
        assert.ok(typeof entry.value === 'number');
        assert.ok(typeof entry.unit === 'string');
        assert.ok(typeof entry.metadata === 'object');
    }
});

// ── appendToxinMetrics ───────────────────────────────────────────────

test('appendToxinMetrics writes JSONL entries to file', () => {
    const tmpDir = makeTmpDir();
    try {
        const metricsPath = path.join(tmpDir, 'metrics.jsonl');
        const entries: ToxinMetricEntry[] = [
            { timestamp_utc: '2026-01-01T00:00:00Z', metric_type: 'stale_locks', value: 2, unit: 'count', metadata: {} },
            { timestamp_utc: '2026-01-01T00:00:00Z', metric_type: 'gate_overhead', value: 10, unit: 'events', metadata: {} }
        ];

        appendToxinMetrics(metricsPath, entries);

        const content = fs.readFileSync(metricsPath, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        assert.equal(lines.length, 2);
        const parsed0 = JSON.parse(lines[0]);
        assert.equal(parsed0.metric_type, 'stale_locks');
        assert.equal(parsed0.value, 2);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('appendToxinMetrics creates parent directories', () => {
    const tmpDir = makeTmpDir();
    try {
        const metricsPath = path.join(tmpDir, 'nested', 'dir', 'metrics.jsonl');
        const entries: ToxinMetricEntry[] = [
            { timestamp_utc: '2026-01-01T00:00:00Z', metric_type: 'stale_locks', value: 0, unit: 'count', metadata: {} }
        ];

        appendToxinMetrics(metricsPath, entries);
        assert.ok(fs.existsSync(metricsPath));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('appendToxinMetrics is a no-op for empty entries', () => {
    const tmpDir = makeTmpDir();
    try {
        const metricsPath = path.join(tmpDir, 'metrics.jsonl');
        appendToxinMetrics(metricsPath, []);
        assert.ok(!fs.existsSync(metricsPath));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── Additional coverage: append semantics ────────────────────────────

test('appendToxinMetrics appends to existing file without overwriting', () => {
    const tmpDir = makeTmpDir();
    try {
        const metricsPath = path.join(tmpDir, 'metrics.jsonl');
        fs.writeFileSync(metricsPath, '{"existing":"line"}\n', 'utf8');

        const entries: ToxinMetricEntry[] = [
            { timestamp_utc: '2026-01-01T00:00:00Z', metric_type: 'stale_locks', value: 1, unit: 'count', metadata: {} }
        ];
        appendToxinMetrics(metricsPath, entries);

        const lines = fs.readFileSync(metricsPath, 'utf8').split('\n').filter(Boolean);
        assert.equal(lines.length, 2);
        assert.deepEqual(JSON.parse(lines[0]), { existing: 'line' });
        assert.equal(JSON.parse(lines[1]).metric_type, 'stale_locks');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── Additional coverage: snapshotToMetricEntries value mapping ───────

test('snapshotToMetricEntries maps values correctly per metric type', () => {
    const snapshot: ToxinSnapshot = {
        timestamp_utc: '2026-06-01T12:00:00.000Z',
        runtime_disk: [{ directory: 'reviews', file_count: 3, total_bytes: 2048 }],
        runtime_total_bytes: 2048,
        stale_lock_count: 4,
        cleanup_candidate_count: 7,
        cleanup_candidate_bytes: 999,
        noisy_artifact_count: 2,
        noisy_artifact_bytes: 1500,
        gate_event_count: 33,
        metrics_file_lines: 100
    };

    const entries = snapshotToMetricEntries(snapshot);
    const byType = Object.fromEntries(entries.map(e => [e.metric_type, e]));

    assert.equal(byType['disk_artifact_growth'].value, 2048);
    assert.equal(byType['disk_artifact_growth'].unit, 'bytes');
    assert.ok(Array.isArray((byType['disk_artifact_growth'].metadata as Record<string, unknown>).directories));

    assert.equal(byType['stale_locks'].value, 4);
    assert.equal(byType['stale_locks'].unit, 'count');

    assert.equal(byType['cleanup_candidates'].value, 7);
    assert.equal((byType['cleanup_candidates'].metadata as Record<string, unknown>).total_bytes, 999);

    assert.equal(byType['gate_overhead'].value, 33);
    assert.equal(byType['gate_overhead'].unit, 'events');

    assert.equal(byType['noisy_outputs'].value, 2);
    assert.equal((byType['noisy_outputs'].metadata as Record<string, unknown>).total_bytes, 1500);
});

// ── Additional coverage: estimateGateEventCount missing dir ──────────

test('estimateGateEventCount returns 0 for missing task-events dir', () => {
    const tmpDir = makeTmpDir();
    try {
        const runtimeRoot = makeRuntimeDir(tmpDir);
        // No task-events dir created
        assert.equal(estimateGateEventCount(runtimeRoot), 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── Additional coverage: pruneMetricsFile on empty file ──────────────

test('pruneMetricsFile handles empty file gracefully', () => {
    const tmpDir = makeTmpDir();
    try {
        const metricsPath = path.join(tmpDir, 'metrics.jsonl');
        fs.writeFileSync(metricsPath, '', 'utf8');

        const result = pruneMetricsFile(metricsPath, 100);
        assert.equal(result.pruned, false);
        assert.equal(result.linesBefore, 0);
        assert.equal(result.linesAfter, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── Additional coverage: pruneMetricsFile at exact boundary ──────────

test('pruneMetricsFile does not prune when exactly at limit', () => {
    const tmpDir = makeTmpDir();
    try {
        const metricsPath = path.join(tmpDir, 'metrics.jsonl');
        const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({ i }));
        fs.writeFileSync(metricsPath, lines.join('\n') + '\n', 'utf8');

        const result = pruneMetricsFile(metricsPath, 5);
        assert.equal(result.pruned, false);
        assert.equal(result.linesBefore, 5);
        assert.equal(result.linesAfter, 5);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── countFileLinesStreaming ───────────────────────────────────────────

test('countFileLinesStreaming returns 0 for non-existent file', () => {
    assert.equal(countFileLinesStreaming('/nonexistent/path/metrics.jsonl'), 0);
});

test('countFileLinesStreaming returns 0 for empty file', () => {
    const tmpDir = makeTmpDir();
    try {
        const filePath = path.join(tmpDir, 'empty.jsonl');
        fs.writeFileSync(filePath, '', 'utf8');
        assert.equal(countFileLinesStreaming(filePath), 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('countFileLinesStreaming counts non-empty lines with trailing newline', () => {
    const tmpDir = makeTmpDir();
    try {
        const filePath = path.join(tmpDir, 'data.jsonl');
        fs.writeFileSync(filePath, '{"a":1}\n{"b":2}\n{"c":3}\n', 'utf8');
        assert.equal(countFileLinesStreaming(filePath), 3);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('countFileLinesStreaming counts lines without trailing newline', () => {
    const tmpDir = makeTmpDir();
    try {
        const filePath = path.join(tmpDir, 'data.jsonl');
        fs.writeFileSync(filePath, '{"a":1}\n{"b":2}\n{"c":3}', 'utf8');
        assert.equal(countFileLinesStreaming(filePath), 3);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('countFileLinesStreaming skips blank lines', () => {
    const tmpDir = makeTmpDir();
    try {
        const filePath = path.join(tmpDir, 'data.jsonl');
        fs.writeFileSync(filePath, '{"a":1}\n\n{"b":2}\n\n\n{"c":3}\n', 'utf8');
        assert.equal(countFileLinesStreaming(filePath), 3);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('countFileLinesStreaming handles single line', () => {
    const tmpDir = makeTmpDir();
    try {
        const filePath = path.join(tmpDir, 'data.jsonl');
        fs.writeFileSync(filePath, '{"a":1}\n', 'utf8');
        assert.equal(countFileLinesStreaming(filePath), 1);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('countFileLinesStreaming handles large file spanning multiple chunks', () => {
    const tmpDir = makeTmpDir();
    try {
        const filePath = path.join(tmpDir, 'big.jsonl');
        const lineCount = 500;
        const lines = Array.from({ length: lineCount }, (_, i) =>
            JSON.stringify({ index: i, padding: 'x'.repeat(200) })
        );
        fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
        assert.equal(countFileLinesStreaming(filePath), lineCount);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('countFileLinesStreaming returns 0 for directory path', () => {
    const tmpDir = makeTmpDir();
    try {
        assert.equal(countFileLinesStreaming(tmpDir), 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── pruneMetricsFile with knownLineCount ─────────────────────────────

test('pruneMetricsFile skips re-count when knownLineCount is under limit', () => {
    const tmpDir = makeTmpDir();
    try {
        const metricsPath = path.join(tmpDir, 'metrics.jsonl');
        const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({ i }));
        fs.writeFileSync(metricsPath, lines.join('\n') + '\n', 'utf8');

        const result = pruneMetricsFile(metricsPath, 10, 5);
        assert.equal(result.pruned, false);
        assert.equal(result.linesBefore, 5);
        assert.equal(result.linesAfter, 5);
        const remaining = fs.readFileSync(metricsPath, 'utf8').split('\n').filter(Boolean);
        assert.equal(remaining.length, 5);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('pruneMetricsFile prunes correctly when knownLineCount is over limit', () => {
    const tmpDir = makeTmpDir();
    try {
        const metricsPath = path.join(tmpDir, 'metrics.jsonl');
        const lines = Array.from({ length: 20 }, (_, i) => JSON.stringify({ index: i }));
        fs.writeFileSync(metricsPath, lines.join('\n') + '\n', 'utf8');

        const result = pruneMetricsFile(metricsPath, 5, 20);
        assert.equal(result.pruned, true);
        assert.equal(result.linesBefore, 20);
        assert.equal(result.linesAfter, 5);

        const remaining = fs.readFileSync(metricsPath, 'utf8').split('\n').filter(Boolean);
        assert.equal(remaining.length, 5);
        assert.equal(JSON.parse(remaining[0]).index, 15);
        assert.equal(JSON.parse(remaining[4]).index, 19);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('pruneMetricsFile with knownLineCount=0 returns no-op for empty file', () => {
    const tmpDir = makeTmpDir();
    try {
        const metricsPath = path.join(tmpDir, 'metrics.jsonl');
        fs.writeFileSync(metricsPath, '', 'utf8');

        const result = pruneMetricsFile(metricsPath, 100, 0);
        assert.equal(result.pruned, false);
        assert.equal(result.linesBefore, 0);
        assert.equal(result.linesAfter, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('pruneMetricsFile prunes to maxLines=1 correctly', () => {
    const tmpDir = makeTmpDir();
    try {
        const metricsPath = path.join(tmpDir, 'metrics.jsonl');
        const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ index: i }));
        fs.writeFileSync(metricsPath, lines.join('\n') + '\n', 'utf8');

        const result = pruneMetricsFile(metricsPath, 1);
        assert.equal(result.pruned, true);
        assert.equal(result.linesBefore, 10);
        assert.equal(result.linesAfter, 1);

        const remaining = fs.readFileSync(metricsPath, 'utf8').split('\n').filter(Boolean);
        assert.equal(remaining.length, 1);
        assert.equal(JSON.parse(remaining[0]).index, 9);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── recordToxinMetricsSnapshot tracked-count integration ─────────────

test('recordToxinMetricsSnapshot uses tracked count to avoid double read', () => {
    const tmpDir = makeTmpDir();
    try {
        fs.writeFileSync(path.join(tmpDir, 'MANIFEST.md'), '# Manifest', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'bin', 'garda.js'), '', 'utf8');
        const runtimeRoot = path.join(tmpDir, 'runtime');
        fs.mkdirSync(runtimeRoot, { recursive: true });
        const metricsPath = path.join(runtimeRoot, 'metrics.jsonl');

        const existing = Array.from({ length: 3 }, (_, i) => JSON.stringify({ pre: i }));
        fs.writeFileSync(metricsPath, existing.join('\n') + '\n', 'utf8');

        // maxLines=6: 3 existing + 5 appended (8) > 6, so prune to 6
        const snapshot = recordToxinMetricsSnapshot(tmpDir, { maxLines: 6 });

        assert.equal(snapshot.metrics_file_lines, 3);
        const postLines = fs.readFileSync(metricsPath, 'utf8').split('\n').filter(Boolean);
        assert.equal(postLines.length, 6);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('recordToxinMetricsSnapshot does not prune when under limit', () => {
    const tmpDir = makeTmpDir();
    try {
        fs.writeFileSync(path.join(tmpDir, 'MANIFEST.md'), '# Manifest', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'bin', 'garda.js'), '', 'utf8');
        const runtimeRoot = path.join(tmpDir, 'runtime');
        fs.mkdirSync(runtimeRoot, { recursive: true });
        const metricsPath = path.join(runtimeRoot, 'metrics.jsonl');

        const snapshot = recordToxinMetricsSnapshot(tmpDir, { maxLines: 100 });

        assert.equal(snapshot.metrics_file_lines, 0);
        const postLines = fs.readFileSync(metricsPath, 'utf8').split('\n').filter(Boolean);
        assert.equal(postLines.length, 5);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── Streaming prune: large file correctness ──────────────────────────

test('pruneMetricsFile handles large file spanning many chunks', () => {
    const tmpDir = makeTmpDir();
    try {
        const metricsPath = path.join(tmpDir, 'metrics.jsonl');
        const lineCount = 500;
        const lines = Array.from({ length: lineCount }, (_, i) =>
            JSON.stringify({ index: i, padding: 'x'.repeat(200) })
        );
        fs.writeFileSync(metricsPath, lines.join('\n') + '\n', 'utf8');

        const result = pruneMetricsFile(metricsPath, 50);
        assert.equal(result.pruned, true);
        assert.equal(result.linesBefore, lineCount);
        assert.equal(result.linesAfter, 50);

        const remaining = fs.readFileSync(metricsPath, 'utf8').split('\n').filter(Boolean);
        assert.equal(remaining.length, 50);
        assert.equal(JSON.parse(remaining[0]).index, 450);
        assert.equal(JSON.parse(remaining[49]).index, 499);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── Status integration regression ────────────────────────────────────

test('collectToxinSnapshot uses streaming count for metrics_file_lines', () => {
    const tmpDir = makeTmpDir();
    try {
        fs.writeFileSync(path.join(tmpDir, 'MANIFEST.md'), '# Manifest', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0', 'utf8');
        const runtimeRoot = path.join(tmpDir, 'runtime');
        fs.mkdirSync(runtimeRoot, { recursive: true });
        const metricsPath = path.join(runtimeRoot, 'metrics.jsonl');
        const lines = Array.from({ length: 15 }, (_, i) => JSON.stringify({ i }));
        fs.writeFileSync(metricsPath, lines.join('\n') + '\n', 'utf8');

        const snapshot = collectToxinSnapshot(tmpDir, { metricsPath });
        assert.equal(snapshot.metrics_file_lines, 15);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

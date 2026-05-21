import test from 'node:test';
import assert from 'node:assert/strict';

import {
    fs,
    path,
    buildTaskAuditSummary,
    synchronizeFinalCloseoutArtifacts,
    writeEvent,
    writeIntegrityEventSequence,
    writePreflight,
    writeArtifact,
    writeWorkflowConfig,
    makeTempDir
} from '../gates/task-audit-summary-fixtures';
import {
    buildTaskHistoryLedger,
    readTaskHistoryLedgerScanStatus,
    resolveTaskHistoryLedgerPath,
    scanTaskHistoryLedgerRoot
} from '../../../src/gate-runtime/task-history-ledger';
import { writeTimelineSummaryIndex } from '../../../src/gate-runtime/timeline-summary';

function makeWorkspace(taskId: string, options: { fullSuiteEnabled?: boolean } = {}) {
    const repoRoot = makeTempDir();
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const eventsDir = path.join(bundleRoot, 'runtime', 'task-events');
    const reviewsDir = path.join(bundleRoot, 'runtime', 'reviews');
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.mkdirSync(reviewsDir, { recursive: true });
    writeWorkflowConfig(repoRoot, options.fullSuiteEnabled === true);
    return {
        repoRoot,
        bundleRoot,
        eventsDir,
        reviewsDir,
        cleanup() {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    };
}

function writePassingArtifacts(reviewsDir: string, taskId: string, changedFile = 'src/runtime/task-ledger.ts'): void {
    writeArtifact(reviewsDir, taskId, '-task-mode.json', {
        requested_depth: 2,
        effective_depth: 2,
        active_profile: 'balanced'
    });
    writePreflight(reviewsDir, taskId, {
        mode: 'FULL_PATH',
        changed_files: [changedFile],
        metrics: { changed_lines_total: 18 },
        required_reviews: {}
    });
    writeArtifact(reviewsDir, taskId, '-compile-gate.json', {
        status: 'PASSED'
    });
    writeArtifact(reviewsDir, taskId, '-review-gate.json', {
        verdicts: {}
    });
    writeArtifact(reviewsDir, taskId, '-doc-impact.json', {
        decision: 'NO_DOC_UPDATES',
        behavior_changed: false,
        changelog_updated: false,
        docs_updated: []
    });
}

function buildSummary(repoRoot: string, eventsDir: string, reviewsDir: string, taskId: string) {
    return buildTaskAuditSummary({
        taskId,
        repoRoot,
        eventsRoot: eventsDir,
        reviewsRoot: reviewsDir
    });
}

function writeTimelineSummary(eventsDir: string, taskId: string, completenessStatus: 'COMPLETE' | 'INCOMPLETE'): void {
    const timelinePath = path.join(eventsDir, `${taskId}.jsonl`);
    const stat = fs.statSync(timelinePath);
    writeTimelineSummaryIndex(eventsDir, {
        version: 2,
        updated_at_utc: new Date().toISOString(),
        entries: {
            [taskId]: {
                task_id: taskId,
                file_size_bytes: stat.size,
                file_mtime_ms: Math.floor(stat.mtimeMs),
                code_changed: true,
                completeness_status: completenessStatus,
                events_found: [],
                events_missing: [],
                completeness_violations: [],
                integrity_status: 'PASS',
                events_scanned: 1,
                integrity_event_count: 1,
                integrity_violations: [],
                written_at_ms: Date.now()
            }
        }
    });
}

test('synchronizeFinalCloseoutArtifacts materializes a verified task ledger for a clean DONE task', () => {
    const taskId = 'T-LEDGER-DONE';
    const workspace = makeWorkspace(taskId);
    try {
        writeIntegrityEventSequence(workspace.eventsDir, taskId, [
            { event_type: 'TASK_MODE_ENTERED' },
            { event_type: 'RULE_PACK_LOADED' },
            { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
            { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
            { event_type: 'PREFLIGHT_CLASSIFIED' },
            { event_type: 'STATUS_CHANGED', details: { previous_status: 'IN_REVIEW', new_status: 'DONE' } },
            { event_type: 'COMPILE_GATE_PASSED' },
            { event_type: 'REVIEW_PHASE_STARTED' },
            { event_type: 'REVIEW_GATE_PASSED' },
            { event_type: 'DOC_IMPACT_ASSESSED' },
            { event_type: 'COMPLETION_GATE_PASSED' }
        ]);
        writeTimelineSummary(workspace.eventsDir, taskId, 'COMPLETE');
        writePassingArtifacts(workspace.reviewsDir, taskId);

        const summary = buildSummary(workspace.repoRoot, workspace.eventsDir, workspace.reviewsDir, taskId);
        assert.equal(summary.status, 'PASS');

        synchronizeFinalCloseoutArtifacts(summary);

        const ledgerPath = resolveTaskHistoryLedgerPath(workspace.bundleRoot, taskId);
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as Record<string, unknown>;
        assert.equal(ledger.schema_version, 1);
        assert.equal(ledger.event_source, 'task-history-ledger');
        assert.equal((ledger.verification as Record<string, unknown>).status, 'VERIFIED');
        assert.equal(((ledger.lifecycle as Record<string, unknown>).health_state), 'healthy_done');
        assert.equal(((ledger.lifecycle as Record<string, unknown>).retention_tier), 'compact_ledger_candidate');
        assert.equal((((ledger.artifact_refs as Record<string, unknown>).final_closeout_json as Record<string, unknown>).exists), true);
        assert.equal(readTaskHistoryLedgerScanStatus(workspace.bundleRoot, taskId), 'VERIFIED');

        const scan = scanTaskHistoryLedgerRoot(workspace.bundleRoot);
        assert.equal(scan.file_count, 1);
        assert.equal(scan.verified_count, 1);
    } finally {
        workspace.cleanup();
    }
});

test('buildTaskHistoryLedger reports contradictions when a passed gate artifact is missing', () => {
    const taskId = 'T-LEDGER-MISSING';
    const workspace = makeWorkspace(taskId);
    try {
        writeIntegrityEventSequence(workspace.eventsDir, taskId, [
            { event_type: 'TASK_MODE_ENTERED' },
            { event_type: 'RULE_PACK_LOADED' },
            { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
            { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
            { event_type: 'PREFLIGHT_CLASSIFIED' },
            { event_type: 'STATUS_CHANGED', details: { previous_status: 'IN_REVIEW', new_status: 'DONE' } },
            { event_type: 'COMPILE_GATE_PASSED' },
            { event_type: 'REVIEW_PHASE_STARTED' },
            { event_type: 'REVIEW_GATE_PASSED' },
            { event_type: 'DOC_IMPACT_ASSESSED' },
            { event_type: 'COMPLETION_GATE_PASSED' }
        ]);
        writeTimelineSummary(workspace.eventsDir, taskId, 'COMPLETE');
        writePassingArtifacts(workspace.reviewsDir, taskId);
        fs.rmSync(path.join(workspace.reviewsDir, `${taskId}-compile-gate.json`), { force: true });

        const summary = buildSummary(workspace.repoRoot, workspace.eventsDir, workspace.reviewsDir, taskId);
        const ledger = buildTaskHistoryLedger(summary, workspace.repoRoot);
        assert.equal(ledger.verification.status, 'CONTRADICTORY');
        assert.ok(ledger.verification.issues.some((issue) => issue.includes('Compile gate passed')));
    } finally {
        workspace.cleanup();
    }
});

test('buildTaskHistoryLedger classifies failed review timelines as failed lifecycle history', () => {
    const taskId = 'T-LEDGER-REVIEW-FAIL';
    const workspace = makeWorkspace(taskId);
    try {
        writeArtifact(workspace.reviewsDir, taskId, '-task-mode.json', { requested_depth: 2, effective_depth: 2 });
        writePreflight(workspace.reviewsDir, taskId, {
            mode: 'FULL_PATH',
            changed_files: ['src/review.ts'],
            metrics: { changed_lines_total: 12 },
            required_reviews: { code: true }
        });
        writeArtifact(workspace.reviewsDir, taskId, '-compile-gate.json', { status: 'PASSED' });

        writeIntegrityEventSequence(workspace.eventsDir, taskId, [
            { event_type: 'TASK_MODE_ENTERED' },
            { event_type: 'RULE_PACK_LOADED' },
            { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
            { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
            { event_type: 'PREFLIGHT_CLASSIFIED' },
            { event_type: 'COMPILE_GATE_PASSED' },
            { event_type: 'REVIEW_PHASE_STARTED' },
            { event_type: 'REVIEW_GATE_FAILED' },
            { event_type: 'STATUS_CHANGED', details: { previous_status: 'IN_REVIEW', new_status: 'DONE' } }
        ]);
        writeTimelineSummary(workspace.eventsDir, taskId, 'INCOMPLETE');

        const summary = buildSummary(workspace.repoRoot, workspace.eventsDir, workspace.reviewsDir, taskId);
        const ledger = buildTaskHistoryLedger(summary, workspace.repoRoot);
        assert.equal(summary.status, 'BLOCKED');
        assert.equal(ledger.lifecycle.health_state, 'failed');
        assert.equal(ledger.verification.status, 'VERIFIED');
    } finally {
        workspace.cleanup();
    }
});

test('buildTaskHistoryLedger records required full-suite failures for terminal blocked cycles', () => {
    const taskId = 'T-LEDGER-FULL-SUITE-FAIL';
    const workspace = makeWorkspace(taskId, { fullSuiteEnabled: true });
    try {
        writeArtifact(workspace.reviewsDir, taskId, '-task-mode.json', { requested_depth: 2, effective_depth: 2 });
        writePreflight(workspace.reviewsDir, taskId, {
            mode: 'FULL_PATH',
            changed_files: ['src/full-suite.ts'],
            metrics: { changed_lines_total: 10 },
            required_reviews: {}
        });
        writeArtifact(workspace.reviewsDir, taskId, '-compile-gate.json', { status: 'PASSED' });
        writeArtifact(workspace.reviewsDir, taskId, '-doc-impact.json', {
            decision: 'NO_DOC_UPDATES',
            behavior_changed: false,
            changelog_updated: false,
            docs_updated: []
        });

        writeIntegrityEventSequence(workspace.eventsDir, taskId, [
            { event_type: 'TASK_MODE_ENTERED' },
            { event_type: 'RULE_PACK_LOADED' },
            { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
            { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
            { event_type: 'PREFLIGHT_CLASSIFIED' },
            { event_type: 'COMPILE_GATE_PASSED' },
            { event_type: 'DOC_IMPACT_ASSESSED' },
            { event_type: 'FULL_SUITE_VALIDATION_FAILED' },
            { event_type: 'STATUS_CHANGED', details: { previous_status: 'IN_REVIEW', new_status: 'DONE' } }
        ]);
        writeTimelineSummary(workspace.eventsDir, taskId, 'INCOMPLETE');

        const summary = buildSummary(workspace.repoRoot, workspace.eventsDir, workspace.reviewsDir, taskId);
        const ledger = buildTaskHistoryLedger(summary, workspace.repoRoot);
        assert.equal(ledger.lifecycle.health_state, 'failed');
        assert.equal(ledger.validations.full_suite.required, true);
        assert.equal(ledger.validations.full_suite.status, 'FAIL');
    } finally {
        workspace.cleanup();
    }
});

test('synchronizeFinalCloseoutArtifacts materializes blocked-task ledgers for TASK_BLOCKED timelines', () => {
    const taskId = 'T-LEDGER-BLOCKED';
    const workspace = makeWorkspace(taskId);
    try {
        writeArtifact(workspace.reviewsDir, taskId, '-task-mode.json', { requested_depth: 2, effective_depth: 2 });
        writePreflight(workspace.reviewsDir, taskId, {
            mode: 'FULL_PATH',
            changed_files: ['src/blocked.ts'],
            metrics: { changed_lines_total: 9 },
            required_reviews: {}
        });
        writeArtifact(workspace.reviewsDir, taskId, '-compile-gate.json', { status: 'PASSED' });

        writeIntegrityEventSequence(workspace.eventsDir, taskId, [
            { event_type: 'TASK_MODE_ENTERED' },
            { event_type: 'RULE_PACK_LOADED' },
            { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' },
            { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
            { event_type: 'PREFLIGHT_CLASSIFIED' },
            { event_type: 'COMPILE_GATE_PASSED' },
            { event_type: 'COMPLETION_GATE_FAILED' },
            { event_type: 'STATUS_CHANGED', details: { previous_status: 'IN_PROGRESS', new_status: 'BLOCKED' } }
        ]);
        writeTimelineSummary(workspace.eventsDir, taskId, 'INCOMPLETE');

        const summary = buildSummary(workspace.repoRoot, workspace.eventsDir, workspace.reviewsDir, taskId);
        assert.equal(summary.status, 'BLOCKED');

        synchronizeFinalCloseoutArtifacts(summary);

        const ledgerPath = resolveTaskHistoryLedgerPath(workspace.bundleRoot, taskId);
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as Record<string, unknown>;
        assert.equal(((ledger.lifecycle as Record<string, unknown>).health_state), 'blocked');
        assert.equal(readTaskHistoryLedgerScanStatus(workspace.bundleRoot, taskId), 'VERIFIED');
    } finally {
        workspace.cleanup();
    }
});

test('buildTaskHistoryLedger tolerates legacy minimal event lines', () => {
    const taskId = 'T-LEDGER-LEGACY';
    const workspace = makeWorkspace(taskId);
    try {
        writePassingArtifacts(workspace.reviewsDir, taskId, 'src/legacy.ts');
        const legacyEvents = [
            { task_id: taskId, event_type: 'TASK_MODE_ENTERED', outcome: 'PASS', message: 'Task mode entered.' },
            { task_id: taskId, event_type: 'RULE_PACK_LOADED', outcome: 'PASS', message: 'Rules loaded.' },
            { task_id: taskId, event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED', outcome: 'PASS', message: 'Handshake.' },
            { task_id: taskId, event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED', outcome: 'PASS', message: 'Smoke.' },
            { task_id: taskId, event_type: 'PREFLIGHT_CLASSIFIED', outcome: 'PASS', message: 'Preflight.' },
            { task_id: taskId, event_type: 'COMPILE_GATE_PASSED', outcome: 'PASS', message: 'Compile.' },
            { task_id: taskId, event_type: 'REVIEW_PHASE_STARTED', outcome: 'PASS', message: 'Review.' },
            { task_id: taskId, event_type: 'REVIEW_GATE_PASSED', outcome: 'PASS', message: 'Review passed.' },
            { task_id: taskId, event_type: 'DOC_IMPACT_ASSESSED', outcome: 'PASS', message: 'Doc impact.' },
            { task_id: taskId, event_type: 'COMPLETION_GATE_PASSED', outcome: 'PASS', message: 'Done.' }
        ];
        fs.writeFileSync(
            path.join(workspace.eventsDir, `${taskId}.jsonl`),
            legacyEvents.map((event) => JSON.stringify(event)).join('\n') + '\n',
            'utf8'
        );

        const summary = buildSummary(workspace.repoRoot, workspace.eventsDir, workspace.reviewsDir, taskId);
        const ledger = buildTaskHistoryLedger(summary, workspace.repoRoot);
        assert.equal(ledger.task_id, taskId);
        assert.equal(ledger.lifecycle.health_state, 'tampered');
    } finally {
        workspace.cleanup();
    }
});

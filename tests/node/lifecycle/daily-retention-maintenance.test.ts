import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    runDailyRetentionMaintenance,
    resolveDailyRetentionMaintenanceReportPath
} from '../../../src/lifecycle/daily-retention-maintenance';
import { appendTaskEvent } from '../../../src/gate-runtime/task-events';

function makeWorkspace(prefix: string): { targetRoot: string; bundleRoot: string; cleanup: () => void } {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    return {
        targetRoot,
        bundleRoot,
        cleanup: () => fs.rmSync(targetRoot, { recursive: true, force: true })
    };
}

function writeRuntimeRetentionConfig(
    bundleRoot: string,
    options: { enabled: boolean; dryRun?: boolean; maxTasksPerRun?: number; purgeRequireConfirm?: boolean; omitDryRun?: boolean }
): void {
    const configDir = path.join(bundleRoot, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const dailyMaintenance: Record<string, unknown> = {
        enabled: options.enabled,
        max_tasks_per_run: options.maxTasksPerRun ?? 25,
        dry_run: options.dryRun ?? false
    };
    if (options.omitDryRun) {
        delete dailyMaintenance.dry_run;
    }
    fs.writeFileSync(path.join(configDir, 'runtime-retention.json'), JSON.stringify({
        version: 1,
        active_tasks: {
            protect_runtime_grace_days: 7,
            protect_current_cycle_artifacts: true
        },
        healthy_done: {
            compact_after_days: 30,
            require_ledger: true,
            retain_task_events_until_ledger_verified: true
        },
        problem_tasks: {
            compress_after_days: 30,
            preserve_detailed_evidence: true
        },
        purge: {
            require_confirm: options.purgeRequireConfirm ?? true
        },
        daily_maintenance: dailyMaintenance
    }, null, 2) + '\n', 'utf8');
}

function createOldRuntimeTmpEntry(bundleRoot: string): string {
    const entryPath = path.join(bundleRoot, 'runtime', 'tmp', 'old-entry');
    fs.mkdirSync(entryPath, { recursive: true });
    fs.writeFileSync(path.join(entryPath, 'scratch.txt'), 'scratch', 'utf8');
    const old = new Date('2026-01-01T00:00:00.000Z');
    fs.utimesSync(path.join(entryPath, 'scratch.txt'), old, old);
    fs.utimesSync(entryPath, old, old);
    return entryPath;
}

function writeVerifiedLedger(bundleRoot: string, taskId: string): void {
    const ledgerDir = path.join(bundleRoot, 'runtime', 'task-ledger');
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(path.join(ledgerDir, `${taskId}.json`), JSON.stringify({
        schema_version: 1,
        event_source: 'task-history-ledger',
        task_id: taskId,
        verification: {
            status: 'VERIFIED',
            issues: []
        }
    }, null, 2) + '\n', 'utf8');
}

function writeTimelineSummary(bundleRoot: string, taskId: string): void {
    const eventsDir = path.join(bundleRoot, 'runtime', 'task-events');
    const timelinePath = path.join(eventsDir, `${taskId}.jsonl`);
    const stat = fs.statSync(timelinePath);
    fs.writeFileSync(path.join(eventsDir, '.timeline-summary.json'), JSON.stringify({
        version: 2,
        updated_at_utc: '2026-05-21T10:00:00.000Z',
        entries: {
            [taskId]: {
                task_id: taskId,
                file_size_bytes: stat.size,
                file_mtime_ms: Math.floor(stat.mtimeMs),
                code_changed: false,
                completeness_status: 'COMPLETE',
                events_found: ['TASK_MODE_ENTERED', 'STATUS_CHANGED', 'COMPLETION_GATE_PASSED'],
                events_missing: [],
                completeness_violations: [],
                integrity_status: 'PASS',
                events_scanned: 3,
                integrity_event_count: 3,
                integrity_violations: []
            }
        }
    }, null, 2) + '\n', 'utf8');
}

function createEscapingRuntimeRetentionCandidate(targetRoot: string, bundleRoot: string): string {
    const taskId = 'T-900';
    const outsideDir = path.join(targetRoot, 'outside-runtime-target');
    const outsideReviewsDir = path.join(outsideDir, 'reviews');
    const outsideEventsDir = path.join(outsideDir, 'task-events');
    const reviewsDir = path.join(bundleRoot, 'runtime', 'reviews');
    const eventsDir = path.join(bundleRoot, 'runtime', 'task-events');
    fs.mkdirSync(outsideReviewsDir, { recursive: true });
    fs.mkdirSync(outsideEventsDir, { recursive: true });
    fs.mkdirSync(path.dirname(reviewsDir), { recursive: true });
    fs.symlinkSync(outsideReviewsDir, reviewsDir, process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(outsideEventsDir, eventsDir, process.platform === 'win32' ? 'junction' : 'dir');

    const reviewCandidatePath = path.join(reviewsDir, `${taskId}-task-mode.json`);
    fs.writeFileSync(reviewCandidatePath, JSON.stringify({ task_id: taskId }), 'utf8');

    appendTaskEvent(bundleRoot, taskId, 'TASK_MODE_ENTERED', 'PASS', 'Task mode entered.', {}, { passThru: true });
    appendTaskEvent(bundleRoot, taskId, 'STATUS_CHANGED', 'PASS', 'Task status changed.', {
        previous_status: 'IN_REVIEW',
        new_status: 'DONE'
    }, { passThru: true });
    appendTaskEvent(bundleRoot, taskId, 'COMPLETION_GATE_PASSED', 'PASS', 'Completion gate passed.', {}, { passThru: true });
    writeTimelineSummary(bundleRoot, taskId);
    writeVerifiedLedger(bundleRoot, taskId);

    const timelinePath = path.join(eventsDir, `${taskId}.jsonl`);
    const old = new Date('2026-01-01T00:00:00.000Z');
    for (const candidatePath of [reviewCandidatePath, timelinePath]) {
        fs.utimesSync(candidatePath, old, old);
    }
    return reviewCandidatePath;
}

describe('daily retention maintenance', () => {
    it('runs confirmed maintenance once per local day and then skips by sentinel', () => {
        const workspace = makeWorkspace('daily-retention-once-');
        try {
            writeRuntimeRetentionConfig(workspace.bundleRoot, { enabled: true, purgeRequireConfirm: false });
            const staleEntry = createOldRuntimeTmpEntry(workspace.bundleRoot);
            const now = new Date('2026-05-21T10:00:00.000Z');

            const first = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now
            });

            assert.equal(first.status, 'SUCCESS');
            assert.equal(first.lock_acquired, true);
            assert.equal(fs.existsSync(staleEntry), true, 'daily retention must not run broad tmp cleanup');
            assert.equal(fs.existsSync(resolveDailyRetentionMaintenanceReportPath(workspace.bundleRoot, first.local_date)), true);
            assert.equal(first.gc_result?.removed_count ?? 0, 0);

            const second = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now
            });
            assert.equal(second.status, 'SKIPPED_ALREADY_RAN');
            assert.equal(second.lock_acquired, false);
        } finally {
            workspace.cleanup();
        }
    });

    it('honors disabled and dry-run daily maintenance policy', () => {
        const disabledWorkspace = makeWorkspace('daily-retention-disabled-');
        try {
            writeRuntimeRetentionConfig(disabledWorkspace.bundleRoot, { enabled: false });
            const disabled = runDailyRetentionMaintenance({
                targetRoot: disabledWorkspace.targetRoot,
                bundleRoot: disabledWorkspace.bundleRoot,
                now: new Date('2026-05-21T10:00:00.000Z')
            });
            assert.equal(disabled.status, 'DISABLED');
            assert.equal(fs.existsSync(disabled.report_path), false);
        } finally {
            disabledWorkspace.cleanup();
        }

        const dryRunWorkspace = makeWorkspace('daily-retention-dry-run-');
        try {
            writeRuntimeRetentionConfig(dryRunWorkspace.bundleRoot, { enabled: true, dryRun: true });
            const staleEntry = createOldRuntimeTmpEntry(dryRunWorkspace.bundleRoot);
            const dryRun = runDailyRetentionMaintenance({
                targetRoot: dryRunWorkspace.targetRoot,
                bundleRoot: dryRunWorkspace.bundleRoot,
                now: new Date('2026-05-21T10:00:00.000Z')
            });
            assert.equal(dryRun.status, 'DRY_RUN');
            assert.equal(dryRun.dry_run, true);
            assert.equal(fs.existsSync(staleEntry), true);
            assert.equal(dryRun.gc_result?.skipped_count ?? 0, 0);
        } finally {
            dryRunWorkspace.cleanup();
        }
    });

    it('forces dry-run when purge confirmation is still required', () => {
        const workspace = makeWorkspace('daily-retention-confirm-required-');
        try {
            writeRuntimeRetentionConfig(workspace.bundleRoot, {
                enabled: true,
                dryRun: false,
                purgeRequireConfirm: true
            });
            const staleEntry = createOldRuntimeTmpEntry(workspace.bundleRoot);

            const result = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now: new Date('2026-05-21T10:00:00.000Z')
            });

            assert.equal(result.status, 'DRY_RUN');
            assert.equal(result.dry_run, true);
            assert.equal(fs.existsSync(staleEntry), true);
            assert.equal(result.gc_result?.skipped_count ?? 0, 0);
        } finally {
            workspace.cleanup();
        }
    });

    it('treats legacy missing daily dry-run as dry-run even when purge confirm is disabled', () => {
        const workspace = makeWorkspace('daily-retention-legacy-dry-run-');
        try {
            writeRuntimeRetentionConfig(workspace.bundleRoot, {
                enabled: true,
                purgeRequireConfirm: false,
                omitDryRun: true
            });
            const staleEntry = createOldRuntimeTmpEntry(workspace.bundleRoot);

            const result = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now: new Date('2026-05-21T10:00:00.000Z')
            });

            assert.equal(result.status, 'DRY_RUN');
            assert.equal(result.dry_run, true);
            assert.equal(fs.existsSync(staleEntry), true);
            assert.equal(result.gc_result?.skipped_count ?? 0, 0);
        } finally {
            workspace.cleanup();
        }
    });

    it('does not mark partial gc maintenance as a successful daily sentinel', () => {
        const workspace = makeWorkspace('daily-retention-partial-');
        try {
            writeRuntimeRetentionConfig(workspace.bundleRoot, { enabled: true, purgeRequireConfirm: false });
            const escapingCandidate = createEscapingRuntimeRetentionCandidate(workspace.targetRoot, workspace.bundleRoot);
            const now = new Date('2026-05-21T10:00:00.000Z');

            const first = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now
            });

            assert.equal(first.status, 'FAILED');
            assert.equal(first.lock_acquired, true);
            assert.equal(first.gc_result?.result, 'PARTIAL');
            assert.ok((first.gc_result?.error_count ?? 0) > 0);
            assert.equal(fs.existsSync(escapingCandidate), true);

            const second = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now
            });
            assert.equal(second.status, 'FAILED');
            assert.equal(second.skipped_reason, null);
            assert.equal(second.lock_acquired, true);
        } finally {
            workspace.cleanup();
        }
    });
});

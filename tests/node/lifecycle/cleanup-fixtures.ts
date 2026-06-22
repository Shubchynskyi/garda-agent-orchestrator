import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';

import {
    runCleanup,
    runCleanupWithLock,
    runGc,
    runGcWithLock,
    runTaskRuntimeBatchPurge,
    runTaskRuntimeBatchPurgeWithLock,
    runTaskRuntimePurge,
    runTaskRuntimePurgeWithLock,
    buildDefaultRetentionPolicy,
    GC_ALLOWLIST,
    validateGcCategories,
    loadStoragePolicy,
    isGateReceipt,
    compressFileGzip,
    applyStoragePolicy,
    type CleanupOptions,
    type GcOptions,
    type GcResult,
    type RetentionPolicy,
    type ReviewArtifactStoragePolicy,
    type StoragePolicyResult,
    type TaskRuntimeBatchPurgeResult,
    type TaskRuntimePurgeResult
} from '../../../src/lifecycle/cleanup';
import { processCleanupCandidates } from '../../../src/lifecycle/cleanup-removal';
import { appendTaskEvent } from '../../../src/gate-runtime/task-events';

export {
    describe,
    it,
    beforeEach,
    afterEach,
    assert,
    fs,
    path,
    os,
    zlib,
    runCleanup,
    runCleanupWithLock,
    runGc,
    runGcWithLock,
    runTaskRuntimeBatchPurge,
    runTaskRuntimeBatchPurgeWithLock,
    runTaskRuntimePurge,
    runTaskRuntimePurgeWithLock,
    buildDefaultRetentionPolicy,
    GC_ALLOWLIST,
    validateGcCategories,
    loadStoragePolicy,
    isGateReceipt,
    compressFileGzip,
    applyStoragePolicy,
    processCleanupCandidates,
    appendTaskEvent,
    type CleanupOptions,
    type GcOptions,
    type GcResult,
    type RetentionPolicy,
    type ReviewArtifactStoragePolicy,
    type StoragePolicyResult,
    type TaskRuntimeBatchPurgeResult,
    type TaskRuntimePurgeResult
};

export function makeTmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
export function setupRuntimeDir(bundleRoot: string): string {
    const runtimeDir = path.join(bundleRoot, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    return runtimeDir;
}

export function createDirectoryLink(targetPath: string, linkPath: string): void {
    fs.symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Create a timestamped backup directory entry (e.g. `20260101-120000-000`). */
export function createTimestampDir(parentDir: string, date: Date): string {
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const pad3 = (n: number) => String(n).padStart(3, '0');
    const name =
        `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-` +
        `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}-` +
        `${pad3(date.getMilliseconds())}`;
    const dirPath = path.join(parentDir, name);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'data.txt'), 'test backup data');
    return dirPath;
}

/** Create an update-prefixed directory entry (e.g. `update-20260101-120000`). */
export function createUpdateDir(parentDir: string, date: Date): string {
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const name =
        `update-${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-` +
        `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
    const dirPath = path.join(parentDir, name);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'report.md'), '# Update');
    return dirPath;
}

export function daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export function agePath(filePath: string, days: number): void {
    const past = daysAgo(days);
    fs.utimesSync(filePath, past, past);
}

export function createTaskEventFile(eventsDir: string, taskId: string): string {
    const filePath = path.join(eventsDir, `${taskId}.jsonl`);
    fs.writeFileSync(filePath, `{"event":"TASK_MODE_ENTERED","task_id":"${taskId}"}\n`);
    return filePath;
}

export function writeTaskTimeline(
    eventsDir: string,
    taskId: string,
    events: Array<{ event_type: string; details?: Record<string, unknown> }>
): string {
    const filePath = path.join(eventsDir, `${taskId}.jsonl`);
    fs.writeFileSync(
        filePath,
        events.map((event, index) => JSON.stringify({
            timestamp_utc: `2026-04-15T12:00:${String(index).padStart(2, '0')}.000Z`,
            task_id: taskId,
            outcome: 'INFO',
            actor: 'test',
            message: event.event_type,
            event_type: event.event_type,
            details: event.details || {}
        })).join('\n') + '\n',
        'utf8'
    );
    return filePath;
}

export function writeTimelineSummary(
    eventsDir: string,
    taskId: string,
    options: {
        completenessStatus: string;
        integrityStatus?: string;
        eventsFound?: string[];
        eventsMissing?: string[];
    }
): void {
    const timelinePath = path.join(eventsDir, `${taskId}.jsonl`);
    const stat = fs.statSync(timelinePath);
    const summaryPath = path.join(eventsDir, '.timeline-summary.json');
    const existing = fs.existsSync(summaryPath)
        ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as { version: number; updated_at_utc: string; entries: Record<string, unknown> }
        : { version: 2, updated_at_utc: new Date().toISOString(), entries: {} };
    existing.entries[taskId] = {
        task_id: taskId,
        file_size_bytes: stat.size,
        file_mtime_ms: Math.floor(stat.mtimeMs),
        code_changed: true,
        completeness_status: options.completenessStatus,
        events_found: options.eventsFound || ['TASK_MODE_ENTERED', 'COMPLETION_GATE_PASSED'],
        events_missing: options.eventsMissing || [],
        completeness_violations: [],
        integrity_status: options.integrityStatus || 'PASS',
        events_scanned: 2,
        integrity_event_count: 2,
        integrity_violations: [],
        written_at_ms: Date.now()
    };
    existing.updated_at_utc = new Date().toISOString();
    fs.writeFileSync(summaryPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
}

export function createReviewArtifacts(reviewsDir: string, taskId: string): string[] {
    const files = [
        `${taskId}-preflight.json`,
        `${taskId}-task-mode.json`,
        `${taskId}-compile-gate.json`
    ];
    const paths: string[] = [];
    for (const file of files) {
        const filePath = path.join(reviewsDir, file);
        fs.writeFileSync(filePath, JSON.stringify({ task_id: taskId }));
        paths.push(filePath);
    }
    return paths;
}

export function writeVerifiedLedger(bundleRoot: string, taskId: string): string {
    const ledgerDir = path.join(bundleRoot, 'runtime', 'task-ledger');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const ledgerPath = path.join(ledgerDir, `${taskId}.json`);
    fs.writeFileSync(ledgerPath, JSON.stringify({
        schema_version: 1,
        event_source: 'task-history-ledger',
        task_id: taskId,
        verification: {
            status: 'VERIFIED',
            issues: []
        }
    }, null, 2) + '\n', 'utf8');
    return ledgerPath;
}

export function seedHealthyDoneTaskArtifacts(input: {
    bundleRoot: string;
    taskId: string;
    includePlan?: boolean;
    includeProjectMemory?: boolean;
    includeCompletenessCache?: boolean;
    ageDays?: number;
}): {
    reviewsDir: string;
    eventsDir: string;
    plansDir: string;
    projectMemoryDir: string;
    reviewPaths: string[];
    timelinePath: string;
    planPath: string | null;
    projectMemoryPaths: string[];
    ledgerPath: string;
} {
    const {
        bundleRoot,
        taskId,
        includePlan = false,
        includeProjectMemory = false,
        includeCompletenessCache = false,
        ageDays = 45
    } = input;
    const runtimeDir = path.join(bundleRoot, 'runtime');
    const reviewsDir = path.join(runtimeDir, 'reviews');
    const eventsDir = path.join(runtimeDir, 'task-events');
    const plansDir = path.join(runtimeDir, 'plans');
    const projectMemoryDir = path.join(runtimeDir, 'project-memory');
    fs.mkdirSync(reviewsDir, { recursive: true });
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.mkdirSync(plansDir, { recursive: true });
    fs.mkdirSync(projectMemoryDir, { recursive: true });

    const reviewPaths = createReviewArtifacts(reviewsDir, taskId);
    const finalCloseoutJsonPath = path.join(reviewsDir, `${taskId}-final-closeout.json`);
    const finalCloseoutMarkdownPath = path.join(reviewsDir, `${taskId}-final-closeout.md`);
    fs.writeFileSync(finalCloseoutJsonPath, JSON.stringify({ task_id: taskId, status: 'READY' }), 'utf8');
    fs.writeFileSync(finalCloseoutMarkdownPath, '# Final Closeout\n', 'utf8');
    reviewPaths.push(finalCloseoutJsonPath, finalCloseoutMarkdownPath);

    appendTaskEvent(bundleRoot, taskId, 'TASK_MODE_ENTERED', 'PASS', 'Task mode entered.', {}, { passThru: true });
    appendTaskEvent(bundleRoot, taskId, 'STATUS_CHANGED', 'PASS', 'Task status changed.', {
        previous_status: 'IN_REVIEW',
        new_status: 'DONE'
    }, { passThru: true });
    appendTaskEvent(bundleRoot, taskId, 'COMPLETION_GATE_PASSED', 'PASS', 'Completion gate passed.', {}, { passThru: true });
    const timelinePath = path.join(eventsDir, `${taskId}.jsonl`);
    writeTimelineSummary(eventsDir, taskId, { completenessStatus: 'COMPLETE' });

    const touchedPaths = [...reviewPaths, timelinePath];
    if (includeCompletenessCache) {
        const completenessPath = path.join(eventsDir, `${taskId}.completeness.json`);
        fs.writeFileSync(completenessPath, '{}', 'utf8');
        touchedPaths.push(completenessPath);
    }

    let planPath: string | null = null;
    if (includePlan) {
        planPath = path.join(plansDir, `${taskId}.md`);
        fs.writeFileSync(planPath, `# ${taskId}\n`, 'utf8');
        touchedPaths.push(planPath);
    }

    const projectMemoryPaths: string[] = [];
    if (includeProjectMemory) {
        for (const suffix of ['impact', 'update']) {
            const artifactPath = path.join(projectMemoryDir, `${taskId}-${suffix}.json`);
            fs.writeFileSync(artifactPath, JSON.stringify({ task_id: taskId, kind: suffix }), 'utf8');
            projectMemoryPaths.push(artifactPath);
            touchedPaths.push(artifactPath);
        }
    }

    const ledgerPath = writeVerifiedLedger(bundleRoot, taskId);
    const past = daysAgo(ageDays);
    for (const artifactPath of [...touchedPaths, ledgerPath]) {
        fs.utimesSync(artifactPath, past, past);
    }

    return {
        reviewsDir,
        eventsDir,
        plansDir,
        projectMemoryDir,
        reviewPaths,
        timelinePath,
        planPath,
        projectMemoryPaths,
        ledgerPath
    };
}

export function writeTaskQueue(
    targetRoot: string,
    tasks: Array<{ id: string; status: string; title?: string }>
): void {
    const lines = [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|'
    ];

    for (const task of tasks) {
        lines.push(
            `| ${task.id} | ${task.status} | P2 | reliability/test | ${task.title || 'Task'} | gpt-5.4 | 2026-04-15 | balanced | note |`
        );
    }

    fs.writeFileSync(path.join(targetRoot, 'TASK.md'), `${lines.join('\n')}\n`, 'utf8');
}

export function writeRuntimeRetentionPolicy(
    bundleRoot: string,
    options: {
        preserveDetailedEvidence?: boolean;
        omitPreserveDetailedEvidence?: boolean;
        dailyDryRun?: boolean;
        purgeRequireConfirm?: boolean;
        dailyEligibleOlderThanDays?: number;
        dailyKeepLatestTasks?: number;
    } = {}
): void {
    const configDir = path.join(bundleRoot, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
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
            ...(options.omitPreserveDetailedEvidence
                ? {}
                : { preserve_detailed_evidence: options.preserveDetailedEvidence ?? true })
        },
        purge: {
            require_confirm: options.purgeRequireConfirm ?? true
        },
        daily_maintenance: {
            enabled: true,
            max_tasks_per_run: 25,
            eligible_older_than_days: options.dailyEligibleOlderThanDays ?? 30,
            keep_latest_tasks: options.dailyKeepLatestTasks ?? 0,
            dry_run: options.dailyDryRun ?? true
        }
    }, null, 2) + '\n', 'utf8');
}

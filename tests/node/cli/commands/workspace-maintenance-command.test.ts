import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleCleanup, handleGc } from '../../../../src/cli/commands/workspace-maintenance-command';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';

const PACKAGE_JSON = {
    name: 'garda-agent-orchestrator',
    version: '1.1.0'
};

function makeTmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function captureConsoleAsync<T>(run: () => Promise<T> | T): Promise<{ lines: string[]; result: T }> {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
        lines.push(args.join(' '));
    };
    try {
        const result = await Promise.resolve(run());
        return { lines, result };
    } finally {
        console.log = originalLog;
    }
}

function writeTaskQueue(targetRoot: string): void {
    const lines = [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-002 | 🟩 DONE | P2 | runtime/cleanup | Completed task | gpt-5.4 | 2026-04-15 | balanced | note |'
    ];
    fs.writeFileSync(path.join(targetRoot, 'TASK.md'), `${lines.join('\n')}\n`, 'utf8');
}

function createReviewArtifacts(reviewsDir: string, taskId: string): void {
    for (const fileName of [`${taskId}-task-mode.json`, `${taskId}-preflight.json`, `${taskId}-compile-gate.json`]) {
        fs.writeFileSync(path.join(reviewsDir, fileName), JSON.stringify({ task_id: taskId }), 'utf8');
    }
}

function writeTimelineSummary(eventsDir: string, taskId: string): void {
    const timelinePath = path.join(eventsDir, `${taskId}.jsonl`);
    const stat = fs.statSync(timelinePath);
    const summaryPath = path.join(eventsDir, '.timeline-summary.json');
    const payload = {
        version: 2,
        updated_at_utc: new Date().toISOString(),
        entries: {
            [taskId]: {
                task_id: taskId,
                file_size_bytes: stat.size,
                file_mtime_ms: Math.floor(stat.mtimeMs),
                code_changed: true,
                completeness_status: 'COMPLETE',
                events_found: ['TASK_MODE_ENTERED', 'COMPLETION_GATE_PASSED'],
                events_missing: [],
                completeness_violations: [],
                integrity_status: 'PASS',
                events_scanned: 3,
                integrity_event_count: 3,
                integrity_violations: [],
                written_at_ms: Date.now()
            }
        }
    };
    fs.writeFileSync(summaryPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function setupRetentionPreviewWorkspace(): { projectRoot: string; bundleRoot: string } {
    const projectRoot = makeTmpDir('gao-workspace-maintenance-');
    const bundleRoot = path.join(projectRoot, 'garda-agent-orchestrator');
    const runtimeDir = path.join(bundleRoot, 'runtime');
    const reviewsDir = path.join(runtimeDir, 'reviews');
    const eventsDir = path.join(runtimeDir, 'task-events');
    const plansDir = path.join(runtimeDir, 'plans');

    fs.mkdirSync(reviewsDir, { recursive: true });
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.1.0\n', 'utf8');

    writeTaskQueue(projectRoot);
    createReviewArtifacts(reviewsDir, 'T-002');
    fs.writeFileSync(path.join(plansDir, 'T-002.md'), '# completed plan\n', 'utf8');
    appendTaskEvent(bundleRoot, 'T-002', 'TASK_MODE_ENTERED', 'PASS', 'Task mode entered.', {}, { passThru: true });
    appendTaskEvent(bundleRoot, 'T-002', 'STATUS_CHANGED', 'PASS', 'Task status changed.', {
        previous_status: 'IN_REVIEW',
        new_status: 'DONE'
    }, { passThru: true });
    appendTaskEvent(bundleRoot, 'T-002', 'COMPLETION_GATE_PASSED', 'PASS', 'Completion gate passed.', {}, { passThru: true });
    writeTimelineSummary(eventsDir, 'T-002');

    const agedPaths = [
        path.join(reviewsDir, 'T-002-task-mode.json'),
        path.join(reviewsDir, 'T-002-preflight.json'),
        path.join(reviewsDir, 'T-002-compile-gate.json'),
        path.join(eventsDir, 'T-002.jsonl'),
        path.join(plansDir, 'T-002.md')
    ];
    const past = daysAgo(45);
    for (const filePath of agedPaths) {
        fs.utimesSync(filePath, past, past);
    }

    return { projectRoot, bundleRoot };
}

test('handleCleanup prints runtime retention preview lines during dry-run cleanup', async () => {
    const { projectRoot } = setupRetentionPreviewWorkspace();

    try {
        const { lines } = await captureConsoleAsync(() => handleCleanup(['--target-root', projectRoot, '--dry-run'], PACKAGE_JSON));
        assert.ok(lines.some((line) => line.includes('RuntimeRetentionPreviewTasks: 1')));
        assert.ok(lines.some((line) => line.includes('RuntimeRetentionEligibleNow: 0')));
        assert.ok(lines.some((line) => line.includes('RuntimeRetentionLedgerStatus: verified=0, missing=1, incomplete=0, contradictory=0, invalid=0')));
        assert.ok(lines.some((line) => line.includes('RuntimeRetentionTiersLegend: active_evidence=preserve')));
        assert.ok(lines.some((line) => line.includes('RuntimeRetentionSample: T-002:healthy_done->compact_ledger_candidate:MISSING')));
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('handleCleanup routes manual runtime-retention age selection to preview', async () => {
    const { projectRoot } = setupRetentionPreviewWorkspace();

    try {
        const { lines } = await captureConsoleAsync(() => handleCleanup([
            '--target-root',
            projectRoot,
            '--dry-run',
            '--runtime-retention-older-than-days',
            '60'
        ], PACKAGE_JSON));
        assert.ok(lines.some((line) => line.includes('RuntimeRetentionPreviewTasks: 0')));
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('handleCleanup routes batch task purge selection to task-owned dry-run report', async () => {
    const { projectRoot } = setupRetentionPreviewWorkspace();

    try {
        const { lines } = await captureConsoleAsync(() => handleCleanup([
            'batch-task-purge',
            '--target-root',
            projectRoot,
            '--dry-run',
            '--runtime-retention-older-than-days',
            '30',
            '--runtime-retention-keep-latest-tasks',
            '0'
        ], PACKAGE_JSON));

        assert.ok(lines.some((line) => line.includes('BatchPurgeCandidateTasks: 1')));
        assert.ok(lines.some((line) => line.includes('BatchPurgeMatchedTasks: 1')));
        assert.ok(lines.some((line) => line.includes('BatchPurgeSelectedTasks: 1')));
        assert.ok(lines.some((line) => line.includes('BatchPurgeSelectedTaskSample: T-002')));
        assert.ok(lines.some((line) => line.includes('BatchPurgeSharedIndexOperations:')));
        assert.ok(lines.some((line) => line.includes('Result: SUCCESS')));
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('workspace maintenance rejects malformed runtime-retention integer flags', async () => {
    const cases: Array<{
        name: string;
        handler: (args: string[], packageJson: typeof PACKAGE_JSON) => void | Promise<void>;
        args: string[];
    }> = [
        {
            name: 'cleanup older-than suffix',
            handler: handleCleanup,
            args: ['--dry-run', '--runtime-retention-older-than-days', '30days']
        },
        {
            name: 'cleanup keep-latest decimal',
            handler: handleCleanup,
            args: ['--dry-run', '--runtime-retention-keep-latest-tasks', '1.5']
        },
        {
            name: 'gc older-than exponent',
            handler: handleGc,
            args: ['--runtime-retention-older-than-days', '1e2']
        },
        {
            name: 'gc keep-latest suffix',
            handler: handleGc,
            args: ['--runtime-retention-keep-latest-tasks', '2tasks']
        }
    ];

    for (const entry of cases) {
        const { projectRoot } = setupRetentionPreviewWorkspace();
        try {
            await assert.rejects(
                async () => {
                    await entry.handler(['--target-root', projectRoot, ...entry.args], PACKAGE_JSON);
                },
                /must be a non-negative integer/,
                entry.name
            );
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    }
});

test('handleGc prints runtime retention preview lines during dry-run gc', async () => {
    const { projectRoot } = setupRetentionPreviewWorkspace();

    try {
        const { lines } = await captureConsoleAsync(() => handleGc(['--target-root', projectRoot], PACKAGE_JSON));
        assert.ok(lines.some((line) => line.includes('RuntimeRetentionPreviewTasks: 1')));
        assert.ok(lines.some((line) => line.includes('RuntimeRetentionEligibleNow: 0')));
        assert.ok(lines.some((line) => line.includes('RuntimeRetentionLedgerStatus: verified=0, missing=1, incomplete=0, contradictory=0, invalid=0')));
        assert.ok(lines.some((line) => line.includes('RuntimeRetentionTiersLegend: active_evidence=preserve')));
        assert.ok(lines.some((line) => line.includes('RuntimeRetentionSample: T-002:healthy_done->compact_ledger_candidate:MISSING')));
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

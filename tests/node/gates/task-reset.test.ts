import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    resolveTaskResetScope,
    runTaskResetCommand
} from '../../../src/cli/commands/gate-flows/task-reset-flow';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-reset-test-'));
}

function cleanup(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

interface FakeRepoOptions {
    taskId?: string;
    taskStatus?: string;
    hasEventsFile?: boolean;
    hasAggregateLines?: boolean;
    hasReviewArtifact?: boolean;
    hasReviewTempDir?: boolean;
}

function buildFakeRepo(options: FakeRepoOptions = {}): {
    repoRoot: string;
    eventsRoot: string;
    reviewsRoot: string;
    taskId: string;
} {
    const {
        taskId = 'T-001',
        taskStatus = 'IN_PROGRESS',
        hasEventsFile = false,
        hasAggregateLines = false,
        hasReviewArtifact = false,
        hasReviewTempDir = false
    } = options;

    const repoRoot = makeTmpDir();

    // TASK.md with a row for the task (4 columns required by syncTaskQueueStatusDetailed)
    const taskMdContent = [
        '## Tasks',
        '',
        '| Task ID | Status | Description | Notes |',
        '|---------|--------|-------------|-------|',
        `| ${taskId} | ${taskStatus} | Test task | - |`
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), taskMdContent, 'utf8');

    // Orchestrator directory structure
    const bundleDir = path.join(repoRoot, 'garda-agent-orchestrator');
    const eventsRoot = path.join(bundleDir, 'runtime', 'task-events');
    const reviewsRoot = path.join(bundleDir, 'runtime', 'reviews');
    fs.mkdirSync(eventsRoot, { recursive: true });
    fs.mkdirSync(reviewsRoot, { recursive: true });

    // Fake MANIFEST.md and VERSION to satisfy joinOrchestratorPath heuristics
    fs.writeFileSync(path.join(bundleDir, 'MANIFEST.md'), '# MANIFEST\n', 'utf8');
    fs.writeFileSync(path.join(bundleDir, 'VERSION'), '1.0.0\n', 'utf8');

    if (hasEventsFile) {
        fs.writeFileSync(
            path.join(eventsRoot, `${taskId}.jsonl`),
            `{"task_id":"${taskId}","event_type":"PLAN_CREATED","outcome":"INFO"}\n`,
            'utf8'
        );
    }

    if (hasAggregateLines) {
        const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');
        const lines = [
            `{"task_id":"${taskId}","event_type":"PLAN_CREATED","outcome":"INFO"}`,
            `{"task_id":"T-999","event_type":"OTHER","outcome":"INFO"}`,
            `{"task_id":"${taskId}","event_type":"COMPILE_PASSED","outcome":"PASS"}`
        ].join('\n') + '\n';
        fs.writeFileSync(allTasksPath, lines, 'utf8');
    }

    if (hasReviewArtifact) {
        fs.writeFileSync(
            path.join(reviewsRoot, `${taskId}-preflight.json`),
            JSON.stringify({ task_id: taskId, outcome: 'PASS' }) + '\n',
            'utf8'
        );
    }

    if (hasReviewTempDir) {
        const reviewTempDir = path.join(repoRoot, '.review-temp', taskId);
        fs.mkdirSync(reviewTempDir, { recursive: true });
        fs.writeFileSync(path.join(reviewTempDir, 'context.md'), '# context\n', 'utf8');
    }

    return { repoRoot, eventsRoot, reviewsRoot, taskId };
}

// ---------------------------------------------------------------------------
// resolveTaskResetScope
// ---------------------------------------------------------------------------

describe('resolveTaskResetScope', () => {
    it('returns empty scope when no artifacts exist', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo();
        try {
            const scope = resolveTaskResetScope({ taskId, repoRoot, eventsRoot, reviewsRoot });
            assert.equal(scope.taskId, taskId);
            assert.equal(scope.artifacts.length, 0);
            assert.equal(scope.aggregateLineCount, 0);
            assert.equal(scope.hasAnyArtifacts, false);
        } finally {
            cleanup(repoRoot);
        }
    });

    it('detects per-task events file', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasEventsFile: true });
        try {
            const scope = resolveTaskResetScope({ taskId, repoRoot, eventsRoot, reviewsRoot });
            const eventsArtifact = scope.artifacts.find((a) => a.type === 'task-events');
            assert.ok(eventsArtifact, 'should have task-events artifact');
            assert.ok(fs.existsSync(eventsArtifact.path));
            assert.equal(scope.hasAnyArtifacts, true);
        } finally {
            cleanup(repoRoot);
        }
    });

    it('detects review artifact', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasReviewArtifact: true });
        try {
            const scope = resolveTaskResetScope({ taskId, repoRoot, eventsRoot, reviewsRoot });
            const reviewArtifact = scope.artifacts.find((a) => a.type === 'review-artifact');
            assert.ok(reviewArtifact, 'should have review-artifact');
            assert.equal(scope.reviewArtifactNames.length, 1);
            assert.ok(scope.reviewArtifactNames[0].endsWith('-preflight.json'));
        } finally {
            cleanup(repoRoot);
        }
    });

    it('counts aggregate log lines for the task only', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasAggregateLines: true });
        try {
            const scope = resolveTaskResetScope({ taskId, repoRoot, eventsRoot, reviewsRoot });
            assert.equal(scope.aggregateLineCount, 2, 'should count only lines for the target task');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('detects review temp directory', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasReviewTempDir: true });
        try {
            const scope = resolveTaskResetScope({ taskId, repoRoot, eventsRoot, reviewsRoot });
            const tempArtifact = scope.artifacts.find((a) => a.type === 'review-temp-dir');
            assert.ok(tempArtifact, 'should detect review-temp-dir');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('reads previous status from TASK.md', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ taskStatus: 'IN_REVIEW' });
        try {
            const scope = resolveTaskResetScope({ taskId, repoRoot, eventsRoot, reviewsRoot });
            assert.equal(scope.previousStatus, 'IN_REVIEW');
        } finally {
            cleanup(repoRoot);
        }
    });
});

// ---------------------------------------------------------------------------
// runTaskResetCommand — input validation
// ---------------------------------------------------------------------------

describe('runTaskResetCommand — validation', () => {
    it('throws for empty task ID', () => {
        assert.throws(
            () => runTaskResetCommand({ taskId: '', repoRoot: '.', confirm: true }),
            /TaskId must not be empty/
        );
    });

    it('throws for non-canonical task ID (no T- prefix)', () => {
        assert.throws(
            () => runTaskResetCommand({ taskId: 'TASK-001', repoRoot: '.', confirm: true }),
            /canonical format T-NNN/
        );
    });

    it('throws for task ID with letters after T-', () => {
        assert.throws(
            () => runTaskResetCommand({ taskId: 'T-001A', repoRoot: '.', confirm: true }),
            /canonical format T-NNN/
        );
    });

    it('throws when task ID is not found in TASK.md', () => {
        const repoRoot = makeTmpDir();
        try {
            fs.writeFileSync(
                path.join(repoRoot, 'TASK.md'),
                '| T-999 | TODO | Other task | - |\n',
                'utf8'
            );
            assert.throws(
                () => runTaskResetCommand({ taskId: 'T-001', repoRoot, confirm: true }),
                /not found in TASK\.md/
            );
        } finally {
            cleanup(repoRoot);
        }
    });

    it('throws when TASK.md is missing', () => {
        const repoRoot = makeTmpDir();
        try {
            assert.throws(
                () => runTaskResetCommand({ taskId: 'T-001', repoRoot, confirm: true }),
                /TASK\.md not found/
            );
        } finally {
            cleanup(repoRoot);
        }
    });
});

// ---------------------------------------------------------------------------
// runTaskResetCommand — ALREADY_RESET
// ---------------------------------------------------------------------------

describe('runTaskResetCommand — ALREADY_RESET', () => {
    it('returns ALREADY_RESET when task is DONE with no artifacts', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ taskStatus: 'DONE' });
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true });
            assert.equal(result.outcome, 'ALREADY_RESET');
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((l) => l.includes('ALREADY_RESET')));
        } finally {
            cleanup(repoRoot);
        }
    });

    it('does NOT return ALREADY_RESET when DONE but artifacts still exist', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            taskStatus: 'DONE',
            hasEventsFile: true
        });
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
        } finally {
            cleanup(repoRoot);
        }
    });
});

// ---------------------------------------------------------------------------
// runTaskResetCommand — CONFIRMATION_REQUIRED
// ---------------------------------------------------------------------------

describe('runTaskResetCommand — CONFIRMATION_REQUIRED', () => {
    it('returns CONFIRMATION_REQUIRED when neither --dry-run nor --confirm is given', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasEventsFile: true });
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot });
            assert.equal(result.outcome, 'CONFIRMATION_REQUIRED');
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((l) => l.includes('--confirm')));
        } finally {
            cleanup(repoRoot);
        }
    });

    it('CONFIRMATION_REQUIRED does not delete any files', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            hasEventsFile: true,
            hasReviewArtifact: true
        });
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        try {
            runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot });
            assert.ok(fs.existsSync(eventsFile), 'events file should NOT be deleted in confirmation-required mode');
        } finally {
            cleanup(repoRoot);
        }
    });
});

// ---------------------------------------------------------------------------
// runTaskResetCommand — DRY_RUN
// ---------------------------------------------------------------------------

describe('runTaskResetCommand — DRY_RUN', () => {
    it('returns DRY_RUN with artifact list and does not delete files', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            hasEventsFile: true,
            hasReviewArtifact: true,
            hasAggregateLines: true
        });
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, dryRun: true });
            assert.equal(result.outcome, 'DRY_RUN');
            assert.equal(result.exitCode, 0);
            assert.ok(result.dryRun);
            assert.ok(result.artifacts.length > 0);
            assert.ok(result.aggregateLinesRemoved > 0);
            // No files deleted
            assert.ok(fs.existsSync(eventsFile), 'events file should NOT be deleted in dry-run mode');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('DRY_RUN does not write audit breadcrumb', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasEventsFile: true });
        const resetReportPath = path.join(reviewsRoot, `${taskId}-reset-report.json`);
        try {
            runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, dryRun: true });
            assert.ok(!fs.existsSync(resetReportPath), 'reset report should NOT be written in dry-run');
        } finally {
            cleanup(repoRoot);
        }
    });
});

// ---------------------------------------------------------------------------
// runTaskResetCommand — RESET_COMPLETE
// ---------------------------------------------------------------------------

describe('runTaskResetCommand — RESET_COMPLETE', () => {
    it('deletes per-task events file and returns RESET_COMPLETE', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasEventsFile: true });
        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.equal(result.exitCode, 0);
            assert.ok(!fs.existsSync(eventsFile), 'events file should be deleted');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('deletes review artifacts', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasReviewArtifact: true });
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.ok(!fs.existsSync(preflightPath), 'preflight artifact should be deleted');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('removes task lines from aggregate log', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasAggregateLines: true });
        const aggregatePath = path.join(eventsRoot, 'all-tasks.jsonl');
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.ok(result.aggregateLinesRemoved > 0);
            const remaining = fs.readFileSync(aggregatePath, 'utf8');
            assert.ok(!remaining.includes(`"${taskId}"`), 'task lines should be removed from aggregate log');
            assert.ok(remaining.includes('"T-999"'), 'other task lines should remain');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('deletes review temp directory', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasReviewTempDir: true });
        const reviewTempDir = path.join(repoRoot, '.review-temp', taskId);
        try {
            runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true });
            assert.ok(!fs.existsSync(reviewTempDir), 'review temp dir should be deleted');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('writes audit breadcrumb before deletion', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasEventsFile: true });
        const resetReportPath = path.join(reviewsRoot, `${taskId}-reset-report.json`);
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.ok(fs.existsSync(resetReportPath), 'audit breadcrumb should be written');
            const report = JSON.parse(fs.readFileSync(resetReportPath, 'utf8')) as Record<string, unknown>;
            assert.equal(report.task_id, taskId);
            assert.equal(report.event_source, 'task-reset');
            assert.equal(report.reset_by, 'operator');
            assert.ok(typeof report.timestamp_utc === 'string');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('audit breadcrumb is not itself deleted', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasReviewArtifact: true });
        const resetReportPath = path.join(reviewsRoot, `${taskId}-reset-report.json`);
        try {
            runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true });
            assert.ok(fs.existsSync(resetReportPath), 'reset report (breadcrumb) must survive deletion phase');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('updates TASK.md status to DONE', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            taskStatus: 'IN_PROGRESS',
            hasEventsFile: true
        });
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.ok(result.statusSyncOutcome === 'updated' || result.statusSyncOutcome === 'already_synced');
            const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
            assert.ok(taskMd.includes('DONE'), 'TASK.md should have DONE status');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('is idempotent when no artifacts exist (no files to delete)', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ taskStatus: 'IN_PROGRESS' });
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true });
            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.equal(result.artifacts.length, 0);
            assert.equal(result.aggregateLinesRemoved, 0);
        } finally {
            cleanup(repoRoot);
        }
    });

    it('preserves other task lines in aggregate log', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({ hasAggregateLines: true });
        const aggregatePath = path.join(eventsRoot, 'all-tasks.jsonl');
        try {
            runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true });
            const remaining = fs.readFileSync(aggregatePath, 'utf8');
            const lines = remaining.split('\n').filter((l) => l.trim());
            assert.equal(lines.length, 1, 'only T-999 line should remain');
            assert.ok(lines[0].includes('"T-999"'));
        } finally {
            cleanup(repoRoot);
        }
    });

    it('previous status is captured in result', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            taskStatus: 'IN_REVIEW',
            hasEventsFile: true
        });
        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true });
            assert.equal(result.previousStatus, 'IN_REVIEW');
        } finally {
            cleanup(repoRoot);
        }
    });

    it('normalizes task ID to uppercase T-NNN', () => {
        const { repoRoot, eventsRoot, reviewsRoot } = buildFakeRepo({ taskId: 'T-001' });
        try {
            const result = runTaskResetCommand({
                taskId: 't-001',
                repoRoot,
                eventsRoot,
                reviewsRoot,
                confirm: true
            });
            assert.equal(result.taskId, 'T-001');
            assert.equal(result.outcome, 'RESET_COMPLETE');
        } finally {
            cleanup(repoRoot);
        }
    });
});

// ---------------------------------------------------------------------------
// runTaskResetCommand — full reset with all artifact types
// ---------------------------------------------------------------------------

describe('runTaskResetCommand — full artifact cleanup', () => {
    it('cleans all artifact types in one pass', () => {
        const { repoRoot, eventsRoot, reviewsRoot, taskId } = buildFakeRepo({
            taskStatus: 'IN_PROGRESS',
            hasEventsFile: true,
            hasAggregateLines: true,
            hasReviewArtifact: true,
            hasReviewTempDir: true
        });

        const eventsFile = path.join(eventsRoot, `${taskId}.jsonl`);
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const reviewTempDir = path.join(repoRoot, '.review-temp', taskId);

        try {
            const result = runTaskResetCommand({ taskId, repoRoot, eventsRoot, reviewsRoot, confirm: true });

            assert.equal(result.outcome, 'RESET_COMPLETE');
            assert.ok(!fs.existsSync(eventsFile), 'events file gone');
            assert.ok(!fs.existsSync(preflightPath), 'preflight artifact gone');
            assert.ok(!fs.existsSync(reviewTempDir), 'review temp dir gone');
            assert.ok(result.aggregateLinesRemoved > 0);

            const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
            assert.ok(taskMd.includes('DONE'));
        } finally {
            cleanup(repoRoot);
        }
    });
});

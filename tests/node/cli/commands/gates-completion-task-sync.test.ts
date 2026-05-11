import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { handleCompletionGate } from '../../../../src/cli/commands/gate-task-handlers';
import {
    runCompileGateCommand,
    runDocImpactGateCommand,
    runRequiredReviewsCheckCommand
} from '../../../../src/cli/commands/gates';
import { runCliMain } from '../../../../src/cli/main';

import {
    captureExpectedAsyncError,
    createTempRepo,
    loadTaskEntryRulePack,
    loadTaskEventsIoModule,
    loadPostPreflightRulePack,
    readTaskQueueStatusFromTaskFile,
    readTaskTimelineEvents,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedTaskQueue,
    writeCleanReviewArtifact,
    writePreflight
} from './gates-completion-fixtures';

describe('cli/commands/gates', () => {
    test('completion-gate updates the TASK.md row to DONE through the CLI handler', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-status-sync';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-status-sync.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Sync TASK.md status to DONE from completion-gate'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), /\|\s*T-903-completion-status-sync\s*\|\s*🟧 IN_REVIEW\s*\|/);

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Completion status sync regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMain([
                'gate',
                'completion-gate',
                '--preflight-path', preflightPath,
                '--task-id', taskId,
                '--repo-root', repoRoot
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), /\|\s*T-903-completion-status-sync\s*\|\s*🟩 DONE\s*\|/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate rerun repairs missing STATUS_CHANGED finalization without duplicating completion pass evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-status-event-repair';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-status-event-repair.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Repair missing STATUS_CHANGED finalization on completion rerun'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Completion finalization repair regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);
        const taskEventsIoModule = loadTaskEventsIoModule();
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[2] || '') === 'STATUS_CHANGED') {
                throw new Error('Injected STATUS_CHANGED append failure');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory STATUS_CHANGED append failed/i);
            assert.match(error.message, /gate completion-gate/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0,
            'completion pass must not be recorded before finalization reconciliation succeeds'
        );
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            0,
            'DONE status transition must not be recorded when STATUS_CHANGED append failed'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');

        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        const repairedEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            repairedEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            1
        );
        assert.equal(
            repairedEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            1
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate rerun repairs missing TASK.md DONE sync without duplicating STATUS_CHANGED telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-task-queue-repair';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-task-queue-repair.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Repair missing TASK.md DONE sync on completion rerun'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Completion task queue repair regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
        ].join('\n'), 'utf8');

        const error = await captureExpectedAsyncError(async () => {
            await handleCompletionGate([
                '--preflight-path', preflightPath,
                '--task-id', taskId,
                '--repo-root', repoRoot
            ]);
        });
        assert.match(error.message, /TASK\.md queue state could not be reconciled to DONE/i);
        assert.match(error.message, /gate completion-gate/i);

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0,
            'completion pass must not be recorded before TASK.md queue reconciliation succeeds'
        );
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            0,
            'STATUS_CHANGED to DONE must not be recorded before TASK.md queue reconciliation succeeds'
        );

        seedTaskQueue(repoRoot, taskId, '🟧 IN_REVIEW');
        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        const repairedEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            repairedEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            1
        );
        assert.equal(
            repairedEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            1,
            'repair rerun must reuse the existing DONE status transition instead of appending a duplicate'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('completion-gate restores the TASK.md snapshot after a partial write failure during DONE sync', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-task-queue-write-rollback';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-task-queue-write-rollback.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restore TASK.md snapshot after a partial queue write failure'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Completion TASK.md write rollback regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskPath = path.join(repoRoot, 'TASK.md');
        const baselineTaskContent = fs.readFileSync(taskPath, 'utf8');
        const fsModule = require('node:fs') as {
            writeFileSync: typeof fs.writeFileSync;
        };
        const originalWriteFileSync = fsModule.writeFileSync;
        let injectedWriteFailureConsumed = false;
        fsModule.writeFileSync = ((filePath: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
            if (
                !injectedWriteFailureConsumed
                && typeof filePath === 'string'
                && path.resolve(filePath) === path.resolve(taskPath)
            ) {
                injectedWriteFailureConsumed = true;
                originalWriteFileSync(filePath, '| corrupted |\n', options);
                throw new Error('Injected TASK.md write failure');
            }
            return originalWriteFileSync(filePath, data as never, options);
        }) as typeof fs.writeFileSync;

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /TASK\.md queue state could not be reconciled to DONE/i);
        } finally {
            fsModule.writeFileSync = originalWriteFileSync;
        }

        assert.equal(
            fs.readFileSync(taskPath, 'utf8'),
            baselineTaskContent,
            'TASK.md must be restored to its pre-finalization snapshot after a partial write failure'
        );

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0
        );
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            0
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');

        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        const repairedEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            repairedEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            1
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});

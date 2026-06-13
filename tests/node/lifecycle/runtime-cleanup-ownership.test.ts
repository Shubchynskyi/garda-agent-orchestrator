import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    findRuntimeCleanupOwnershipEntry,
    getRuntimeCleanupTaskPurgeModeForCandidateCategory,
    isRuntimeCleanupTaskPurgeDeletionCategory,
    listRuntimeCleanupSideEffectActionsForRemovedCategories,
    listRuntimeCleanupOwnershipEntries,
    listTaskPurgeableRuntimeCandidateCategories,
    resolveRuntimeCleanupStandardPaths
} from '../../../src/lifecycle/cleanup';

describe('runtime cleanup ownership contract', () => {
    it('defines each required runtime cleanup area exactly once', () => {
        const entries = listRuntimeCleanupOwnershipEntries();
        const ids = entries.map((entry) => entry.id);

        assert.deepEqual(ids, [...new Set(ids)], 'ownership entry ids must be unique');

        for (const requiredId of [
            'manual-validation-task-root',
            'plans-task-markdown',
            'project-memory-task-artifacts',
            'project-memory-bootstrap-report',
            'reviews-task-artifacts',
            'reviews-index',
            'task-events-timelines',
            'task-events-completeness-cache',
            'task-events-all-tasks-aggregate',
            'task-events-timeline-summary',
            'task-ledger-files',
            'tmp-review-scratch',
            'tmp-task-prefixed-root-artifacts',
            'tmp-generic-shared-scratch',
            'metrics-jsonl',
            'general-runtime-cleanup-zones'
        ]) {
            assert.ok(findRuntimeCleanupOwnershipEntry(requiredId), `missing ownership entry '${requiredId}'`);
        }
    });

    it('keeps task-scoped purgeable entries separate from shared aggregates and generated zones', () => {
        const entries = listRuntimeCleanupOwnershipEntries();
        const taskScoped = entries.filter((entry) => entry.ownership === 'task-scoped');
        const sharedState = entries.filter((entry) => entry.ownership !== 'task-scoped');

        assert.ok(taskScoped.length > 0, 'expected task-scoped ownership entries');
        assert.ok(sharedState.length > 0, 'expected shared or mixed ownership entries');

        for (const entry of taskScoped) {
            assert.notEqual(
                entry.taskPurgeMode,
                'exclude-from-task-purge',
                `task-scoped entry '${entry.id}' must be purgeable`
            );
            assert.match(
                entry.retentionMode,
                /task-age-or-count/,
                `task-scoped entry '${entry.id}' must follow task retention`
            );
        }

        for (const entry of sharedState.filter((item) => item.ownership !== 'mixed')) {
            assert.notEqual(
                entry.taskPurgeMode,
                'delete-owned-artifacts',
                `shared entry '${entry.id}' must not be treated like a plain task-owned delete`
            );
        }
    });

    it('documents shared side effects for aggregate and index artifacts', () => {
        const aggregateIds = [
            'reviews-task-artifacts',
            'reviews-index',
            'task-events-timelines',
            'task-events-completeness-cache',
            'task-events-all-tasks-aggregate',
            'task-events-timeline-summary',
            'metrics-jsonl'
        ];

        for (const id of aggregateIds) {
            const entry = findRuntimeCleanupOwnershipEntry(id);
            assert.ok(entry, `missing entry '${id}'`);
            assert.ok(
                entry.sharedSideEffects.length > 0 || entry.taskPurgeMode === 'prune-or-rebuild-shared-state-only',
                `entry '${id}' must describe shared prune/rebuild behavior`
            );
        }
    });

    it('drives task purge category and side-effect decisions from the ownership map', () => {
        assert.deepEqual(listTaskPurgeableRuntimeCandidateCategories(), [
            'manual-validation',
            'reviews',
            'task-events',
            'plans',
            'project-memory',
            'task-ledger',
            'tmp'
        ]);
        assert.deepEqual(
            listRuntimeCleanupSideEffectActionsForRemovedCategories(new Set(['reviews'])),
            ['invalidate-reviews-index']
        );
        assert.deepEqual(
            listRuntimeCleanupSideEffectActionsForRemovedCategories(new Set(['task-events'])),
            ['prune-all-tasks-aggregate', 'prune-timeline-summary']
        );
        assert.deepEqual(
            listRuntimeCleanupSideEffectActionsForRemovedCategories(new Set(['manual-validation', 'tmp'])),
            []
        );
        assert.equal(getRuntimeCleanupTaskPurgeModeForCandidateCategory('reviews'), 'delete-owned-artifacts-and-rebuild-shared-state');
        assert.equal(getRuntimeCleanupTaskPurgeModeForCandidateCategory('manual-validation'), 'delete-owned-artifacts');
        assert.equal(getRuntimeCleanupTaskPurgeModeForCandidateCategory('metrics'), null);
        assert.equal(isRuntimeCleanupTaskPurgeDeletionCategory('task-events'), true);
        assert.equal(isRuntimeCleanupTaskPurgeDeletionCategory('metrics'), false);
    });

    it('marks generic tmp scratch as non-task-purgeable and task-prefixed tmp artifacts as ownership-aware', () => {
        const taskPrefixed = findRuntimeCleanupOwnershipEntry('tmp-task-prefixed-root-artifacts');
        const genericScratch = findRuntimeCleanupOwnershipEntry('tmp-generic-shared-scratch');

        assert.equal(taskPrefixed?.ownership, 'mixed');
        assert.equal(taskPrefixed?.taskPurgeMode, 'delete-owned-artifacts');
        assert.equal(genericScratch?.ownership, 'shared-generated');
        assert.equal(genericScratch?.taskPurgeMode, 'exclude-from-task-purge');
    });

    it('keeps standard cleanup paths aligned with the canonical ownership map', () => {
        const standardPaths = resolveRuntimeCleanupStandardPaths('C:\\repo\\garda-agent-orchestrator\\runtime');
        const sharedZones = findRuntimeCleanupOwnershipEntry('general-runtime-cleanup-zones');

        assert.ok(sharedZones);
        assert.match(sharedZones.location, /\.test-scratch/);
        assert.ok(standardPaths.testScratchDir.endsWith('\\.test-scratch'));
        assert.ok(standardPaths.manualValidationDir.endsWith('\\manual-validation'));
        assert.ok(standardPaths.reviewsDir.endsWith('\\reviews'));
        assert.ok(standardPaths.taskEventsDir.endsWith('\\task-events'));
        assert.ok(standardPaths.projectMemoryDir.endsWith('\\project-memory'));
        assert.ok(standardPaths.taskLedgerDir.endsWith('\\task-ledger'));
        assert.ok(standardPaths.tmpDir.endsWith('\\tmp'));
    });
});

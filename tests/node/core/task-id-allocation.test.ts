import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    allocateNextParentDerivedTaskId,
    allocateParentDerivedTaskIds
} from '../../../src/core/task-id-allocation';

describe('core/task-id-allocation', () => {
    it('allocates child task ids from the parent numeric suffix space', () => {
        assert.deepEqual(
            allocateParentDerivedTaskIds({
                parentTaskId: 'T-506',
                existingTaskIds: ['T-506', 'T-506-1', 'T-506-3'],
                kind: 'child',
                count: 3
            }),
            ['T-506-2', 'T-506-4', 'T-506-5']
        );
    });

    it('allocates reviewer follow-up ids from the parent F suffix space', () => {
        assert.equal(
            allocateNextParentDerivedTaskId({
                parentTaskId: 'T-506',
                existingTaskIds: ['T-506', 'T-506-F1', 't-506-f2'],
                kind: 'followup'
            }),
            'T-506-F3'
        );
    });

    it('rejects invalid parent ids before generating child ids', () => {
        assert.throws(
            () => allocateParentDerivedTaskIds({
                parentTaskId: '../T-506',
                existingTaskIds: [],
                kind: 'child',
                count: 1
            }),
            /invalid parent task id/
        );
    });
});

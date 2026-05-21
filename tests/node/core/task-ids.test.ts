import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStructuredTaskArtifactTaskId } from '../../../src/core/task-ids';

test('parseStructuredTaskArtifactTaskId keeps lowercase follow-up suffix ownership', () => {
    assert.equal(
        parseStructuredTaskArtifactTaskId('T-506-f1-reset-report.json'),
        'T-506-f1'
    );
});

test('parseStructuredTaskArtifactTaskId keeps uppercase follow-up suffix ownership', () => {
    assert.equal(
        parseStructuredTaskArtifactTaskId('T-506-F1-reset-report.json'),
        'T-506-F1'
    );
});

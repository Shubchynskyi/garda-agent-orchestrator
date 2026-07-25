import test from 'node:test';
import assert from 'node:assert/strict';

import {
    REVIEW_TRIVIAL_CONTENT_LENGTH_THRESHOLD,
    REVIEW_TRIVIAL_FINDINGS_WORD_THRESHOLD,
    REVIEW_TRIVIAL_NO_REFERENCE_WORD_THRESHOLD,
    REVIEW_TRIVIAL_OUTPUT_THRESHOLD_MESSAGE,
    TASK_QUEUE_FILENAME
} from '../../../src/core/orchestration-constants';

test('orchestration constants preserve canonical task queue and review threshold values', () => {
    assert.equal(TASK_QUEUE_FILENAME, 'TASK.md');
    assert.equal(REVIEW_TRIVIAL_CONTENT_LENGTH_THRESHOLD, 100);
    assert.equal(REVIEW_TRIVIAL_FINDINGS_WORD_THRESHOLD, 30);
    assert.equal(REVIEW_TRIVIAL_NO_REFERENCE_WORD_THRESHOLD, 60);
    assert.equal(
        REVIEW_TRIVIAL_OUTPUT_THRESHOLD_MESSAGE,
        'Meaningful review artifacts must include implementation details and carry at least 100 characters of content.'
    );
});

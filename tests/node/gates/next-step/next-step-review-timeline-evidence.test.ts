import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
    getLatestTaskSequenceForEventTypes,
    NEXT_STEP_REVIEW_TIMELINE_READ_LIMITS,
    readTaskTimelineEventLikes,
    readTaskTimelineEventWindow
} from '../../../../src/gates/next-step/next-step-review-timeline-evidence';

function eventLine(sequence: number, eventType = 'NOISE'): string {
    return JSON.stringify({
        event_type: eventType,
        integrity: { task_sequence: sequence }
    });
}

test('next-step review timeline reader enforces event and parse bounds on the recent tail', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-bounded-timeline-'));
    try {
        const taskId = 'T-bounded-review-timeline';
        const timelinePath = path.join(root, `${taskId}.jsonl`);
        const totalEvents = NEXT_STEP_REVIEW_TIMELINE_READ_LIMITS.maxEvents + 3;
        const lines = Array.from({ length: totalEvents }, (_, index) => eventLine(
            index + 1,
            index === 0 ? 'TASK_MODE_ENTERED' : index === totalEvents - 1 ? 'REVIEW_RECORDED' : 'NOISE'
        ));
        fs.writeFileSync(timelinePath, lines.join('\n') + '\n', 'utf8');

        const window = readTaskTimelineEventWindow(root, taskId);

        assert.equal(window.truncated, true);
        assert.equal(window.invalidJson, false);
        assert.equal(window.events.length, NEXT_STEP_REVIEW_TIMELINE_READ_LIMITS.maxEvents);
        assert.equal(window.parseAttempts, NEXT_STEP_REVIEW_TIMELINE_READ_LIMITS.maxEvents);
        assert.equal(
            getLatestTaskSequenceForEventTypes(root, taskId, ['REVIEW_RECORDED']),
            totalEvents
        );
        assert.equal(
            getLatestTaskSequenceForEventTypes(root, taskId, ['TASK_MODE_ENTERED']),
            null,
            'required evidence outside the retained tail must not be inferred'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('next-step review timeline reader fails closed on malformed retained JSON', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-invalid-timeline-'));
    try {
        const taskId = 'T-invalid-review-timeline';
        fs.writeFileSync(
            path.join(root, `${taskId}.jsonl`),
            `${eventLine(1, 'TASK_MODE_ENTERED')}\n{"event_type":\n${eventLine(3, 'REVIEW_RECORDED')}\n`,
            'utf8'
        );

        const window = readTaskTimelineEventWindow(root, taskId);

        assert.equal(window.invalidJson, true);
        assert.deepEqual(window.events, []);
        assert.deepEqual(readTaskTimelineEventLikes(root, taskId), []);
        assert.equal(getLatestTaskSequenceForEventTypes(root, taskId, ['REVIEW_RECORDED']), null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

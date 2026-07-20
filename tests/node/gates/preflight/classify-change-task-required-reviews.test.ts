import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyTaskRequiredReviewDeclaration,
    resolveTaskRequiredReviewDeclaration
} from '../../../../src/gates/preflight/classify-change-task-required-reviews';
import { getDefaultReviewCapabilities } from '../../../../src/core/review-capabilities';

describe('task required-review declaration', () => {
    it('applies an exact task-owned review declaration', () => {
        const declaration = resolveTaskRequiredReviewDeclaration({
            taskId: 'T-979-33-3',
            notes: 'Scope: guarded UI flow. Required reviews: code, api, test. Parent guard preserved.',
            reviewCapabilities: getDefaultReviewCapabilities()
        });
        const requiredReviews = { code: false, api: false, test: false };

        applyTaskRequiredReviewDeclaration(requiredReviews, declaration);

        assert.deepEqual(declaration, {
            source: 'task_queue_notes',
            declared_reviews: ['code', 'api', 'test'],
            applied_reviews: ['code', 'api', 'test']
        });
        assert.deepEqual(requiredReviews, { code: true, api: true, test: true });
    });

    it('ignores incidental prose that is not an explicit declaration sentence', () => {
        assert.equal(resolveTaskRequiredReviewDeclaration({
            taskId: 'T-1',
            notes: 'No required reviews are declared for this documentation note.',
            reviewCapabilities: getDefaultReviewCapabilities()
        }), null);
    });

    it('fails closed with an exact reason for unknown, duplicate, and malformed lanes', () => {
        const capabilities = getDefaultReviewCapabilities();
        assert.throws(
            () => resolveTaskRequiredReviewDeclaration({
                taskId: 'T-unknown',
                notes: 'Required reviews: code, ux.',
                reviewCapabilities: capabilities
            }),
            /Task 'T-unknown' has invalid TASK\.md required-review declaration: unknown lane 'ux'\. Allowed lanes:/
        );
        assert.throws(
            () => resolveTaskRequiredReviewDeclaration({
                taskId: 'T-duplicate',
                notes: 'Required reviews: code, code.',
                reviewCapabilities: capabilities
            }),
            /lane 'code' is declared more than once/
        );
        assert.throws(
            () => resolveTaskRequiredReviewDeclaration({
                taskId: 'T-malformed',
                notes: 'Required reviews code, api.',
                reviewCapabilities: capabilities
            }),
            /expected the exact form "Required reviews: lane, lane\."/
        );
    });

    it('fails closed when a declared lane is unavailable', () => {
        assert.throws(
            () => resolveTaskRequiredReviewDeclaration({
                taskId: 'T-unavailable',
                notes: 'Required reviews: code, api.',
                reviewCapabilities: { ...getDefaultReviewCapabilities(), api: false }
            }),
            /review lane 'api' is unavailable because review-capabilities\.api is not enabled/
        );
    });
});

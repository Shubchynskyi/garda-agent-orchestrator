import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    getScopedDiffMetadataReadiness,
    readReviewArtifactState,
    readReviewTrust,
    reviewReceiptDomainScopeMatchesCurrentPreflight,
    scopedDiffExpectedForReview
} from '../../../../src/gates/next-step/next-step-review-artifact-readers';

function tempRoot(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('readReviewArtifactState reports missing review artifacts without route decisions', () => {
    const reviewsRoot = tempRoot('garda-next-step-review-readers-');
    const preflightPath = path.join(reviewsRoot, 'T-100-preflight.json');

    const state = readReviewArtifactState(
        reviewsRoot,
        'T-100',
        'code',
        preflightPath,
        null,
        null
    );

    assert.equal(state.reviewType, 'code');
    assert.equal(state.ready, false);
    assert.equal(state.contextExists, false);
    assert.equal(state.artifactExists, false);
    assert.equal(state.receiptExists, false);
    assert.deepEqual(state.violations, [
        'review context artifact is missing',
        'review artifact is missing',
        'review receipt is missing'
    ]);
});

test('getScopedDiffMetadataReadiness rejects missing and empty scoped diff metadata', () => {
    const reviewsRoot = tempRoot('garda-next-step-scoped-readers-');
    const metadataPath = path.join(reviewsRoot, 'T-100-code-scoped.json');
    const preflightPath = path.join(reviewsRoot, 'T-100-preflight.json');

    const missing = getScopedDiffMetadataReadiness({
        metadataPath,
        preflight: null,
        preflightPath,
        preflightSha256: null,
        reviewType: 'code'
    });
    assert.equal(missing.ready, false);
    assert.match(missing.reason, /Scoped diff metadata is missing/);

    fs.writeFileSync(metadataPath, JSON.stringify({ output_diff_line_count: 0 }));
    const empty = getScopedDiffMetadataReadiness({
        metadataPath,
        preflight: null,
        preflightPath,
        preflightSha256: null,
        reviewType: 'code'
    });
    assert.equal(empty.ready, false);
    assert.match(empty.reason, /has no output diff lines/);
});

test('review receipt domain matching fails closed for mismatched review type or missing scope', () => {
    assert.equal(reviewReceiptDomainScopeMatchesCurrentPreflight(
        { review_type: 'code' },
        { review_type: 'test' },
        { metrics: {} }
    ), false);
    assert.equal(reviewReceiptDomainScopeMatchesCurrentPreflight(
        { review_type: 'code' },
        null,
        { metrics: {} }
    ), false);
});

test('reader helpers expose scoped diff expectation and trust summary surfaces', () => {
    const reviewsRoot = tempRoot('garda-next-step-trust-readers-');
    assert.equal(scopedDiffExpectedForReview({ preflight: null, reviewType: 'code' }), false);

    const summary = readReviewTrust(reviewsRoot, 'T-100', ['code'], 'mixed');
    assert.ok(summary);
    assert.equal(summary.status, 'UNAVAILABLE');
});

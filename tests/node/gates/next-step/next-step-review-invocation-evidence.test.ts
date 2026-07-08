import test from 'node:test';
import assert from 'node:assert/strict';

import {
    readReviewArtifactState
} from '../../../../src/gates/next-step/next-step-review-artifact-readers';
import {
    timelineHasDelegatedReviewInvocationAttestation,
    timelineHasHistoricalDelegatedReviewInvocationAttestation
} from '../../../../src/gates/next-step/next-step-review-invocation-evidence';
import {
    ALL_REVIEW_FLAGS,
    eventsRoot,
    fileSha256,
    fs,
    makeTempRepo,
    path,
    reviewsRoot,
    seedCompilePass,
    seedStartedTask,
    TASK_ID,
    writePreflight,
    writeReviewEvidence
} from './next-step-review-reuse-fixtures';

function readState(repoRoot: string, reviewType: string) {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
    return readReviewArtifactState(
        reviewsRoot(repoRoot),
        TASK_ID,
        reviewType,
        preflightPath,
        fileSha256(preflightPath),
        JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>,
        repoRoot
    );
}

function seedReviewedRepo(options: { includeLaunchArtifact?: boolean } = {}): string {
    const repoRoot = makeTempRepo();
    seedStartedTask(repoRoot, TASK_ID);
    writePreflight(repoRoot, TASK_ID, {
        ...ALL_REVIEW_FLAGS,
        code: true
    }, {
        includeDomainScopeFingerprints: true
    });
    seedCompilePass(repoRoot, TASK_ID);
    writeReviewEvidence(repoRoot, TASK_ID, 'code', options);
    return repoRoot;
}

test('current delegated review invocation evidence requires the launched reviewer artifact binding', () => {
    const repoRoot = seedReviewedRepo();
    const state = readState(repoRoot, 'code');

    assert.equal(
        timelineHasDelegatedReviewInvocationAttestation(repoRoot, eventsRoot(repoRoot), TASK_ID, state),
        true
    );
    assert.equal(
        timelineHasHistoricalDelegatedReviewInvocationAttestation(eventsRoot(repoRoot), TASK_ID, state),
        true
    );
});

test('historical delegated review invocation evidence does not stand in for current launch binding', () => {
    const repoRoot = seedReviewedRepo({ includeLaunchArtifact: false });
    const state = readState(repoRoot, 'code');

    assert.equal(
        timelineHasDelegatedReviewInvocationAttestation(repoRoot, eventsRoot(repoRoot), TASK_ID, state),
        false
    );
    assert.equal(
        timelineHasHistoricalDelegatedReviewInvocationAttestation(eventsRoot(repoRoot), TASK_ID, state),
        true
    );
});

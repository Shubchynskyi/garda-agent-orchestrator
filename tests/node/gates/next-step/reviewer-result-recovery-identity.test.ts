import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveReviewerResultRecoveryIdentity
} from '../../../../src/gates/review/security/reviewer-result-recovery-identity';

test('stale receipt identity does not conflict with the current delegated launch', () => {
    const resolution = resolveReviewerResultRecoveryIdentity({
        launchState: 'launched',
        launchReviewerIdentity: 'agent:current-reviewer',
        receiptReviewerIdentity: 'agent:stale-reviewer',
        receiptIdentityCurrent: false,
        contextReviewerIdentity: 'agent:pending:T-100-code',
        receivingGateCanResolveCurrentAttempt: false
    });

    assert.deepEqual(resolution, {
        ready: true,
        reviewerIdentity: 'agent:current-reviewer',
        identitySource: 'explicit_resolved_attempt'
    });
});

test('current conflicting receipt identity remains fail closed', () => {
    const resolution = resolveReviewerResultRecoveryIdentity({
        launchState: 'launched',
        launchReviewerIdentity: 'agent:current-reviewer',
        receiptReviewerIdentity: 'agent:other-current-reviewer',
        receiptIdentityCurrent: true,
        contextReviewerIdentity: 'agent:current-reviewer',
        receivingGateCanResolveCurrentAttempt: false
    });

    assert.deepEqual(resolution, {
        ready: false,
        reason: 'conflicting_resolved_identities'
    });
});

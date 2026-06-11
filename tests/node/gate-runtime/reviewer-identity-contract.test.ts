import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildPlannedReviewerIdentity,
    isPlannedReviewerIdentity,
    isResolvedReviewerIdentity,
    resolveLaunchBindingReviewerIdentity,
    reviewerIdentityMatchesDelegatedLaunchCycle
} from '../../../src/gate-runtime/review/reviewer-identity-contract';

describe('gate-runtime/review reviewer-identity-contract', () => {
    it('builds stable planned reviewer identities', () => {
        assert.equal(
            buildPlannedReviewerIdentity('T-776-F1', 'code'),
            'agent:pending:T-776-F1-code'
        );
        assert.equal(isPlannedReviewerIdentity('agent:pending:T-776-F1-code'), true);
        assert.equal(isResolvedReviewerIdentity('agent:pending:T-776-F1-code'), false);
        assert.equal(isResolvedReviewerIdentity('agent:cursor-task-123'), true);
    });

    it('keeps launch binding identity on the planned reviewer identity after resolve', () => {
        const planned = buildPlannedReviewerIdentity('T-776-F1', 'code');
        const resolved = 'agent:cursor-task-123';
        assert.equal(
            resolveLaunchBindingReviewerIdentity({
                taskId: 'T-776-F1',
                reviewType: 'code',
                artifactReviewerIdentity: planned,
                plannedReviewerIdentity: planned
            }),
            planned
        );
        assert.equal(
            resolveLaunchBindingReviewerIdentity({
                taskId: 'T-776-F1',
                reviewType: 'code',
                artifactReviewerIdentity: resolved,
                plannedReviewerIdentity: planned
            }),
            planned
        );
    });

    it('matches delegated launch cycles across planned and resolved identities', () => {
        const planned = buildPlannedReviewerIdentity('T-776-F1', 'code');
        const resolved = 'agent:cursor-task-123';
        assert.equal(
            reviewerIdentityMatchesDelegatedLaunchCycle({
                observedIdentity: resolved,
                expectedIdentity: planned,
                taskId: 'T-776-F1',
                reviewType: 'code',
                plannedReviewerIdentity: planned,
                artifactPlannedReviewerIdentity: planned
            }),
            true
        );
        assert.equal(
            reviewerIdentityMatchesDelegatedLaunchCycle({
                observedIdentity: planned,
                expectedIdentity: resolved,
                taskId: 'T-776-F1',
                reviewType: 'code',
                plannedReviewerIdentity: planned,
                artifactPlannedReviewerIdentity: planned
            }),
            true
        );
        assert.equal(
            reviewerIdentityMatchesDelegatedLaunchCycle({
                observedIdentity: planned,
                expectedIdentity: planned,
                taskId: 'T-776-F1',
                reviewType: 'code',
                plannedReviewerIdentity: planned
            }),
            true
        );
        assert.equal(
            reviewerIdentityMatchesDelegatedLaunchCycle({
                observedIdentity: 'agent:other-reviewer',
                expectedIdentity: planned,
                taskId: 'T-776-F1',
                reviewType: 'code',
                plannedReviewerIdentity: planned,
                artifactPlannedReviewerIdentity: 'agent:pending:other-task-code'
            }),
            false
        );
    });

    it('rejects different resolved reviewer identities after a launch is rebound', () => {
        const planned = buildPlannedReviewerIdentity('T-776-F1', 'code');
        const resolved = 'agent:cursor-task-123';
        assert.equal(
            reviewerIdentityMatchesDelegatedLaunchCycle({
                observedIdentity: 'agent:cursor-task-456',
                expectedIdentity: planned,
                taskId: 'T-776-F1',
                reviewType: 'code',
                plannedReviewerIdentity: planned,
                artifactPlannedReviewerIdentity: planned,
                artifactResolvedReviewerIdentity: resolved
            }),
            false
        );
        assert.equal(
            reviewerIdentityMatchesDelegatedLaunchCycle({
                observedIdentity: resolved,
                expectedIdentity: planned,
                taskId: 'T-776-F1',
                reviewType: 'code',
                plannedReviewerIdentity: planned,
                artifactPlannedReviewerIdentity: planned,
                artifactResolvedReviewerIdentity: resolved
            }),
            true
        );
    });
});

import {
    isPlannedReviewerIdentity,
    isResolvedReviewerIdentity
} from '../../../gate-runtime/review/reviewer-identity-contract';
import type {
    DelegatedReviewLaunchArtifactState
} from '../../next-step/next-step-review-readiness-routing';

export type ReviewerResultRecoveryIdentityFailureReason =
    | 'current_attempt_not_launched'
    | 'planned_identity_only'
    | 'resolved_identity_missing'
    | 'conflicting_resolved_identities';

export type ReviewerResultRecoveryIdentityResolution =
    | {
        ready: true;
        reviewerIdentity: string | null;
        identitySource: 'explicit_resolved_attempt' | 'receiving_gate_current_attempt';
    }
    | {
        ready: false;
        reason: ReviewerResultRecoveryIdentityFailureReason;
    };

export function resolveReviewerResultRecoveryIdentity(options: {
    launchState: DelegatedReviewLaunchArtifactState;
    launchReviewerIdentity: string | null;
    receiptReviewerIdentity: string | null;
    contextReviewerIdentity: string | null;
    receivingGateCanResolveCurrentAttempt: boolean;
}): ReviewerResultRecoveryIdentityResolution {
    if (options.launchState !== 'launched') {
        return {
            ready: false,
            reason: 'current_attempt_not_launched'
        };
    }

    const launchReviewerIdentity = String(options.launchReviewerIdentity || '').trim();
    const supportingIdentityCandidates = [
        options.receiptReviewerIdentity,
        options.contextReviewerIdentity
    ].map((identity) => String(identity || '').trim()).filter(Boolean);
    if (isPlannedReviewerIdentity(launchReviewerIdentity)) {
        return {
            ready: false,
            reason: 'planned_identity_only'
        };
    }
    if (isResolvedReviewerIdentity(launchReviewerIdentity)) {
        const mismatchedResolvedIdentity = supportingIdentityCandidates
            .filter(isResolvedReviewerIdentity)
            .some((identity) => identity !== launchReviewerIdentity);
        if (mismatchedResolvedIdentity) {
            return {
                ready: false,
                reason: 'conflicting_resolved_identities'
            };
        }
        return {
            ready: true,
            reviewerIdentity: launchReviewerIdentity,
            identitySource: 'explicit_resolved_attempt'
        };
    }

    const identityCandidates = [launchReviewerIdentity, ...supportingIdentityCandidates].filter(Boolean);
    const unboundResolvedIdentities = [...new Set(
        supportingIdentityCandidates.filter(isResolvedReviewerIdentity)
    )];
    if (unboundResolvedIdentities.length > 1) {
        return {
            ready: false,
            reason: 'conflicting_resolved_identities'
        };
    }
    if (identityCandidates.some(isPlannedReviewerIdentity)) {
        return {
            ready: false,
            reason: 'planned_identity_only'
        };
    }
    if (unboundResolvedIdentities.length > 0) {
        return {
            ready: false,
            reason: 'resolved_identity_missing'
        };
    }
    if (options.receivingGateCanResolveCurrentAttempt && identityCandidates.length === 0) {
        return {
            ready: true,
            reviewerIdentity: null,
            identitySource: 'receiving_gate_current_attempt'
        };
    }
    return {
        ready: false,
        reason: 'resolved_identity_missing'
    };
}

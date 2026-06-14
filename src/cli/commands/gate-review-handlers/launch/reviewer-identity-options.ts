import {
    normalizeCompatibilityReviewerExecutionMode,
} from '../../../../gate-runtime/review-context';
import {
    REVIEW_EVIDENCE_AGENT_IDENTITY_PREFIX,
    REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE
} from '../../../../gates/review/review-evidence-contract';
import {
    buildPlannedReviewerIdentity,
    isPlannedReviewerIdentity,
    isResolvedReviewerIdentity
} from '../../../../gate-runtime/review/reviewer-identity-contract';
import {
    type ParsedOptionsRecord
} from '../../shared-command-utils';

export interface ParsedReviewerIdentity {
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewerFallbackReason: string | null;
}

export interface ParseReviewerIdentityOptions {
    allowPlannedIdentity?: boolean;
    requireResolvedIdentity?: boolean;
}

export function resolveReviewerIdentityOption(
    options: ParsedOptionsRecord,
    taskId: string,
    reviewType: string
): string {
    const explicitIdentity = options.reviewerIdentity
        ? String(options.reviewerIdentity).trim()
        : '';
    if (explicitIdentity) {
        return explicitIdentity;
    }
    return buildPlannedReviewerIdentity(taskId, reviewType);
}

export function parseReviewerIdentity(
    options: ParsedOptionsRecord,
    modeRequiredMessage: string,
    identityOptions: ParseReviewerIdentityOptions = {}
): ParsedReviewerIdentity {
    const rawReviewerExecutionMode = options.reviewerExecutionMode
        ? String(options.reviewerExecutionMode).trim()
        : null;
    const reviewerExecutionMode = normalizeCompatibilityReviewerExecutionMode(rawReviewerExecutionMode);
    const reviewerIdentity = options.reviewerIdentity
        ? String(options.reviewerIdentity).trim()
        : null;
    const reviewerFallbackReason = options.reviewerFallbackReason
        ? String(options.reviewerFallbackReason).trim()
        : null;

    if (!reviewerExecutionMode) {
        if (rawReviewerExecutionMode) {
            throw new Error(
                `ReviewerExecutionMode '${rawReviewerExecutionMode}' is invalid. ` +
                "Expected 'delegated_subagent'."
            );
        }
        throw new Error(modeRequiredMessage);
    }
    if (reviewerExecutionMode !== REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE) {
        throw new Error(
            `ReviewerExecutionMode '${reviewerExecutionMode}' is no longer supported. ` +
            "Mandatory reviews must use 'delegated_subagent'."
        );
    }
    if (!reviewerIdentity) {
        throw new Error('ReviewerIdentity is required.');
    }
    if (reviewerIdentity.startsWith('self:')) {
        throw new Error('Delegated review evidence cannot use a self-scoped reviewer identity.');
    }
    if (isPlannedReviewerIdentity(reviewerIdentity)) {
        if (identityOptions.requireResolvedIdentity) {
            throw new Error(
                'Delegated review evidence requires a resolved agent-scoped reviewer identity from the provider launch result; ' +
                'planned pending identities are not valid here.'
            );
        }
        if (!identityOptions.allowPlannedIdentity) {
            throw new Error(
                'Planned reviewer identity is not accepted for this gate. ' +
                'Omit --reviewer-identity to let the gate assign a pending identity, or pass a resolved agent: identity from the provider.'
            );
        }
    } else if (!isResolvedReviewerIdentity(reviewerIdentity)) {
        throw new Error(`Delegated review evidence requires an agent-scoped reviewer identity (prefix '${REVIEW_EVIDENCE_AGENT_IDENTITY_PREFIX}').`);
    }
    if (reviewerFallbackReason) {
        throw new Error(
            'ReviewerFallbackReason is not supported for delegated_subagent review evidence. ' +
            'Remove --reviewer-fallback-reason and rerun the delegated reviewer flow.'
        );
    }

    return {
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason
    };
}

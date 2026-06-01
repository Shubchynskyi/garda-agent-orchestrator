import {
    normalizeCompatibilityReviewerExecutionMode,
} from '../../../../gate-runtime/review-context';
import {
    type ParsedOptionsRecord
} from '../../shared-command-utils';

export interface ParsedReviewerIdentity {
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewerFallbackReason: string | null;
}

export function parseReviewerIdentity(options: ParsedOptionsRecord, modeRequiredMessage: string): ParsedReviewerIdentity {
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
    if (reviewerExecutionMode !== 'delegated_subagent') {
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
    if (!reviewerIdentity.startsWith('agent:')) {
        throw new Error("Delegated review evidence requires an agent-scoped reviewer identity (prefix 'agent:').");
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

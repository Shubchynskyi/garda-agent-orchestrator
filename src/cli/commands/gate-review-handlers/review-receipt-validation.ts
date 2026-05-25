import {
    normalizeCompatibilityReviewerExecutionMode
} from '../../../gate-runtime/review-context';
import {
    normalizePath
} from '../../../gates/helpers';

interface AssertReviewReceiptRoutingMatchesContextOptions {
    reviewType: string;
    contextPath: string;
    currentRouting: Record<string, unknown> | null;
    reviewerExecutionMode: string;
    reviewerIdentity: string;
    reviewerFallbackReason: string | null;
}

export function assertReviewReceiptRoutingMatchesContext(
    options: AssertReviewReceiptRoutingMatchesContextOptions
): void {
    const currentExecutionMode = normalizeCompatibilityReviewerExecutionMode(
        options.currentRouting?.actual_execution_mode
    );
    const currentReviewerSessionId = options.currentRouting?.reviewer_session_id != null
        ? String(options.currentRouting.reviewer_session_id).trim()
        : '';
    if (currentExecutionMode !== options.reviewerExecutionMode) {
        throw new Error(
            `Review receipt execution mode (${options.reviewerExecutionMode}) must match pre-recorded ` +
            `reviewer_routing.actual_execution_mode (${currentExecutionMode || 'missing'}) in ${normalizePath(options.contextPath)}. ` +
            'Record review routing before writing the receipt.'
        );
    }
    if (!currentReviewerSessionId) {
        throw new Error(
            `Review receipts require pre-recorded reviewer_routing.reviewer_session_id in ${normalizePath(options.contextPath)}. ` +
            'Record review routing before writing the receipt.'
        );
    }
    if (currentReviewerSessionId !== options.reviewerIdentity) {
        throw new Error(
            `Review receipt reviewer identity (${options.reviewerIdentity}) must match pre-recorded ` +
            `reviewer_routing.reviewer_session_id (${currentReviewerSessionId}).`
        );
    }
    const currentFallbackReason = options.currentRouting?.fallback_reason != null
        ? String(options.currentRouting.fallback_reason).trim()
        : '';
    if (
        options.reviewerExecutionMode === 'delegated_subagent' &&
        currentFallbackReason !== (options.reviewerFallbackReason || '')
    ) {
        throw new Error(
            `Review receipt fallback reason (${options.reviewerFallbackReason || 'missing'}) must match pre-recorded ` +
            `reviewer_routing.fallback_reason (${currentFallbackReason || 'missing'}).`
        );
    }
}

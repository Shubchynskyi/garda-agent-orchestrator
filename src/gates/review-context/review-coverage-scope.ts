import {
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint
} from '../review-reuse/review-reuse';

export function resolveReviewCoverageChangedFiles(options: {
    reviewType: string;
    preflight: Record<string, unknown>;
    repoRoot: string;
}): string[] {
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    return reviewType === 'test'
        ? computeReviewRelevantScopeFingerprint(
            options.preflight,
            options.repoRoot
        ).review_relevant_changed_files
        : computeReviewReuseCodeScopeFingerprint(
            reviewType,
            options.preflight,
            options.repoRoot
        ).non_test_changed_files;
}

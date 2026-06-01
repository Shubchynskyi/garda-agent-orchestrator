// Extracted from required-reviews-check.ts; keep behavior changes in the facade tests.
export {
    REVIEW_CONTRACTS,
    parseSkipReviews,
    resolveExpectedReviewVerdicts,
    testExpectedVerdict,
    validatePreflightForReview
} from './required-reviews-check-contracts';
export {
    type ReviewArtifactEntry
} from './required-reviews-check-evidence';
export {
    type ReviewArtifactGateEligibilityResult,
    validateReviewArtifactGateEligibility
} from './required-reviews-check-trust';
export {
    checkRequiredReviews,
    detectZeroDiffFromPreflight,
    type CheckRequiredReviewsOptions,
    type ZeroDiffReviewGuardResult,
    validateZeroDiffForReviewGate
} from './required-reviews-check-output';

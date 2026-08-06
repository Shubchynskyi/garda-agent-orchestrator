import {
    buildReviewCoverageContract,
    type ReviewCoverageContract
} from '../review/review-coverage-ledger';
import { resolveReviewCoverageChangedFiles } from './review-coverage-scope';
import { resolveReviewCoverageCategoryIdsFromPreflight } from './review-context-lane';

export interface AuthoritativeReviewCoverageContract {
    changedFiles: string[];
    categoryIds: readonly string[] | undefined;
    contract: ReviewCoverageContract;
}

export function buildAuthoritativeReviewCoverageContract(options: {
    reviewType: string;
    preflight: Record<string, unknown>;
    repoRoot: string;
}): AuthoritativeReviewCoverageContract {
    const changedFiles = resolveReviewCoverageChangedFiles({
        reviewType: options.reviewType,
        preflight: options.preflight,
        repoRoot: options.repoRoot
    });
    const categoryIds = resolveReviewCoverageCategoryIdsFromPreflight(
        options.preflight,
        options.reviewType
    );
    return {
        changedFiles,
        categoryIds,
        contract: buildReviewCoverageContract({
            reviewType: options.reviewType,
            changedFiles,
            categoryIds
        })
    };
}

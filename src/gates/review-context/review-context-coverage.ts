import {
    buildReviewCoverageContract,
    type ReviewCoverageContract
} from '../review/review-coverage-ledger';
import { resolveReviewCoverageChangedFiles } from './review-coverage-scope';
import { resolveReviewCoverageCategoryIdsFromPreflight } from './review-context-lane';

export interface AuthoritativeReviewCoverageScope {
    changedFiles: string[];
    categoryIds: readonly string[] | undefined;
}

export interface AuthoritativeReviewCoverageContract extends AuthoritativeReviewCoverageScope {
    contract: ReviewCoverageContract;
}

export function resolveAuthoritativeReviewCoverageScope(options: {
    reviewType: string;
    preflight: Record<string, unknown>;
    repoRoot: string;
}): AuthoritativeReviewCoverageScope {
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
        categoryIds
    };
}

export function buildAuthoritativeReviewCoverageContract(options: {
    reviewType: string;
    preflight: Record<string, unknown>;
    repoRoot: string;
}): AuthoritativeReviewCoverageContract {
    const scope = resolveAuthoritativeReviewCoverageScope(options);
    return {
        ...scope,
        contract: buildReviewCoverageContract({
            reviewType: options.reviewType,
            changedFiles: scope.changedFiles,
            categoryIds: scope.categoryIds
        })
    };
}

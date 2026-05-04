import * as path from 'node:path';
import * as gateHelpers from './helpers';

export const REVIEW_SCRATCH_RELATIVE_ROOT = path.join('runtime', 'tmp', 'reviews');
export const LEGACY_REVIEW_TEMP_DIRECTORY = '.review-temp';

export function resolveReviewScratchRoot(repoRoot: string): string {
    return gateHelpers.joinOrchestratorPath(repoRoot, REVIEW_SCRATCH_RELATIVE_ROOT);
}

export function resolveLegacyReviewTempRoot(repoRoot: string): string {
    return path.resolve(repoRoot, LEGACY_REVIEW_TEMP_DIRECTORY);
}

export function resolveReviewScratchRoots(repoRoot: string): string[] {
    const roots = [
        resolveReviewScratchRoot(repoRoot),
        resolveLegacyReviewTempRoot(repoRoot)
    ].map((root) => path.resolve(root));
    return [...new Set(roots)];
}

export function resolveDefaultReviewScratchPath(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    fileName: string
): string {
    return path.join(resolveReviewScratchRoot(repoRoot), taskId, reviewType, fileName);
}

export function buildDefaultReviewScratchCommandPath(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    fileName: string
): string {
    return gateHelpers.normalizePath(path.relative(
        repoRoot,
        resolveDefaultReviewScratchPath(repoRoot, taskId, reviewType, fileName)
    ));
}

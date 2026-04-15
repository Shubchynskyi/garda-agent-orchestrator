import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizePath, resolvePathInsideRepo } from './helpers';

function isFile(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

export function getCanonicalReviewContextPath(reviewsRoot: string, taskId: string | null, reviewType: string): string {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    if (!taskId) {
        return path.join(reviewsRoot, `${normalizedReviewType}-review-context.json`);
    }
    return path.join(reviewsRoot, `${taskId}-${normalizedReviewType}-review-context.json`);
}

export function getLegacyDefaultReviewContextPath(reviewsRoot: string, taskId: string | null, reviewType: string): string {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    if (!taskId) {
        return path.join(reviewsRoot, `${normalizedReviewType}-context.json`);
    }
    return path.join(reviewsRoot, `${taskId}-${normalizedReviewType}-context.json`);
}

function materializeCanonicalCopyFromLegacy(canonicalPath: string, legacyPath: string): string {
    if (!isFile(canonicalPath) && isFile(legacyPath)) {
        fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
        fs.copyFileSync(legacyPath, canonicalPath);
    }
    return canonicalPath;
}

export function resolveCanonicalReviewContextPath(options: {
    reviewsRoot: string;
    taskId: string | null;
    reviewType: string;
    explicitPath?: string | null | undefined;
    repoRoot?: string | null | undefined;
}): string {
    const canonicalPath = getCanonicalReviewContextPath(options.reviewsRoot, options.taskId, options.reviewType);
    const legacyPath = getLegacyDefaultReviewContextPath(options.reviewsRoot, options.taskId, options.reviewType);
    const rawExplicitPath = String(options.explicitPath || '').trim();
    if (!rawExplicitPath) {
        if (isFile(canonicalPath)) {
            return canonicalPath;
        }
        if (isFile(legacyPath)) {
            return materializeCanonicalCopyFromLegacy(canonicalPath, legacyPath);
        }
        return canonicalPath;
    }

    const resolvedExplicitPath = options.repoRoot
        ? resolvePathInsideRepo(rawExplicitPath, String(options.repoRoot || ''), { allowMissing: true })
        : path.resolve(rawExplicitPath);
    if (!resolvedExplicitPath) {
        return canonicalPath;
    }

    if (normalizePath(resolvedExplicitPath) === normalizePath(legacyPath)) {
        return materializeCanonicalCopyFromLegacy(canonicalPath, legacyPath);
    }
    return resolvedExplicitPath;
}

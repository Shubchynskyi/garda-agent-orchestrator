import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPathRealpathInsideRoot, normalizePath, resolvePathInsideRepo } from '../shared/helpers';

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

function assertReviewContextPathRealpathSafe(options: {
    candidatePath: string;
    reviewsRoot: string;
    repoRoot?: string | null | undefined;
    allowMissing?: boolean;
}): string {
    const resolvedPath = path.resolve(options.candidatePath);
    if (!isPathRealpathInsideRoot(resolvedPath, options.reviewsRoot, { allowMissing: options.allowMissing === true })) {
        throw new Error(`Review context path must resolve inside reviews root: ${normalizePath(resolvedPath)}.`);
    }
    if (
        options.repoRoot
        && !isPathRealpathInsideRoot(resolvedPath, String(options.repoRoot), { allowMissing: options.allowMissing === true })
    ) {
        throw new Error(`Review context path must resolve inside repo root: ${normalizePath(resolvedPath)}.`);
    }
    return resolvedPath;
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
            return assertReviewContextPathRealpathSafe({
                candidatePath: canonicalPath,
                reviewsRoot: options.reviewsRoot,
                repoRoot: options.repoRoot
            });
        }
        if (isFile(legacyPath)) {
            const safeLegacyPath = assertReviewContextPathRealpathSafe({
                candidatePath: legacyPath,
                reviewsRoot: options.reviewsRoot,
                repoRoot: options.repoRoot
            });
            const safeCanonicalPath = assertReviewContextPathRealpathSafe({
                candidatePath: canonicalPath,
                reviewsRoot: options.reviewsRoot,
                repoRoot: options.repoRoot,
                allowMissing: true
            });
            return materializeCanonicalCopyFromLegacy(safeCanonicalPath, safeLegacyPath);
        }
        return assertReviewContextPathRealpathSafe({
            candidatePath: canonicalPath,
            reviewsRoot: options.reviewsRoot,
            repoRoot: options.repoRoot,
            allowMissing: true
        });
    }

    const resolvedExplicitPath = options.repoRoot
        ? resolvePathInsideRepo(rawExplicitPath, String(options.repoRoot || ''), { allowMissing: true })
        : path.resolve(rawExplicitPath);
    if (!resolvedExplicitPath) {
        return canonicalPath;
    }

    const safeExplicitPath = assertReviewContextPathRealpathSafe({
        candidatePath: resolvedExplicitPath,
        reviewsRoot: options.reviewsRoot,
        repoRoot: options.repoRoot,
        allowMissing: true
    });
    if (normalizePath(safeExplicitPath) === normalizePath(legacyPath)) {
        const safeCanonicalPath = assertReviewContextPathRealpathSafe({
            candidatePath: canonicalPath,
            reviewsRoot: options.reviewsRoot,
            repoRoot: options.repoRoot,
            allowMissing: true
        });
        return materializeCanonicalCopyFromLegacy(safeCanonicalPath, safeExplicitPath);
    }
    return safeExplicitPath;
}

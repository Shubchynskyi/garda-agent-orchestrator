import * as fs from 'node:fs';
import * as path from 'node:path';

export const REVIEW_TRUST_COMPATIBILITY_TYPES = [
    'code',
    'db',
    'security',
    'refactor',
    'test',
    'api',
    'performance',
    'infra',
    'dependency'
] as const;

const REVIEW_TRUST_COMPATIBILITY_TYPE_SET = new Set<string>(REVIEW_TRUST_COMPATIBILITY_TYPES);

export function normalizeKnownReviewType(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return REVIEW_TRUST_COMPATIBILITY_TYPE_SET.has(normalized) ? normalized : null;
}

export function collectKnownRequiredReviewTypes(requiredReviews: Record<string, boolean>): string[] {
    const reviewTypes = new Set<string>();
    for (const [reviewType, required] of Object.entries(requiredReviews || {})) {
        const normalizedReviewType = normalizeKnownReviewType(reviewType);
        if (required === true && normalizedReviewType) {
            reviewTypes.add(normalizedReviewType);
        }
    }
    return [...reviewTypes].sort();
}

export function collectUnsafeRequiredReviewTypeIssues(requiredReviews: Record<string, boolean>): string[] {
    return Object.entries(requiredReviews || {})
        .filter(([reviewType, required]) => required === true && !normalizeKnownReviewType(reviewType))
        .map(([reviewType]) => `unsafe or unknown required review type ignored: ${JSON.stringify(reviewType)}`)
        .sort();
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeTrustToken(value: unknown): string {
    return String(value || '').trim().toUpperCase();
}

export function normalizeSha256Text(value: unknown): string {
    const text = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(text) ? text : '';
}

export function pathInsideOrEqual(candidatePath: string, rootPath: string): boolean {
    const relative = path.relative(rootPath, candidatePath);
    return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isSafeCanonicalArtifactPath(filePath: string, rootPath: string): boolean {
    const resolvedFilePath = path.resolve(filePath);
    const resolvedRootPath = path.resolve(rootPath);
    if (!pathInsideOrEqual(resolvedFilePath, resolvedRootPath)) {
        return false;
    }
    if (!fs.existsSync(resolvedFilePath)) {
        return true;
    }
    const realRootPath = fs.existsSync(resolvedRootPath)
        ? fs.realpathSync.native(resolvedRootPath)
        : resolvedRootPath;
    const realFilePath = fs.realpathSync.native(resolvedFilePath);
    return pathInsideOrEqual(realFilePath, realRootPath);
}

export function getCanonicalReviewContextPath(reviewsRoot: string, taskId: string, reviewType: string): string {
    return path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
}

export function safeReadJson(filePath: string): Record<string, unknown> | null {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

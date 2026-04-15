import { normalizePath } from './helpers';

function normalizeOptionalString(value: unknown): string | null {
    const trimmed = String(value || '').trim();
    return trimmed ? trimmed : null;
}

function normalizeOptionalReviewType(value: unknown): string | null {
    const normalized = normalizeOptionalString(value);
    return normalized ? normalized.toLowerCase() : null;
}

function normalizeOptionalHash(value: unknown): string | null {
    const normalized = normalizeOptionalString(value);
    return normalized ? normalized.toLowerCase() : null;
}

export interface ReviewContextContractValidationOptions {
    contextPath: string;
    reviewContext: Record<string, unknown> | null;
    expectedTaskId?: string | null;
    expectedReviewType: string;
    expectedPreflightPath?: string | null;
    expectedPreflightSha256?: string | null;
    requireReviewType?: boolean;
    requireTaskId?: boolean;
    requirePreflightPath?: boolean;
    requirePreflightSha256?: boolean;
}

export function getReviewContextContractViolations(
    options: ReviewContextContractValidationOptions
): string[] {
    const reviewContext = options.reviewContext;
    if (!reviewContext || typeof reviewContext !== 'object' || Array.isArray(reviewContext)) {
        return [];
    }

    const violations: string[] = [];
    const normalizedContextPath = normalizePath(options.contextPath);
    const expectedReviewType = normalizeOptionalReviewType(options.expectedReviewType) || '';
    const expectedTaskId = normalizeOptionalString(options.expectedTaskId);
    const expectedPreflightPath = normalizeOptionalString(options.expectedPreflightPath);
    const expectedPreflightSha256 = normalizeOptionalHash(options.expectedPreflightSha256);

    const actualReviewType = normalizeOptionalReviewType(reviewContext.review_type);
    const actualTaskId = normalizeOptionalString(reviewContext.task_id);
    const actualPreflightPath = normalizeOptionalString(reviewContext.preflight_path);
    const actualPreflightSha256 = normalizeOptionalHash(reviewContext.preflight_sha256);

    if (actualReviewType) {
        if (actualReviewType !== expectedReviewType) {
            violations.push(
                `Review context '${normalizedContextPath}' declares review_type '${actualReviewType}', ` +
                `but '${expectedReviewType}' was required.`
            );
        }
    } else if (options.requireReviewType !== false) {
        violations.push(
            `Review context '${normalizedContextPath}' is missing review_type. ` +
            `Expected '${expectedReviewType}'.`
        );
    }

    if (expectedTaskId) {
        if (actualTaskId) {
            if (actualTaskId !== expectedTaskId) {
                violations.push(
                    `Review context '${normalizedContextPath}' belongs to task '${actualTaskId}', ` +
                    `but '${expectedTaskId}' was required.`
                );
            }
        } else if (options.requireTaskId === true) {
            violations.push(
                `Review context '${normalizedContextPath}' is missing task_id. ` +
                `Expected '${expectedTaskId}'.`
            );
        }
    }

    if (expectedPreflightPath) {
        if (actualPreflightPath) {
            const normalizedActualPreflightPath = normalizePath(actualPreflightPath);
            const normalizedExpectedPreflightPath = normalizePath(expectedPreflightPath);
            if (normalizedActualPreflightPath !== normalizedExpectedPreflightPath) {
                violations.push(
                    `Review context '${normalizedContextPath}' points to preflight '${normalizedActualPreflightPath}', ` +
                    `but '${normalizedExpectedPreflightPath}' was required.`
                );
            }
        } else if (options.requirePreflightPath === true) {
            violations.push(
                `Review context '${normalizedContextPath}' is missing preflight_path. ` +
                `Expected '${normalizePath(expectedPreflightPath)}'.`
            );
        }
    }

    if (expectedPreflightSha256) {
        if (actualPreflightSha256) {
            if (actualPreflightSha256 !== expectedPreflightSha256) {
                violations.push(
                    `Review context '${normalizedContextPath}' declares preflight_sha256 '${actualPreflightSha256}', ` +
                    `but '${expectedPreflightSha256}' was required.`
                );
            }
        } else if (options.requirePreflightSha256 === true) {
            violations.push(
                `Review context '${normalizedContextPath}' is missing preflight_sha256. ` +
                `Expected '${expectedPreflightSha256}'.`
            );
        }
    }

    return violations;
}

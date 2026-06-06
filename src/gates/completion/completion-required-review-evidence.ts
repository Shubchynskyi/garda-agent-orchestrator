import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ReviewReceipt } from '../../gate-runtime/review-context';
import { withReviewArtifactReadBarrier } from '../../gate-runtime/review-artifacts';
import { normalizePath } from '../shared/helpers';
import { resolveCanonicalReviewContextPath } from '../review-context/review-context-paths';
import {
    buildReviewContextPreflightDiffExpectations,
    getReviewContextContractViolations
} from '../review-context/review-context-contract';
import {
    buildUnavailableRequiredReviewTrustSummary,
    readReviewTrustSummary,
    readReviewTrustSummaryFromReviewGate
} from '../task-audit/task-audit-summary-collectors';
import {
    findLatestRecordedReviewContextPath,
    readJsonArtifact,
    ensurePassedArtifactStatus,
    type TimelineEventEntry
} from './completion-evidence';
import {
    REVIEW_CONTRACTS,
    getReviewArtifactFindingsEvidence
} from './completion-verdict';

function toRequiredReviewBooleanRecord(value: Record<string, unknown>): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const [key, enabled] of Object.entries(value)) {
        result[key] = enabled === true;
    }
    return result;
}

export interface CompletionReviewArtifactEvidence {
    path: string;
    content: string;
    reviewContextPath: string;
    reviewContext: Record<string, unknown> | null;
    receipt: ReviewReceipt | null;
    findings_evidence: ReturnType<typeof getReviewArtifactFindingsEvidence>;
}

export function collectRequiredReviewEvidence(input: {
    reviewsRoot: string;
    taskId: string;
    preflight: Record<string, unknown>;
    preflightPath: string;
    preflightSha256: string;
    reviewEvidencePath: string;
    requiredReviews: Record<string, unknown>;
    scopeCategory: string | null;
    orderedEvents: readonly TimelineEventEntry[];
    errors: string[];
}): {
    reviewArtifacts: Record<string, CompletionReviewArtifactEvidence>;
    receiptReviewTrustSummary: ReturnType<typeof readReviewTrustSummary>;
    reviewGateTrustSummary: ReturnType<typeof readReviewTrustSummaryFromReviewGate>;
} {
    const reviewArtifacts: Record<string, CompletionReviewArtifactEvidence> = {};
    const {
        receiptReviewTrustSummary,
        reviewGateTrustSummary
    } = withReviewArtifactReadBarrier(input.reviewsRoot, () => {
        const requiredReviewBooleans = toRequiredReviewBooleanRecord(input.requiredReviews);
        const reviewEvidence = readJsonArtifact(input.reviewEvidencePath, 'Review gate', input.errors);
        ensurePassedArtifactStatus(reviewEvidence, 'Review gate', input.errors);
        for (const [reviewKey] of REVIEW_CONTRACTS) {
            const required = !!input.requiredReviews[reviewKey];
            if (!required) {
                continue;
            }
            const artifactPath = path.join(input.reviewsRoot, `${input.taskId}-${reviewKey}.md`);
            const recordedReviewContextPath = findLatestRecordedReviewContextPath(input.orderedEvents, reviewKey);
            const reviewContextPath = resolveCanonicalReviewContextPath({
                reviewsRoot: input.reviewsRoot,
                taskId: input.taskId,
                reviewType: reviewKey,
                explicitPath: recordedReviewContextPath
            });
            const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
            const artifactExists = fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile();

            if (!artifactExists) {
                input.errors.push(`Required review artifact not found: ${normalizePath(artifactPath)}`);
                continue;
            }

            const artifactContent = fs.readFileSync(artifactPath, 'utf8');
            let reviewContext: Record<string, unknown> | null = null;
            let receipt: ReviewReceipt | null = null;
            if (fs.existsSync(reviewContextPath) && fs.statSync(reviewContextPath).isFile()) {
                try {
                    const parsedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
                    if (parsedReviewContext && typeof parsedReviewContext === 'object' && !Array.isArray(parsedReviewContext)) {
                        reviewContext = parsedReviewContext as Record<string, unknown>;
                        input.errors.push(...getReviewContextContractViolations({
                            contextPath: reviewContextPath,
                            reviewContext,
                            expectedTaskId: input.taskId,
                            expectedReviewType: reviewKey,
                            expectedPreflightPath: input.preflightPath,
                            expectedPreflightSha256: input.preflightSha256,
                            requireReviewType: true,
                            requireTaskId: true,
                            requirePreflightPath: true,
                            requirePreflightSha256: true,
                            ...buildReviewContextPreflightDiffExpectations(input.preflight, reviewKey)
                        }));
                    }
                } catch {
                    input.errors.push(`Required review-context artifact is invalid JSON: ${normalizePath(reviewContextPath)}`);
                }
            } else {
                input.errors.push(`Required review-context artifact not found: ${normalizePath(reviewContextPath)}`);
            }
            if (fs.existsSync(receiptPath) && fs.statSync(receiptPath).isFile()) {
                try {
                    const parsedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
                    if (parsedReceipt && typeof parsedReceipt === 'object' && !Array.isArray(parsedReceipt)) {
                        receipt = parsedReceipt as ReviewReceipt;
                    }
                } catch {
                    input.errors.push(`Required review receipt is invalid JSON: ${normalizePath(receiptPath)}`);
                }
            } else {
                input.errors.push(`Required review receipt not found: ${normalizePath(receiptPath)}`);
            }
            const findingsEvidence = getReviewArtifactFindingsEvidence(artifactPath, artifactContent);
            reviewArtifacts[reviewKey] = {
                path: normalizePath(artifactPath),
                content: artifactContent,
                reviewContextPath: normalizePath(reviewContextPath),
                reviewContext,
                receipt,
                findings_evidence: findingsEvidence
            };
            if (Array.isArray(findingsEvidence.violations) && findingsEvidence.violations.length > 0) {
                input.errors.push(...findingsEvidence.violations);
            }
        }
        const receiptReviewTrustSummary = readReviewTrustSummary(
            requiredReviewBooleans,
            input.reviewsRoot,
            input.taskId,
            input.scopeCategory,
            input.preflightSha256
        );
        const reviewGateTrustSummary = readReviewTrustSummaryFromReviewGate(
            reviewEvidence && typeof reviewEvidence === 'object' && !Array.isArray(reviewEvidence)
                ? reviewEvidence as Record<string, unknown>
                : null,
            requiredReviewBooleans,
            input.taskId,
            input.scopeCategory,
            input.preflightSha256
        );
        return {
            receiptReviewTrustSummary,
            reviewGateTrustSummary
        };
    });

    return {
        reviewArtifacts,
        receiptReviewTrustSummary,
        reviewGateTrustSummary
    };
}

export function resolveCompletionReviewTrustSummary(input: {
    requiredReviews: Record<string, unknown>;
    scopeCategory: string | null;
    receiptReviewTrustSummary: ReturnType<typeof readReviewTrustSummary>;
    reviewGateTrustSummary: ReturnType<typeof readReviewTrustSummaryFromReviewGate>;
}) {
    const hasRequiredReviews = Object.values(input.requiredReviews).some((value) => value === true);
    const requiredReviewBooleans = toRequiredReviewBooleanRecord(input.requiredReviews);
    return input.reviewGateTrustSummary
        ?? (hasRequiredReviews
            ? buildUnavailableRequiredReviewTrustSummary(requiredReviewBooleans, input.scopeCategory)
            : input.receiptReviewTrustSummary);
}

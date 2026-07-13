import { extractReviewVerdictToken } from '../../gate-runtime/review-context';
import { isPlainRecord } from '../../core/records';
import {
    validateReviewFindingsReport,
    type ReviewFindingsReport
} from './review-findings-schema';
import type { ReviewCoverageContract } from './review-coverage-ledger';

export interface JsonReviewFindingsArtifactValidation {
    detected: boolean;
    report: ReviewFindingsReport | null;
    violations: string[];
}

function getCoverageObligationIds(contract: ReviewCoverageContract | null | undefined): string[] {
    return Array.isArray(contract?.obligations)
        ? contract.obligations
            .map((entry) => String(entry?.id || '').trim())
            .filter(Boolean)
        : [];
}

function getCoverageChangedFilePaths(contract: ReviewCoverageContract | null | undefined): string[] {
    return Array.isArray(contract?.obligations)
        ? contract.obligations
            .filter((entry) => entry?.kind === 'file')
            .map((entry) => String(entry?.target || '').trim())
            .filter(Boolean)
        : [];
}

function parseJsonReviewFindingsArtifactObject(content: string): Record<string, unknown> | null {
    const trimmed = String(content || '').trim();
    if (!trimmed.startsWith('{')) {
        return null;
    }
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!isPlainRecord(parsed) || Number(parsed.schema_version) !== 1 || !isPlainRecord(parsed.findings)) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

export function validateJsonReviewFindingsArtifact(options: {
    content: string;
    expectedTaskId: string;
    expectedReviewType: string;
    expectedReviewContextSha256?: string | null;
    expectedTreeStateSha256?: string | null;
    coverageContract?: ReviewCoverageContract | null;
}): JsonReviewFindingsArtifactValidation {
    const parsed = parseJsonReviewFindingsArtifactObject(options.content);
    if (!parsed) {
        return {
            detected: false,
            report: null,
            violations: []
        };
    }
    const validation = validateReviewFindingsReport(parsed, {
        expectedTaskId: options.expectedTaskId,
        expectedReviewType: options.expectedReviewType,
        expectedCoverageObligationIds: getCoverageObligationIds(options.coverageContract),
        expectedChangedFilePaths: getCoverageChangedFilePaths(options.coverageContract),
        expectedReviewContextSha256: options.expectedReviewContextSha256 || undefined,
        expectedTreeStateSha256: options.expectedTreeStateSha256 || undefined
    });
    const violations = [...validation.violations];
    if (
        validation.report
        && options.coverageContract?.contract_sha256
        && validation.report.coverage_ledger.coverage_contract_sha256 !== options.coverageContract.contract_sha256
    ) {
        violations.push(
            `coverage_ledger.coverage_contract_sha256 does not match current coverage contract '${options.coverageContract.contract_sha256}'.`
        );
    }
    return {
        detected: true,
        report: violations.length === 0 ? validation.report : null,
        violations
    };
}

export function jsonReviewFindingsArtifactHasActiveFindings(report: ReviewFindingsReport): boolean {
    return report.findings.critical.length > 0
        || report.findings.high.length > 0
        || report.findings.medium.length > 0
        || report.findings.low.length > 0
        || report.residual_risks.length > 0;
}

export function resolveReviewFindingsArtifactVerdictToken(options: {
    content: string;
    passToken: string | null;
    failToken: string | null;
    reviewType: string;
    expectedTaskId?: string;
    expectedReviewContextSha256?: string | null;
    expectedTreeStateSha256?: string | null;
    coverageContract?: ReviewCoverageContract | null;
}): string | null {
    const parsedJsonArtifact = parseJsonReviewFindingsArtifactObject(options.content);
    if (!parsedJsonArtifact) {
        return extractReviewVerdictToken(
            options.content,
            options.passToken,
            options.failToken,
            options.reviewType
        );
    }
    const validation = validateJsonReviewFindingsArtifact({
        content: options.content,
        expectedTaskId: options.expectedTaskId || String(parsedJsonArtifact.task_id || '').trim(),
        expectedReviewType: options.reviewType,
        expectedReviewContextSha256: options.expectedReviewContextSha256 || undefined,
        expectedTreeStateSha256: options.expectedTreeStateSha256 || undefined,
        coverageContract: options.coverageContract || null
    });
    if (!validation.report) {
        return null;
    }
    return jsonReviewFindingsArtifactHasActiveFindings(validation.report)
        ? options.failToken || null
        : options.passToken || null;
}

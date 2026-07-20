import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
    buildReviewCoverageContract,
    getReviewCoverageContractViolations,
    getReviewCoverageValidationSummaryContractViolations
} from '../review/review-coverage-ledger';
import { resolveReviewCoverageChangedFiles } from '../review-context/review-coverage-scope';

export interface ReviewCoverageAuditEntry {
    review_type: string;
    status: 'COMPLETE' | 'INCOMPLETE' | 'LEGACY_NOT_REQUIRED';
    contract_sha256: string | null;
    obligation_count: number;
    completed_obligation_count: number;
    omitted_obligation_ids: string[];
    duplicate_obligation_ids: string[];
    unknown_obligation_ids: string[];
    finding_ids: string[];
    violations: string[];
    receipt_path: string;
}

export interface ReviewCoverageAuditSummary {
    status: 'COMPLETE' | 'INCOMPLETE' | 'NOT_REQUIRED';
    entries: ReviewCoverageAuditEntry[];
    omitted_obligation_ids: string[];
    visible_summary_line: string;
}

function readJson(filePath: string): Record<string, unknown> | null {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function sha256File(filePath: string): string | null {
    try {
        return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    } catch {
        return null;
    }
}

function eventDetails(event: Record<string, unknown>): Record<string, unknown> {
    return event.details && typeof event.details === 'object' && !Array.isArray(event.details)
        ? event.details as Record<string, unknown>
        : event;
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
}

export function buildReviewCoverageAuditSummary(options: {
    reviewsRoot: string;
    taskId: string;
    requiredReviews: Record<string, boolean>;
    orderedEvents?: readonly Record<string, unknown>[];
}): ReviewCoverageAuditSummary {
    const entries: ReviewCoverageAuditEntry[] = [];
    const repoRoot = path.resolve(options.reviewsRoot, '..', '..', '..');
    const preflightPath = path.join(options.reviewsRoot, `${options.taskId}-preflight.json`);
    const preflight = readJson(preflightPath);
    const preflightSha256 = sha256File(preflightPath);
    for (const reviewType of Object.keys(options.requiredReviews).filter((key) => options.requiredReviews[key]).sort()) {
        const contextPath = path.join(options.reviewsRoot, `${options.taskId}-${reviewType}-review-context.json`);
        const receiptPath = path.join(options.reviewsRoot, `${options.taskId}-${reviewType}-receipt.json`);
        const context = readJson(contextPath);
        const receipt = readJson(receiptPath);
        const contextSchemaVersion = Number(context?.schema_version);
        if (Number.isInteger(contextSchemaVersion) && contextSchemaVersion > 0 && contextSchemaVersion < 3) {
            const contextSha256 = sha256File(contextPath);
            const receiptContextSha256 = String(receipt?.review_context_sha256 || '').trim().toLowerCase();
            const receiptPreflightSha256 = String(receipt?.preflight_sha256 || '').trim().toLowerCase();
            const recordedEventMatches = (options.orderedEvents || []).some((event) => {
                if (String(event.event_type || '').trim() !== 'REVIEW_RECORDED') {
                    return false;
                }
                const details = eventDetails(event);
                return String(details.review_type || '').trim().toLowerCase() === reviewType
                    && String(details.review_context_sha256 || '').trim().toLowerCase() === contextSha256
                    && String(details.preflight_sha256 || '').trim().toLowerCase() === preflightSha256;
            });
            if (preflight?.review_coverage_contract_required !== true
                && contextSha256 && preflightSha256
                && receiptContextSha256 === contextSha256
                && receiptPreflightSha256 === preflightSha256
                && recordedEventMatches) {
                entries.push({
                    review_type: reviewType,
                    status: 'LEGACY_NOT_REQUIRED',
                    contract_sha256: null,
                    obligation_count: 0,
                    completed_obligation_count: 0,
                    omitted_obligation_ids: [],
                    duplicate_obligation_ids: [],
                    unknown_obligation_ids: [],
                    finding_ids: [],
                    violations: [],
                    receipt_path: receiptPath
                });
                continue;
            }
        }
        const contract = context?.coverage_contract && typeof context.coverage_contract === 'object' && !Array.isArray(context.coverage_contract)
            ? context.coverage_contract as Record<string, unknown>
            : null;
        const authoritativeCoverageChangedFiles = preflight
            ? resolveReviewCoverageChangedFiles({ reviewType, preflight, repoRoot })
            : [];
        const authoritativeContract = buildReviewCoverageContract({
            reviewType,
            changedFiles: authoritativeCoverageChangedFiles
        });
        const coverage = receipt?.review_coverage && typeof receipt.review_coverage === 'object' && !Array.isArray(receipt.review_coverage)
            ? receipt.review_coverage as Record<string, unknown>
            : null;
        const receiptHash = String(coverage?.contract_sha256 || '').trim().toLowerCase();
        const obligationCount = authoritativeContract.obligation_count;
        const contractObligationIds = authoritativeContract.obligations.map((entry) => entry.id);
        const completedObligationCount = Number(coverage?.completed_obligation_count || 0);
        const reportedOmittedObligationIds = stringArray(coverage?.omitted_obligation_ids);
        const omissionAccountingValid = !authoritativeContract.required
            || completedObligationCount + reportedOmittedObligationIds.length === obligationCount;
        const omittedObligationIds = coverage && omissionAccountingValid
            ? reportedOmittedObligationIds
            : [...new Set([...reportedOmittedObligationIds, ...contractObligationIds])].sort();
        const duplicateObligationIds = stringArray(coverage?.duplicate_obligation_ids);
        const unknownObligationIds = stringArray(coverage?.unknown_obligation_ids);
        const violations: string[] = [];
        if (!preflight) {
            violations.push('current preflight is missing or unreadable for authoritative coverage reconstruction');
        } else {
            violations.push(...getReviewCoverageContractViolations(contract, {
                reviewType,
                changedFiles: authoritativeCoverageChangedFiles
            }));
        }
        if (!context || !Number.isInteger(contextSchemaVersion) || contextSchemaVersion < 3) {
            violations.push('review context is missing, unreadable, or has an invalid schema version');
            if (Number.isInteger(contextSchemaVersion) && contextSchemaVersion > 0 && contextSchemaVersion < 3) {
                violations.push('legacy review coverage exemption is not authenticated by receipt and lifecycle evidence');
            }
        }
        if (!String(contract?.contract_sha256 || '').trim()) violations.push('context coverage contract hash is missing');
        violations.push(...getReviewCoverageValidationSummaryContractViolations(coverage, authoritativeContract)
            .map((violation) => `receipt ${violation}`));
        const complete = violations.length === 0;
        entries.push({
            review_type: reviewType,
            status: complete ? 'COMPLETE' : 'INCOMPLETE',
            contract_sha256: receiptHash || null,
            obligation_count: obligationCount,
            completed_obligation_count: completedObligationCount,
            omitted_obligation_ids: omittedObligationIds,
            duplicate_obligation_ids: duplicateObligationIds,
            unknown_obligation_ids: unknownObligationIds,
            finding_ids: stringArray(coverage?.finding_ids),
            violations,
            receipt_path: receiptPath
        });
    }
    const incomplete = entries.filter((entry) => entry.status === 'INCOMPLETE');
    const omitted = [...new Set(incomplete.flatMap((entry) =>
        entry.omitted_obligation_ids.map((id) => `${entry.review_type}:${id}`)
    ))].sort();
    const status = entries.length === 0
        ? 'NOT_REQUIRED'
        : incomplete.length > 0 ? 'INCOMPLETE' : 'COMPLETE';
    const totals = entries.reduce((acc, entry) => ({
        completed: acc.completed + entry.completed_obligation_count,
        required: acc.required + entry.obligation_count
    }), { completed: 0, required: 0 });
    return {
        status,
        entries,
        omitted_obligation_ids: omitted,
        visible_summary_line:
            `Review coverage: status=${status}; obligations=${totals.completed}/${totals.required}; ` +
            `incomplete_reviews=${incomplete.map((entry) => entry.review_type).join(',') || 'none'}; ` +
            `omitted=${omitted.join(',') || 'none'}`
    };
}

import {
    REVIEW_FINDING_POLICY_PRESETS,
    type ReviewFindingDispositionAction,
    type ReviewFindingPolicy
} from '../../policy/profile-resolver';
import type {
    NormalizedReviewFindingsInventory,
    ReviewFindingsValidationArtifact
} from './review-findings-validation-artifact';
import type {
    ReviewFindingsReport,
    ReviewFindingsSeverity
} from './review-findings-schema';

const REVIEW_FINDING_POLICY_ACTIONS = ['fix_now', 'create_follow_up', 'ignore'] as const;
const REVIEW_FINDING_POLICY_IDS = ['soft', 'balanced', 'strict', 'custom'] as const;
const REVIEW_FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const satisfies readonly ReviewFindingsSeverity[];

export interface LockedReviewFindingPolicyResolution {
    policy: ReviewFindingPolicy;
    source: 'preflight_profile_policy_snapshot' | 'receipt_review_findings_disposition' | 'fallback_strict';
    diagnostics: string[];
}

export interface ReviewFindingDispositionBucket {
    action: ReviewFindingDispositionAction;
    ids: string[];
    count: number;
}

export interface ReviewFindingsDispositionEvaluation {
    schema_version: 1;
    policy_id: ReviewFindingPolicy['policy_id'];
    policy_source: LockedReviewFindingPolicyResolution['source'];
    policy_diagnostics: string[];
    findings: Record<ReviewFindingsSeverity, ReviewFindingDispositionBucket>;
    residual_risks: ReviewFindingDispositionBucket;
    counts_by_action: Record<ReviewFindingDispositionAction, number>;
    blocking_count: number;
    blocking_ids: string[];
    non_blocking_count: number;
    total_count: number;
    verdict: 'fail_for_fix_now' | 'pass_no_findings' | 'pass_with_follow_up_or_ignored_findings';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clonePolicy(policy: ReviewFindingPolicy): ReviewFindingPolicy {
    return {
        schema_version: policy.schema_version,
        policy_id: policy.policy_id,
        findings: { ...policy.findings },
        residual_risk: policy.residual_risk
    };
}

function strictPolicyResolution(diagnostic: string): LockedReviewFindingPolicyResolution {
    return {
        policy: clonePolicy(REVIEW_FINDING_POLICY_PRESETS.strict),
        source: 'fallback_strict',
        diagnostics: [diagnostic]
    };
}

function isDispositionAction(value: unknown): value is ReviewFindingDispositionAction {
    return typeof value === 'string'
        && (REVIEW_FINDING_POLICY_ACTIONS as readonly string[]).includes(value);
}

function parseReviewFindingPolicy(value: unknown): ReviewFindingPolicy | null {
    if (!isRecord(value) || value.schema_version !== 1) {
        return null;
    }
    if (
        typeof value.policy_id !== 'string'
        || !(REVIEW_FINDING_POLICY_IDS as readonly string[]).includes(value.policy_id)
        || !isRecord(value.findings)
        || !isDispositionAction(value.residual_risk)
    ) {
        return null;
    }
    const findings = {} as ReviewFindingPolicy['findings'];
    for (const severity of REVIEW_FINDING_SEVERITIES) {
        if (!isDispositionAction(value.findings[severity])) {
            return null;
        }
        findings[severity] = value.findings[severity];
    }
    if (findings.critical !== 'fix_now') {
        return null;
    }
    const policy: ReviewFindingPolicy = {
        schema_version: 1,
        policy_id: value.policy_id as ReviewFindingPolicy['policy_id'],
        findings,
        residual_risk: value.residual_risk
    };
    if (policy.policy_id !== 'custom') {
        const preset = REVIEW_FINDING_POLICY_PRESETS[policy.policy_id as keyof typeof REVIEW_FINDING_POLICY_PRESETS];
        if (!preset) {
            return null;
        }
        for (const severity of REVIEW_FINDING_SEVERITIES) {
            if (policy.findings[severity] !== preset.findings[severity]) {
                return null;
            }
        }
        if (policy.residual_risk !== preset.residual_risk) {
            return null;
        }
    }
    return policy;
}

function parseReviewFindingPolicyFromDisposition(value: unknown): ReviewFindingPolicy | null {
    if (!isRecord(value) || value.schema_version !== 1) {
        return null;
    }
    if (
        typeof value.policy_id !== 'string'
        || !(REVIEW_FINDING_POLICY_IDS as readonly string[]).includes(value.policy_id)
        || !isRecord(value.findings)
        || !isRecord(value.residual_risks)
    ) {
        return null;
    }
    const findings = {} as ReviewFindingPolicy['findings'];
    for (const severity of REVIEW_FINDING_SEVERITIES) {
        const bucket = value.findings[severity];
        if (!isRecord(bucket) || !isDispositionAction(bucket.action)) {
            return null;
        }
        findings[severity] = bucket.action;
    }
    if (!isDispositionAction(value.residual_risks.action) || findings.critical !== 'fix_now') {
        return null;
    }
    return parseReviewFindingPolicy({
        schema_version: 1,
        policy_id: value.policy_id,
        findings,
        residual_risk: value.residual_risks.action
    });
}

export function resolveLockedReviewFindingPolicyFromPreflight(
    preflight: Record<string, unknown> | null | undefined
): LockedReviewFindingPolicyResolution {
    const snapshot = isRecord(preflight?.profile_policy_snapshot)
        ? preflight.profile_policy_snapshot
        : null;
    const policy = parseReviewFindingPolicy(snapshot?.review_finding_policy);
    if (!policy) {
        return strictPolicyResolution(
            'Preflight profile_policy_snapshot.review_finding_policy is missing or invalid; resolved fail-closed to strict.'
        );
    }
    return {
        policy: clonePolicy(policy),
        source: 'preflight_profile_policy_snapshot',
        diagnostics: []
    };
}

export function resolveLockedReviewFindingPolicyFromReceiptDisposition(
    receiptOrEventDetails: Record<string, unknown> | null | undefined
): LockedReviewFindingPolicyResolution {
    const disposition = isRecord(receiptOrEventDetails?.review_findings_disposition)
        ? receiptOrEventDetails.review_findings_disposition
        : isRecord(receiptOrEventDetails?.reviewFindingsDisposition)
            ? receiptOrEventDetails.reviewFindingsDisposition
            : null;
    const policy = parseReviewFindingPolicyFromDisposition(disposition);
    if (!policy) {
        return strictPolicyResolution(
            'Review receipt review_findings_disposition is missing or invalid; resolved fail-closed to strict.'
        );
    }
    return {
        policy: clonePolicy(policy),
        source: 'receipt_review_findings_disposition',
        diagnostics: []
    };
}

function emptyCounts(): Record<ReviewFindingDispositionAction, number> {
    return {
        fix_now: 0,
        create_follow_up: 0,
        ignore: 0
    };
}

function buildBucket(action: ReviewFindingDispositionAction, ids: string[]): ReviewFindingDispositionBucket {
    return {
        action,
        ids: [...ids],
        count: ids.length
    };
}

function evaluateIds(
    findingIdsBySeverity: Record<ReviewFindingsSeverity, string[]>,
    residualRiskIds: string[],
    policyResolution: LockedReviewFindingPolicyResolution
): ReviewFindingsDispositionEvaluation {
    const countsByAction = emptyCounts();
    const blockingIds: string[] = [];
    const findings = {} as Record<ReviewFindingsSeverity, ReviewFindingDispositionBucket>;

    for (const severity of REVIEW_FINDING_SEVERITIES) {
        const action = policyResolution.policy.findings[severity];
        const ids = [...findingIdsBySeverity[severity]];
        findings[severity] = buildBucket(action, ids);
        countsByAction[action] += ids.length;
        if (action === 'fix_now') {
            blockingIds.push(...ids);
        }
    }

    const residualRiskAction = policyResolution.policy.residual_risk;
    const residualRisks = buildBucket(residualRiskAction, residualRiskIds);
    countsByAction[residualRiskAction] += residualRiskIds.length;
    if (residualRiskAction === 'fix_now') {
        blockingIds.push(...residualRiskIds);
    }

    const totalCount = countsByAction.fix_now + countsByAction.create_follow_up + countsByAction.ignore;
    const blockingCount = countsByAction.fix_now;
    return {
        schema_version: 1,
        policy_id: policyResolution.policy.policy_id,
        policy_source: policyResolution.source,
        policy_diagnostics: [...policyResolution.diagnostics],
        findings,
        residual_risks: residualRisks,
        counts_by_action: countsByAction,
        blocking_count: blockingCount,
        blocking_ids: blockingIds,
        non_blocking_count: totalCount - blockingCount,
        total_count: totalCount,
        verdict: blockingCount > 0
            ? 'fail_for_fix_now'
            : totalCount === 0
                ? 'pass_no_findings'
                : 'pass_with_follow_up_or_ignored_findings'
    };
}

export function evaluateReviewFindingsReportDispositions(
    report: ReviewFindingsReport,
    policyResolution: LockedReviewFindingPolicyResolution
): ReviewFindingsDispositionEvaluation {
    return evaluateIds(
        {
            critical: report.findings.critical.map((finding) => finding.id),
            high: report.findings.high.map((finding) => finding.id),
            medium: report.findings.medium.map((finding) => finding.id),
            low: report.findings.low.map((finding) => finding.id)
        },
        report.residual_risks.map((risk) => risk.id),
        policyResolution
    );
}

export function evaluateReviewFindingsValidationArtifactDispositions(
    artifact: ReviewFindingsValidationArtifact | null,
    policyResolution: LockedReviewFindingPolicyResolution
): ReviewFindingsDispositionEvaluation {
    const inventory: NormalizedReviewFindingsInventory | null = artifact?.validation_result.accepted
        ? artifact.validation_result.normalized_inventory
        : null;
    return evaluateIds(
        {
            critical: inventory?.findings_by_severity.critical.map((finding) => finding.id) ?? [],
            high: inventory?.findings_by_severity.high.map((finding) => finding.id) ?? [],
            medium: inventory?.findings_by_severity.medium.map((finding) => finding.id) ?? [],
            low: inventory?.findings_by_severity.low.map((finding) => finding.id) ?? []
        },
        inventory?.residual_risks.map((risk) => risk.id) ?? [],
        policyResolution
    );
}

export function reviewFindingsValidationArtifactHasBlockingFindings(
    artifact: ReviewFindingsValidationArtifact | null,
    policyResolution: LockedReviewFindingPolicyResolution
): boolean {
    return evaluateReviewFindingsValidationArtifactDispositions(artifact, policyResolution).blocking_count > 0;
}

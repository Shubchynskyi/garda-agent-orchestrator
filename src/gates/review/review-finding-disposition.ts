import {
    REVIEW_FINDING_POLICY_PRESETS,
    type ReviewFindingDispositionAction,
    type ReviewFindingPolicy
} from '../../policy/profile-resolver';
import {
    buildLegacyReviewFollowUpTaskClosurePolicySnapshot,
    getReviewFollowUpTaskClosurePolicySnapshotViolations,
    type ReviewFollowUpTaskClosurePolicySnapshot
} from '../../core/review-follow-up-task-closure-policy';
import { isReviewFindingsFollowUpTaskId } from '../../core/task-ids';
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
const EVIDENCE_ONLY_FINDING_ID = 'F-000';

export interface LockedReviewFindingPolicyResolution {
    policy: ReviewFindingPolicy;
    base_policy: ReviewFindingPolicy;
    source: 'preflight_profile_policy_snapshot' | 'receipt_review_findings_disposition' | 'fallback_strict';
    follow_up_task_closure_policy: ReviewFollowUpTaskClosurePolicySnapshot;
    follow_up_task_closure_policy_source:
        | 'preflight_profile_policy_snapshot'
        | 'receipt_review_findings_disposition'
        | 'legacy_default';
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
    base_review_finding_policy?: ReviewFindingPolicy;
    review_follow_up_task_closure_policy?: ReviewFollowUpTaskClosurePolicySnapshot;
    review_follow_up_task_closure_policy_source?:
        LockedReviewFindingPolicyResolution['follow_up_task_closure_policy_source'];
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

function cloneClosurePolicy(
    policy: ReviewFollowUpTaskClosurePolicySnapshot
): ReviewFollowUpTaskClosurePolicySnapshot {
    return {
        ...policy,
        diagnostics: [...policy.diagnostics]
    };
}

function legacyClosurePolicy(): ReviewFollowUpTaskClosurePolicySnapshot {
    return buildLegacyReviewFollowUpTaskClosurePolicySnapshot();
}

function parseClosurePolicy(value: unknown): ReviewFollowUpTaskClosurePolicySnapshot | null {
    if (getReviewFollowUpTaskClosurePolicySnapshotViolations(value).length > 0) {
        return null;
    }
    return cloneClosurePolicy(value as ReviewFollowUpTaskClosurePolicySnapshot);
}

function strictPolicyResolution(diagnostic: string): LockedReviewFindingPolicyResolution {
    const policy = clonePolicy(REVIEW_FINDING_POLICY_PRESETS.strict);
    return {
        policy,
        base_policy: clonePolicy(policy),
        source: 'fallback_strict',
        follow_up_task_closure_policy: legacyClosurePolicy(),
        follow_up_task_closure_policy_source: 'legacy_default',
        diagnostics: [diagnostic]
    };
}

function applyMandatoryReviewFindingSafetyFloors(
    resolution: LockedReviewFindingPolicyResolution,
    taskId: unknown
): LockedReviewFindingPolicyResolution {
    const basePolicy = clonePolicy(resolution.base_policy);
    const diagnostics = [...resolution.diagnostics];
    const isFollowUpTask = isReviewFindingsFollowUpTaskId(taskId);
    if (basePolicy.findings.high !== 'fix_now') {
        basePolicy.findings.high = 'fix_now';
        diagnostics.push('High-severity review findings are immutable fix_now obligations.');
    }

    const closurePolicy = resolution.follow_up_task_closure_policy;
    if (isFollowUpTask && (
        !closurePolicy.eligible
        || !closurePolicy.configured
        || !closurePolicy.valid
    )) {
        basePolicy.findings = { ...REVIEW_FINDING_POLICY_PRESETS.strict.findings };
        basePolicy.residual_risk = 'fix_now';
        diagnostics.push(
            `Review follow-up task '${String(taskId)}' resolves every finding and residual risk to fix_now; ` +
            'nested follow-up tasks are forbidden.'
        );
    }

    const policy = clonePolicy(basePolicy);
    if (isFollowUpTask && closurePolicy.eligible && closurePolicy.valid) {
        if (closurePolicy.skip_low_findings) {
            policy.findings.low = 'ignore';
            diagnostics.push(
                'Frozen follow-up task closure policy explicitly ignores accepted low-severity findings.'
            );
        }
        if (closurePolicy.forbid_child_tasks) {
            for (const severity of REVIEW_FINDING_SEVERITIES) {
                if (severity === 'low' && closurePolicy.skip_low_findings) {
                    continue;
                }
                if (policy.findings[severity] === 'create_follow_up') {
                    policy.findings[severity] = 'fix_now';
                }
            }
            if (policy.residual_risk === 'create_follow_up') {
                policy.residual_risk = 'fix_now';
            }
            diagnostics.push(
                'Frozen follow-up task closure policy retains would-be descendant findings and residual risks as current-task fix_now obligations.'
            );
        }
    }
    return {
        ...resolution,
        base_policy: basePolicy,
        policy,
        diagnostics
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
        if (severity === 'critical') {
            if (value.findings[severity] !== 'fix_now') {
                return null;
            }
            findings.critical = value.findings[severity];
            continue;
        }
        findings[severity] = value.findings[severity];
    }
    const policy: ReviewFindingPolicy = {
        schema_version: 1,
        policy_id: value.policy_id as ReviewFindingPolicy['policy_id'],
        findings,
        residual_risk: value.residual_risk
    };
    // A locked preflight snapshot or receipt owns its action matrix. Named presets
    // are validated when a new profile is stored; comparing historical evidence
    // with today's preset would mutate active-task semantics retroactively.
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
        if (severity === 'critical') {
            if (bucket.action !== 'fix_now') {
                return null;
            }
            findings.critical = bucket.action;
            continue;
        }
        findings[severity] = bucket.action;
    }
    if (!isDispositionAction(value.residual_risks.action)) {
        return null;
    }
    return parseReviewFindingPolicy({
        schema_version: 1,
        policy_id: value.policy_id,
        findings,
        residual_risk: value.residual_risks.action
    });
}

function parseBaseReviewFindingPolicyFromDisposition(value: unknown): ReviewFindingPolicy | null {
    if (!isRecord(value)) {
        return null;
    }
    return parseReviewFindingPolicy(value.base_review_finding_policy)
        || parseReviewFindingPolicyFromDisposition(value);
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
    const closurePolicyValue = snapshot?.review_follow_up_task_closure_policy;
    const closurePolicy = parseClosurePolicy(closurePolicyValue);
    const resolvedClosurePolicy = closurePolicy || legacyClosurePolicy();
    return applyMandatoryReviewFindingSafetyFloors({
        policy: clonePolicy(policy),
        base_policy: clonePolicy(policy),
        source: 'preflight_profile_policy_snapshot',
        follow_up_task_closure_policy: resolvedClosurePolicy,
        follow_up_task_closure_policy_source: closurePolicy
            ? 'preflight_profile_policy_snapshot'
            : 'legacy_default',
        diagnostics: closurePolicy || closurePolicyValue === undefined
            ? []
            : ['Preflight closure-policy snapshot is invalid; closure controls fail closed to legacy defaults.']
    }, preflight?.task_id);
}

export function resolveLockedReviewFindingPolicyFromReceiptDisposition(
    receiptOrEventDetails: Record<string, unknown> | null | undefined
): LockedReviewFindingPolicyResolution {
    const disposition = isRecord(receiptOrEventDetails?.review_findings_disposition)
        ? receiptOrEventDetails.review_findings_disposition
        : isRecord(receiptOrEventDetails?.reviewFindingsDisposition)
            ? receiptOrEventDetails.reviewFindingsDisposition
            : null;
    const policy = parseBaseReviewFindingPolicyFromDisposition(disposition);
    if (!policy) {
        return strictPolicyResolution(
            'Review receipt review_findings_disposition is missing or invalid; resolved fail-closed to strict.'
        );
    }
    const closurePolicyValue = disposition?.review_follow_up_task_closure_policy;
    const closurePolicy = parseClosurePolicy(closurePolicyValue);
    const resolvedClosurePolicy = closurePolicy || legacyClosurePolicy();
    return applyMandatoryReviewFindingSafetyFloors({
        policy: clonePolicy(policy),
        base_policy: clonePolicy(policy),
        source: 'receipt_review_findings_disposition',
        follow_up_task_closure_policy: resolvedClosurePolicy,
        follow_up_task_closure_policy_source: closurePolicy
            ? 'receipt_review_findings_disposition'
            : 'legacy_default',
        diagnostics: closurePolicy || closurePolicyValue === undefined
            ? []
            : ['Receipt disposition has an invalid closure-policy snapshot; closure controls fail closed to legacy defaults.']
    }, receiptOrEventDetails?.task_id);
}

export function resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence(
    receiptOrEventDetails: Record<string, unknown> | null | undefined
): LockedReviewFindingPolicyResolution {
    const resolution = resolveLockedReviewFindingPolicyFromReceiptDisposition(receiptOrEventDetails);
    if (resolution.source === 'fallback_strict') {
        return resolution;
    }
    const disposition = isRecord(receiptOrEventDetails?.review_findings_disposition)
        ? receiptOrEventDetails.review_findings_disposition
        : isRecord(receiptOrEventDetails?.reviewFindingsDisposition)
            ? receiptOrEventDetails.reviewFindingsDisposition
            : null;
    const recordedSource = disposition?.policy_source;
    if (
        recordedSource !== 'preflight_profile_policy_snapshot'
        && recordedSource !== 'receipt_review_findings_disposition'
    ) {
        return resolution;
    }
    return {
        ...resolution,
        source: recordedSource,
        follow_up_task_closure_policy_source: recordedSource === 'preflight_profile_policy_snapshot'
            ? 'preflight_profile_policy_snapshot'
            : resolution.follow_up_task_closure_policy_source
    };
}

export function resolveReviewFindingDispositionSourceRule(
    resolution: LockedReviewFindingPolicyResolution,
    kind: 'finding' | 'residual_risk',
    severity: ReviewFindingsSeverity | 'residual_risk'
): string {
    const closurePolicy = resolution.follow_up_task_closure_policy;
    if (
        kind === 'finding'
        && severity === 'low'
        && closurePolicy.skip_low_findings
        && resolution.base_policy.findings.low !== resolution.policy.findings.low
    ) {
        return 'review_follow_up_task_closure_policy.skip_low_findings';
    }
    const baseAction = kind === 'residual_risk'
        ? resolution.base_policy.residual_risk
        : resolution.base_policy.findings[severity as ReviewFindingsSeverity];
    const effectiveAction = kind === 'residual_risk'
        ? resolution.policy.residual_risk
        : resolution.policy.findings[severity as ReviewFindingsSeverity];
    if (
        closurePolicy.forbid_child_tasks
        && baseAction === 'create_follow_up'
        && effectiveAction === 'fix_now'
    ) {
        return 'review_follow_up_task_closure_policy.forbid_child_tasks';
    }
    return kind === 'residual_risk'
        ? 'review_finding_policy.residual_risk'
        : `review_finding_policy.findings.${severity}`;
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
        // F-000 is a schema-validated evidence note, not an implementation finding.
        // Preserve it in the validation artifact and coverage ledger for audit, but do
        // not let a reviewer's inability to run a focused command change the verdict,
        // create follow-up work, or trigger another review cycle.
        const ids = findingIdsBySeverity[severity].filter((id) => id !== EVIDENCE_ONLY_FINDING_ID);
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
    const closurePolicyEvidence = policyResolution.follow_up_task_closure_policy.eligible
        ? {
            base_review_finding_policy: clonePolicy(policyResolution.base_policy),
            review_follow_up_task_closure_policy: cloneClosurePolicy(
                policyResolution.follow_up_task_closure_policy
            ),
            review_follow_up_task_closure_policy_source:
                policyResolution.follow_up_task_closure_policy_source
        }
        : {};
    return {
        schema_version: 1,
        policy_id: policyResolution.policy.policy_id,
        policy_source: policyResolution.source,
        policy_diagnostics: [...policyResolution.diagnostics],
        ...closurePolicyEvidence,
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

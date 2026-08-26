import { sha256RedactedJsonPayload } from '../../core/redaction';
import type { ReviewFindingDispositionAction, ReviewFindingPolicy } from '../../policy/profile-resolver';
import { normalizePath } from '../shared/helpers';
import type {
    NormalizedReviewFindingInventoryEntry,
    NormalizedReviewResidualRiskInventoryEntry,
    ReviewFindingsValidationArtifact
} from './review-findings-validation-artifact';
import {
    evaluateReviewFindingsValidationArtifactDispositions,
    resolveReviewFindingDispositionSourceRule,
    type LockedReviewFindingPolicyResolution,
    type ReviewFindingsDispositionEvaluation
} from './review-finding-disposition';
import type { ReviewFollowUpTaskClosurePolicySnapshot } from '../../core/review-follow-up-task-closure-policy';
import type { ReviewFindingsSeverity } from './review-findings-schema';

export const REVIEW_FINDINGS_DISPOSITION_ARTIFACT_TYPE = 'review_findings_disposition';
export const REVIEW_FINDINGS_DISPOSITION_ARTIFACT_SCHEMA_VERSION = 1;

const REVIEW_FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const satisfies readonly ReviewFindingsSeverity[];
const EVIDENCE_ONLY_FINDING_ID = 'F-000';

export type ReviewFindingsDispositionItemKind = 'finding' | 'residual_risk';
export type ReviewFindingsDispositionItemMaterializationStatus =
    | 'requires_fix_now'
    | 'pending_follow_up_materialization'
    | 'audited_ignored';

export interface ReviewFindingsDispositionSourceValidation {
    artifact_path: string | null;
    artifact_sha256: string;
    validation_result_sha256: string;
    status: 'accepted';
    accepted: true;
}

export interface ReviewFindingsDispositionPolicySnapshot {
    policy_id: ReviewFindingPolicy['policy_id'];
    policy_source: LockedReviewFindingPolicyResolution['source'];
    policy_diagnostics: string[];
    review_finding_policy: ReviewFindingPolicy;
    base_review_finding_policy?: ReviewFindingPolicy;
    review_follow_up_task_closure_policy?: ReviewFollowUpTaskClosurePolicySnapshot;
    review_follow_up_task_closure_policy_source?:
        LockedReviewFindingPolicyResolution['follow_up_task_closure_policy_source'];
}

export interface ReviewFindingsDispositionArtifactItem {
    id: string;
    kind: ReviewFindingsDispositionItemKind;
    severity: ReviewFindingsSeverity | 'residual_risk';
    action: ReviewFindingDispositionAction;
    source_rule: string;
    policy_source: LockedReviewFindingPolicyResolution['source'];
    blocking: boolean;
    materialization_status: ReviewFindingsDispositionItemMaterializationStatus;
    audit_status: 'retained_in_disposition_artifact';
}

export interface ReviewFindingsDispositionArtifactSummary {
    item_count: number;
    fix_now_count: number;
    follow_up_pending_count: number;
    ignored_count: number;
    blocking_count: number;
    non_blocking_count: number;
}

export interface ReviewFindingsDispositionArtifact {
    schema_version: typeof REVIEW_FINDINGS_DISPOSITION_ARTIFACT_SCHEMA_VERSION;
    artifact_type: typeof REVIEW_FINDINGS_DISPOSITION_ARTIFACT_TYPE;
    task_id: string;
    review_type: string;
    derivation_source: 'garda_locked_policy_evaluation';
    source_validation: ReviewFindingsDispositionSourceValidation;
    policy: ReviewFindingsDispositionPolicySnapshot;
    disposition_result: ReviewFindingsDispositionEvaluation;
    disposition_result_sha256: string;
    items: ReviewFindingsDispositionArtifactItem[];
    summary: ReviewFindingsDispositionArtifactSummary;
}

export interface BuildReviewFindingsDispositionArtifactOptions {
    taskId: string;
    reviewType: string;
    validationArtifact: ReviewFindingsValidationArtifact;
    validationArtifactPath?: string | null;
    validationArtifactSha256: string;
    policyResolution: LockedReviewFindingPolicyResolution;
}

function clonePolicy(policy: ReviewFindingPolicy): ReviewFindingPolicy {
    return {
        schema_version: policy.schema_version,
        policy_id: policy.policy_id,
        findings: { ...policy.findings },
        residual_risk: policy.residual_risk
    };
}

function dispositionStatus(action: ReviewFindingDispositionAction): ReviewFindingsDispositionItemMaterializationStatus {
    if (action === 'fix_now') {
        return 'requires_fix_now';
    }
    if (action === 'create_follow_up') {
        return 'pending_follow_up_materialization';
    }
    return 'audited_ignored';
}

function buildFindingItem(
    finding: NormalizedReviewFindingInventoryEntry,
    action: ReviewFindingDispositionAction,
    policyResolution: LockedReviewFindingPolicyResolution
): ReviewFindingsDispositionArtifactItem {
    return {
        id: finding.id,
        kind: 'finding',
        severity: finding.severity,
        action,
        source_rule: resolveReviewFindingDispositionSourceRule(
            policyResolution,
            'finding',
            finding.severity
        ),
        policy_source: policyResolution.source,
        blocking: action === 'fix_now',
        materialization_status: dispositionStatus(action),
        audit_status: 'retained_in_disposition_artifact'
    };
}

function buildResidualRiskItem(
    risk: NormalizedReviewResidualRiskInventoryEntry,
    action: ReviewFindingDispositionAction,
    policyResolution: LockedReviewFindingPolicyResolution
): ReviewFindingsDispositionArtifactItem {
    return {
        id: risk.id,
        kind: 'residual_risk',
        severity: 'residual_risk',
        action,
        source_rule: resolveReviewFindingDispositionSourceRule(
            policyResolution,
            'residual_risk',
            'residual_risk'
        ),
        policy_source: policyResolution.source,
        blocking: action === 'fix_now',
        materialization_status: dispositionStatus(action),
        audit_status: 'retained_in_disposition_artifact'
    };
}

function summarizeItems(items: readonly ReviewFindingsDispositionArtifactItem[]): ReviewFindingsDispositionArtifactSummary {
    return {
        item_count: items.length,
        fix_now_count: items.filter((item) => item.action === 'fix_now').length,
        follow_up_pending_count: items.filter((item) => item.action === 'create_follow_up').length,
        ignored_count: items.filter((item) => item.action === 'ignore').length,
        blocking_count: items.filter((item) => item.blocking).length,
        non_blocking_count: items.filter((item) => !item.blocking).length
    };
}

export function getReviewFindingsDispositionArtifactPath(reviewArtifactPath: string): string {
    return reviewArtifactPath.replace(/\.md$/u, '-findings-disposition.json');
}

export function getReviewFindingsDispositionArtifactSnapshotPath(artifactPath: string, artifactSha256: string): string {
    return artifactPath.replace(/\.json$/u, `-${artifactSha256}.json`);
}

export function buildReviewFindingsDispositionArtifact(
    options: BuildReviewFindingsDispositionArtifactOptions
): ReviewFindingsDispositionArtifact {
    const validationResult = options.validationArtifact.validation_result;
    if (validationResult.status !== 'accepted' || validationResult.accepted !== true) {
        throw new Error('Review findings disposition artifact requires an accepted system validation artifact.');
    }

    const dispositionResult = evaluateReviewFindingsValidationArtifactDispositions(
        options.validationArtifact,
        options.policyResolution
    );
    const items: ReviewFindingsDispositionArtifactItem[] = [];
    for (const severity of REVIEW_FINDING_SEVERITIES) {
        const action = dispositionResult.findings[severity].action;
        for (const finding of validationResult.normalized_inventory.findings_by_severity[severity]) {
            if (finding.id === EVIDENCE_ONLY_FINDING_ID) {
                continue;
            }
            items.push(buildFindingItem(finding, action, options.policyResolution));
        }
    }
    for (const risk of validationResult.normalized_inventory.residual_risks) {
        items.push(buildResidualRiskItem(
            risk,
            dispositionResult.residual_risks.action,
            options.policyResolution
        ));
    }

    return {
        schema_version: REVIEW_FINDINGS_DISPOSITION_ARTIFACT_SCHEMA_VERSION,
        artifact_type: REVIEW_FINDINGS_DISPOSITION_ARTIFACT_TYPE,
        task_id: options.taskId,
        review_type: options.reviewType,
        derivation_source: 'garda_locked_policy_evaluation',
        source_validation: {
            artifact_path: options.validationArtifactPath
                ? normalizePath(options.validationArtifactPath)
                : null,
            artifact_sha256: options.validationArtifactSha256,
            validation_result_sha256: options.validationArtifact.validation_result_sha256,
            status: 'accepted',
            accepted: true
        },
        policy: {
            policy_id: options.policyResolution.policy.policy_id,
            policy_source: options.policyResolution.source,
            policy_diagnostics: [...options.policyResolution.diagnostics],
            review_finding_policy: clonePolicy(options.policyResolution.policy),
            ...(options.policyResolution.follow_up_task_closure_policy.eligible
                ? {
                    base_review_finding_policy: clonePolicy(options.policyResolution.base_policy),
                    review_follow_up_task_closure_policy: {
                        ...options.policyResolution.follow_up_task_closure_policy,
                        diagnostics: [
                            ...options.policyResolution.follow_up_task_closure_policy.diagnostics
                        ]
                    },
                    review_follow_up_task_closure_policy_source:
                        options.policyResolution.follow_up_task_closure_policy_source
                }
                : {})
        },
        disposition_result: dispositionResult,
        disposition_result_sha256: sha256RedactedJsonPayload(dispositionResult),
        items,
        summary: summarizeItems(items)
    };
}

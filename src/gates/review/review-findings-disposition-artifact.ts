import { createHash } from 'node:crypto';

import type { ReviewFindingDispositionAction, ReviewFindingPolicy } from '../../policy/profile-resolver';
import { normalizePath } from '../shared/helpers';
import type {
    NormalizedReviewFindingInventoryEntry,
    NormalizedReviewResidualRiskInventoryEntry,
    ReviewFindingsValidationArtifact
} from './review-findings-validation-artifact';
import {
    evaluateReviewFindingsValidationArtifactDispositions,
    type LockedReviewFindingPolicyResolution,
    type ReviewFindingsDispositionEvaluation
} from './review-finding-disposition';
import type { ReviewFindingsSeverity } from './review-findings-schema';

export const REVIEW_FINDINGS_DISPOSITION_ARTIFACT_TYPE = 'review_findings_disposition';
export const REVIEW_FINDINGS_DISPOSITION_ARTIFACT_SCHEMA_VERSION = 1;

const REVIEW_FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const satisfies readonly ReviewFindingsSeverity[];

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

function sha256JsonPayload(value: unknown): string {
    return createHash('sha256')
        .update(`${JSON.stringify(value, null, 2)}\n`)
        .digest('hex');
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
    policySource: LockedReviewFindingPolicyResolution['source']
): ReviewFindingsDispositionArtifactItem {
    return {
        id: finding.id,
        kind: 'finding',
        severity: finding.severity,
        action,
        source_rule: `review_finding_policy.findings.${finding.severity}`,
        policy_source: policySource,
        blocking: action === 'fix_now',
        materialization_status: dispositionStatus(action),
        audit_status: 'retained_in_disposition_artifact'
    };
}

function buildResidualRiskItem(
    risk: NormalizedReviewResidualRiskInventoryEntry,
    action: ReviewFindingDispositionAction,
    policySource: LockedReviewFindingPolicyResolution['source']
): ReviewFindingsDispositionArtifactItem {
    return {
        id: risk.id,
        kind: 'residual_risk',
        severity: 'residual_risk',
        action,
        source_rule: 'review_finding_policy.residual_risk',
        policy_source: policySource,
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
            items.push(buildFindingItem(finding, action, options.policyResolution.source));
        }
    }
    for (const risk of validationResult.normalized_inventory.residual_risks) {
        items.push(buildResidualRiskItem(
            risk,
            dispositionResult.residual_risks.action,
            options.policyResolution.source
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
            review_finding_policy: clonePolicy(options.policyResolution.policy)
        },
        disposition_result: dispositionResult,
        disposition_result_sha256: sha256JsonPayload(dispositionResult),
        items,
        summary: summarizeItems(items)
    };
}

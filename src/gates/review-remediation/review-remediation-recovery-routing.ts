import { sha256RedactedJsonPayload } from '../../core/redaction';
import {
    getReviewExecutionDependencies,
    getReviewExecutionPreparationOrder,
    type EffectiveReviewExecutionPolicyMode
} from '../../core/review-execution-policy';
import { REVIEW_CAPABILITY_KEYS } from '../../core/review-capabilities';
import { isPlainRecord } from '../../core/records';
import { validateTaskProfilePolicySnapshot } from '../../policy/task-profile-policy-snapshot';
import {
    resolveReviewRemediationRerunLanes,
    resolveReviewRemediationRerunPolicyFromSnapshot
} from '../../policy/review-remediation-rerun-policy';
import type { ReviewRemediationDeltaClassification } from './review-remediation-delta';
import {
    buildReviewRemediationValidationRequirement,
    getReviewRemediationDeltaClassificationViolations,
    validateReviewRemediationValidationEvidence,
    type ReviewRemediationValidationArtifactStateReader,
    type ReviewRemediationValidationEvidence,
    type ReviewRemediationValidationRequirement
} from './review-remediation-validation-evidence';

export type ReviewRemediationRecoveryValidationRoute =
    | 'focused'
    | 'focused_and_affected'
    | 'ordinary';

export interface ReviewRemediationRecoveryCommand {
    command: string;
}

export interface ReviewRemediationReusableReceipt {
    review_type: string;
    reuse_status: 'ACCEPTED' | 'REJECTED';
    findings_satisfied: boolean;
    reason?: string | null;
}

export interface ReviewRemediationCompletedReceipt {
    schema_version: 1;
    task_id: string;
    review_type: string;
    status: 'ACCEPTED';
    findings_satisfied: true;
    review_context_sha256: string;
    delta_classification_sha256: string;
    validation_evidence_sha256: string;
    receipt_artifact_path: string;
    receipt_artifact_sha256: string;
}

export interface ReviewRemediationRecoveryNextAction {
    kind: 'validation' | 'review';
    target: string;
    command: string;
}

export interface ReviewRemediationRecoveryRoute {
    schema_version: 1;
    status: 'VALIDATION_REQUIRED' | 'REVIEW_REQUIRED' | 'COMPLETE';
    task_id: string;
    review_type: string;
    delta_category: ReviewRemediationDeltaClassification['category'];
    delta_classification_sha256: string;
    profile_policy_snapshot_sha256: string;
    policy_id: string;
    policy_legacy_fallback: boolean;
    validation_requirement: ReviewRemediationValidationRequirement;
    validation_route: ReviewRemediationRecoveryValidationRoute;
    validation_evidence_sha256: string | null;
    invalidated_review_types: string[];
    preserved_review_types: string[];
    reused_review_types: string[];
    rejected_reuse_review_types: string[];
    review_required_types: string[];
    completed_review_types: string[];
    dependency_edges: Array<{ review_type: string; depends_on: string[] }>;
    next_action: ReviewRemediationRecoveryNextAction | null;
    reason: string;
    routing_sha256: string;
}

export interface BuildReviewRemediationRecoveryRouteOptions {
    taskId: string;
    currentReviewType: string;
    profilePolicySnapshot: unknown;
    baselineProfilePolicySnapshotSha256: string;
    delta: ReviewRemediationDeltaClassification;
    requiredReviews: Record<string, boolean>;
    reviewExecutionPolicyMode: EffectiveReviewExecutionPolicyMode;
    reusableReceipts?: readonly ReviewRemediationReusableReceipt[];
    completedReceipts?: readonly ReviewRemediationCompletedReceipt[];
    reviewContextSha256ByType?: Partial<Record<string, string>>;
    validationEvidence?: ReviewRemediationValidationEvidence | null;
    reviewsRoot?: string;
    artifactStateReader?: ReviewRemediationValidationArtifactStateReader;
    validationCommands: Record<ReviewRemediationRecoveryValidationRoute, ReviewRemediationRecoveryCommand>;
    reviewCommands: Partial<Record<string, ReviewRemediationRecoveryCommand>>;
}

function normalizeSha256(value: unknown, label: string): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(normalized)) {
        throw new Error(`${label} must be a lowercase SHA-256 hash.`);
    }
    return normalized;
}

function resolveProfilePolicySnapshotSha256(snapshot: unknown): string {
    if (isPlainRecord(snapshot) && snapshot.snapshot_hash !== undefined) {
        const validation = validateTaskProfilePolicySnapshot(snapshot);
        if (validation.status !== 'PASS' || !validation.snapshot) {
            throw new Error(
                `Review remediation recovery policy snapshot is invalid: ${validation.violations.join(' ')}`
            );
        }
        return validation.snapshot.snapshot_hash;
    }
    return sha256RedactedJsonPayload(snapshot ?? null);
}

function normalizeReviewType(value: unknown, label: string): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (
        !normalized
        || value !== normalized
        || !(REVIEW_CAPABILITY_KEYS as readonly string[]).includes(normalized)
    ) {
        throw new Error(`${label} must be a supported canonical review type.`);
    }
    return normalized;
}

function canonicalRequiredReviewTypes(
    requiredReviews: Record<string, boolean>,
    policyMode: EffectiveReviewExecutionPolicyMode
): string[] {
    const required = Object.entries(requiredReviews)
        .filter(([, enabled]) => enabled === true)
        .map(([reviewType]) => normalizeReviewType(reviewType, 'required review type'));
    const order = getReviewExecutionPreparationOrder(policyMode);
    return [...new Set(required)].sort((left, right) => {
        const leftIndex = order.indexOf(left);
        const rightIndex = order.indexOf(right);
        return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
            - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
            || left.localeCompare(right);
    });
}

function requireCommand(command: ReviewRemediationRecoveryCommand | undefined, label: string): string {
    const value = String(command?.command || '');
    if (!value.trim() || value !== value.trim() || /[\r\n]/u.test(value)) {
        throw new Error(`${label} must provide one non-empty single-line executable command.`);
    }
    return value;
}

function validationRouteForRequirement(
    requirement: ReviewRemediationValidationRequirement
): ReviewRemediationRecoveryValidationRoute {
    return requirement === 'expanded_or_full' ? 'ordinary' : requirement;
}

function resolveReusableReviewTypes(options: {
    receipts: readonly ReviewRemediationReusableReceipt[];
    requiredReviewTypes: readonly string[];
    invalidatedReviewTypes: ReadonlySet<string>;
}): { reused: string[]; rejected: string[] } {
    const byReviewType = new Map<string, ReviewRemediationReusableReceipt>();
    for (const receipt of options.receipts) {
        const reviewType = normalizeReviewType(receipt.review_type, 'reusable receipt review_type');
        if (!options.requiredReviewTypes.includes(reviewType)) {
            throw new Error(`Reusable receipt '${reviewType}' is not a currently required review lane.`);
        }
        if (byReviewType.has(reviewType)) {
            throw new Error(`Reusable receipt '${reviewType}' is duplicated.`);
        }
        if (!['ACCEPTED', 'REJECTED'].includes(receipt.reuse_status)) {
            throw new Error(`Reusable receipt '${reviewType}' has unsupported reuse_status.`);
        }
        byReviewType.set(reviewType, receipt);
    }
    const reused: string[] = [];
    const rejected: string[] = [];
    for (const reviewType of options.requiredReviewTypes) {
        const receipt = byReviewType.get(reviewType);
        if (
            receipt
            && receipt.reuse_status === 'ACCEPTED'
            && receipt.findings_satisfied === true
            && !options.invalidatedReviewTypes.has(reviewType)
        ) {
            reused.push(reviewType);
        } else if (receipt) {
            rejected.push(reviewType);
        }
    }
    return { reused, rejected };
}

function resolveCompletedReviewTypes(
    options: {
        receipts: readonly ReviewRemediationCompletedReceipt[];
        taskId: string;
        requiredReviewTypes: readonly string[];
        reusedReviewTypes: ReadonlySet<string>;
        expectedDeltaClassificationSha256: string;
        expectedValidationEvidenceSha256: string;
        reviewContextSha256ByType: Partial<Record<string, string>>;
        reviewsRoot: string;
        artifactStateReader: ReviewRemediationValidationArtifactStateReader;
    }
): string[] {
    const completed: string[] = [];
    for (const receipt of options.receipts) {
        const reviewType = normalizeReviewType(receipt.review_type, 'completed receipt review_type');
        if (completed.includes(reviewType)) {
            throw new Error(`Completed receipt '${reviewType}' is duplicated.`);
        }
        if (!options.requiredReviewTypes.includes(reviewType)) {
            throw new Error(`Completed review '${reviewType}' is not currently required.`);
        }
        if (options.reusedReviewTypes.has(reviewType)) {
            throw new Error(`Completed review '${reviewType}' cannot also be a reused receipt.`);
        }
        if (
            receipt.schema_version !== 1
            || receipt.task_id !== options.taskId
            || receipt.status !== 'ACCEPTED'
            || receipt.findings_satisfied !== true
        ) {
            throw new Error(`Completed receipt '${reviewType}' is not accepted satisfied evidence for this task.`);
        }
        const reviewContextSha256 = normalizeSha256(
            receipt.review_context_sha256,
            `completed receipt '${reviewType}' review_context_sha256`
        );
        const expectedReviewContextSha256 = normalizeSha256(
            options.reviewContextSha256ByType[reviewType],
            `current review context '${reviewType}' hash`
        );
        if (reviewContextSha256 !== expectedReviewContextSha256) {
            throw new Error(`Completed receipt '${reviewType}' is not bound to the current review context.`);
        }
        if (
            normalizeSha256(
                receipt.delta_classification_sha256,
                `completed receipt '${reviewType}' delta_classification_sha256`
            ) !== options.expectedDeltaClassificationSha256
            || normalizeSha256(
                receipt.validation_evidence_sha256,
                `completed receipt '${reviewType}' validation_evidence_sha256`
            ) !== options.expectedValidationEvidenceSha256
        ) {
            throw new Error(`Completed receipt '${reviewType}' is not bound to the current remediation cycle.`);
        }
        const receiptArtifactPath = String(receipt.receipt_artifact_path || '').replace(/\\/gu, '/');
        const reviewsRoot = options.reviewsRoot.replace(/\\/gu, '/').replace(/\/$/u, '');
        if (
            receipt.receipt_artifact_path !== receiptArtifactPath
            || !receiptArtifactPath.startsWith(`${reviewsRoot}/`)
            || !receiptArtifactPath.slice(reviewsRoot.length + 1).startsWith(`${options.taskId}-`)
            || receiptArtifactPath.split('/').some((segment) => segment === '.' || segment === '..')
        ) {
            throw new Error(`Completed receipt '${reviewType}' artifact path is not task-owned.`);
        }
        const receiptArtifactSha256 = normalizeSha256(
            receipt.receipt_artifact_sha256,
            `completed receipt '${reviewType}' receipt_artifact_sha256`
        );
        const artifactState = options.artifactStateReader(receiptArtifactPath);
        if (!artifactState || artifactState.sha256 !== receiptArtifactSha256) {
            throw new Error(`Completed receipt '${reviewType}' does not match authenticated artifact state.`);
        }
        completed.push(reviewType);
    }
    return options.requiredReviewTypes.filter((reviewType) => completed.includes(reviewType));
}

function withoutRoutingHash(route: Omit<ReviewRemediationRecoveryRoute, 'routing_sha256'>): Record<string, unknown> {
    return route as unknown as Record<string, unknown>;
}

export function buildReviewRemediationRecoveryRoute(
    options: BuildReviewRemediationRecoveryRouteOptions
): ReviewRemediationRecoveryRoute {
    const taskId = String(options.taskId || '').trim();
    if (!taskId || options.taskId !== taskId) {
        throw new Error('Review remediation recovery routing requires a canonical task id.');
    }
    const currentReviewType = normalizeReviewType(options.currentReviewType, 'current review type');
    const deltaViolations = getReviewRemediationDeltaClassificationViolations(options.delta);
    if (deltaViolations.length > 0) {
        throw new Error(`Review remediation recovery delta is invalid: ${deltaViolations.join(' ')}`);
    }
    if (options.delta.task_id !== taskId || options.delta.review_type !== currentReviewType) {
        throw new Error('Review remediation recovery delta belongs to a foreign task or review type.');
    }

    const profilePolicySnapshotSha256 = resolveProfilePolicySnapshotSha256(options.profilePolicySnapshot);
    const baselineProfilePolicySnapshotSha256 = normalizeSha256(
        options.baselineProfilePolicySnapshotSha256,
        'baseline profile policy snapshot hash'
    );
    if (profilePolicySnapshotSha256 !== baselineProfilePolicySnapshotSha256) {
        throw new Error('Review remediation recovery policy snapshot does not match the authenticated baseline.');
    }

    const requiredReviewTypes = canonicalRequiredReviewTypes(
        options.requiredReviews,
        options.reviewExecutionPolicyMode
    );
    const policyResolution = resolveReviewRemediationRerunPolicyFromSnapshot(options.profilePolicySnapshot);
    const selection = resolveReviewRemediationRerunLanes({
        policy: policyResolution.policy,
        category: options.delta.category,
        currentReviewType,
        requiredReviews: options.requiredReviews,
        reviewExecutionPolicyMode: options.reviewExecutionPolicyMode
    });
    const invalidatedReviewTypes = selection.ordered_rerun_lanes;
    const invalidatedSet = new Set(invalidatedReviewTypes);
    const preservedReviewTypes = requiredReviewTypes.filter((reviewType) => !invalidatedSet.has(reviewType));
    const receiptResolution = resolveReusableReviewTypes({
        receipts: options.reusableReceipts ?? [],
        requiredReviewTypes,
        invalidatedReviewTypes: invalidatedSet
    });
    const reusedSet = new Set(receiptResolution.reused);
    const reviewRequiredTypes = requiredReviewTypes.filter((reviewType) => !reusedSet.has(reviewType));
    const dependencyEdges = reviewRequiredTypes.map((reviewType) => ({
        review_type: reviewType,
        depends_on: getReviewExecutionDependencies(
            reviewType,
            options.requiredReviews,
            options.reviewExecutionPolicyMode
        ).filter((dependency) => requiredReviewTypes.includes(dependency))
    }));
    const validationRequirement = buildReviewRemediationValidationRequirement(options.delta.category);
    const validationRoute = validationRouteForRequirement(validationRequirement);
    let validationEvidenceSha256: string | null = null;
    let completedReviewTypes: string[] = [];
    let status: ReviewRemediationRecoveryRoute['status'];
    let nextAction: ReviewRemediationRecoveryNextAction | null;
    let reason: string;

    if (!options.validationEvidence) {
        status = 'VALIDATION_REQUIRED';
        nextAction = {
            kind: 'validation',
            target: validationRoute,
            command: requireCommand(
                options.validationCommands[validationRoute],
                `${validationRoute} validation route`
            )
        };
        reason = `Remediation category '${options.delta.category}' requires '${validationRequirement}' validation before any affected review lane.`;
    } else {
        if (!options.reviewsRoot || !options.artifactStateReader) {
            throw new Error('Review remediation validation evidence requires reviewsRoot and artifactStateReader.');
        }
        const validation = validateReviewRemediationValidationEvidence(options.validationEvidence, {
            reviewsRoot: options.reviewsRoot,
            artifactStateReader: options.artifactStateReader,
            taskId,
            reviewType: currentReviewType,
            deltaCategory: options.delta.category,
            baselineArtifactSha256: options.delta.baseline.artifact_sha256,
            deltaClassificationSha256: options.delta.classification_sha256
        });
        if (!validation.valid) {
            throw new Error(`Review remediation validation evidence is invalid: ${validation.violations.join(' ')}`);
        }
        validationEvidenceSha256 = sha256RedactedJsonPayload(options.validationEvidence);
        completedReviewTypes = resolveCompletedReviewTypes({
            receipts: options.completedReceipts ?? [],
            taskId,
            requiredReviewTypes,
            reusedReviewTypes: reusedSet,
            expectedDeltaClassificationSha256: options.delta.classification_sha256,
            expectedValidationEvidenceSha256: validationEvidenceSha256,
            reviewContextSha256ByType: options.reviewContextSha256ByType ?? {},
            reviewsRoot: options.reviewsRoot,
            artifactStateReader: options.artifactStateReader
        });
        const completedSet = new Set(completedReviewTypes);
        const pendingReviewTypes = reviewRequiredTypes.filter((reviewType) => !completedSet.has(reviewType));
        if (pendingReviewTypes.length === 0) {
            status = 'COMPLETE';
            nextAction = null;
            reason = 'Selective validation is satisfied and every required review lane is fresh or safely reused.';
        } else {
            const satisfiedReviewTypes = new Set([...receiptResolution.reused, ...completedReviewTypes]);
            const nextReviewType = pendingReviewTypes.find((reviewType) => {
                const edge = dependencyEdges.find((candidate) => candidate.review_type === reviewType);
                return (edge?.depends_on ?? []).every((dependency) => satisfiedReviewTypes.has(dependency));
            });
            if (!nextReviewType) {
                throw new Error('Review remediation dependency order has no executable next review lane.');
            }
            status = 'REVIEW_REQUIRED';
            nextAction = {
                kind: 'review',
                target: nextReviewType,
                command: requireCommand(
                    options.reviewCommands[nextReviewType],
                    `review route '${nextReviewType}'`
                )
            };
            reason = `Selective validation is satisfied; '${nextReviewType}' is the first dependency-ready review lane.`;
        }
    }

    const routeWithoutHash: Omit<ReviewRemediationRecoveryRoute, 'routing_sha256'> = {
        schema_version: 1,
        status,
        task_id: taskId,
        review_type: currentReviewType,
        delta_category: options.delta.category,
        delta_classification_sha256: options.delta.classification_sha256,
        profile_policy_snapshot_sha256: profilePolicySnapshotSha256,
        policy_id: policyResolution.policy.policy_id,
        policy_legacy_fallback: policyResolution.legacy_fallback,
        validation_requirement: validationRequirement,
        validation_route: validationRoute,
        validation_evidence_sha256: validationEvidenceSha256,
        invalidated_review_types: invalidatedReviewTypes,
        preserved_review_types: preservedReviewTypes,
        reused_review_types: receiptResolution.reused,
        rejected_reuse_review_types: receiptResolution.rejected,
        review_required_types: reviewRequiredTypes,
        completed_review_types: completedReviewTypes,
        dependency_edges: dependencyEdges,
        next_action: nextAction,
        reason
    };
    return {
        ...routeWithoutHash,
        routing_sha256: sha256RedactedJsonPayload(withoutRoutingHash(routeWithoutHash))
    };
}

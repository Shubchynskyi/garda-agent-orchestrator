import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import {
    buildReviewRemediationRecoveryRoute,
    type BuildReviewRemediationRecoveryRouteOptions,
    type ReviewRemediationCompletedReceipt,
    type ReviewRemediationReusableReceipt
} from '../../../../src/gates/review-remediation/review-remediation-recovery-routing';
import type { ReviewRemediationDeltaClassification } from '../../../../src/gates/review-remediation/review-remediation-delta';
import {
    buildReviewRemediationValidationEvidence,
    type BuildReviewRemediationValidationComponentInput,
    type ReviewRemediationValidationArtifactState
} from '../../../../src/gates/review-remediation/review-remediation-validation-evidence';
import {
    buildDefaultReviewRemediationRerunPolicy,
    type ReviewRemediationDeltaCategory
} from '../../../../src/policy/review-remediation-rerun-policy';

const TASK_ID = 'T-979-40-fixture';
const REVIEWS_ROOT = 'garda-agent-orchestrator/runtime/reviews';

function hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function makeSnapshot(): Record<string, unknown> {
    return {
        schema_version: 1,
        review_remediation_rerun_policy: buildDefaultReviewRemediationRerunPolicy(),
        review_remediation_rerun_policy_diagnostics: ['fixture policy']
    };
}

function makeDelta(category: ReviewRemediationDeltaCategory): ReviewRemediationDeltaClassification {
    const core: Omit<ReviewRemediationDeltaClassification, 'classification_sha256'> = {
        schema_version: 1,
        task_id: TASK_ID,
        review_type: 'test',
        status: 'CLASSIFIED',
        category,
        reason: `fixture category ${category}`,
        baseline: {
            artifact_path: `${REVIEWS_ROOT}/${TASK_ID}-test-remediation-baseline.json`,
            artifact_sha256: hash('baseline'),
            review_tree_state_sha256: hash('tree'),
            delta_base_snapshot_sha256: hash('delta-base')
        },
        current_snapshot_sha256: hash('current'),
        changed_files: ['tests/node/example.test.ts'],
        unchanged_files: [],
        file_deltas: [],
        additions_total: 1,
        deletions_total: 0,
        changed_lines_total: 1
    };
    return {
        ...core,
        classification_sha256: sha256RedactedJsonPayload(core)
    };
}

function component(role: BuildReviewRemediationValidationComponentInput['role']): BuildReviewRemediationValidationComponentInput {
    const full = role === 'full';
    return {
        role,
        sourceKind: full ? 'full_suite_validation' : 'intermediate_command',
        command: full ? 'npm test' : `npm test -- ${role}`,
        status: 'PASSED',
        exitCode: 0,
        sourceArtifactPath: `${REVIEWS_ROOT}/${TASK_ID}-${role}-result.json`,
        sourceArtifactSha256: hash(`${role}-result`),
        ...(full
            ? {}
            : {
                outputArtifactPath: `${REVIEWS_ROOT}/${TASK_ID}-${role}-output.log`,
                outputArtifactSha256: hash(`${role}-output`),
                outputArtifactSizeBytes: 64
            })
    };
}

function readArtifactState(artifactPath: string): ReviewRemediationValidationArtifactState | null {
    if (artifactPath.endsWith('-test-remediation-baseline.json')) {
        return { sha256: hash('baseline'), size_bytes: 1 };
    }
    for (const role of ['focused', 'affected', 'expanded', 'full'] as const) {
        if (artifactPath.endsWith(`-${role}-result.json`)) {
            return {
                sha256: hash(`${role}-result`),
                size_bytes: 1,
                source_kind: role === 'full' ? 'full_suite_validation' : 'intermediate_command',
                command: role === 'full' ? 'npm test' : `npm test -- ${role}`,
                status: 'PASSED',
                exit_code: 0
            };
        }
        if (artifactPath.endsWith(`-${role}-output.log`)) {
            return { sha256: hash(`${role}-output`), size_bytes: 64 };
        }
    }
    for (const reviewType of ['code', 'security', 'refactor', 'test']) {
        if (artifactPath.endsWith(`-${reviewType}-receipt.json`)) {
            return { sha256: hash(`${reviewType}-receipt`), size_bytes: 1 };
        }
    }
    return null;
}

function validationEvidence(category: ReviewRemediationDeltaCategory) {
    const roles = category === 'leaf_test'
        ? ['focused'] as const
        : category === 'structural_test'
            ? ['focused', 'affected'] as const
            : ['expanded'] as const;
    return buildReviewRemediationValidationEvidence({
        reviewsRoot: REVIEWS_ROOT,
        artifactStateReader: readArtifactState,
        delta: makeDelta(category),
        components: roles.map(component)
    });
}

const validationCommands = {
    focused: { command: 'node run-focused.js' },
    focused_and_affected: { command: 'node run-focused-affected.js' },
    ordinary: { command: 'node bin/garda.js gate full-suite-validation --task-id T-979-40-fixture' }
};

const reviewCommands = {
    code: { command: 'node review-code.js' },
    security: { command: 'node review-security.js' },
    refactor: { command: 'node review-refactor.js' },
    test: { command: 'node review-test.js' }
};

function acceptedReceipt(reviewType: string): ReviewRemediationReusableReceipt {
    return {
        review_type: reviewType,
        reuse_status: 'ACCEPTED',
        findings_satisfied: true
    };
}

function completedReceipt(
    reviewType: string,
    evidence: ReturnType<typeof validationEvidence>
): ReviewRemediationCompletedReceipt {
    return {
        schema_version: 1,
        task_id: TASK_ID,
        review_type: reviewType,
        status: 'ACCEPTED',
        findings_satisfied: true,
        review_context_sha256: hash(`${reviewType}-context`),
        delta_classification_sha256: evidence.remediation_bindings.delta_classification_sha256,
        validation_evidence_sha256: sha256RedactedJsonPayload(evidence),
        receipt_artifact_path: `${REVIEWS_ROOT}/${TASK_ID}-${reviewType}-receipt.json`,
        receipt_artifact_sha256: hash(`${reviewType}-receipt`)
    };
}

function routeOptions(
    category: ReviewRemediationDeltaCategory,
    overrides: Partial<BuildReviewRemediationRecoveryRouteOptions> = {}
): BuildReviewRemediationRecoveryRouteOptions {
    const profilePolicySnapshot = makeSnapshot();
    return {
        taskId: TASK_ID,
        currentReviewType: 'test',
        profilePolicySnapshot,
        baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot),
        delta: makeDelta(category),
        requiredReviews: { code: true, refactor: true, test: true },
        reviewExecutionPolicyMode: 'strict_sequential',
        reusableReceipts: [acceptedReceipt('code'), acceptedReceipt('refactor'), acceptedReceipt('test')],
        completedReceipts: [],
        reviewContextSha256ByType: {
            code: hash('code-context'),
            security: hash('security-context'),
            refactor: hash('refactor-context'),
            test: hash('test-context')
        },
        validationCommands,
        reviewCommands,
        reviewsRoot: REVIEWS_ROOT,
        artifactStateReader: readArtifactState,
        ...overrides
    };
}

describe('review remediation selective recovery routing', () => {
    it('routes leaf remediation through focused validation and reruns only the current lane', () => {
        const beforeValidation = buildReviewRemediationRecoveryRoute(routeOptions('leaf_test'));
        assert.equal(beforeValidation.status, 'VALIDATION_REQUIRED');
        assert.deepEqual(beforeValidation.invalidated_review_types, ['test']);
        assert.deepEqual(beforeValidation.reused_review_types, ['code', 'refactor']);
        assert.deepEqual(beforeValidation.review_required_types, ['test']);
        assert.deepEqual(beforeValidation.next_action, {
            kind: 'validation',
            target: 'focused',
            command: 'node run-focused.js'
        });

        const afterValidation = buildReviewRemediationRecoveryRoute(routeOptions('leaf_test', {
            validationEvidence: validationEvidence('leaf_test')
        }));
        assert.equal(afterValidation.status, 'REVIEW_REQUIRED');
        assert.deepEqual(afterValidation.next_action, {
            kind: 'review',
            target: 'test',
            command: 'node review-test.js'
        });
    });

    it('routes structural remediation through focused plus affected validation in dependency order', () => {
        const beforeValidation = buildReviewRemediationRecoveryRoute(routeOptions('structural_test'));
        assert.equal(beforeValidation.validation_route, 'focused_and_affected');
        assert.deepEqual(beforeValidation.invalidated_review_types, ['refactor', 'test']);
        assert.deepEqual(beforeValidation.reused_review_types, ['code']);
        assert.equal(beforeValidation.next_action?.command, 'node run-focused-affected.js');

        const afterValidation = buildReviewRemediationRecoveryRoute(routeOptions('structural_test', {
            validationEvidence: validationEvidence('structural_test')
        }));
        assert.equal(afterValidation.next_action?.target, 'refactor');

        const evidence = validationEvidence('structural_test');
        const afterRefactor = buildReviewRemediationRecoveryRoute(routeOptions('structural_test', {
            validationEvidence: evidence,
            completedReceipts: [completedReceipt('refactor', evidence)]
        }));
        assert.equal(afterRefactor.next_action?.target, 'test');
        assert.deepEqual(
            afterRefactor.dependency_edges.find((entry) => entry.review_type === 'test')?.depends_on,
            ['code', 'refactor']
        );
    });

    it('routes broad impact to ordinary validation and invalidates only currently required lanes', () => {
        const beforeValidation = buildReviewRemediationRecoveryRoute(routeOptions('production', {
            requiredReviews: { code: true, security: true, api: false, test: true },
            reusableReceipts: [acceptedReceipt('code'), acceptedReceipt('security'), acceptedReceipt('test')]
        }));
        assert.equal(beforeValidation.validation_route, 'ordinary');
        assert.deepEqual(beforeValidation.invalidated_review_types, ['code', 'security', 'test']);
        assert.deepEqual(beforeValidation.preserved_review_types, []);
        assert.deepEqual(beforeValidation.reused_review_types, []);
        assert.equal(beforeValidation.next_action?.command, validationCommands.ordinary.command);

        const afterValidation = buildReviewRemediationRecoveryRoute(routeOptions('production', {
            requiredReviews: { code: true, security: true, api: false, test: true },
            reusableReceipts: [acceptedReceipt('code'), acceptedReceipt('security'), acceptedReceipt('test')],
            validationEvidence: validationEvidence('production')
        }));
        assert.equal(afterValidation.next_action?.target, 'code');
    });

    it('does not preserve an unaffected receipt unless reuse and findings satisfaction were accepted', () => {
        const route = buildReviewRemediationRecoveryRoute(routeOptions('leaf_test', {
            requiredReviews: { code: true, test: true },
            reusableReceipts: [
                {
                    review_type: 'code',
                    reuse_status: 'REJECTED',
                    findings_satisfied: true,
                    reason: 'scope binding is stale'
                },
                acceptedReceipt('test')
            ],
            validationEvidence: validationEvidence('leaf_test')
        }));
        assert.deepEqual(route.preserved_review_types, ['code']);
        assert.deepEqual(route.reused_review_types, []);
        assert.deepEqual(route.rejected_reuse_review_types, ['code', 'test']);
        assert.deepEqual(route.review_required_types, ['code', 'test']);
        assert.equal(route.next_action?.target, 'code');
    });

    it('completes only after every non-reused lane has fresh satisfied evidence', () => {
        const evidence = validationEvidence('structural_test');
        const route = buildReviewRemediationRecoveryRoute(routeOptions('structural_test', {
            validationEvidence: evidence,
            completedReceipts: [
                completedReceipt('refactor', evidence),
                completedReceipt('test', evidence)
            ]
        }));
        assert.equal(route.status, 'COMPLETE');
        assert.equal(route.next_action, null);
        assert.match(route.routing_sha256, /^[0-9a-f]{64}$/u);
    });

    it('fails closed for forged validation evidence and a foreign policy snapshot binding', () => {
        const tampered = validationEvidence('leaf_test');
        tampered.delta_category = 'production';
        assert.throws(() => buildReviewRemediationRecoveryRoute(routeOptions('leaf_test', {
            validationEvidence: tampered
        })), /validation evidence is invalid/iu);

        assert.throws(() => buildReviewRemediationRecoveryRoute(routeOptions('leaf_test', {
            baselineProfilePolicySnapshotSha256: hash('foreign')
        })), /policy snapshot does not match/iu);

        const policy = makeSnapshot();
        assert.throws(() => buildReviewRemediationRecoveryRoute(routeOptions('leaf_test', {
            profilePolicySnapshot: { ...policy, snapshot_hash: sha256RedactedJsonPayload(policy) },
            baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(policy)
        })), /policy snapshot is invalid/iu);
    });

    it('rejects completed lane names without authenticated current-cycle receipt bindings', () => {
        const evidence = validationEvidence('structural_test');
        const forged = completedReceipt('refactor', evidence);
        forged.validation_evidence_sha256 = hash('foreign-validation');
        assert.throws(() => buildReviewRemediationRecoveryRoute(routeOptions('structural_test', {
            validationEvidence: evidence,
            completedReceipts: [forged]
        })), /not bound to the current remediation cycle/iu);

        const staleContext = completedReceipt('refactor', evidence);
        staleContext.review_context_sha256 = hash('stale-context');
        assert.throws(() => buildReviewRemediationRecoveryRoute(routeOptions('structural_test', {
            validationEvidence: evidence,
            completedReceipts: [staleContext]
        })), /not bound to the current review context/iu);
    });

    it('uses the conservative all-required fallback for legacy task snapshots', () => {
        const profilePolicySnapshot = { schema_version: 1 };
        const route = buildReviewRemediationRecoveryRoute(routeOptions('leaf_test', {
            profilePolicySnapshot,
            baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot),
            requiredReviews: { code: true, test: true },
            reusableReceipts: [acceptedReceipt('code'), acceptedReceipt('test')]
        }));
        assert.equal(route.policy_legacy_fallback, true);
        assert.deepEqual(route.invalidated_review_types, ['code', 'test']);
        assert.deepEqual(route.reused_review_types, []);
    });
});

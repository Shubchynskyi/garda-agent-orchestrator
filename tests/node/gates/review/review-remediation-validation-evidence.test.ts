import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import type { ReviewRemediationDeltaClassification } from '../../../../src/gates/review-remediation/review-remediation-delta';
import {
    buildReviewRemediationValidationEvidence,
    buildReviewRemediationValidationRequirement,
    REVIEW_REMEDIATION_VALIDATION_EVIDENCE_ARTIFACT_TYPE,
    validateReviewRemediationValidationEvidence,
    type BuildReviewRemediationValidationComponentInput,
    type ReviewRemediationValidationEvidence
} from '../../../../src/gates/review-remediation/review-remediation-validation-evidence';
import {
    REVIEW_REMEDIATION_DELTA_CATEGORIES,
    type ReviewRemediationDeltaCategory
} from '../../../../src/policy/review-remediation-rerun-policy';

const hash = (value: string): string => sha256RedactedJsonPayload(value);
const REVIEWS_ROOT = 'garda-agent-orchestrator/runtime/reviews';

function readArtifactState(artifactPath: string): {
    sha256: string;
    size_bytes: number;
    source_kind?: 'intermediate_command' | 'full_suite_validation';
    command?: string;
    status?: string;
    exit_code?: number;
} | null {
    if (artifactPath.endsWith('-test-remediation-baseline.json')) {
        return { sha256: hash('baseline'), size_bytes: 256 };
    }
    const role = ['focused', 'affected', 'expanded', 'full'].find((candidate) => (
        artifactPath.endsWith(`-${candidate}-result.json`)
        || artifactPath.endsWith(`-${candidate}-output.log`)
    ));
    if (!role) {
        return null;
    }
    return artifactPath.endsWith('-output.log')
        ? { sha256: hash(`${role}-output`), size_bytes: 128 }
        : {
            sha256: hash(`${role}-result`),
            size_bytes: 64,
            source_kind: role === 'full' ? 'full_suite_validation' : 'intermediate_command',
            command: role === 'full' ? 'npm test' : `npm test -- ${role}`,
            status: 'PASSED',
            exit_code: 0
        };
}

function buildEvidence(
    options: Omit<
        Parameters<typeof buildReviewRemediationValidationEvidence>[0],
        'reviewsRoot' | 'artifactStateReader'
    >
): ReviewRemediationValidationEvidence {
    return buildReviewRemediationValidationEvidence({
        reviewsRoot: REVIEWS_ROOT,
        artifactStateReader: readArtifactState,
        ...options
    });
}

function validateEvidence(
    value: unknown,
    expectations: Omit<
        Parameters<typeof validateReviewRemediationValidationEvidence>[1],
        'reviewsRoot' | 'artifactStateReader'
    > = {}
) {
    return validateReviewRemediationValidationEvidence(value, {
        reviewsRoot: REVIEWS_ROOT,
        artifactStateReader: readArtifactState,
        ...expectations
    });
}

function makeDelta(category: ReviewRemediationDeltaCategory): ReviewRemediationDeltaClassification {
    const core: Omit<ReviewRemediationDeltaClassification, 'classification_sha256'> = {
        schema_version: 1,
        task_id: 'T-979-39-fixture',
        review_type: 'test',
        status: 'CLASSIFIED',
        category,
        reason: `fixture category ${category}`,
        baseline: {
            artifact_path: 'garda-agent-orchestrator/runtime/reviews/T-979-39-fixture-test-remediation-baseline.json',
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

function component(
    role: BuildReviewRemediationValidationComponentInput['role']
): BuildReviewRemediationValidationComponentInput {
    const full = role === 'full';
    return {
        role,
        sourceKind: full ? 'full_suite_validation' : 'intermediate_command',
        command: full ? 'npm test' : `npm test -- ${role}`,
        status: 'PASSED',
        exitCode: 0,
        sourceArtifactPath: `garda-agent-orchestrator/runtime/reviews/T-979-39-fixture-${role}-result.json`,
        sourceArtifactSha256: hash(`${role}-result`),
        ...(full
            ? {}
            : {
                outputArtifactPath: `garda-agent-orchestrator/runtime/reviews/T-979-39-fixture-${role}-output.log`,
                outputArtifactSha256: hash(`${role}-output`),
                outputArtifactSizeBytes: 128
            })
    };
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

describe('review remediation composite validation evidence', () => {
    it('maps every delta category to its frozen validation requirement', () => {
        assert.equal(buildReviewRemediationValidationRequirement('leaf_test'), 'focused');
        assert.equal(buildReviewRemediationValidationRequirement('structural_test'), 'focused_and_affected');
        for (const category of REVIEW_REMEDIATION_DELTA_CATEGORIES.filter((entry) => (
            entry !== 'leaf_test' && entry !== 'structural_test'
        ))) {
            assert.equal(
                buildReviewRemediationValidationRequirement(category),
                'expanded_or_full',
                category
            );
        }
    });

    it('builds leaf and structural composites with exact component coverage', () => {
        const leaf = buildEvidence({
            delta: makeDelta('leaf_test'),
            components: [component('focused')]
        });
        assert.equal(leaf.artifact_type, REVIEW_REMEDIATION_VALIDATION_EVIDENCE_ARTIFACT_TYPE);
        assert.equal(leaf.receipt_kind, 'selective_remediation_validation');
        assert.equal(leaf.is_full_suite_receipt, false);
        assert.equal(leaf.validation_requirement, 'focused');
        assert.equal(validateEvidence(leaf).valid, true);

        const structural = buildEvidence({
            delta: makeDelta('structural_test'),
            components: [component('focused'), component('affected')]
        });
        assert.deepEqual(structural.components.map((entry) => entry.role), ['focused', 'affected']);
        assert.equal(validateEvidence(structural).valid, true);

        assert.throws(() => buildEvidence({
            delta: makeDelta('structural_test'),
            components: [component('focused')]
        }), /do not satisfy 'focused_and_affected'/u);
        assert.throws(() => buildEvidence({
            delta: makeDelta('leaf_test'),
            components: [component('focused'), component('affected')]
        }), /do not satisfy 'focused'/u);
    });

    it('accepts expanded validation for every broad category including generated churn', () => {
        const broadCategories = REVIEW_REMEDIATION_DELTA_CATEGORIES.filter((category) => (
            category !== 'leaf_test' && category !== 'structural_test'
        ));
        for (const category of broadCategories) {
            const evidence = buildEvidence({
                delta: makeDelta(category),
                components: [component('expanded')]
            });
            assert.equal(evidence.validation_requirement, 'expanded_or_full', category);
            assert.equal(validateEvidence(evidence).valid, true, category);
        }
    });

    it('accepts full-suite results only as a component while retaining the selective receipt label', () => {
        const evidence = buildEvidence({
            delta: makeDelta('production'),
            components: [component('full')]
        });
        assert.equal(evidence.components[0].source_kind, 'full_suite_validation');
        assert.equal(evidence.components[0].output_artifact_path, null);
        assert.equal(evidence.receipt_kind, 'selective_remediation_validation');
        assert.equal(evidence.is_full_suite_receipt, false);
        assert.equal(validateEvidence(evidence).valid, true);

        const relabeled = clone(evidence) as unknown as Record<string, unknown>;
        relabeled.artifact_type = 'full_suite_validation';
        relabeled.receipt_kind = 'full_suite_validation';
        relabeled.is_full_suite_receipt = true;
        const result = validateEvidence(relabeled);
        assert.equal(result.valid, false);
        assert.match(result.violations.join(' '), /never as a full-suite receipt/u);
    });

    it('rejects non-passing, malformed, duplicate, and source-incompatible components', () => {
        const evidence = buildEvidence({
            delta: makeDelta('structural_test'),
            components: [component('focused'), component('affected')]
        });

        const failed = clone(evidence) as unknown as {
            components: Array<Record<string, unknown>>;
        };
        failed.components[0].status = 'WARNED';
        failed.components[0].exit_code = 1;
        assert.match(
            validateEvidence(failed).violations.join(' '),
            /PASSED result with exit_code 0/u
        );

        const duplicate = clone(evidence);
        duplicate.components = [duplicate.components[0], duplicate.components[0]];
        assert.match(
            validateEvidence(duplicate).violations.join(' '),
            /do not satisfy 'focused_and_affected'/u
        );

        const incompatible = clone(evidence);
        incompatible.components[0].source_kind = 'full_suite_validation';
        assert.match(
            validateEvidence(incompatible).violations.join(' '),
            /non-full role must use intermediate_command/u
        );

        const extraField = clone(evidence) as unknown as Record<string, unknown>;
        extraField.unexpected = true;
        assert.match(
            validateEvidence(extraField).violations.join(' '),
            /evidence\.unexpected is not allowed/u
        );

        const mismatchedCommand = component('focused');
        mismatchedCommand.command = 'npm test -- another-target';
        assert.throws(() => buildEvidence({
            delta: makeDelta('leaf_test'),
            components: [mismatchedCommand]
        }), /source_artifact command does not match authenticated state/u);
    });

    it('rejects artifacts outside the task-owned reviews root or owned by another task', () => {
        const cases = [{
            path: '../outside-result.json',
            pattern: /must not contain '\.' or '\.\.' path segments/u
        }, {
            path: 'D:/outside-result.json',
            pattern: /must remain inside task-owned reviews root/u
        }, {
            path: 'garda-agent-orchestrator/runtime/reviews/T-foreign-focused-result.json',
            pattern: /must name an artifact owned by task 'T-979-39-fixture'/u
        }];
        for (const testCase of cases) {
            const input = component('focused');
            input.sourceArtifactPath = testCase.path;
            assert.throws(() => buildEvidence({
                delta: makeDelta('leaf_test'),
                components: [input]
            }), testCase.pattern);
        }

        const externalDelta = makeDelta('leaf_test');
        externalDelta.baseline.artifact_path = 'external/reviews/T-979-39-fixture-test-remediation-baseline.json';
        const { classification_sha256: ignoredClassificationHash, ...externalDeltaCore } = externalDelta;
        void ignoredClassificationHash;
        externalDelta.classification_sha256 = sha256RedactedJsonPayload(externalDeltaCore);
        const externalComponent = component('focused');
        externalComponent.sourceArtifactPath = 'external/reviews/T-979-39-fixture-focused-result.json';
        externalComponent.outputArtifactPath = 'external/reviews/T-979-39-fixture-focused-output.log';
        assert.throws(() => buildEvidence({
            delta: externalDelta,
            components: [externalComponent]
        }), /baseline_artifact_path must remain inside task-owned reviews root/u);

        const missingComponent = component('focused');
        missingComponent.sourceArtifactPath = `${REVIEWS_ROOT}/T-979-39-fixture-missing-result.json`;
        assert.throws(() => buildEvidence({
            delta: makeDelta('leaf_test'),
            components: [missingComponent]
        }), /source_artifact artifact is missing or unreadable/u);
    });

    it('detects command, result, baseline, delta, component, and aggregate hash tampering', () => {
        const delta = makeDelta('leaf_test');
        const evidence = buildEvidence({
            delta,
            components: [component('focused')]
        });
        const mutations: Array<{
            label: string;
            mutate: (artifact: ReviewRemediationValidationEvidence) => void;
            pattern: RegExp;
        }> = [{
            label: 'command',
            mutate: (artifact) => { artifact.components[0].command = 'npm test -- changed'; },
            pattern: /command_sha256 does not match/u
        }, {
            label: 'result artifact',
            mutate: (artifact) => { artifact.components[0].source_artifact_sha256 = hash('changed'); },
            pattern: /component_sha256 does not match/u
        }, {
            label: 'baseline',
            mutate: (artifact) => { artifact.remediation_bindings.baseline_artifact_sha256 = hash('changed'); },
            pattern: /remediation_binding_sha256 does not match/u
        }, {
            label: 'delta',
            mutate: (artifact) => { artifact.remediation_bindings.delta_classification_sha256 = hash('changed'); },
            pattern: /remediation_binding_sha256 does not match/u
        }, {
            label: 'component hash',
            mutate: (artifact) => { artifact.components[0].component_sha256 = hash('changed'); },
            pattern: /component_sha256 does not match/u
        }, {
            label: 'component aggregate',
            mutate: (artifact) => { artifact.components_sha256 = hash('changed'); },
            pattern: /components_sha256 does not match/u
        }, {
            label: 'validation aggregate',
            mutate: (artifact) => { artifact.validation_result_sha256 = hash('changed'); },
            pattern: /validation_result_sha256 does not match/u
        }];
        for (const mutation of mutations) {
            const changed = clone(evidence);
            mutation.mutate(changed);
            assert.match(
                validateEvidence(changed).violations.join(' '),
                mutation.pattern,
                mutation.label
            );
        }

        assert.throws(() => buildEvidence({
            delta: { ...delta, current_snapshot_sha256: hash('tampered') },
            components: [component('focused')]
        }), /classification_sha256 does not match/u);
    });

    it('checks task, review, category, baseline, and delta expectations', () => {
        const delta = makeDelta('leaf_test');
        const evidence = buildEvidence({
            delta,
            components: [component('focused')]
        });
        const result = validateEvidence(evidence, {
            taskId: 'T-foreign',
            reviewType: 'code',
            deltaCategory: 'structural_test',
            baselineArtifactSha256: hash('foreign-baseline'),
            deltaClassificationSha256: hash('foreign-delta')
        });
        assert.equal(result.valid, false);
        assert.equal(result.violations.filter((violation) => violation.includes('mismatch')).length, 5);
    });
});

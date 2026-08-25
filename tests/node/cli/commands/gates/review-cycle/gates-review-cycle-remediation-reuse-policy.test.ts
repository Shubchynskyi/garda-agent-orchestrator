process.env.GARDA_REVIEW_CYCLE_REMEDIATION_PART = 'reuse-policy';

import assert from 'node:assert/strict';
import { it } from 'node:test';

import { resolveRuntimeDecisionInputs } from '../../../../../../src/cli/commands/gate-flows/recovery/recovery-flow-review-cycle';
import {
    appendTaskEvent,
    createTempRepo,
    fileSha256,
    fs,
    getReviewsRoot,
    path
} from './gates-review-cycle-fixtures';

it('forces FULL when immutable remediation snapshot lineage is replaced or invalid', () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-992-invalid-remediation-lineage';
    const reviewsRoot = getReviewsRoot(repoRoot);
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const mutableBaselinePath = path.join(reviewsRoot, `${taskId}-code-remediation-baseline.json`);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(mutableBaselinePath, '{}\n', 'utf8');
    appendTaskEvent(
        orchestratorRoot,
        taskId,
        'REVIEW_PHASE_STARTED',
        'INFO',
        'fixture timeline initialized',
        { review_type: 'code' }
    );
    const options = {
        repoRoot,
        taskId,
        remediationReviewType: 'code',
        requiredReviewTypes: ['code', 'security'],
        remediationFixClassification: {
            category: 'production',
            reason: 'fixture production remediation',
            blocked_before_reuse: false,
            invalidated_review_types: ['code']
        },
        profilePolicySnapshot: {},
        currentChangedFiles: ['src/app.ts'],
        reviewTriggerPolicy: {
            test_path_regexes: ['(^|/)tests?/'],
            test_refactor_structural_path_regexes: ['(^|/)tests?/helpers?/'],
            test_refactor_changed_lines_threshold: 20
        },
        allowAuthenticatedDelta: true
    };

    const missingBinding = resolveRuntimeDecisionInputs(options);
    const missingRuntime = missingBinding.classification as {
        source: 'runtime_fix';
        classification: { reason: string; invalidated_review_types: string[] };
    };
    assert.equal(missingRuntime.source, 'runtime_fix');
    assert.deepEqual(missingRuntime.classification.invalidated_review_types, ['code']);
    assert.match(missingRuntime.classification.reason, /does not bind an immutable remediation snapshot/iu);

    const failedSnapshotPath = path.join(
        reviewsRoot,
        `${taskId}-code-remediation-baseline-${'f'.repeat(64)}.json`
    );
    fs.writeFileSync(failedSnapshotPath, '{}\n', 'utf8');
    appendTaskEvent(
        orchestratorRoot,
        taskId,
        'REVIEW_RECORDED',
        'FAIL',
        'failed fixture snapshot recorded',
        {
            review_type: 'code',
            remediation_baseline_snapshot_path: failedSnapshotPath,
            remediation_baseline_snapshot_sha256: fileSha256(failedSnapshotPath)
        }
    );
    const failedBinding = resolveRuntimeDecisionInputs(options);
    const failedRuntime = failedBinding.classification as {
        source: 'runtime_fix';
        classification: { reason: string; invalidated_review_types: string[] };
    };
    assert.equal(failedRuntime.source, 'runtime_fix');
    assert.deepEqual(failedRuntime.classification.invalidated_review_types, ['code']);
    assert.match(failedRuntime.classification.reason, /does not bind an immutable remediation snapshot/iu);

    const externalSnapshotPath = path.join(repoRoot, 'external-remediation-baseline.json');
    fs.writeFileSync(externalSnapshotPath, '{}\n', 'utf8');
    appendTaskEvent(
        orchestratorRoot,
        taskId,
        'REVIEW_RECORDED',
        'PASS',
        'external fixture snapshot recorded',
        {
            review_type: 'code',
            review_execution_mode: 'FULL',
            remediation_baseline_snapshot_path: externalSnapshotPath,
            remediation_baseline_snapshot_sha256: fileSha256(externalSnapshotPath)
        }
    );
    const externalBinding = resolveRuntimeDecisionInputs(options);
    const externalRuntime = externalBinding.classification as {
        source: 'runtime_fix';
        classification: { reason: string; invalidated_review_types: string[] };
    };
    assert.equal(externalRuntime.source, 'runtime_fix');
    assert.deepEqual(externalRuntime.classification.invalidated_review_types, ['code']);
    assert.match(externalRuntime.classification.reason, /unsafe or invalid remediation snapshot binding/iu);

    const mismatchedDigestSnapshotPath = path.join(
        reviewsRoot,
        `${taskId}-code-remediation-baseline-${'a'.repeat(64)}.json`
    );
    fs.writeFileSync(mismatchedDigestSnapshotPath, '{}\n', 'utf8');
    appendTaskEvent(
        orchestratorRoot,
        taskId,
        'REVIEW_RECORDED',
        'PASS',
        'mismatched filename digest fixture snapshot recorded',
        {
            review_type: 'code',
            review_execution_mode: 'FULL',
            remediation_baseline_snapshot_path: mismatchedDigestSnapshotPath,
            remediation_baseline_snapshot_sha256: fileSha256(mismatchedDigestSnapshotPath)
        }
    );
    const mismatchedDigestBinding = resolveRuntimeDecisionInputs(options);
    const mismatchedDigestRuntime = mismatchedDigestBinding.classification as {
        source: 'runtime_fix';
        classification: { reason: string; invalidated_review_types: string[] };
    };
    assert.equal(mismatchedDigestRuntime.source, 'runtime_fix');
    assert.deepEqual(mismatchedDigestRuntime.classification.invalidated_review_types, ['code']);
    assert.match(mismatchedDigestRuntime.classification.reason, /unsafe or invalid remediation snapshot binding/iu);

    fs.rmSync(repoRoot, { recursive: true, force: true });
});

it('rejects untrusted legacy-prefix snapshot binding and forces FULL', () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-992-legacy-remediation-lineage';
    const reviewsRoot = getReviewsRoot(repoRoot);
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const timelinePath = path.join(orchestratorRoot, 'runtime', 'task-events', `${taskId}.jsonl`);
    const mutableBaselinePath = path.join(reviewsRoot, `${taskId}-code-remediation-baseline.json`);
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(mutableBaselinePath, '{}\n', 'utf8');

    const snapshotSha256 = fileSha256(mutableBaselinePath);
    const immutableSnapshotPath = path.join(
        reviewsRoot,
        `${taskId}-code-remediation-baseline-${snapshotSha256}.json`
    );
    fs.copyFileSync(mutableBaselinePath, immutableSnapshotPath);
    fs.writeFileSync(timelinePath, JSON.stringify({
        task_id: taskId,
        event_type: 'REVIEW_RECORDED',
        outcome: 'PASS',
        details: {
            review_type: 'code',
            remediation_baseline_snapshot_path: immutableSnapshotPath,
            remediation_baseline_snapshot_sha256: snapshotSha256
        }
    }) + '\n', 'utf8');
    appendTaskEvent(
        orchestratorRoot,
        taskId,
        'REVIEW_PHASE_STARTED',
        'INFO',
        'integrity chain starts after unauthenticated review binding',
        { review_type: 'code' }
    );

    const decision = resolveRuntimeDecisionInputs({
        repoRoot,
        taskId,
        remediationReviewType: 'code',
        requiredReviewTypes: ['code', 'security'],
        remediationFixClassification: {
            category: 'production',
            reason: 'fixture production remediation',
            blocked_before_reuse: false,
            invalidated_review_types: ['code']
        },
        profilePolicySnapshot: {},
        currentChangedFiles: ['src/app.ts'],
        reviewTriggerPolicy: {
            test_path_regexes: ['(^|/)tests?/'],
            test_refactor_structural_path_regexes: ['(^|/)tests?/helpers?/'],
            test_refactor_changed_lines_threshold: 20
        },
        allowAuthenticatedDelta: true
    });
    const runtime = decision.classification as {
        source: 'runtime_fix';
        classification: { reason: string; invalidated_review_types: string[] };
    };
    assert.equal(runtime.source, 'runtime_fix');
    assert.deepEqual(runtime.classification.invalidated_review_types, ['code']);
    assert.match(runtime.classification.reason, /cannot authenticate remediation snapshot lineage \(PASS_WITH_LEGACY_PREFIX\)/iu);

    fs.rmSync(repoRoot, { recursive: true, force: true });
});

require('./gates-review-cycle-remediation-suite');

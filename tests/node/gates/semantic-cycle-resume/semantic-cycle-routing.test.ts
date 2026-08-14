import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { stringSha256 } from '../../../../src/gate-runtime/hash';
import {
    readSemanticCycleResumeRoutingState
} from '../../../../src/gates/semantic-cycle-resume/semantic-cycle-routing';
import { serializeSemanticCycleValue } from '../../../../src/gates/semantic-cycle-resume/semantic-cycle-snapshot';
import { computeSemanticCycleRebindManifestSha256 } from '../../../../src/gates/semantic-cycle-resume/semantic-cycle-transaction';
import {
    SEMANTIC_CYCLE_REBIND_TRANSACTION_CONTRACT_ID,
    SEMANTIC_CYCLE_REBIND_TRANSACTION_SCHEMA_VERSION,
    type SemanticCycleRebindArtifactClass,
    type SemanticCycleRebindManifest,
    type SemanticCycleReboundArtifact
} from '../../../../src/gates/semantic-cycle-resume/semantic-cycle-transaction-types';
import * as fx from '../next-step/next-step-review-reuse-fixtures';

const {
    ALL_REVIEW_FLAGS,
    TASK_ID,
    appendEvent,
    eventsRoot,
    fileSha256,
    makeTempRepo,
    resolveNextStep,
    reviewsRoot,
    seedCompilePass,
    seedFullSuiteValidation,
    seedStartedTask,
    writeJson,
    writePreflight,
    writeReviewEvidence
} = fx;

const REBOUND_REVIEW_TYPES = ['code', 'security', 'refactor'] as const;

interface LifecyclePosition {
    cycle_sha256: string;
    task_event_sequence: number;
}

interface RoutingFixture {
    repoRoot: string;
    manifestPath: string;
    taskEventsPath: string;
    preflightPath: string;
    manifest: SemanticCycleRebindManifest;
    preservedEvidenceHashes: Map<string, string>;
}

function hash(value: string): string {
    return stringSha256(value) || '';
}

function latestLifecyclePosition(taskEventsPath: string): LifecyclePosition {
    const lines = fs.readFileSync(taskEventsPath, 'utf8').trim().split('\n');
    const event = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    const integrity = event.integrity as Record<string, unknown>;
    return {
        cycle_sha256: String(integrity.event_sha256 || ''),
        task_event_sequence: Number(integrity.task_sequence)
    };
}

function enableStrictResumeValidation(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const fullSuite = config.full_suite_validation as Record<string, unknown>;
    fullSuite.enabled = true;
    fullSuite.command = 'npm test';
    fullSuite.placement = 'after_compile_before_reviews';
    config.review_execution_policy = { mode: 'strict_sequential' };
    writeJson(configPath, config);
}

function toReboundArtifact(
    repoRoot: string,
    artifactClass: SemanticCycleRebindArtifactClass,
    reviewType: string | null,
    sourcePath: string,
    target: LifecyclePosition
): SemanticCycleReboundArtifact {
    return {
        artifact_class: artifactClass,
        review_type: reviewType,
        source_path: path.relative(repoRoot, sourcePath).replace(/\\/gu, '/'),
        source_sha256: fileSha256(sourcePath),
        accepted: true,
        rebound_cycle_sha256: target.cycle_sha256,
        rebound_task_event_sequence: target.task_event_sequence
    };
}

function buildArtifacts(
    repoRoot: string,
    target: LifecyclePosition
): { artifacts: SemanticCycleReboundArtifact[]; preservedEvidenceHashes: Map<string, string> } {
    const root = reviewsRoot(repoRoot);
    const artifacts = [
        toReboundArtifact(repoRoot, 'compile', null, path.join(root, `${TASK_ID}-compile-gate.json`), target),
        toReboundArtifact(repoRoot, 'full_suite', null, path.join(root, `${TASK_ID}-full-suite-validation.json`), target)
    ];
    for (const reviewType of REBOUND_REVIEW_TYPES) {
        const findingsPath = path.join(root, `${TASK_ID}-${reviewType}-findings-disposition.json`);
        const dependencyPath = path.join(root, `${TASK_ID}-${reviewType}-dependency-state.json`);
        writeJson(findingsPath, { task_id: TASK_ID, review_type: reviewType, findings: [] });
        writeJson(dependencyPath, { task_id: TASK_ID, review_type: reviewType, dependencies: [] });
        artifacts.push(
            toReboundArtifact(repoRoot, 'review_context', reviewType, path.join(root, `${TASK_ID}-${reviewType}-review-context.json`), target),
            toReboundArtifact(repoRoot, 'findings_disposition', reviewType, findingsPath, target),
            toReboundArtifact(repoRoot, 'review_receipt', reviewType, path.join(root, `${TASK_ID}-${reviewType}-receipt.json`), target),
            toReboundArtifact(repoRoot, 'reviewer_dependency', reviewType, dependencyPath, target)
        );
    }
    return {
        artifacts,
        preservedEvidenceHashes: new Map(artifacts.map((artifact) => [
            artifact.source_path,
            artifact.source_sha256
        ]))
    };
}

function artifactClassCounts(
    artifacts: readonly SemanticCycleReboundArtifact[]
): Record<SemanticCycleRebindArtifactClass, number> {
    const counts: Record<SemanticCycleRebindArtifactClass, number> = {
        compile: 0,
        full_suite: 0,
        review_context: 0,
        findings_disposition: 0,
        review_receipt: 0,
        reviewer_dependency: 0
    };
    for (const artifact of artifacts) {
        counts[artifact.artifact_class] += 1;
    }
    return counts;
}

function buildCommittedManifest(
    taskEventsPath: string,
    source: LifecyclePosition,
    target: LifecyclePosition,
    artifacts: SemanticCycleReboundArtifact[]
): SemanticCycleRebindManifest {
    const requestSha256 = hash('semantic-routing-request');
    const transactionId = hash(serializeSemanticCycleValue({
        contract_id: SEMANTIC_CYCLE_REBIND_TRANSACTION_CONTRACT_ID,
        request_sha256: requestSha256
    }));
    const manifest = {
        schema_version: SEMANTIC_CYCLE_REBIND_TRANSACTION_SCHEMA_VERSION,
        contract_id: SEMANTIC_CYCLE_REBIND_TRANSACTION_CONTRACT_ID,
        transaction_id: transactionId,
        request_sha256: requestSha256,
        status: 'COMMITTED',
        task_id: TASK_ID,
        created_at_utc: '2026-08-14T12:00:00.000Z',
        source_position: source,
        target_position: target,
        comparison_decision_sha256: hash('semantic-routing-comparison'),
        authoritative_snapshot_sha256: hash('semantic-routing-authoritative'),
        candidate_snapshot_sha256: hash('semantic-routing-candidate'),
        lifecycle_authority_sha256: fileSha256(taskEventsPath),
        artifacts,
        audit: {
            event: 'SEMANTIC_CYCLE_REBIND_COMMITTED',
            outcome: 'REUSED',
            route: 'semantic_rebind',
            mutation_allowed: true,
            comparison_decision_sha256: hash('semantic-routing-comparison'),
            authoritative_snapshot_sha256: hash('semantic-routing-authoritative'),
            candidate_snapshot_sha256: hash('semantic-routing-candidate'),
            lifecycle_authority_sha256: fileSha256(taskEventsPath),
            request_sha256: requestSha256,
            verified_artifact_count: artifacts.length,
            artifact_class_counts: artifactClassCounts(artifacts),
            invalidation_codes: [],
            violations: [],
            rollback_performed: false,
            rollback_completed: true
        },
        transaction_sha256: ''
    } as SemanticCycleRebindManifest;
    manifest.transaction_sha256 = computeSemanticCycleRebindManifestSha256(manifest);
    return manifest;
}

function createRoutingFixture(recordCommitEvent = true): RoutingFixture {
    const repoRoot = makeTempRepo();
    enableStrictResumeValidation(repoRoot);
    seedStartedTask(repoRoot, TASK_ID);
    const requiredReviews = {
        ...ALL_REVIEW_FLAGS,
        code: true,
        security: true,
        refactor: true,
        api: true
    };
    const initialPreflightPath = writePreflight(repoRoot, TASK_ID, requiredReviews, {
        reviewPolicyMode: 'strict_sequential',
        includeDomainScopeFingerprints: true
    });
    fs.appendFileSync(initialPreflightPath, '\n', 'utf8');
    seedCompilePass(repoRoot, TASK_ID);
    seedFullSuiteValidation(repoRoot, TASK_ID);
    for (const reviewType of REBOUND_REVIEW_TYPES) {
        writeReviewEvidence(repoRoot, TASK_ID, reviewType);
    }
    const taskEventsPath = path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`);
    const source = latestLifecyclePosition(taskEventsPath);
    appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL');
    const preflightPath = writePreflight(repoRoot, TASK_ID, requiredReviews, {
        reviewPolicyMode: 'strict_sequential',
        includeDomainScopeFingerprints: true
    });
    const target = latestLifecyclePosition(taskEventsPath);
    const { artifacts, preservedEvidenceHashes } = buildArtifacts(repoRoot, target);
    const manifest = buildCommittedManifest(taskEventsPath, source, target, artifacts);
    const manifestPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-semantic-cycle-rebind.json`);
    writeJson(manifestPath, manifest);
    if (recordCommitEvent) {
        appendEvent(repoRoot, TASK_ID, 'SEMANTIC_CYCLE_REBIND_COMMITTED', 'PASS', {
            transaction_id: manifest.transaction_id,
            transaction_sha256: manifest.transaction_sha256,
            manifest_path: path.relative(repoRoot, manifestPath).replace(/\\/gu, '/'),
            manifest_sha256: fileSha256(manifestPath)
        });
    }
    return { repoRoot, manifestPath, taskEventsPath, preflightPath, manifest, preservedEvidenceHashes };
}

function writeRuntimeRejectedManifest(fixture: RoutingFixture): void {
    const manifest = structuredClone(fixture.manifest);
    manifest.status = 'INVALIDATED';
    manifest.artifacts = [];
    manifest.audit.event = 'SEMANTIC_CYCLE_REBIND_INVALIDATED';
    manifest.audit.outcome = 'INVALIDATED';
    manifest.audit.route = 'runtime_upgrade_required';
    manifest.audit.mutation_allowed = false;
    manifest.audit.verified_artifact_count = 0;
    manifest.audit.artifact_class_counts = artifactClassCounts([]);
    manifest.audit.invalidation_codes = ['COMPARISON_NOT_REUSABLE'];
    manifest.audit.violations = ['The active runtime cannot interpret the authenticated snapshot.'];
    manifest.transaction_sha256 = computeSemanticCycleRebindManifestSha256(manifest);
    writeJson(fixture.manifestPath, manifest);
}

describe('semantic cycle resume routing', () => {
    it('keeps unchanged code, security, and refactor evidence accepted and resumes exactly at API', () => {
        const fixture = createRoutingFixture();
        fs.rmSync(fixture.manifestPath, { force: true });
        const withoutSemanticResume = resolveNextStep({ taskId: TASK_ID, repoRoot: fixture.repoRoot });
        assert.equal(withoutSemanticResume.next_gate, 'compile-gate', withoutSemanticResume.reason);

        writeJson(fixture.manifestPath, fixture.manifest);
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot: fixture.repoRoot });

        assert.equal(result.review.next_review_type, 'api', result.reason);
        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.ok(result.commands[0].command.includes('--review-type "api"'), result.commands[0].command);
        assert.match(result.reason, /Accepted unchanged review lanes: code, refactor, security/);
        for (const [sourcePath, expectedSha256] of fixture.preservedEvidenceHashes) {
            assert.equal(fileSha256(path.join(fixture.repoRoot, sourcePath)), expectedSha256);
        }
    });

    it('retains existing compile recovery when any rebound input changes', () => {
        const fixture = createRoutingFixture();
        const receiptPath = path.join(reviewsRoot(fixture.repoRoot), `${TASK_ID}-security-receipt.json`);
        fs.appendFileSync(receiptPath, '\n', 'utf8');

        const routing = readSemanticCycleResumeRoutingState({
            repo_root: fixture.repoRoot,
            task_id: TASK_ID,
            manifest_path: fixture.manifestPath,
            task_events_path: fixture.taskEventsPath,
            preflight_path: fixture.preflightPath
        });
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot: fixture.repoRoot });

        assert.equal(routing.status, 'RECOVERY_REQUIRED');
        assert.match(routing.reason, /review_receipt evidence content changed/);
        assert.equal(result.next_gate, 'compile-gate', result.reason);
        assert.doesNotMatch(result.reason, /Accepted unchanged review lanes/);
    });

    it('rejects a committed manifest that lacks its canonical task-event commit binding', () => {
        const fixture = createRoutingFixture(false);

        const routing = readSemanticCycleResumeRoutingState({
            repo_root: fixture.repoRoot,
            task_id: TASK_ID,
            manifest_path: fixture.manifestPath,
            task_events_path: fixture.taskEventsPath,
            preflight_path: fixture.preflightPath
        });
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot: fixture.repoRoot });

        assert.equal(routing.status, 'RECOVERY_REQUIRED');
        assert.match(routing.reason, /commit event is missing/);
        assert.equal(result.next_gate, 'compile-gate', result.reason);
    });

    it('rejects a current preflight that no longer matches the authenticated target lifecycle binding', () => {
        const fixture = createRoutingFixture();
        const preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8')) as Record<string, unknown>;
        const effectiveSnapshot = preflight.effective_review_snapshot as Record<string, unknown>;
        effectiveSnapshot.snapshot_sha256 = hash('tampered current preflight');
        writeJson(fixture.preflightPath, preflight);

        const routing = readSemanticCycleResumeRoutingState({
            repo_root: fixture.repoRoot,
            task_id: TASK_ID,
            manifest_path: fixture.manifestPath,
            task_events_path: fixture.taskEventsPath,
            preflight_path: fixture.preflightPath
        });

        assert.equal(routing.status, 'RECOVERY_REQUIRED');
        assert.match(routing.reason, /Current preflight no longer matches/);
    });

    it('preserves the full old-runtime rejection path without accepting gates or reviewer lanes', () => {
        const fixture = createRoutingFixture();
        writeRuntimeRejectedManifest(fixture);

        const routing = readSemanticCycleResumeRoutingState({
            repo_root: fixture.repoRoot,
            task_id: TASK_ID,
            manifest_path: fixture.manifestPath,
            task_events_path: fixture.taskEventsPath,
            preflight_path: fixture.preflightPath
        });
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot: fixture.repoRoot });

        assert.equal(routing.status, 'RUNTIME_UPGRADE_REQUIRED');
        assert.equal(routing.accepted_compile, false);
        assert.equal(routing.accepted_full_suite, false);
        assert.deepEqual(routing.accepted_review_types, []);
        assert.equal(result.next_gate, 'compile-gate', result.reason);
    });
});

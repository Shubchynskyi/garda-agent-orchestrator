import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { normalizeReviewCatalog } from '../../../../../src/core/review-catalog';
import type { ReviewCapabilitiesConfigMap } from '../../../../../src/core/review-capabilities';
import { buildEffectiveReviewSnapshot } from '../../../../../src/policy/effective-review-snapshot';
import { resolveProfileReviewCatalogPolicy } from '../../../../../src/policy/profile-review-catalog-policy';
import { resolveReviewContextLaneBinding } from '../../../../../src/gates/review-context/review-context-lane';
import { buildScopedDiff } from '../../../../../src/gates/preflight/build-scoped-diff';
import { getWorkspaceSnapshot } from '../../../../../src/gates/compile/compile-gate';
import {
    assertArtifactReviewLaneEvidence,
    resolveAuthenticatedReviewLaneContract
} from '../../../../../src/cli/commands/gate-review-handlers/review-lane-contract';
import {
    createTempRepo,
    getOrchestratorRoot,
    getReviewsRoot,
    initializeGitRepo,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    runCliWithCapturedOutput,
    seedInitAnswers,
    seedTaskQueue,
    writeBalancedProfilesConfig,
    writeCompilePassEvidence,
    writePreflight,
    writeReviewCapabilitiesConfig
} from '../gate-test-helpers';
import { buildReviewContext as buildGeneratedReviewContext } from '../../../gates/review-context/build-review-context-fixtures';
import {
    buildFailedJsonReviewReport,
    buildNoFindingsJsonReviewReport,
    fileSha256
} from './review-result/gates-command-review-result-fixtures';

function customCatalogDocument() {
    return {
        version: 1,
        custom_review_types: [{
            id: 'architecture-boundary',
            display_label: 'Architecture boundary review',
            enabled_by_default: false,
            skill_id: 'code-review',
            trigger: { mode: 'manual', signal_ids: [] },
            coverage_category_ids: ['maintainability'],
            reviewer_role: {
                role_id: 'architecture-reviewer',
                focus_tags: ['maintainability']
            }
        }]
    };
}

function buildPreflight(
    customState: boolean | 'auto' = true,
    profileSnapshotSha256 = 'a'.repeat(64),
    frozenProfilePolicy?: Readonly<Record<string, boolean | 'auto'>>,
    frozenCapabilities?: ReviewCapabilitiesConfigMap
): Record<string, unknown> {
    const catalog = normalizeReviewCatalog(customCatalogDocument());
    const capabilities = frozenCapabilities ?? Object.fromEntries(
        catalog.review_types.map((definition) => [definition.id, true])
    ) as ReviewCapabilitiesConfigMap;
    const profilePolicy = resolveProfileReviewCatalogPolicy(
        'balanced',
        frozenProfilePolicy ?? { 'architecture-boundary': customState },
        capabilities,
        catalog
    );
    const snapshot = buildEffectiveReviewSnapshot({
        catalog,
        profilePolicy,
        profileSnapshotSha256,
        legacyRequiredReviews: { code: true },
        scopeCategory: 'code',
        taskIntent: 'Inspect an architecture boundary',
        changedFiles: ['src/architecture.ts'],
        taskTriggers: {},
        zeroDiffBaselineOnly: false
    });
    return {
        required_reviews: snapshot.required_reviews,
        effective_review_snapshot: snapshot
    };
}

function buildLaneReviewContext(preflight: Record<string, unknown>, reviewType: string): Record<string, unknown> {
    const binding = resolveReviewContextLaneBinding(preflight, reviewType);
    return binding.built_in ? {} : { review_lane: binding };
}

interface CustomReviewCliFixture {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    orchestratorRoot: string;
    reviewsRoot: string;
    preflightPath: string;
    reviewContextPath: string;
    launchArtifactPath: string;
}

const CUSTOM_LANE_EVIDENCE_FIELDS = [
    'review_lane_binding_sha256',
    'review_lane_definition_sha256',
    'effective_review_snapshot_sha256',
    'review_catalog_sha256',
    'review_verdict_contract_sha256'
] as const;

function readJsonObject(filePath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function writeJsonObject(filePath: string, value: Record<string, unknown>): void {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function assertCliFailure(
    result: { exitCode: number; logs: string[]; errors: string[] },
    expectedDiagnostic: RegExp,
    label: string
): void {
    const output = [...result.logs, ...result.errors].join('\n');
    assert.notEqual(result.exitCode, 0, `${label} unexpectedly succeeded`);
    assert.match(output, expectedDiagnostic, `${label} failed for the wrong reason:\n${output}`);
}

function writeCaseDriftedLaneEvidence(filePath: string): string {
    const original = fs.readFileSync(filePath, 'utf8');
    const artifact = JSON.parse(original) as Record<string, unknown>;
    artifact.review_catalog_sha256 = String(artifact.review_catalog_sha256).toUpperCase();
    writeJsonObject(filePath, artifact);
    return original;
}

async function seedCustomReviewCliFixture(
    t: TestContext,
    taskId: string,
    sourceValue: string
): Promise<CustomReviewCliFixture> {
    const repoRoot = createTempRepo(t);
    const reviewType = 'architecture-boundary';
    const reviewerIdentity = `agent:${taskId}-reviewer`;
    seedTaskQueue(repoRoot, taskId);
    seedInitAnswers(repoRoot, 'Codex');
    const orchestratorRoot = getOrchestratorRoot(repoRoot);
    const configRoot = path.join(orchestratorRoot, 'live', 'config');
    writeBalancedProfilesConfig(repoRoot);
    writeReviewCapabilitiesConfig(repoRoot);
    const profilesPath = path.join(configRoot, 'profiles.json');
    const profiles = readJsonObject(profilesPath) as {
        built_in_profiles: { balanced: { review_policy: Record<string, unknown> } };
    };
    profiles.built_in_profiles.balanced.review_policy[reviewType] = true;
    writeJsonObject(profilesPath, profiles);
    const capabilitiesPath = path.join(configRoot, 'review-capabilities.json');
    const capabilities = readJsonObject(capabilitiesPath) as Record<string, boolean>;
    capabilities[reviewType] = true;
    writeJsonObject(capabilitiesPath, capabilities);
    writeJsonObject(path.join(configRoot, 'review-catalog.json'), customCatalogDocument());
    initializeGitRepo(repoRoot);
    fs.writeFileSync(
        path.join(repoRoot, 'src', 'app.ts'),
        `export const customReviewOutcome = '${sourceValue}';\n`,
        'utf8'
    );
    runEnterTaskMode({
        repoRoot,
        taskId,
        taskSummary: `Exercise ${sourceValue} custom review lane`,
        provider: 'Codex'
    });
    const taskEntryRules = loadTaskEntryRulePack(repoRoot, taskId);
    assert.equal(taskEntryRules.exitCode, 0, taskEntryRules.outputLines.join('\n'));
    runHandshakeForTask(repoRoot, taskId, 'Codex');
    runShellSmokeForTask(repoRoot, taskId, 'Codex');
    const taskMode = readJsonObject(
        path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`)
    ) as {
        profile_policy_snapshot: {
            snapshot_hash: string;
            review_lane_selection: {
                profile_review_policy: Record<string, boolean | 'auto'>;
                review_capabilities: ReviewCapabilitiesConfigMap;
            };
        };
    };
    const workspaceSnapshot = getWorkspaceSnapshot(
        repoRoot,
        'explicit_changed_files',
        true,
        ['src/app.ts']
    );
    const customPreflight = buildPreflight(
        true,
        taskMode.profile_policy_snapshot.snapshot_hash,
        taskMode.profile_policy_snapshot.review_lane_selection.profile_review_policy,
        taskMode.profile_policy_snapshot.review_lane_selection.review_capabilities
    );
    const snapshot = customPreflight.effective_review_snapshot as {
        required_reviews: Record<string, boolean>;
    };
    const preflightPath = writePreflight(repoRoot, taskId, {
        detection_source: 'explicit_changed_files',
        review_coverage_contract_required: true,
        scope_category: 'code',
        changed_files: ['src/app.ts'],
        metrics: {
            changed_lines_total: workspaceSnapshot.changed_lines_total,
            changed_files_sha256: workspaceSnapshot.changed_files_sha256,
            scope_content_sha256: workspaceSnapshot.scope_content_sha256,
            scope_sha256: workspaceSnapshot.scope_sha256
        },
        required_reviews: snapshot.required_reviews,
        effective_review_snapshot: customPreflight.effective_review_snapshot,
        profile_policy_snapshot: taskMode.profile_policy_snapshot,
        triggers: { runtime_changed: true, runtime_code_changed: true }
    });
    const postPreflightRules = loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
    assert.equal(postPreflightRules.exitCode, 0, postPreflightRules.outputLines.join('\n'));
    writeCompilePassEvidence(repoRoot, taskId, preflightPath);

    const reviewsRoot = getReviewsRoot(repoRoot);
    const pathsConfigPath = path.join(configRoot, 'paths.json');
    writeJsonObject(pathsConfigPath, { triggers: { [reviewType]: ['^src/app\\.ts$'] } });
    const scopedDiffMetadataPath = path.join(reviewsRoot, `${taskId}-${reviewType}-scoped.json`);
    buildScopedDiff({
        reviewType,
        preflightPath,
        pathsConfigPath,
        outputPath: path.join(reviewsRoot, `${taskId}-${reviewType}-scoped.diff`),
        metadataPath: scopedDiffMetadataPath,
        repoRoot
    });
    const reviewContextPath = path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
    buildGeneratedReviewContext({
        reviewType,
        depth: 3,
        preflightPath,
        tokenEconomyConfigPath: path.join(configRoot, 'token-economy.json'),
        scopedDiffMetadataPath,
        outputPath: reviewContextPath,
        repoRoot
    });
    const routing = await runCliWithCapturedOutput([
        'gate', 'record-review-routing', '--task-id', taskId, '--review-type', reviewType,
        '--repo-root', repoRoot, '--reviewer-execution-mode', 'delegated_subagent',
        '--reviewer-identity', reviewerIdentity
    ], { cwd: repoRoot });
    assert.equal(routing.exitCode, 0, routing.errors.join('\n'));

    return {
        repoRoot,
        taskId,
        reviewType,
        reviewerIdentity,
        orchestratorRoot,
        reviewsRoot,
        preflightPath,
        reviewContextPath,
        launchArtifactPath: path.join(
            orchestratorRoot,
            'runtime',
            'tmp',
            'reviews',
            taskId,
            reviewType,
            'reviewer-launch.json'
        )
    };
}

describe('authenticated review lane contract', () => {
    it('derives custom verdicts and hash evidence only from the immutable preflight lane', () => {
        const preflight = buildPreflight(true);
        const reviewContext = buildLaneReviewContext(preflight, 'architecture-boundary');

        const contract = resolveAuthenticatedReviewLaneContract({
            preflight,
            reviewContext,
            reviewType: 'architecture-boundary'
        });

        assert.equal(contract.reviewType, 'architecture-boundary');
        assert.equal(contract.builtIn, false);
        assert.equal(contract.passVerdict, 'ARCHITECTURE BOUNDARY REVIEW PASSED');
        assert.equal(contract.failVerdict, 'ARCHITECTURE BOUNDARY REVIEW FAILED');
        assert.deepEqual(contract.artifactEvidence, {
            review_lane_binding_sha256: contract.binding.binding_sha256,
            review_lane_definition_sha256: contract.binding.lane_definition_sha256,
            effective_review_snapshot_sha256: contract.binding.effective_review_snapshot_sha256,
            review_catalog_sha256: contract.binding.catalog_sha256,
            review_verdict_contract_sha256: contract.verdictTokensSha256
        });
        assert.doesNotThrow(() => assertArtifactReviewLaneEvidence(
            contract.artifactEvidence,
            contract,
            'Reviewer launch artifact'
        ));
    });

    it('preserves built-in verdict and artifact formats', () => {
        const preflight = buildPreflight(true);
        const contract = resolveAuthenticatedReviewLaneContract({
            preflight,
            reviewContext: {},
            reviewType: 'code'
        });

        assert.equal(contract.builtIn, true);
        assert.equal(contract.passVerdict, 'REVIEW PASSED');
        assert.equal(contract.failVerdict, 'REVIEW FAILED');
        assert.deepEqual(contract.artifactEvidence, {});
    });

    it('rejects case drift, path-like, unknown, inactive, and forged custom lanes', () => {
        const preflight = buildPreflight(true);
        const reviewContext = buildLaneReviewContext(preflight, 'architecture-boundary');
        for (const reviewType of ['Architecture-Boundary', '../architecture-boundary', 'architecture_boundary']) {
            assert.throws(
                () => resolveAuthenticatedReviewLaneContract({ preflight, reviewContext, reviewType }),
                /canonical stable id/u
            );
        }
        assert.throws(
            () => resolveAuthenticatedReviewLaneContract({
                preflight,
                reviewContext,
                reviewType: 'live-config-only'
            }),
            /unknown to the immutable effective review snapshot/u
        );
        const inactivePreflight = buildPreflight(false);
        assert.throws(
            () => resolveAuthenticatedReviewLaneContract({
                preflight: inactivePreflight,
                reviewContext: {},
                reviewType: 'architecture-boundary'
            }),
            /is inactive/u
        );
        const forgedContext = structuredClone(reviewContext);
        (forgedContext.review_lane as Record<string, unknown>).lane_definition_sha256 = 'f'.repeat(64);
        assert.throws(
            () => resolveAuthenticatedReviewLaneContract({
                preflight,
                reviewContext: forgedContext,
                reviewType: 'architecture-boundary'
            }),
            /does not match the immutable effective review snapshot/u
        );
    });

    it('rejects missing or tampered custom lane hashes on downstream artifacts', () => {
        const preflight = buildPreflight(true);
        const contract = resolveAuthenticatedReviewLaneContract({
            preflight,
            reviewContext: buildLaneReviewContext(preflight, 'architecture-boundary'),
            reviewType: 'architecture-boundary'
        });

        assert.throws(
            () => assertArtifactReviewLaneEvidence({}, contract, 'Review receipt'),
            /review_lane_binding_sha256/u
        );
        assert.throws(
            () => assertArtifactReviewLaneEvidence({
                ...contract.artifactEvidence,
                review_verdict_contract_sha256: '0'.repeat(64)
            }, contract, 'Review receipt'),
            /review_verdict_contract_sha256/u
        );
        for (const caseDriftedValue of [
            contract.verdictTokensSha256.toUpperCase(),
            ` ${contract.verdictTokensSha256}`,
            `${contract.verdictTokensSha256}\n`
        ]) {
            assert.throws(
                () => assertArtifactReviewLaneEvidence({
                    ...contract.artifactEvidence,
                    review_verdict_contract_sha256: caseDriftedValue
                }, contract, 'Review receipt'),
                /review_verdict_contract_sha256/u
            );
        }
    });

    it('launches and records real custom delegated PASS and FAIL results through the public CLI', async (t) => {
        for (const outcome of ['pass', 'fail'] as const) {
            const taskId = outcome === 'pass'
                ? 'T-729-4B-custom-pass'
                : 'T-729-4B-custom-fail';
            const fixture = await seedCustomReviewCliFixture(t, taskId, outcome);
            const {
                repoRoot,
                reviewType,
                reviewerIdentity,
                orchestratorRoot,
                reviewsRoot,
                preflightPath,
                reviewContextPath,
                launchArtifactPath
            } = fixture;
            const prepare = await runCliWithCapturedOutput([
                'gate', 'prepare-reviewer-launch', '--task-id', taskId, '--review-type', reviewType,
                '--repo-root', repoRoot, '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ], { cwd: repoRoot });
            assert.equal(prepare.exitCode, 0, prepare.errors.join('\n'));
            const preparedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
            const launchInputArtifactPath = String(preparedArtifact.reviewer_launch_input_artifact_path);
            const launchInputSha256 = fileSha256(launchInputArtifactPath);
            const launchInput = JSON.parse(fs.readFileSync(launchInputArtifactPath, 'utf8')) as Record<string, unknown>;
            const laneReservation = readJsonObject(`${launchArtifactPath}.lane-reservation.json`);
            const laneContract = resolveAuthenticatedReviewLaneContract({
                preflight: readJsonObject(preflightPath),
                reviewContext: readJsonObject(reviewContextPath),
                reviewType
            });
            for (const field of CUSTOM_LANE_EVIDENCE_FIELDS) {
                assert.equal(preparedArtifact[field], laneContract.artifactEvidence[field]);
                assert.equal(launchInput[field], laneContract.artifactEvidence[field]);
                assert.equal(laneReservation[field], laneContract.artifactEvidence[field]);
            }

            const launchInputArgs = [
                '--launch-input-mode', 'launch_artifact_path',
                '--launch-input-artifact-path', launchInputArtifactPath,
                '--launch-input-sha256', launchInputSha256
            ];
            const providerInvocationId = `${taskId}-invocation`;
            const started = await runCliWithCapturedOutput([
                'gate', 'record-reviewer-delegation-started', '--task-id', taskId,
                '--review-type', reviewType, '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent', '--reviewer-identity', reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', providerInvocationId,
                '--attestation-source', 'test_provider_controller',
                ...launchInputArgs,
                '--fork-context', 'false'
            ], { cwd: repoRoot });
            assert.equal(started.exitCode, 0, started.errors.join('\n'));
            const completed = await runCliWithCapturedOutput([
                'gate', 'complete-reviewer-launch', '--task-id', taskId,
                '--review-type', reviewType, '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent', '--reviewer-identity', reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', providerInvocationId,
                '--attestation-source', 'test_provider_controller',
                ...launchInputArgs,
                '--fork-context', 'false', '--record-invocation'
            ], { cwd: repoRoot });
            assert.equal(completed.exitCode, 0, completed.errors.join('\n'));

            const report = outcome === 'pass'
                ? buildNoFindingsJsonReviewReport(reviewContextPath, taskId, reviewType)
                : buildFailedJsonReviewReport(reviewContextPath, taskId, reviewType);
            const reviewOutputPath = path.join(
                orchestratorRoot,
                'runtime',
                'tmp',
                'reviews',
                taskId,
                reviewType,
                'review-output.md'
            );
            fs.writeFileSync(reviewOutputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
            const result = await runCliWithCapturedOutput([
                'gate', 'record-review-result', '--task-id', taskId, '--review-type', reviewType,
                '--preflight-path', preflightPath, '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot, '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', reviewerIdentity
            ], { cwd: repoRoot });
            assert.equal(result.exitCode, 0, result.errors.join('\n'));
            assert.ok(result.logs.some((line) => line.includes(
                outcome === 'pass'
                    ? 'VerdictToken: ARCHITECTURE BOUNDARY REVIEW PASSED'
                    : 'VerdictToken: ARCHITECTURE BOUNDARY REVIEW FAILED'
            )));
            const receipt = JSON.parse(fs.readFileSync(
                path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`),
                'utf8'
            )) as Record<string, unknown>;
            for (const field of CUSTOM_LANE_EVIDENCE_FIELDS) {
                assert.equal(receipt[field], laneContract.artifactEvidence[field]);
            }
            if (outcome === 'pass') {
                const directReceipt = await runCliWithCapturedOutput([
                    'gate', 'record-review-receipt', '--task-id', taskId,
                    '--review-type', reviewType, '--preflight-path', preflightPath,
                    '--review-context-path', reviewContextPath, '--repo-root', repoRoot,
                    '--reviewer-execution-mode', 'delegated_subagent',
                    '--reviewer-identity', reviewerIdentity
                ], { cwd: repoRoot });
                assert.equal(directReceipt.exitCode, 0, directReceipt.errors.join('\n'));
                assert.ok(directReceipt.logs.some((line) => line.includes(
                    `REVIEW_RECORDED: ${reviewType}`
                )));
                const directReceiptArtifact = readJsonObject(
                    path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`)
                );
                for (const field of CUSTOM_LANE_EVIDENCE_FIELDS) {
                    assert.equal(directReceiptArtifact[field], laneContract.artifactEvidence[field]);
                }
            }
        }
    });

    it('authenticates custom lane evidence while recording and retrying a failed launch', async (t) => {
        const fixture = await seedCustomReviewCliFixture(
            t,
            'T-729-4B-custom-launch-failed',
            'launch-failed'
        );
        const {
            repoRoot,
            taskId,
            reviewType,
            reviewerIdentity,
            preflightPath,
            reviewContextPath,
            launchArtifactPath
        } = fixture;
        const prepare = await runCliWithCapturedOutput([
            'gate', 'prepare-reviewer-launch', '--task-id', taskId,
            '--review-type', reviewType, '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath
        ], { cwd: repoRoot });
        assert.equal(prepare.exitCode, 0, prepare.errors.join('\n'));
        const preparedArtifact = readJsonObject(launchArtifactPath);
        const launchInputArtifactPath = String(preparedArtifact.reviewer_launch_input_artifact_path);
        const launchInputArgs = [
            '--launch-input-mode', 'launch_artifact_path',
            '--launch-input-artifact-path', launchInputArtifactPath,
            '--launch-input-sha256', fileSha256(launchInputArtifactPath)
        ];
        const providerInvocationId = `${taskId}-invocation`;
        const started = await runCliWithCapturedOutput([
            'gate', 'record-reviewer-delegation-started', '--task-id', taskId,
            '--review-type', reviewType, '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath,
            '--provider-invocation-id', providerInvocationId,
            '--attestation-source', 'test_provider_controller',
            ...launchInputArgs,
            '--fork-context', 'false'
        ], { cwd: repoRoot });
        assert.equal(started.exitCode, 0, started.errors.join('\n'));

        const failureArgs = [
            'gate', 'record-reviewer-launch-failed', '--task-id', taskId,
            '--review-type', reviewType, '--review-context-path', reviewContextPath,
            '--repo-root', repoRoot, '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath,
            '--provider-invocation-id', providerInvocationId,
            '--failure-reason', 'Provider transport failed before review output'
        ];
        const reservationPath = `${launchArtifactPath}.lane-reservation.json`;
        for (const [label, artifactPath] of [
            ['Reviewer launch artifact', launchArtifactPath],
            ['Reviewer launch input artifact', launchInputArtifactPath],
            ['Reviewer launch lane reservation', reservationPath]
        ] as const) {
            const original = writeCaseDriftedLaneEvidence(artifactPath);
            const rejected = await runCliWithCapturedOutput(failureArgs, { cwd: repoRoot });
            assertCliFailure(
                rejected,
                new RegExp(`${label} review lane evidence is invalid: review_catalog_sha256`, 'u'),
                `record-reviewer-launch-failed ${label}`
            );
            fs.writeFileSync(artifactPath, original, 'utf8');
        }

        const laneContract = resolveAuthenticatedReviewLaneContract({
            preflight: readJsonObject(preflightPath),
            reviewContext: readJsonObject(reviewContextPath),
            reviewType
        });
        const supersededContext = readJsonObject(reviewContextPath);
        delete supersededContext.review_lane;
        fs.writeFileSync(reviewContextPath, `${JSON.stringify(supersededContext, null, 2)}\n`, 'utf8');

        const failed = await runCliWithCapturedOutput(failureArgs, { cwd: repoRoot });
        assert.equal(failed.exitCode, 0, failed.errors.join('\n'));
        const failedArtifact = readJsonObject(launchArtifactPath);
        assert.equal(failedArtifact.attestation_state, 'launch_failed');
        for (const field of CUSTOM_LANE_EVIDENCE_FIELDS) {
            assert.equal(failedArtifact[field], laneContract.artifactEvidence[field]);
        }

        const retriedFailure = await runCliWithCapturedOutput(failureArgs, { cwd: repoRoot });
        assert.equal(retriedFailure.exitCode, 0, retriedFailure.errors.join('\n'));
        assert.equal(readJsonObject(launchArtifactPath).attestation_state, 'launch_failed');
    });

    it('fails closed through public CLI boundaries for forged custom-lane and reviewer evidence', async (t) => {
        const fixture = await seedCustomReviewCliFixture(
            t,
            'T-729-4B-custom-negative',
            'negative'
        );
        const {
            repoRoot,
            taskId,
            reviewType,
            reviewerIdentity,
            orchestratorRoot,
            preflightPath,
            reviewContextPath,
            launchArtifactPath
        } = fixture;
        const prepareArgs = (candidateReviewType: string) => [
            'gate', 'prepare-reviewer-launch', '--task-id', taskId,
            '--review-type', candidateReviewType, '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath
        ];

        for (const [invalidReviewType, expectedDiagnostic] of [
            ['Architecture-Boundary', /canonical stable id/u],
            ['../architecture-boundary', /canonical stable id/u],
            ['architecture_boundary', /canonical stable id/u],
            ['live-config-only', /Review context artifact not found/u]
        ] as const) {
            const invalidPrepare = await runCliWithCapturedOutput(
                prepareArgs(invalidReviewType),
                { cwd: repoRoot }
            );
            assertCliFailure(invalidPrepare, expectedDiagnostic, invalidReviewType);
            assert.equal(fs.existsSync(launchArtifactPath), false);
        }

        const sameAgentRouting = await runCliWithCapturedOutput([
            'gate', 'record-review-routing', '--task-id', taskId,
            '--review-type', reviewType, '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'same_agent_fallback',
            '--reviewer-identity', 'self:implementation-agent',
            '--reviewer-fallback-reason', 'reuse implementation agent'
        ], { cwd: repoRoot });
        assertCliFailure(sameAgentRouting, /delegated_subagent/u, 'same-agent routing');

        const originalContext = fs.readFileSync(reviewContextPath, 'utf8');
        const forgedContext = JSON.parse(originalContext) as {
            review_lane: Record<string, unknown>;
        };
        forgedContext.review_lane.catalog_sha256 = 'f'.repeat(64);
        writeJsonObject(reviewContextPath, forgedContext);
        const forgedContextPrepare = await runCliWithCapturedOutput(
            prepareArgs(reviewType),
            { cwd: repoRoot }
        );
        assertCliFailure(
            forgedContextPrepare,
            /does not match the immutable effective review snapshot/u,
            'forged review context'
        );
        fs.writeFileSync(reviewContextPath, originalContext, 'utf8');

        const prepare = await runCliWithCapturedOutput(prepareArgs(reviewType), { cwd: repoRoot });
        assert.equal(prepare.exitCode, 0, prepare.errors.join('\n'));
        const originalLaunchArtifact = fs.readFileSync(launchArtifactPath, 'utf8');
        const preparedArtifact = JSON.parse(originalLaunchArtifact) as Record<string, unknown>;
        const launchInputArtifactPath = String(preparedArtifact.reviewer_launch_input_artifact_path);
        const launchInputSha256 = fileSha256(launchInputArtifactPath);
        const launchInputArgs = [
            '--launch-input-mode', 'launch_artifact_path',
            '--launch-input-artifact-path', launchInputArtifactPath,
            '--launch-input-sha256', launchInputSha256
        ];
        const providerInvocationId = `${taskId}-invocation`;
        const startArgs = [
            'gate', 'record-reviewer-delegation-started', '--task-id', taskId,
            '--review-type', reviewType, '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath,
            '--provider-invocation-id', providerInvocationId,
            '--attestation-source', 'test_provider_controller',
            ...launchInputArgs,
            '--fork-context', 'false'
        ];

        fs.writeFileSync(reviewContextPath, `${originalContext.trim()}\n\n`, 'utf8');
        const staleContextStart = await runCliWithCapturedOutput(startArgs, { cwd: repoRoot });
        assertCliFailure(
            staleContextStart,
            /review_context_sha256 must match the current review context/u,
            'stale review context'
        );
        fs.writeFileSync(reviewContextPath, originalContext, 'utf8');

        const reservationPath = `${launchArtifactPath}.lane-reservation.json`;
        const originalReservation = fs.readFileSync(reservationPath, 'utf8');
        const originalLaunchInputArtifact = fs.readFileSync(launchInputArtifactPath, 'utf8');
        for (const [label, artifactPath, original] of [
            ['Reviewer launch artifact', launchArtifactPath, originalLaunchArtifact],
            ['Reviewer launch input artifact', launchInputArtifactPath, originalLaunchInputArtifact],
            ['Reviewer launch lane reservation', reservationPath, originalReservation]
        ] as const) {
            writeCaseDriftedLaneEvidence(artifactPath);
            const rejectedStart = await runCliWithCapturedOutput(startArgs, { cwd: repoRoot });
            assertCliFailure(
                rejectedStart,
                new RegExp(`${label} review lane evidence is invalid: review_catalog_sha256`, 'u'),
                `delegation start ${label}`
            );
            fs.writeFileSync(artifactPath, original, 'utf8');
        }

        const collidingReservation = JSON.parse(originalReservation) as Record<string, unknown>;
        collidingReservation.reviewer_launch_artifact_path = path.join(
            orchestratorRoot,
            'runtime',
            'tmp',
            'reviews',
            taskId,
            reviewType,
            'other-reviewer-launch.json'
        );
        writeJsonObject(reservationPath, collidingReservation);
        const collisionPrepare = await runCliWithCapturedOutput(
            prepareArgs(reviewType),
            { cwd: repoRoot }
        );
        assertCliFailure(
            collisionPrepare,
            /already reserved at/u,
            'lane reservation collision'
        );
        fs.writeFileSync(reservationPath, originalReservation, 'utf8');

        const unresolvedIdentityStart = await runCliWithCapturedOutput([
            ...startArgs.slice(0, startArgs.indexOf('--reviewer-identity') + 1),
            `agent:pending:${taskId}-${reviewType}`,
            ...startArgs.slice(startArgs.indexOf('--reviewer-identity') + 2)
        ], { cwd: repoRoot });
        assertCliFailure(
            unresolvedIdentityStart,
            /resolved agent-scoped reviewer identity/u,
            'unresolved reviewer identity'
        );

        const started = await runCliWithCapturedOutput(startArgs, { cwd: repoRoot });
        assert.equal(started.exitCode, 0, started.errors.join('\n'));
        const completeArgs = [
            'gate', 'complete-reviewer-launch', '--task-id', taskId,
            '--review-type', reviewType, '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath,
            '--provider-invocation-id', providerInvocationId,
            '--attestation-source', 'test_provider_controller',
            ...launchInputArgs,
            '--fork-context', 'false', '--record-invocation'
        ];
        const startedLaunchArtifact = fs.readFileSync(launchArtifactPath, 'utf8');
        for (const [label, artifactPath, original] of [
            ['Reviewer launch artifact', launchArtifactPath, startedLaunchArtifact],
            ['Reviewer launch input artifact', launchInputArtifactPath, originalLaunchInputArtifact],
            ['Reviewer launch lane reservation', reservationPath, originalReservation]
        ] as const) {
            writeCaseDriftedLaneEvidence(artifactPath);
            const rejectedCompletion = await runCliWithCapturedOutput(completeArgs, { cwd: repoRoot });
            assertCliFailure(
                rejectedCompletion,
                new RegExp(`${label} review lane evidence is invalid: review_catalog_sha256`, 'u'),
                `launch completion ${label}`
            );
            fs.writeFileSync(artifactPath, original, 'utf8');
        }
        const completed = await runCliWithCapturedOutput(completeArgs, { cwd: repoRoot });
        assert.equal(completed.exitCode, 0, completed.errors.join('\n'));

        const report = buildNoFindingsJsonReviewReport(reviewContextPath, taskId, reviewType) as
            Record<string, unknown>;
        const reviewOutputPath = path.join(
            orchestratorRoot,
            'runtime',
            'tmp',
            'reviews',
            taskId,
            reviewType,
            'review-output.md'
        );
        writeJsonObject(reviewOutputPath, { ...report, verdict: 'CUSTOM REVIEW LOOKS GOOD' });
        const resultArgs = [
            'gate', 'record-review-result', '--task-id', taskId,
            '--review-type', reviewType, '--preflight-path', preflightPath,
            '--review-output-path', reviewOutputPath, '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity
        ];
        const freeFormVerdictResult = await runCliWithCapturedOutput(resultArgs, { cwd: repoRoot });
        assertCliFailure(
            freeFormVerdictResult,
            /verdict/iu,
            'free-form reviewer verdict'
        );

        writeJsonObject(reviewOutputPath, report);
        const validResult = await runCliWithCapturedOutput(resultArgs, { cwd: repoRoot });
        assert.equal(validResult.exitCode, 0, validResult.errors.join('\n'));

        const reusedReviewer = await runCliWithCapturedOutput(
            prepareArgs(reviewType),
            { cwd: repoRoot }
        );
        assertCliFailure(
            reusedReviewer,
            /already launched|already .* for/u,
            'reused reviewer launch'
        );
    });
});

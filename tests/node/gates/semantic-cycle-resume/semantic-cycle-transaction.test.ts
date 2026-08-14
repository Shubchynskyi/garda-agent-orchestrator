import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { fileSha256, stringSha256 } from '../../../../src/gate-runtime/hash';
import { buildEventIntegrityHash } from '../../../../src/gate-runtime/task-events';
import {
    SEMANTIC_CYCLE_BASE_BINDING_KEYS,
    type SemanticCycleBaseBindingKey,
    type SemanticCycleRuntimeIdentity,
    type SemanticCycleSnapshot
} from '../../../../src/gates/semantic-cycle-resume/semantic-cycle-contract-types';
import { compareSemanticCycleSnapshots } from '../../../../src/gates/semantic-cycle-resume/semantic-cycle-comparison';
import { buildSemanticCycleSnapshot } from '../../../../src/gates/semantic-cycle-resume/semantic-cycle-snapshot';
import {
    computeSemanticCycleRebindManifestSha256,
    executeSemanticCycleRebindTransaction,
    readSemanticCycleRebindManifest,
    validateSemanticCycleRebindManifest
} from '../../../../src/gates/semantic-cycle-resume/semantic-cycle-transaction';
import {
    SEMANTIC_CYCLE_REBIND_ARTIFACT_CLASSES,
    type SemanticCycleRebindArtifactClass,
    type SemanticCycleRebindArtifactInput,
    type SemanticCycleRebindTransactionOptions
} from '../../../../src/gates/semantic-cycle-resume/semantic-cycle-transaction-types';

const runtime: SemanticCycleRuntimeIdentity = {
    cli_version: '1.3.0',
    task_event_schema_version: 2,
    snapshot_schema_version: 1
};
const fixedNow = '2026-08-14T12:00:00.000Z';

function hash(value: string): string {
    return stringSha256(value) || '';
}

interface Fixture {
    repoRoot: string;
    snapshot: SemanticCycleSnapshot;
    artifacts: SemanticCycleRebindArtifactInput[];
    options: SemanticCycleRebindTransactionOptions;
    artifactPaths: Record<SemanticCycleRebindArtifactClass, string>;
    taskEventsPath: string;
    lifecycleHashes: [string, string];
    outputPath: string;
    cleanup: () => void;
}

function appendIntegrityEvent(
    taskEventsPath: string,
    taskSequence: number,
    previousSha256: string | null
): string {
    const event: Record<string, unknown> = {
        timestamp_utc: fixedNow,
        task_id: 'T-1015-2',
        event_type: 'test',
        outcome: 'PASS',
        actor: 'test',
        message: `Lifecycle event ${taskSequence}`,
        details: null,
        integrity: {
            schema_version: 1,
            task_sequence: taskSequence,
            prev_event_sha256: previousSha256
        }
    };
    const eventSha256 = buildEventIntegrityHash(event) || '';
    (event.integrity as Record<string, unknown>).event_sha256 = eventSha256;
    fs.appendFileSync(taskEventsPath, `${JSON.stringify(event)}\n`, 'utf8');
    return eventSha256;
}

function createFixture(): Fixture {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-semantic-rebind-'));
    const evidenceRoot = path.join(repoRoot, 'runtime', 'evidence');
    fs.mkdirSync(evidenceRoot, { recursive: true });
    const taskEventsPath = path.join(repoRoot, 'runtime', 'task-events', 'T-1015-2.jsonl');
    fs.mkdirSync(path.dirname(taskEventsPath), { recursive: true });
    const sourceLifecycleSha256 = appendIntegrityEvent(taskEventsPath, 1, null);
    const targetLifecycleSha256 = appendIntegrityEvent(taskEventsPath, 2, sourceLifecycleSha256);

    const writeEvidence = (name: string, content: string): { path: string; sha256: string } => {
        const artifactPath = path.join(evidenceRoot, name);
        fs.writeFileSync(artifactPath, `${content}\n`, 'utf8');
        return { path: artifactPath, sha256: fileSha256(artifactPath) || '' };
    };
    const compile = writeEvidence('compile.json', '{"status":"PASSED"}');
    const fullSuite = writeEvidence('full-suite.json', '{"status":"PASSED"}');
    const context = writeEvidence('code-context.json', '{"review_type":"code"}');
    const findings = writeEvidence('code-findings.json', '{"findings":[]}');
    const receipt = writeEvidence('code-receipt.json', '{"accepted":true}');
    const dependency = writeEvidence('code-dependency.json', '{"dependencies":[]}');

    const baseBindings = Object.fromEntries(SEMANTIC_CYCLE_BASE_BINDING_KEYS.map((key) => [
        key,
        key === 'compile_evidence'
            ? compile.sha256
            : key === 'full_suite_evidence'
                ? fullSuite.sha256
                : hash(`binding:${key}`)
    ])) as Record<SemanticCycleBaseBindingKey, string>;
    const snapshot = buildSemanticCycleSnapshot({
        task_id: 'T-1015-2',
        runtime,
        bindings: baseBindings,
        review_lanes: [{
            review_type: 'code',
            context_sha256: context.sha256,
            findings_disposition_sha256: findings.sha256,
            receipt_sha256: receipt.sha256,
            dependency_state_sha256: dependency.sha256,
            accepted_receipt: true
        }]
    });
    const comparison = compareSemanticCycleSnapshots(snapshot, structuredClone(snapshot), runtime);
    const artifacts: SemanticCycleRebindArtifactInput[] = [
        {
            artifact_class: 'compile',
            review_type: null,
            source_path: path.relative(repoRoot, compile.path),
            source_sha256: compile.sha256,
            accepted: true
        },
        {
            artifact_class: 'full_suite',
            review_type: null,
            source_path: path.relative(repoRoot, fullSuite.path),
            source_sha256: fullSuite.sha256,
            accepted: true
        },
        {
            artifact_class: 'review_context',
            review_type: 'code',
            source_path: path.relative(repoRoot, context.path),
            source_sha256: context.sha256,
            accepted: true
        },
        {
            artifact_class: 'findings_disposition',
            review_type: 'code',
            source_path: path.relative(repoRoot, findings.path),
            source_sha256: findings.sha256,
            accepted: true
        },
        {
            artifact_class: 'review_receipt',
            review_type: 'code',
            source_path: path.relative(repoRoot, receipt.path),
            source_sha256: receipt.sha256,
            accepted: true
        },
        {
            artifact_class: 'reviewer_dependency',
            review_type: 'code',
            source_path: path.relative(repoRoot, dependency.path),
            source_sha256: dependency.sha256,
            accepted: true
        }
    ];
    const outputPath = path.join(
        repoRoot,
        'runtime',
        'reviews',
        'T-1015-2-semantic-cycle-rebind.json'
    );
    const options: SemanticCycleRebindTransactionOptions = {
        repo_root: repoRoot,
        output_path: outputPath,
        task_events_path: taskEventsPath,
        comparison,
        authoritative_snapshot: snapshot,
        candidate_snapshot: structuredClone(snapshot),
        current_runtime: runtime,
        source_position: {
            cycle_sha256: sourceLifecycleSha256,
            task_event_sequence: 1
        },
        target_position: {
            cycle_sha256: targetLifecycleSha256,
            task_event_sequence: 2
        },
        artifacts,
        _testHooks: { now_utc: () => fixedNow }
    };
    return {
        repoRoot,
        snapshot,
        artifacts,
        options,
        artifactPaths: {
            compile: compile.path,
            full_suite: fullSuite.path,
            review_context: context.path,
            findings_disposition: findings.path,
            review_receipt: receipt.path,
            reviewer_dependency: dependency.path
        },
        taskEventsPath,
        lifecycleHashes: [sourceLifecycleSha256, targetLifecycleSha256],
        outputPath,
        cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true })
    };
}

describe('semantic cycle rebind transaction', () => {
    it('commits every accepted artifact class as one authenticated immutable audit record', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(result.status, 'COMMITTED');
            assert.equal(result.mutation_allowed, true);
            assert.equal(result.route, 'semantic_rebind');
            assert.equal(result.manifest?.status, 'COMMITTED');
            assert.equal(result.manifest?.artifacts.length, 6);
            assert.deepEqual(
                new Set(result.manifest?.artifacts.map((artifact) => artifact.artifact_class)),
                new Set(SEMANTIC_CYCLE_REBIND_ARTIFACT_CLASSES)
            );
            assert.ok(result.manifest?.artifacts.every((artifact) => (
                artifact.rebound_cycle_sha256 === fixture.options.target_position.cycle_sha256
                && artifact.rebound_task_event_sequence === 2
                && artifact.accepted
            )));
            assert.equal(result.audit.event, 'SEMANTIC_CYCLE_REBIND_COMMITTED');
            assert.equal(result.audit.verified_artifact_count, 6);
            assert.deepEqual(result.audit.invalidation_codes, []);

            const persisted = readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath);
            assert.equal(persisted.status, 'VALID');
            assert.equal(persisted.manifest?.transaction_sha256, result.manifest?.transaction_sha256);
            for (const artifact of fixture.artifacts) {
                assert.equal(fileSha256(path.resolve(fixture.repoRoot, artifact.source_path)), artifact.source_sha256);
            }
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects changed evidence for each artifact class without exposing a partial rebind', () => {
        for (const artifactClass of SEMANTIC_CYCLE_REBIND_ARTIFACT_CLASSES) {
            const fixture = createFixture();
            try {
                fs.appendFileSync(fixture.artifactPaths[artifactClass], 'tampered\n', 'utf8');
                const result = executeSemanticCycleRebindTransaction(fixture.options);
                assert.equal(result.status, 'INVALIDATED', artifactClass);
                assert.equal(result.mutation_allowed, false, artifactClass);
                assert.equal(result.route, 'existing_recovery', artifactClass);
                assert.ok(result.audit.invalidation_codes.includes('ARTIFACT_HASH_MISMATCH'), artifactClass);
                assert.deepEqual(result.manifest?.artifacts, [], artifactClass);
                assert.equal(readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath).status, 'VALID');
            } finally {
                fixture.cleanup();
            }
        }
    });

    it('invalidates a typed non-reusable comparison into the existing recovery route', () => {
        const fixture = createFixture();
        try {
            const candidate = buildSemanticCycleSnapshot({
                task_id: fixture.snapshot.task_id,
                runtime,
                bindings: {
                    task_contract: fixture.snapshot.bindings.task_contract,
                    profile_policy: fixture.snapshot.bindings.profile_policy,
                    workflow_config: fixture.snapshot.bindings.workflow_config,
                    rule_pack: fixture.snapshot.bindings.rule_pack,
                    review_catalog: fixture.snapshot.bindings.review_catalog,
                    trust_boundary_analysis: fixture.snapshot.bindings.trust_boundary_analysis,
                    authorized_scope: fixture.snapshot.bindings.authorized_scope,
                    source_content: hash('changed source'),
                    tree_state: fixture.snapshot.bindings.tree_state,
                    compile_evidence: fixture.snapshot.bindings.compile_evidence,
                    full_suite_evidence: fixture.snapshot.bindings.full_suite_evidence
                },
                review_lanes: fixture.snapshot.review_lanes
            });
            const comparison = compareSemanticCycleSnapshots(fixture.snapshot, candidate, runtime);
            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                comparison,
                candidate_snapshot: candidate
            });
            assert.equal(result.status, 'INVALIDATED');
            assert.equal(result.route, 'existing_recovery');
            assert.ok(result.audit.invalidation_codes.includes('COMPARISON_NOT_REUSABLE'));
            assert.match(result.audit.violations.join(' '), /status=RECOVERY_REQUIRED/u);
            assert.deepEqual(result.manifest?.artifacts, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects concurrent artifact drift before committing a rebind', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                _testHooks: {
                    now_utc: () => fixedNow,
                    before_final_validation: () => {
                        fs.appendFileSync(fixture.artifactPaths.compile, 'concurrent drift\n', 'utf8');
                    }
                }
            });
            assert.equal(result.status, 'INVALIDATED');
            assert.equal(result.route, 'existing_recovery');
            assert.ok(result.audit.invalidation_codes.includes('CONCURRENT_DRIFT'));
            assert.deepEqual(result.manifest?.artifacts, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects an unauthorized output path without overwriting the target', () => {
        const fixture = createFixture();
        try {
            const protectedPath = path.join(fixture.repoRoot, 'src', 'control.ts');
            fs.mkdirSync(path.dirname(protectedPath), { recursive: true });
            fs.writeFileSync(protectedPath, 'export const protectedControl = true;\n', 'utf8');
            const protectedBytes = fs.readFileSync(protectedPath, 'utf8');

            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                output_path: protectedPath
            });

            assert.equal(result.status, 'INVALIDATED');
            assert.equal(result.mutation_allowed, false);
            assert.ok(result.audit.invalidation_codes.includes('ARTIFACT_COVERAGE_INVALID'));
            assert.equal(fs.readFileSync(protectedPath, 'utf8'), protectedBytes);
            assert.equal(result.artifact_path, fixture.outputPath);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects forged lifecycle positions outside the authenticated task-event chain', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                source_position: {
                    cycle_sha256: hash('forged-source-cycle'),
                    task_event_sequence: 20
                },
                target_position: {
                    cycle_sha256: hash('forged-target-cycle'),
                    task_event_sequence: 40
                }
            });

            assert.equal(result.status, 'INVALIDATED');
            assert.equal(result.mutation_allowed, false);
            assert.equal(result.route, 'existing_recovery');
            assert.ok(result.audit.invalidation_codes.includes('LIFECYCLE_POSITION_INVALID'));
            assert.deepEqual(result.manifest?.artifacts, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects a case-variant task-event authority file on case-sensitive filesystems', (context) => {
        const fixture = createFixture();
        try {
            const caseVariantPath = path.join(
                fixture.repoRoot,
                'runtime',
                'task-events',
                't-1015-2.jsonl'
            );
            if (fs.existsSync(caseVariantPath)) {
                context.skip('The temporary filesystem is case-insensitive.');
                return;
            }
            fs.copyFileSync(fixture.taskEventsPath, caseVariantPath);

            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                task_events_path: caseVariantPath
            });

            assert.equal(result.status, 'INVALIDATED');
            assert.equal(result.mutation_allowed, false);
            assert.ok(result.audit.invalidation_codes.includes('LIFECYCLE_POSITION_INVALID'));
            assert.match(result.audit.violations.join(' '), /canonical task-events path/u);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects stale lifecycle authority when the task-event chain advances before commit', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                _testHooks: {
                    now_utc: () => fixedNow,
                    before_final_validation: () => {
                        appendIntegrityEvent(fixture.taskEventsPath, 3, fixture.lifecycleHashes[1]);
                    }
                }
            });

            assert.equal(result.status, 'INVALIDATED');
            assert.equal(result.mutation_allowed, false);
            assert.equal(result.route, 'existing_recovery');
            assert.ok(result.audit.invalidation_codes.includes('CONCURRENT_DRIFT'));
            assert.match(result.audit.violations.join(' '), /Lifecycle authority/u);
            assert.deepEqual(result.manifest?.artifacts, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('rolls back a partial transaction when post-commit verification fails', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                _testHooks: {
                    now_utc: () => fixedNow,
                    after_persist_before_verification: () => {
                        fs.appendFileSync(fixture.artifactPaths.review_receipt, 'concurrent drift\n', 'utf8');
                    }
                }
            });
            assert.equal(result.status, 'INTERRUPTED');
            assert.equal(result.mutation_allowed, false);
            assert.equal(result.audit.rollback_performed, true);
            assert.equal(result.audit.rollback_completed, true);
            assert.ok(result.audit.invalidation_codes.includes('POST_COMMIT_VALIDATION_FAILED'));
            assert.equal(fs.existsSync(fixture.outputPath), false);
        } finally {
            fixture.cleanup();
        }
    });

    it('keeps a failed rollback manifest unreadable when output removal fails', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                _testHooks: {
                    now_utc: () => fixedNow,
                    after_persist_before_verification: () => {
                        fs.appendFileSync(fixture.artifactPaths.review_receipt, 'concurrent drift\n', 'utf8');
                    },
                    rollback_remove_output: () => {
                        throw new Error('simulated output removal failure');
                    }
                }
            });

            assert.equal(result.status, 'INTERRUPTED');
            assert.equal(result.mutation_allowed, false);
            assert.equal(result.audit.rollback_performed, true);
            assert.equal(result.audit.rollback_completed, false);
            assert.equal(fs.existsSync(fixture.outputPath), true);
            assert.equal(fs.existsSync(`${fixture.outputPath}.pending`), true);
            const persisted = readSemanticCycleRebindManifest(fixture.repoRoot, fixture.outputPath);
            assert.equal(persisted.status, 'INVALID');
            assert.match(persisted.violations.join(' '), /incomplete transaction marker/u);
        } finally {
            fixture.cleanup();
        }
    });

    it('rolls back a tampered manifest during post-persist authentication', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                _testHooks: {
                    now_utc: () => fixedNow,
                    after_persist_before_verification: () => {
                        fs.writeFileSync(fixture.outputPath, '{"tampered":true}\n', 'utf8');
                    }
                }
            });
            assert.equal(result.status, 'INTERRUPTED');
            assert.equal(result.mutation_allowed, false);
            assert.equal(result.audit.rollback_performed, true);
            assert.equal(result.audit.rollback_completed, true);
            assert.ok(result.audit.invalidation_codes.includes('POST_COMMIT_VALIDATION_FAILED'));
            assert.equal(fs.existsSync(fixture.outputPath), false);
        } finally {
            fixture.cleanup();
        }
    });

    it('rolls back output when persisted manifest validation fails after the atomic write', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                _testHooks: {
                    now_utc: () => fixedNow,
                    after_write_before_persisted_validation: (outputPath) => {
                        fs.writeFileSync(outputPath, '{"corrupt":true}\n', 'utf8');
                    }
                }
            });
            assert.equal(result.status, 'INTERRUPTED');
            assert.equal(result.mutation_allowed, false);
            assert.equal(result.audit.rollback_performed, true);
            assert.equal(result.audit.rollback_completed, true);
            assert.ok(result.audit.invalidation_codes.includes('PERSISTENCE_FAILED'));
            assert.equal(fs.existsSync(fixture.outputPath), false);
        } finally {
            fixture.cleanup();
        }
    });

    it('recovers idempotently after an interrupted pre-persist attempt', () => {
        const fixture = createFixture();
        try {
            const interrupted = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                _testHooks: {
                    now_utc: () => fixedNow,
                    before_persist: () => {
                        throw new Error('simulated interruption');
                    }
                }
            });
            assert.equal(interrupted.status, 'INTERRUPTED');
            assert.equal(fs.existsSync(fixture.outputPath), false);

            const committed = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(committed.status, 'COMMITTED');
            const bytes = fs.readFileSync(fixture.outputPath, 'utf8');
            const idempotent = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(idempotent.status, 'IDEMPOTENT');
            assert.equal(idempotent.manifest?.transaction_sha256, committed.manifest?.transaction_sha256);
            assert.equal(fs.readFileSync(fixture.outputPath, 'utf8'), bytes);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects stale source evidence when replaying a committed request', () => {
        const fixture = createFixture();
        try {
            const committed = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(committed.status, 'COMMITTED');
            const committedBytes = fs.readFileSync(fixture.outputPath, 'utf8');

            fs.appendFileSync(fixture.artifactPaths.review_context, 'stale evidence\n', 'utf8');
            const replay = executeSemanticCycleRebindTransaction(fixture.options);

            assert.equal(replay.status, 'INVALIDATED');
            assert.equal(replay.mutation_allowed, false);
            assert.equal(replay.route, 'existing_recovery');
            assert.equal(replay.artifact_path, null);
            assert.ok(replay.audit.invalidation_codes.includes('ARTIFACT_HASH_MISMATCH'));
            assert.equal(fs.readFileSync(fixture.outputPath, 'utf8'), committedBytes);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects TOCTOU drift before idempotent replay inside the output lock', () => {
        const fixture = createFixture();
        try {
            const committed = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(committed.status, 'COMMITTED');
            const committedBytes = fs.readFileSync(fixture.outputPath, 'utf8');

            const replay = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                _testHooks: {
                    now_utc: () => fixedNow,
                    after_initial_validation_before_lock: () => {
                        fs.appendFileSync(fixture.artifactPaths.review_receipt, 'TOCTOU drift\n', 'utf8');
                    }
                }
            });

            assert.equal(replay.status, 'INVALIDATED');
            assert.equal(replay.mutation_allowed, false);
            assert.equal(replay.route, 'existing_recovery');
            assert.equal(replay.artifact_path, null);
            assert.ok(replay.audit.invalidation_codes.includes('CONCURRENT_DRIFT'));
            assert.equal(fs.readFileSync(fixture.outputPath, 'utf8'), committedBytes);
        } finally {
            fixture.cleanup();
        }
    });

    it('preserves an immutable committed audit when another request targets the same path', () => {
        const fixture = createFixture();
        try {
            const committed = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(committed.status, 'COMMITTED');
            const bytes = fs.readFileSync(fixture.outputPath, 'utf8');
            const conflict = executeSemanticCycleRebindTransaction({
                ...fixture.options,
                target_position: {
                    cycle_sha256: hash('another-target-cycle'),
                    task_event_sequence: 41
                }
            });
            assert.equal(conflict.status, 'INVALIDATED');
            assert.ok(conflict.audit.invalidation_codes.includes('IMMUTABLE_OUTPUT_CONFLICT'));
            assert.equal(conflict.artifact_path, null);
            assert.equal(fs.readFileSync(fixture.outputPath, 'utf8'), bytes);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects tampered or schema-expanded transaction audit evidence', () => {
        const fixture = createFixture();
        try {
            const result = executeSemanticCycleRebindTransaction(fixture.options);
            assert.equal(result.status, 'COMMITTED');
            const tampered = structuredClone(result.manifest!);
            tampered.audit.verified_artifact_count = 5;
            const tamperedValidation = validateSemanticCycleRebindManifest(tampered);
            assert.equal(tamperedValidation.status, 'INVALID');
            assert.match(tamperedValidation.violations.join(' '), /verify every rebound artifact/u);

            const expanded = {
                ...structuredClone(result.manifest!),
                synthetic_reviewer_identity: 'agent:forged'
            } as unknown as Record<string, unknown>;
            expanded.transaction_sha256 = computeSemanticCycleRebindManifestSha256(
                expanded as unknown as Parameters<typeof computeSemanticCycleRebindManifestSha256>[0]
            );
            assert.match(
                validateSemanticCycleRebindManifest(expanded).violations.join(' '),
                /unsupported field/u
            );
        } finally {
            fixture.cleanup();
        }
    });
});

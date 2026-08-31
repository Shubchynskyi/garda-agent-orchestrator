import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stringSha256 } from '../../../../src/gate-runtime/hash';
import {
    SEMANTIC_CYCLE_BASE_BINDING_KEYS,
    type SemanticCycleBaseBindingKey,
    type SemanticCycleLifecyclePosition,
    type SemanticCycleMismatchCode,
    type SemanticCycleReviewLaneBinding,
    type SemanticCycleRuntimeIdentity,
    type SemanticCycleSnapshot
} from '../../../../src/gates/semantic-cycle-resume/semantic-cycle-contract-types';
import {
    assertSemanticCycleRuntimeCompatibility,
    compareSemanticCycleSnapshots,
    SemanticCycleRuntimeCompatibilityError
} from '../../../../src/gates/semantic-cycle-resume/semantic-cycle-comparison';
import {
    buildSemanticCycleSnapshot,
    computeSemanticCycleSnapshotSha256,
    copySemanticCycleBaseBindings,
    deriveSemanticCycleReviewBindings,
    serializeSemanticCycleValue,
    validateSemanticCycleSnapshot
} from '../../../../src/gates/semantic-cycle-resume/semantic-cycle-snapshot';

const runtime: SemanticCycleRuntimeIdentity = {
    cli_version: '1.3.0',
    task_event_schema_version: 2,
    snapshot_schema_version: 1
};

function hash(label: string): string {
    return stringSha256(label) || '';
}

function buildBaseBindings(
    overrides: Partial<Record<SemanticCycleBaseBindingKey, string>> = {}
): Record<SemanticCycleBaseBindingKey, string> {
    return Object.fromEntries(SEMANTIC_CYCLE_BASE_BINDING_KEYS.map((key) => [
        key,
        overrides[key] || hash(key)
    ])) as Record<SemanticCycleBaseBindingKey, string>;
}

function buildLane(reviewType: string, suffix = 'baseline'): SemanticCycleReviewLaneBinding {
    return {
        review_type: reviewType,
        context_sha256: hash(`${reviewType}:context:${suffix}`),
        findings_disposition_sha256: hash(`${reviewType}:findings:${suffix}`),
        receipt_sha256: hash(`${reviewType}:receipt:${suffix}`),
        dependency_state_sha256: hash(`${reviewType}:dependencies:${suffix}`),
        accepted_receipt: true
    };
}

function buildSnapshot(options: {
    taskId?: string;
    runtimeIdentity?: SemanticCycleRuntimeIdentity;
    bindings?: Partial<Record<SemanticCycleBaseBindingKey, string>>;
    lanes?: SemanticCycleReviewLaneBinding[];
    lifecyclePosition?: SemanticCycleLifecyclePosition;
} = {}): SemanticCycleSnapshot {
    return buildSemanticCycleSnapshot({
        task_id: options.taskId || 'T-1015-1',
        runtime: options.runtimeIdentity || runtime,
        lifecycle_position: options.lifecyclePosition || {
            cycle_sha256: hash('lifecycle:source'),
            task_event_sequence: 12
        },
        bindings: buildBaseBindings(options.bindings),
        review_lanes: options.lanes || [buildLane('security'), buildLane('code')]
    });
}

function rehash(snapshot: SemanticCycleSnapshot): SemanticCycleSnapshot {
    return {
        ...snapshot,
        snapshot_sha256: computeSemanticCycleSnapshotSha256(snapshot)
    };
}

describe('semantic cycle snapshot contract', () => {
    it('builds a deterministic authenticated snapshot with sorted lanes and derived review bindings', () => {
        const snapshot = buildSnapshot();
        assert.deepEqual(snapshot.review_lanes.map((lane) => lane.review_type), ['code', 'security']);
        assert.deepEqual(
            {
                review_contexts: snapshot.bindings.review_contexts,
                findings_dispositions: snapshot.bindings.findings_dispositions,
                review_receipts: snapshot.bindings.review_receipts,
                reviewer_dependencies: snapshot.bindings.reviewer_dependencies
            },
            deriveSemanticCycleReviewBindings(snapshot.review_lanes)
        );
        assert.equal(validateSemanticCycleSnapshot(snapshot).status, 'VALID');
        assert.deepEqual(buildSnapshot(), snapshot);
    });

    it('authenticates and validates the lifecycle position carried by the snapshot', () => {
        const snapshot = buildSnapshot();
        const stale = structuredClone(snapshot);
        stale.lifecycle_position.task_event_sequence += 1;
        assert.match(
            validateSemanticCycleSnapshot(stale).violations.join(' '),
            /snapshot_sha256 does not authenticate/u
        );

        const malformed = structuredClone(snapshot);
        malformed.lifecycle_position.cycle_sha256 = malformed.lifecycle_position.cycle_sha256.toUpperCase();
        assert.match(
            validateSemanticCycleSnapshot(rehash(malformed)).violations.join(' '),
            /lifecycle_position\.cycle_sha256 must be a lowercase SHA-256/u
        );
    });

    it('rejects locale-dependent ordering for canonical payload keys and review lanes', () => {
        assert.equal(
            serializeSemanticCycleValue({ 'ä': 2, z: 1 }),
            '{"z":1,"ä":2}'
        );
        assert.deepEqual(
            buildSnapshot({
                lanes: [buildLane('z-lane'), buildLane('a-2'), buildLane('a-10')]
            }).review_lanes.map((lane) => lane.review_type),
            ['a-10', 'a-2', 'z-lane']
        );
    });

    it('rejects stale hashes and coherently rehashed derived review bindings', () => {
        const snapshot = buildSnapshot();
        const stale = structuredClone(snapshot);
        stale.bindings.source_content = hash('changed source');
        assert.match(
            validateSemanticCycleSnapshot(stale).violations.join(' '),
            /snapshot_sha256 does not authenticate/u
        );

        const forged = structuredClone(snapshot);
        forged.bindings.review_receipts = hash('forged aggregate');
        const coherentlyRehashed = rehash(forged);
        assert.match(
            validateSemanticCycleSnapshot(coherentlyRehashed).violations.join(' '),
            /review_receipts does not match review_lanes/u
        );
    });

    it('rejects unknown schema fields, duplicate lanes, and unsorted lanes', () => {
        const snapshot = buildSnapshot();
        const unknownField = { ...snapshot, future_field: true };
        assert.match(validateSemanticCycleSnapshot(unknownField).violations.join(' '), /unsupported field/u);

        const duplicate = structuredClone(snapshot);
        duplicate.review_lanes.push({ ...duplicate.review_lanes[0] });
        duplicate.bindings = { ...duplicate.bindings, ...deriveSemanticCycleReviewBindings(duplicate.review_lanes) };
        assert.match(validateSemanticCycleSnapshot(rehash(duplicate)).violations.join(' '), /duplicate review_type/u);

        const unsorted = structuredClone(snapshot);
        unsorted.review_lanes.reverse();
        unsorted.bindings = { ...unsorted.bindings, ...deriveSemanticCycleReviewBindings(unsorted.review_lanes) };
        assert.match(validateSemanticCycleSnapshot(rehash(unsorted)).violations.join(' '), /sorted by review_type/u);
    });
});

describe('semantic cycle comparison', () => {
    it('accepts exact authenticated semantic equality and emits a stable decision hash', () => {
        const authoritative = buildSnapshot();
        const candidate = buildSnapshot();
        const first = compareSemanticCycleSnapshots(authoritative, candidate, runtime);
        const second = compareSemanticCycleSnapshots(authoritative, candidate, runtime);
        assert.equal(first.status, 'REUSABLE');
        assert.equal(first.mutation_allowed, true);
        assert.equal(first.route, 'semantic_rebind');
        assert.deepEqual(first.mismatches, []);
        assert.equal(first.decision_sha256, second.decision_sha256);
    });

    it('classifies every authoritative base binding mismatch and routes to existing recovery', () => {
        const expectedCodes: Record<SemanticCycleBaseBindingKey, SemanticCycleMismatchCode> = {
            task_contract: 'TASK_CONTRACT_MISMATCH',
            profile_policy: 'PROFILE_POLICY_MISMATCH',
            workflow_config: 'WORKFLOW_CONFIG_MISMATCH',
            rule_pack: 'RULE_PACK_MISMATCH',
            review_catalog: 'REVIEW_CATALOG_MISMATCH',
            trust_boundary_analysis: 'TRUST_BOUNDARY_ANALYSIS_MISMATCH',
            authorized_scope: 'AUTHORIZED_SCOPE_MISMATCH',
            source_content: 'SOURCE_CONTENT_MISMATCH',
            tree_state: 'TREE_STATE_MISMATCH',
            compile_evidence: 'COMPILE_EVIDENCE_MISMATCH',
            full_suite_evidence: 'FULL_SUITE_EVIDENCE_MISMATCH'
        };
        const authoritative = buildSnapshot();
        for (const key of SEMANTIC_CYCLE_BASE_BINDING_KEYS) {
            const candidate = buildSnapshot({ bindings: { [key]: hash(`changed:${key}`) } });
            const result = compareSemanticCycleSnapshots(authoritative, candidate, runtime);
            assert.equal(result.status, 'RECOVERY_REQUIRED', key);
            assert.equal(result.mutation_allowed, false, key);
            assert.equal(result.route, 'existing_recovery', key);
            assert.ok(result.mismatches.some((entry) => entry.code === expectedCodes[key]), key);
        }
    });

    it('classifies lane set, context, findings, receipt, dependency, and acceptance drift', () => {
        const authoritative = buildSnapshot();
        const changedCodeLane = {
            ...buildLane('code'),
            context_sha256: hash('changed context'),
            findings_disposition_sha256: hash('changed findings'),
            receipt_sha256: hash('changed receipt'),
            dependency_state_sha256: hash('changed dependencies'),
            accepted_receipt: false
        };
        const candidate = buildSnapshot({ lanes: [changedCodeLane, buildLane('api')] });
        const result = compareSemanticCycleSnapshots(authoritative, candidate, runtime);
        const codes = new Set(result.mismatches.map((entry) => entry.code));
        const expectedCodes: SemanticCycleMismatchCode[] = [
            'REVIEW_CONTEXTS_MISMATCH',
            'FINDINGS_DISPOSITIONS_MISMATCH',
            'REVIEW_RECEIPTS_MISMATCH',
            'REVIEWER_DEPENDENCIES_MISMATCH',
            'REVIEW_LANE_SET_MISMATCH',
            'REVIEW_LANE_CONTEXT_MISMATCH',
            'REVIEW_LANE_FINDINGS_MISMATCH',
            'REVIEW_LANE_RECEIPT_MISMATCH',
            'REVIEW_LANE_DEPENDENCY_MISMATCH',
            'REVIEW_LANE_ACCEPTANCE_MISMATCH'
        ];
        for (const code of expectedCodes) {
            assert.ok(codes.has(code), code);
        }
    });

    it('rejects another task and invalid snapshots without trusting their payload', () => {
        const authoritative = buildSnapshot();
        const otherTask = buildSnapshot({ taskId: 'T-1015-2' });
        assert.ok(
            compareSemanticCycleSnapshots(authoritative, otherTask, runtime).mismatches
                .some((entry) => entry.code === 'TASK_ID_MISMATCH')
        );

        const invalid = structuredClone(authoritative);
        invalid.snapshot_sha256 = hash('wrong');
        const invalidResult = compareSemanticCycleSnapshots(authoritative, invalid, runtime);
        assert.equal(invalidResult.status, 'RECOVERY_REQUIRED');
        assert.equal(invalidResult.mutation_allowed, false);
        assert.equal(invalidResult.mismatches[0]?.code, 'CANDIDATE_SNAPSHOT_INVALID');

        const invalidAuthoritative = structuredClone(authoritative);
        invalidAuthoritative.snapshot_sha256 = hash('wrong authoritative hash');
        const invalidAuthoritativeResult = compareSemanticCycleSnapshots(
            invalidAuthoritative,
            authoritative,
            runtime
        );
        assert.equal(invalidAuthoritativeResult.status, 'RECOVERY_REQUIRED');
        assert.equal(invalidAuthoritativeResult.mutation_allowed, false);
        assert.equal(invalidAuthoritativeResult.mismatches[0]?.code, 'AUTHORITATIVE_SNAPSHOT_INVALID');
    });

    it('blocks an old nested launcher before lifecycle mutation', () => {
        const snapshot = buildSnapshot();
        const oldRuntime: SemanticCycleRuntimeIdentity = {
            ...runtime,
            cli_version: '1.2.9',
            task_event_schema_version: 1,
            snapshot_schema_version: 2
        };
        let mutated = false;
        assert.throws(
            () => {
                assertSemanticCycleRuntimeCompatibility(snapshot, oldRuntime);
                mutated = true;
            },
            (error: unknown) => {
                assert.ok(error instanceof SemanticCycleRuntimeCompatibilityError);
                assert.equal(error.compatibility.mutation_allowed, false);
                assert.match(error.message, /current workspace CLI\/runtime/u);
                return true;
            }
        );
        assert.equal(mutated, false);

        const comparison = compareSemanticCycleSnapshots(snapshot, snapshot, oldRuntime);
        assert.equal(comparison.status, 'RUNTIME_INCOMPATIBLE');
        assert.equal(comparison.route, 'runtime_upgrade_required');
        assert.equal(comparison.mutation_allowed, false);
        assert.deepEqual(
            new Set(comparison.mismatches.map((entry) => entry.code)),
            new Set([
                'SNAPSHOT_SCHEMA_UNSUPPORTED',
                'RUNTIME_CLI_MISMATCH',
                'TASK_EVENT_SCHEMA_MISMATCH'
            ])
        );
    });

    it('reports concurrent semantic drift while runtime incompatibility keeps mutation blocked', () => {
        const authoritative = buildSnapshot();
        const candidate = buildSnapshot({
            taskId: 'T-1015-2',
            bindings: { source_content: hash('changed source') },
            lanes: [buildLane('api'), buildLane('code')]
        });
        const oldRuntime: SemanticCycleRuntimeIdentity = {
            ...runtime,
            cli_version: '1.2.9',
            task_event_schema_version: 1,
            snapshot_schema_version: 2
        };

        const result = compareSemanticCycleSnapshots(authoritative, candidate, oldRuntime);
        const codes = new Set(result.mismatches.map((entry) => entry.code));
        assert.equal(result.status, 'RUNTIME_INCOMPATIBLE');
        assert.equal(result.route, 'runtime_upgrade_required');
        assert.equal(result.mutation_allowed, false);
        for (const code of [
            'SNAPSHOT_SCHEMA_UNSUPPORTED',
            'RUNTIME_CLI_MISMATCH',
            'TASK_EVENT_SCHEMA_MISMATCH',
            'TASK_ID_MISMATCH',
            'SOURCE_CONTENT_MISMATCH',
            'REVIEW_CONTEXTS_MISMATCH',
            'FINDINGS_DISPOSITIONS_MISMATCH',
            'REVIEW_RECEIPTS_MISMATCH',
            'REVIEWER_DEPENDENCIES_MISMATCH',
            'REVIEW_LANE_SET_MISMATCH'
        ] as const) {
            assert.ok(codes.has(code), code);
        }
    });

    it('round-trips the base bindings needed by a later transaction without derived review hashes', () => {
        const snapshot = buildSnapshot();
        assert.deepEqual(copySemanticCycleBaseBindings(snapshot.bindings), buildBaseBindings());
    });
});

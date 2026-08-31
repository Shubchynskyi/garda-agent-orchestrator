import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    bindFullSuiteValidationBarrier,
    compileReviewDependencyGraph,
    getCompiledReviewDependencyGraphViolations,
    getReviewDependencyTimelineOrderViolations,
    normalizeReviewDependencyGraphDeclaration,
    resolveCompiledReviewDependencyGraphFromPreflight,
    resolveReviewDependencyDownstreamReachability
} from '../../../src/core/review-dependency-graph';
import { validateProfilesConfig } from '../../../src/schemas/config-artifacts';
import { profilesSchema, validateAgainstSchema } from '../../../src/schemas/config-schemas';

const BUILT_IN_LANES = [
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'performance',
    'infra',
    'dependency',
    'test'
] as const;

describe('review dependency graph compilation', () => {
    it('keeps full-suite enablement and placement frozen for the current preflight cycle', () => {
        const graph = compileReviewDependencyGraph({
            catalogLaneIds: ['code', 'test'],
            activeLaneIds: ['code', 'test'],
            requiredReviewIds: ['code', 'test'],
            mode: 'test_after_code',
            fullSuiteValidation: { enabled: true, placement: 'before_test_review' }
        });
        const liveConfig = {
            enabled: false,
            placement: 'before_completion' as const,
            command: 'npm test'
        };

        assert.deepEqual(bindFullSuiteValidationBarrier(liveConfig, graph), {
            enabled: true,
            placement: 'before_test_review',
            command: 'npm test'
        });
    });

    it('accepts the bounded graph contract through both profile validators', () => {
        const profiles = {
            version: 1,
            active_profile: 'custom',
            built_in_profiles: {
                custom: {
                    description: 'Custom dependency profile',
                    depth: 2,
                    review_policy: { code: true, test: true },
                    review_dependency_graph: {
                        preparation_order: ['code', 'test'],
                        dependencies: { test: ['code'] }
                    },
                    token_economy: {
                        enabled: true,
                        strip_examples: true,
                        strip_code_blocks: true,
                        scoped_diffs: true,
                        compact_reviewer_output: true
                    },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        };

        const normalized = validateProfilesConfig(profiles);
        assert.deepEqual(
            ((normalized.built_in_profiles as Record<string, Record<string, unknown>>).custom
                .review_dependency_graph as Record<string, unknown>).preparation_order,
            ['code', 'test']
        );
        assert.equal(validateAgainstSchema(normalized, profilesSchema).valid, true);
    });

    it('rejects the gate-owned full-suite barrier through the published profile schema', () => {
        const profiles = {
            version: 1,
            active_profile: 'custom',
            built_in_profiles: {
                custom: {
                    description: 'Invalid dependency profile',
                    depth: 2,
                    review_policy: { code: true },
                    review_dependency_graph: {
                        preparation_order: ['code', 'full-suite-validation'],
                        dependencies: { 'full-suite-validation': ['code'] }
                    },
                    token_economy: {
                        enabled: true,
                        strip_examples: true,
                        strip_code_blocks: true,
                        scoped_diffs: true,
                        compact_reviewer_output: true
                    },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        };

        const result = validateAgainstSchema(profiles, profilesSchema);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some((error) => error.path.includes('review_dependency_graph')));
    });

    const compatibilityScenarios = [
        {
            mode: 'parallel_all',
            dependencies: { code: [], security: [], api: [], test: [] },
            batches: [['code', 'security', 'api', 'test']]
        },
        {
            mode: 'test_after_code',
            dependencies: { code: [], security: [], api: [], test: ['code'] },
            batches: [['code', 'security', 'api'], ['test']]
        },
        {
            mode: 'code_first_optional',
            dependencies: { code: [], security: [], api: ['code'], test: ['code', 'security', 'api'] },
            batches: [['code', 'security'], ['api'], ['test']]
        },
        {
            mode: 'strict_sequential',
            dependencies: {
                code: [],
                security: ['code'],
                api: ['code', 'security'],
                test: ['code', 'security', 'api']
            },
            batches: [['code'], ['security'], ['api'], ['test']]
        }
    ] as const;

    for (const scenario of compatibilityScenarios) {
        it(`keeps ${scenario.mode} compiled-graph compatibility behavior-equivalent`, () => {
            const graph = compileReviewDependencyGraph({
                catalogLaneIds: BUILT_IN_LANES,
                activeLaneIds: BUILT_IN_LANES,
                requiredReviewIds: ['code', 'security', 'api', 'test'],
                mode: scenario.mode
            });

            assert.equal(graph.source, 'compatibility_mode');
            assert.deepEqual(graph.preparation_order, ['code', 'security', 'api', 'test']);
            assert.deepEqual(graph.dependencies, scenario.dependencies);
            assert.deepEqual(graph.preparation_batches, scenario.batches);
            assert.deepEqual(getCompiledReviewDependencyGraphViolations(graph), []);
        });
    }

    it('compiles a custom lane dependency from a complete active profile declaration', () => {
        const graph = compileReviewDependencyGraph({
            catalogLaneIds: [...BUILT_IN_LANES, 'architecture-boundary'],
            activeLaneIds: ['code', 'security', 'test', 'architecture-boundary'],
            requiredReviewIds: ['code', 'architecture-boundary', 'test'],
            mode: 'parallel_all',
            declaration: {
                preparation_order: ['code', 'security', 'architecture-boundary', 'test'],
                dependencies: {
                    'architecture-boundary': ['code'],
                    test: ['architecture-boundary']
                }
            }
        });

        assert.equal(graph.source, 'profile');
        assert.deepEqual(graph.nodes, ['code', 'architecture-boundary', 'test']);
        assert.deepEqual(graph.dependencies, {
            code: [],
            'architecture-boundary': ['code'],
            test: ['architecture-boundary']
        });
        assert.deepEqual(graph.preparation_batches, [['code'], ['architecture-boundary'], ['test']]);
        assert.deepEqual(resolveReviewDependencyDownstreamReachability(graph, ['code']), {
            seed_review_ids: ['code'],
            affected_review_ids: ['code', 'architecture-boundary', 'test']
        });
        assert.deepEqual(resolveReviewDependencyDownstreamReachability(graph, ['architecture-boundary']), {
            seed_review_ids: ['architecture-boundary'],
            affected_review_ids: ['architecture-boundary', 'test']
        });
        assert.deepEqual(resolveReviewDependencyDownstreamReachability(graph, ['test']), {
            seed_review_ids: ['test'],
            affected_review_ids: ['test']
        });
        assert.throws(
            () => resolveReviewDependencyDownstreamReachability(graph, ['security']),
            /missing from the frozen graph: security/u
        );
        assert.deepEqual(getReviewDependencyTimelineOrderViolations(graph, [
            { event_type: 'COMPILE_GATE_PASSED', sequence: 1, details: {} },
            { event_type: 'REVIEW_PHASE_STARTED', sequence: 2, details: { review_type: 'architecture-boundary' } },
            { event_type: 'REVIEW_RECORDED', sequence: 3, details: { review_type: 'code' } },
            { event_type: 'REVIEW_PHASE_STARTED', sequence: 4, details: { review_type: 'test' } },
            { event_type: 'REVIEW_RECORDED', sequence: 5, details: { review_type: 'architecture-boundary' } }
        ]), [
            {
                code: 'downstream_started_early',
                downstream_review_id: 'architecture-boundary',
                upstream_review_id: 'code',
                downstream_phase_sequence: 2,
                upstream_record_sequence: 3
            },
            {
                code: 'downstream_started_early',
                downstream_review_id: 'test',
                upstream_review_id: 'architecture-boundary',
                downstream_phase_sequence: 4,
                upstream_record_sequence: 5
            }
        ]);
    });

    it('rejects a late reuse rebind that was not accepted before downstream review started', () => {
        const graph = compileReviewDependencyGraph({
            catalogLaneIds: ['code', 'architecture-boundary'],
            activeLaneIds: ['code', 'architecture-boundary'],
            requiredReviewIds: ['code', 'architecture-boundary'],
            mode: 'parallel_all',
            declaration: {
                preparation_order: ['code', 'architecture-boundary'],
                dependencies: { 'architecture-boundary': ['code'] }
            }
        });

        assert.deepEqual(getReviewDependencyTimelineOrderViolations(graph, [
            { event_type: 'REVIEW_RECORDED', sequence: 4, details: { review_type: 'code' } },
            { event_type: 'COMPILE_GATE_PASSED', sequence: 10, details: {} },
            { event_type: 'REVIEW_PHASE_STARTED', sequence: 11, details: { review_type: 'architecture-boundary' } },
            {
                event_type: 'REVIEW_RECORDED',
                sequence: 12,
                details: { review_type: 'code', reused_existing_review: true }
            }
        ]), [{
            code: 'downstream_started_early',
            downstream_review_id: 'architecture-boundary',
            upstream_review_id: 'code',
            downstream_phase_sequence: 11,
            upstream_record_sequence: 12
        }]);
    });

    it('rejects downstream review ordering when the latest upstream result has blocking findings', () => {
        const graph = compileReviewDependencyGraph({
            catalogLaneIds: ['code', 'architecture-boundary'],
            activeLaneIds: ['code', 'architecture-boundary'],
            requiredReviewIds: ['code', 'architecture-boundary'],
            mode: 'parallel_all',
            declaration: {
                preparation_order: ['code', 'architecture-boundary'],
                dependencies: { 'architecture-boundary': ['code'] }
            }
        });

        assert.deepEqual(getReviewDependencyTimelineOrderViolations(graph, [
            { event_type: 'COMPILE_GATE_PASSED', sequence: 1, details: {} },
            {
                event_type: 'REVIEW_RECORDED',
                sequence: 2,
                details: {
                    review_type: 'code',
                    review_findings_disposition: {
                        blocking_count: 1,
                        verdict: 'fail_for_fix_now'
                    }
                }
            },
            { event_type: 'REVIEW_PHASE_STARTED', sequence: 3, details: { review_type: 'architecture-boundary' } }
        ]), [{
            code: 'unaccepted_upstream_record',
            downstream_review_id: 'architecture-boundary',
            upstream_review_id: 'code',
            downstream_phase_sequence: 3,
            upstream_record_sequence: 2
        }]);
    });

    it('selects latest timeline evidence by task sequence instead of array order', () => {
        const graph = compileReviewDependencyGraph({
            catalogLaneIds: ['code', 'architecture-boundary'],
            activeLaneIds: ['code', 'architecture-boundary'],
            requiredReviewIds: ['code', 'architecture-boundary'],
            mode: 'parallel_all',
            declaration: {
                preparation_order: ['code', 'architecture-boundary'],
                dependencies: { 'architecture-boundary': ['code'] }
            }
        });

        assert.deepEqual(getReviewDependencyTimelineOrderViolations(graph, [
            { event_type: 'COMPILE_GATE_PASSED', sequence: 1, details: {} },
            { event_type: 'REVIEW_RECORDED', sequence: 4, details: { review_type: 'code' } },
            { event_type: 'REVIEW_PHASE_STARTED', sequence: 3, details: { review_type: 'architecture-boundary' } },
            { event_type: 'REVIEW_RECORDED', sequence: 2, details: { review_type: 'code' } }
        ]), [{
            code: 'downstream_started_early',
            downstream_review_id: 'architecture-boundary',
            upstream_review_id: 'code',
            downstream_phase_sequence: 3,
            upstream_record_sequence: 4
        }]);
    });

    it('retains an earlier current-cycle ordering violation after a later valid phase starts', () => {
        const graph = compileReviewDependencyGraph({
            catalogLaneIds: ['code', 'architecture-boundary'],
            activeLaneIds: ['code', 'architecture-boundary'],
            requiredReviewIds: ['code', 'architecture-boundary'],
            mode: 'parallel_all',
            declaration: {
                preparation_order: ['code', 'architecture-boundary'],
                dependencies: { 'architecture-boundary': ['code'] }
            }
        });

        assert.deepEqual(getReviewDependencyTimelineOrderViolations(graph, [
            { event_type: 'COMPILE_GATE_PASSED', sequence: 1, details: {} },
            { event_type: 'REVIEW_PHASE_STARTED', sequence: 2, details: { review_type: 'architecture-boundary' } },
            { event_type: 'REVIEW_RECORDED', sequence: 3, details: { review_type: 'code' } },
            { event_type: 'REVIEW_PHASE_STARTED', sequence: 4, details: { review_type: 'architecture-boundary' } }
        ]), [{
            code: 'downstream_started_early',
            downstream_review_id: 'architecture-boundary',
            upstream_review_id: 'code',
            downstream_phase_sequence: 2,
            upstream_record_sequence: 3
        }]);
    });

    it('does not carry a remediated dependency-order violation across compile cycles', () => {
        const graph = compileReviewDependencyGraph({
            catalogLaneIds: ['code', 'architecture-boundary'],
            activeLaneIds: ['code', 'architecture-boundary'],
            requiredReviewIds: ['code', 'architecture-boundary'],
            mode: 'parallel_all',
            declaration: {
                preparation_order: ['code', 'architecture-boundary'],
                dependencies: { 'architecture-boundary': ['code'] }
            }
        });

        assert.deepEqual(getReviewDependencyTimelineOrderViolations(graph, [
            { event_type: 'REVIEW_PHASE_STARTED', sequence: 1, details: { review_type: 'architecture-boundary' } },
            { event_type: 'COMPILE_GATE_PASSED', sequence: 2, details: {} },
            { event_type: 'REVIEW_RECORDED', sequence: 3, details: { review_type: 'code' } },
            { event_type: 'REVIEW_PHASE_STARTED', sequence: 4, details: { review_type: 'architecture-boundary' } }
        ]), []);
    });

    it('does not carry superseded prepared phases across a review-cycle restart', () => {
        const graph = compileReviewDependencyGraph({
            catalogLaneIds: [...BUILT_IN_LANES, 'architecture-boundary'],
            activeLaneIds: ['code', 'architecture-boundary'],
            requiredReviewIds: ['code', 'architecture-boundary'],
            mode: 'parallel_all',
            declaration: {
                preparation_order: ['code', 'architecture-boundary'],
                dependencies: { 'architecture-boundary': ['code'] }
            }
        });

        assert.deepEqual(getReviewDependencyTimelineOrderViolations(graph, [
            { event_type: 'COMPILE_GATE_PASSED', sequence: 1, details: {} },
            { event_type: 'REVIEW_PHASE_STARTED', sequence: 2, details: { review_type: 'architecture-boundary' } },
            { event_type: 'REVIEW_CYCLE_RESTARTED', sequence: 3, details: {} },
            { event_type: 'REVIEW_PHASE_STARTED', sequence: 4, details: { review_type: 'code' } },
            { event_type: 'REVIEW_RECORDED', sequence: 5, details: { review_type: 'code' } },
            { event_type: 'REVIEW_PHASE_STARTED', sequence: 6, details: { review_type: 'architecture-boundary' } }
        ]), []);
    });

    it('injects full-suite placement as a gate barrier instead of a review lane', () => {
        const graph = compileReviewDependencyGraph({
            catalogLaneIds: BUILT_IN_LANES,
            activeLaneIds: BUILT_IN_LANES,
            requiredReviewIds: ['code', 'test'],
            mode: 'test_after_code',
            fullSuiteValidation: { enabled: true, placement: 'before_test_review' }
        });

        assert.deepEqual(graph.full_suite_barrier, {
            enabled: true,
            placement: 'before_test_review',
            before_review_ids: ['test']
        });
        assert.ok(!graph.nodes.includes('full-suite-validation'));
        assert.throws(
            () => normalizeReviewDependencyGraphDeclaration({
                preparation_order: ['code', 'full-suite-validation'],
                dependencies: {}
            }),
            /gate-owned 'full-suite-validation'/u
        );
    });

    it('rejects cycles, self-edges, duplicate edges, and contradictory order', () => {
        assert.throws(
            () => normalizeReviewDependencyGraphDeclaration({
                preparation_order: ['code', 'test'],
                dependencies: { code: ['test'], test: ['code'] }
            }),
            /contains a cycle/u
        );
        assert.throws(
            () => normalizeReviewDependencyGraphDeclaration({
                preparation_order: ['code'],
                dependencies: { code: ['code'] }
            }),
            /self-edge/u
        );
        assert.throws(
            () => normalizeReviewDependencyGraphDeclaration({
                preparation_order: ['code', 'test'],
                dependencies: { test: ['code', 'code'] }
            }),
            /duplicate review lane 'code'/u
        );
        assert.throws(
            () => normalizeReviewDependencyGraphDeclaration({
                preparation_order: ['test', 'code'],
                dependencies: { test: ['code'] }
            }),
            /ambiguous or contradicts dependency/u
        );
    });

    it('rejects missing, disabled, and impossible required dependencies', () => {
        assert.throws(
            () => compileReviewDependencyGraph({
                catalogLaneIds: BUILT_IN_LANES,
                activeLaneIds: ['code', 'test'],
                requiredReviewIds: ['code', 'test'],
                mode: 'parallel_all',
                declaration: {
                    preparation_order: ['code'],
                    dependencies: {}
                }
            }),
            /missing active review lane 'test'/u
        );
        assert.throws(
            () => compileReviewDependencyGraph({
                catalogLaneIds: BUILT_IN_LANES,
                activeLaneIds: ['code', 'test'],
                requiredReviewIds: ['code', 'test'],
                mode: 'parallel_all',
                declaration: {
                    preparation_order: ['code', 'security', 'test'],
                    dependencies: {}
                }
            }),
            /disabled review lane 'security'/u
        );
        assert.throws(
            () => compileReviewDependencyGraph({
                catalogLaneIds: BUILT_IN_LANES,
                activeLaneIds: ['code', 'test'],
                requiredReviewIds: ['test'],
                mode: 'parallel_all',
                declaration: {
                    preparation_order: ['code', 'test'],
                    dependencies: { test: ['code'] }
                }
            }),
            /depends on non-required lane 'code'/u
        );
    });

    it('detects graph tampering through the graph hash', () => {
        const graph = compileReviewDependencyGraph({
            catalogLaneIds: BUILT_IN_LANES,
            activeLaneIds: BUILT_IN_LANES,
            requiredReviewIds: ['code', 'test'],
            mode: 'test_after_code'
        });
        const forged = JSON.parse(JSON.stringify(graph)) as Record<string, unknown>;
        (forged.dependencies as Record<string, string[]>).test = [];

        assert.ok(getCompiledReviewDependencyGraphViolations(forged).some((violation) => (
            violation.includes('hash mismatch')
        )));
    });

    it('rejects graph removal whenever the frozen task contract requires it', () => {
        assert.throws(
            () => resolveCompiledReviewDependencyGraphFromPreflight({
                review_execution_policy: { mode: 'strict_sequential' }
            }, 'strict_sequential', null, true),
            /required by the frozen task profile policy/u
        );
    });
});

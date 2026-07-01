import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    validateReviewArtifactGateEligibility,
} from '../../../../src/gates/required-reviews/required-reviews-check';


describe('gates/required-reviews-check', () => {
    describe('validateReviewArtifactGateEligibility', () => {

        it('rejects current receipts whose reviewer invocation telemetry has a different tree-state binding', () => {
            const contextSha = '1'.repeat(64);
            const treeStateSha = '2'.repeat(64);
            const otherTreeStateSha = '3'.repeat(64);
            const routingEventSha = '4'.repeat(64);
            const invocationEventSha = '5'.repeat(64);
            const artifactSha = '6'.repeat(64);
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-362',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-362-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'explicit_provider',
                timelineEvents: [
                    { event_type: 'COMPILE_GATE_PASSED', sequence: 0, details: {}, integrity: null },
                    { event_type: 'REVIEW_PHASE_STARTED', sequence: 1, details: { review_type: 'code' }, integrity: null },
                    {
                        event_type: 'REVIEWER_DELEGATION_ROUTED',
                        sequence: 2,
                        details: {
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 10,
                            prev_event_sha256: null,
                            event_sha256: routingEventSha
                        }
                    },
                    {
                        event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        sequence: 3,
                        details: {
                            task_id: 'T-362',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: contextSha,
                            review_tree_state_sha256: otherTreeStateSha,
                            routing_event_sha256: routingEventSha
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 11,
                            prev_event_sha256: routingEventSha,
                            event_sha256: invocationEventSha
                        }
                    }
                ],
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-362-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated current receipt tree-state binding with concrete implementation detail and a non-trivial receipt fixture.',
                        '',
                        '## Findings by Severity',
                        'none',
                        '',
                        '## Residual Risks',
                        'none',
                        '',
                        '## Verdict',
                        'REVIEW PASSED'
                    ].join('\n'),
                    reviewContextPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-362-code-review-context.json',
                    reviewContext: {
                        schema_version: 2,
                        task_id: 'T-362',
                        review_type: 'code',
                        preflight_path: '/repo/garda-agent-orchestrator/runtime/reviews/T-362-preflight.json',
                        preflight_sha256: 'abc123',
                        tree_state: {
                            tree_state_sha256: treeStateSha
                        },
                        reviewer_routing: {
                            source_of_truth: 'Codex',
                            canonical_source_of_truth: 'Codex',
                            execution_provider: 'Codex',
                            execution_provider_source: 'explicit_provider',
                            identity_status: 'resolved',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        }
                    },
                    reviewContextSha256: contextSha,
                    artifactSha256: artifactSha,
                    receipt: {
                        schema_version: 2,
                        task_id: 'T-362',
                        review_type: 'code',
                        preflight_sha256: 'abc123',
                        scope_sha256: null,
                        review_context_sha256: contextSha,
                        review_tree_state_sha256: treeStateSha,
                        review_artifact_sha256: artifactSha,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        reviewer_provenance: {
                            schema_version: 1,
                            attestation_type: 'reviewer_invocation_attestation',
                            controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                            task_sequence: 11,
                            prev_event_sha256: routingEventSha,
                            event_sha256: invocationEventSha,
                            task_id: 'T-362',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: contextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: routingEventSha
                        },
                        trust_level: 'INDEPENDENT_AUDITED',
                        recorded_at_utc: '2026-05-02T00:00:00.000Z'
                    }
                }
            });

            assert.ok(result.violations.some((violation) => (
                violation.includes('reviewer_provenance does not match REVIEWER_INVOCATION_ATTESTED launch telemetry')
            )));
        });

        it('rejects current receipts whose reviewer provenance context binding diverges from the receipt', () => {
            const currentContextSha = '1'.repeat(64);
            const treeStateSha = '2'.repeat(64);
            const staleContextSha = '3'.repeat(64);
            const routingEventSha = '4'.repeat(64);
            const invocationEventSha = '5'.repeat(64);
            const artifactSha = '6'.repeat(64);
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-883',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-883-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'explicit_provider',
                timelineEvents: [
                    { event_type: 'COMPILE_GATE_PASSED', sequence: 0, details: {}, integrity: null },
                    { event_type: 'REVIEW_PHASE_STARTED', sequence: 1, details: { review_type: 'code' }, integrity: null },
                    {
                        event_type: 'REVIEWER_DELEGATION_ROUTED',
                        sequence: 2,
                        details: {
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 10,
                            prev_event_sha256: null,
                            event_sha256: routingEventSha
                        }
                    },
                    {
                        event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        sequence: 3,
                        details: {
                            task_id: 'T-883',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: staleContextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: routingEventSha
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 11,
                            prev_event_sha256: routingEventSha,
                            event_sha256: invocationEventSha
                        }
                    }
                ],
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-883-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated provenance context binding with concrete implementation detail and a non-trivial receipt fixture.',
                        '',
                        '## Findings by Severity',
                        'none',
                        '',
                        '## Residual Risks',
                        'none',
                        '',
                        '## Verdict',
                        'REVIEW PASSED'
                    ].join('\n'),
                    reviewContextPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-883-code-review-context.json',
                    reviewContext: {
                        schema_version: 2,
                        task_id: 'T-883',
                        review_type: 'code',
                        preflight_path: '/repo/garda-agent-orchestrator/runtime/reviews/T-883-preflight.json',
                        preflight_sha256: 'abc123',
                        tree_state: {
                            tree_state_sha256: treeStateSha
                        },
                        reviewer_routing: {
                            source_of_truth: 'Codex',
                            canonical_source_of_truth: 'Codex',
                            execution_provider: 'Codex',
                            execution_provider_source: 'explicit_provider',
                            identity_status: 'resolved',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        }
                    },
                    reviewContextSha256: currentContextSha,
                    artifactSha256: artifactSha,
                    receipt: {
                        schema_version: 2,
                        task_id: 'T-883',
                        review_type: 'code',
                        preflight_sha256: 'abc123',
                        scope_sha256: null,
                        review_context_sha256: currentContextSha,
                        review_tree_state_sha256: treeStateSha,
                        review_artifact_sha256: artifactSha,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        reviewer_provenance: {
                            schema_version: 1,
                            attestation_type: 'reviewer_invocation_attestation',
                            controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                            task_sequence: 11,
                            prev_event_sha256: routingEventSha,
                            event_sha256: invocationEventSha,
                            task_id: 'T-883',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: staleContextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: routingEventSha
                        },
                        trust_level: 'INDEPENDENT_AUDITED',
                        recorded_at_utc: '2026-07-01T00:00:00.000Z'
                    }
                }
            });

            assert.ok(result.violations.some((violation) => (
                violation.includes('reviewer_provenance does not match REVIEWER_INVOCATION_ATTESTED launch telemetry')
            )), JSON.stringify(result, null, 2));
        });

        it('rejects current receipts whose timing provenance diverges from invocation telemetry', () => {
            const contextSha = '1'.repeat(64);
            const treeStateSha = '2'.repeat(64);
            const routingEventSha = '4'.repeat(64);
            const invocationEventSha = '5'.repeat(64);
            const artifactSha = '6'.repeat(64);
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-564-1',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-564-1-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'explicit_provider',
                timelineEvents: [
                    { event_type: 'COMPILE_GATE_PASSED', sequence: 0, details: {}, integrity: null },
                    { event_type: 'REVIEW_PHASE_STARTED', sequence: 1, details: { review_type: 'code' }, integrity: null },
                    {
                        event_type: 'REVIEWER_DELEGATION_ROUTED',
                        sequence: 2,
                        details: {
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 10,
                            prev_event_sha256: null,
                            event_sha256: routingEventSha
                        }
                    },
                    {
                        event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        sequence: 3,
                        details: {
                            task_id: 'T-564-1',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: contextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: routingEventSha,
                            launch_prepared_at_utc: '2026-05-17T21:00:00.000Z',
                            launched_at_utc: '2026-05-17T21:00:01.000Z',
                            launch_completed_at_utc: '2026-05-17T21:00:02.000Z',
                            invocation_attested_at_utc: '2026-05-17T21:00:03.000Z'
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 11,
                            prev_event_sha256: routingEventSha,
                            event_sha256: invocationEventSha
                        }
                    }
                ],
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-564-1-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated current receipt timing provenance binding with concrete implementation detail and a non-trivial receipt fixture.',
                        '',
                        '## Findings by Severity',
                        'none',
                        '',
                        '## Residual Risks',
                        'none',
                        '',
                        '## Verdict',
                        'REVIEW PASSED'
                    ].join('\n'),
                    reviewContextPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-564-1-code-review-context.json',
                    reviewContext: {
                        schema_version: 2,
                        task_id: 'T-564-1',
                        review_type: 'code',
                        preflight_path: '/repo/garda-agent-orchestrator/runtime/reviews/T-564-1-preflight.json',
                        preflight_sha256: 'abc123',
                        tree_state: {
                            tree_state_sha256: treeStateSha
                        },
                        reviewer_routing: {
                            source_of_truth: 'Codex',
                            canonical_source_of_truth: 'Codex',
                            execution_provider: 'Codex',
                            execution_provider_source: 'explicit_provider',
                            identity_status: 'resolved',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        }
                    },
                    reviewContextSha256: contextSha,
                    artifactSha256: artifactSha,
                    receipt: {
                        schema_version: 2,
                        task_id: 'T-564-1',
                        review_type: 'code',
                        preflight_sha256: 'abc123',
                        scope_sha256: null,
                        review_context_sha256: contextSha,
                        review_tree_state_sha256: treeStateSha,
                        review_artifact_sha256: artifactSha,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        reviewer_provenance: {
                            schema_version: 1,
                            attestation_type: 'reviewer_invocation_attestation',
                            controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                            task_sequence: 11,
                            prev_event_sha256: routingEventSha,
                            event_sha256: invocationEventSha,
                            task_id: 'T-564-1',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: contextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: routingEventSha,
                            launch_prepared_at_utc: '2026-05-17T21:00:00.000Z',
                            launched_at_utc: '2026-05-17T21:00:01.000Z',
                            launch_completed_at_utc: '2026-05-17T21:00:59.000Z',
                            invocation_attested_at_utc: '2026-05-17T21:00:03.000Z'
                        },
                        trust_level: 'INDEPENDENT_AUDITED',
                        recorded_at_utc: '2026-05-17T21:01:00.000Z'
                    }
                }
            });

            assert.ok(result.violations.some((violation) => (
                violation.includes('reviewer_provenance does not match REVIEWER_INVOCATION_ATTESTED launch telemetry')
            )));
        });

        it('rejects receipts when latest current routing telemetry conflicts with the review context', () => {
            const contextSha = '1'.repeat(64);
            const treeStateSha = '2'.repeat(64);
            const originalRoutingEventSha = '3'.repeat(64);
            const lateRoutingEventSha = '4'.repeat(64);
            const invocationEventSha = '5'.repeat(64);
            const artifactSha = '6'.repeat(64);
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-574',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-574-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'explicit_provider',
                timelineEvents: [
                    { event_type: 'COMPILE_GATE_PASSED', sequence: 0, details: {}, integrity: null },
                    { event_type: 'REVIEW_PHASE_STARTED', sequence: 1, details: { review_type: 'code' }, integrity: null },
                    {
                        event_type: 'REVIEWER_DELEGATION_ROUTED',
                        sequence: 2,
                        details: {
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:original-reviewer'
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 10,
                            prev_event_sha256: null,
                            event_sha256: originalRoutingEventSha
                        }
                    },
                    {
                        event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        sequence: 3,
                        details: {
                            task_id: 'T-574',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:original-reviewer',
                            review_context_sha256: contextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: originalRoutingEventSha
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 11,
                            prev_event_sha256: originalRoutingEventSha,
                            event_sha256: invocationEventSha
                        }
                    },
                    {
                        event_type: 'REVIEWER_DELEGATION_ROUTED',
                        sequence: 4,
                        details: {
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:late-reviewer'
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 12,
                            prev_event_sha256: invocationEventSha,
                            event_sha256: lateRoutingEventSha
                        }
                    }
                ],
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-574-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated review gate provenance parity with completion using concrete late-routing telemetry and receipt provenance evidence.',
                        '',
                        '## Findings by Severity',
                        'none',
                        '',
                        '## Residual Risks',
                        'none',
                        '',
                        '## Verdict',
                        'REVIEW PASSED'
                    ].join('\n'),
                    reviewContextPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-574-code-review-context.json',
                    reviewContext: {
                        schema_version: 2,
                        task_id: 'T-574',
                        review_type: 'code',
                        preflight_path: '/repo/garda-agent-orchestrator/runtime/reviews/T-574-preflight.json',
                        preflight_sha256: 'abc123',
                        tree_state: {
                            tree_state_sha256: treeStateSha
                        },
                        reviewer_routing: {
                            source_of_truth: 'Codex',
                            canonical_source_of_truth: 'Codex',
                            execution_provider: 'Codex',
                            execution_provider_source: 'explicit_provider',
                            identity_status: 'resolved',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:original-reviewer'
                        }
                    },
                    reviewContextSha256: contextSha,
                    artifactSha256: artifactSha,
                    receipt: {
                        schema_version: 2,
                        task_id: 'T-574',
                        review_type: 'code',
                        preflight_sha256: 'abc123',
                        scope_sha256: null,
                        review_context_sha256: contextSha,
                        review_tree_state_sha256: treeStateSha,
                        review_artifact_sha256: artifactSha,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:original-reviewer',
                        reviewer_fallback_reason: null,
                        reviewer_provenance: {
                            schema_version: 1,
                            attestation_type: 'reviewer_invocation_attestation',
                            controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                            task_sequence: 11,
                            prev_event_sha256: originalRoutingEventSha,
                            event_sha256: invocationEventSha,
                            task_id: 'T-574',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:original-reviewer',
                            review_context_sha256: contextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: originalRoutingEventSha
                        },
                        trust_level: 'INDEPENDENT_AUDITED',
                        recorded_at_utc: '2026-05-18T00:00:00.000Z'
                    }
                }
            });

            assert.ok(result.violations.some((violation) => (
                violation.includes('inconsistent reviewer identity between REVIEWER_DELEGATION_ROUTED telemetry') &&
                violation.includes('agent:late-reviewer') &&
                violation.includes('agent:original-reviewer')
            )));
        });

        it('rejects hidden timing distrust with generic remediation only', () => {
            const contextSha = '1'.repeat(64);
            const treeStateSha = '2'.repeat(64);
            const routingEventSha = '4'.repeat(64);
            const invocationEventSha = '5'.repeat(64);
            const artifactSha = '6'.repeat(64);
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-564-1',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-564-1-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'explicit_provider',
                timelineEvents: [
                    { event_type: 'COMPILE_GATE_PASSED', sequence: 0, details: {}, integrity: null },
                    {
                        event_type: 'REVIEWER_DELEGATION_ROUTED',
                        sequence: 1,
                        details: {
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 10,
                            prev_event_sha256: null,
                            event_sha256: routingEventSha
                        }
                    },
                    {
                        event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        sequence: 2,
                        details: {
                            task_id: 'T-564-1',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: contextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: routingEventSha,
                            launch_prepared_at_utc: '2026-05-17T21:00:00.000Z',
                            launched_at_utc: '2026-05-17T21:00:01.000Z',
                            launch_completed_at_utc: '2026-05-17T21:00:02.000Z',
                            invocation_attested_at_utc: '2026-05-17T21:00:03.000Z',
                            provider_invocation_id: 'provider-run-required',
                            reviewer_launch_attestation_source: 'codex.spawn_agent'
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 11,
                            prev_event_sha256: routingEventSha,
                            event_sha256: invocationEventSha
                        }
                    }
                ],
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-564-1-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated hidden timing distrust acceptance surface with concrete implementation detail and a non-trivial receipt fixture.',
                        '',
                        '## Findings by Severity',
                        'none',
                        '',
                        '## Residual Risks',
                        'none',
                        '',
                        '## Verdict',
                        'REVIEW PASSED'
                    ].join('\n'),
                    reviewContextPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-564-1-code-review-context.json',
                    reviewContext: {
                        schema_version: 2,
                        task_id: 'T-564-1',
                        review_type: 'code',
                        preflight_path: '/repo/garda-agent-orchestrator/runtime/reviews/T-564-1-preflight.json',
                        preflight_sha256: 'abc123',
                        tree_state: {
                            tree_state_sha256: treeStateSha
                        },
                        reviewer_routing: {
                            source_of_truth: 'Codex',
                            canonical_source_of_truth: 'Codex',
                            execution_provider: 'Codex',
                            execution_provider_source: 'explicit_provider',
                            identity_status: 'resolved',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        }
                    },
                    reviewContextSha256: contextSha,
                    artifactSha256: artifactSha,
                    receipt: {
                        schema_version: 2,
                        task_id: 'T-564-1',
                        review_type: 'code',
                        preflight_sha256: 'abc123',
                        scope_sha256: null,
                        review_context_sha256: contextSha,
                        review_tree_state_sha256: treeStateSha,
                        review_artifact_sha256: artifactSha,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        reviewer_provenance: {
                            schema_version: 1,
                            attestation_type: 'reviewer_invocation_attestation',
                            controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                            task_sequence: 11,
                            prev_event_sha256: routingEventSha,
                            event_sha256: invocationEventSha,
                            task_id: 'T-564-1',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: contextSha,
                            review_tree_state_sha256: treeStateSha,
                            routing_event_sha256: routingEventSha,
                            launch_prepared_at_utc: '2026-05-17T21:00:00.000Z',
                            launched_at_utc: '2026-05-17T21:00:01.000Z',
                            launch_completed_at_utc: '2026-05-17T21:00:02.000Z',
                            invocation_attested_at_utc: '2026-05-17T21:00:03.000Z'
                        },
                        trust_level: 'INDEPENDENT_AUDITED',
                        reused_existing_review: false,
                        recorded_at_utc: '2026-05-17T21:01:00.000Z',
                        review_result_recorded_at_utc: '2026-05-17T21:01:00.000Z',
                        review_output_source_mtime_utc: '2026-05-17T20:59:59.000Z'
                    }
                }
            });

            const hiddenViolation = result.violations.find((violation) => (
                violation.includes("Review receipt for 'code' is not sufficiently trustworthy")
            ));
            assert.ok(hiddenViolation, JSON.stringify(result, null, 2));
            assert.match(hiddenViolation, /Launch a real subagent using built-in tools/);
            assert.equal(/timing|threshold|elapsed|duration|seconds|impossible_ordering|missing_timing/i.test(hiddenViolation), false);
        });


    });

});

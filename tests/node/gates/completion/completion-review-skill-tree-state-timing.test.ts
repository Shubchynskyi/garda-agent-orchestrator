import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateReviewSkillEvidence } from '../../../../src/gates/completion';

import { makeTimelineEvent } from './completion-stage-evidence-fixtures';

describe('gates/completion — stage and evidence validation', () => {
    describe('validateReviewSkillEvidence', () => {

        it('fails fresh review receipts that omit review tree-state provenance at completion', () => {

            const contextSha = '1'.repeat(64);

            const treeStateSha = '2'.repeat(64);

            const routingEventSha = '3'.repeat(64);

            const invocationEventSha = '4'.repeat(64);

            const artifactSha = '5'.repeat(64);

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'code' }),

                makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer'

                }, {

                    schema_version: 1,

                    task_sequence: 10,

                    prev_event_sha256: null,

                    event_sha256: routingEventSha

                }),

                makeTimelineEvent('REVIEWER_INVOCATION_ATTESTED', 5, {

                    task_id: 'T-123',

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer',

                    reviewer_identity: 'agent:code-reviewer',

                    review_context_sha256: contextSha,

                    routing_event_sha256: routingEventSha

                }, {

                    schema_version: 1,

                    task_sequence: 11,

                    prev_event_sha256: routingEventSha,

                    event_sha256: invocationEventSha

                }),

                makeTimelineEvent('REVIEW_RECORDED', 6, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 7)

            ];

            const result = validateReviewSkillEvidence(

                events,

                { code: true },

                {

                    code: {

                        path: '/reviews/T-123-code.md',

                        reviewContext: {

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

                        receipt: {

                            schema_version: 2,

                            task_id: 'T-123',

                            review_type: 'code',

                            preflight_sha256: null,

                            scope_sha256: null,

                            review_context_sha256: contextSha,

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

                                task_id: 'T-123',

                                review_type: 'code',

                                reviewer_execution_mode: 'delegated_subagent',

                                reviewer_identity: 'agent:code-reviewer',

                                review_context_sha256: contextSha,

                                routing_event_sha256: routingEventSha

                            },

                            trust_level: 'INDEPENDENT_AUDITED',

                            reused_existing_review: false,

                            recorded_at_utc: '2026-01-01T00:00:00.000Z'

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Codex',

                'Codex',

                false,

                'explicit_provider'

            );


            assert.ok(result.violations.some((violation) => (

                violation.includes("Required review 'code' receipt is missing review_tree_state_sha256")

            )), JSON.stringify(result, null, 2));

            assert.ok(result.violations.some((violation) => (

                violation.includes("Required review 'code' receipt reviewer_provenance is missing review_tree_state_sha256")

            )), JSON.stringify(result, null, 2));

        });


        it('fails fresh review receipts whose timing provenance diverges from invocation telemetry at completion', () => {

            const contextSha = '1'.repeat(64);

            const treeStateSha = '2'.repeat(64);

            const routingEventSha = '3'.repeat(64);

            const invocationEventSha = '4'.repeat(64);

            const artifactSha = '5'.repeat(64);

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'code' }),

                makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer'

                }, {

                    schema_version: 1,

                    task_sequence: 10,

                    prev_event_sha256: null,

                    event_sha256: routingEventSha

                }),

                makeTimelineEvent('REVIEWER_INVOCATION_ATTESTED', 5, {

                    task_id: 'T-123',

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer',

                    reviewer_identity: 'agent:code-reviewer',

                    review_context_sha256: contextSha,

                    review_tree_state_sha256: treeStateSha,

                    routing_event_sha256: routingEventSha,

                    launch_prepared_at_utc: '2026-05-17T21:00:00.000Z',

                    launched_at_utc: '2026-05-17T21:00:01.000Z',

                    launch_completed_at_utc: '2026-05-17T21:00:02.000Z',

                    invocation_attested_at_utc: '2026-05-17T21:00:03.000Z'

                }, {

                    schema_version: 1,

                    task_sequence: 11,

                    prev_event_sha256: routingEventSha,

                    event_sha256: invocationEventSha

                }),

                makeTimelineEvent('REVIEW_RECORDED', 6, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 7)

            ];

            const result = validateReviewSkillEvidence(

                events,

                { code: true },

                {

                    code: {

                        path: '/reviews/T-123-code.md',

                        reviewContext: {

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

                        receipt: {

                            schema_version: 2,

                            task_id: 'T-123',

                            review_type: 'code',

                            preflight_sha256: null,

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

                                task_id: 'T-123',

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

                            reused_existing_review: false,

                            recorded_at_utc: '2026-01-01T00:00:00.000Z'

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Codex',

                'Codex',

                false,

                'explicit_provider'

            );


            assert.ok(result.violations.some((violation) => (

                violation.includes("Required review 'code' receipt reviewer_provenance does not match REVIEWER_INVOCATION_ATTESTED launch telemetry")

            )), JSON.stringify(result, null, 2));

        });


        it('fails hidden timing distrust at completion with generic remediation only', () => {

            const contextSha = '1'.repeat(64);

            const treeStateSha = '2'.repeat(64);

            const routingEventSha = '3'.repeat(64);

            const invocationEventSha = '4'.repeat(64);

            const artifactSha = '5'.repeat(64);

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'code' }),

                makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer'

                }, {

                    schema_version: 1,

                    task_sequence: 10,

                    prev_event_sha256: null,

                    event_sha256: routingEventSha

                }),

                makeTimelineEvent('REVIEWER_INVOCATION_ATTESTED', 5, {

                    task_id: 'T-123',

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer',

                    reviewer_identity: 'agent:code-reviewer',

                    review_context_sha256: contextSha,

                    review_tree_state_sha256: treeStateSha,

                    routing_event_sha256: routingEventSha,

                    launch_prepared_at_utc: '2026-05-17T21:00:00.000Z',

                    launched_at_utc: '2026-05-17T21:00:01.000Z',

                    launch_completed_at_utc: '2026-05-17T21:00:02.000Z',

                    invocation_attested_at_utc: '2026-05-17T21:00:03.000Z',

                    provider_invocation_id: 'provider-run-completion',

                    reviewer_launch_attestation_source: 'codex.spawn_agent'

                }, {

                    schema_version: 1,

                    task_sequence: 11,

                    prev_event_sha256: routingEventSha,

                    event_sha256: invocationEventSha

                }),

                makeTimelineEvent('REVIEW_RECORDED', 6, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 7)

            ];

            const result = validateReviewSkillEvidence(

                events,

                { code: true },

                {

                    code: {

                        path: '/reviews/T-123-code.md',

                        reviewContext: {

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

                        receipt: {

                            schema_version: 2,

                            task_id: 'T-123',

                            review_type: 'code',

                            preflight_sha256: null,

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

                                task_id: 'T-123',

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

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Codex',

                'Codex',

                false,

                'explicit_provider'

            );


            const hiddenViolation = result.violations.find((violation) => (

                violation.includes("Required review 'code' evidence is not sufficiently trustworthy")

            ));

            assert.ok(hiddenViolation, JSON.stringify(result, null, 2));

            assert.match(hiddenViolation, /Launch a real subagent using built-in tools/);

            assert.equal(/timing|threshold|elapsed|duration|seconds|impossible_ordering|missing_timing/i.test(hiddenViolation), false);

        });


        it('fails required review contexts that omit tree-state binding at completion', () => {

            const contextSha = '1'.repeat(64);

            const treeStateSha = '2'.repeat(64);

            const routingEventSha = '3'.repeat(64);

            const invocationEventSha = '4'.repeat(64);

            const artifactSha = '5'.repeat(64);

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'code' }),

                makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer'

                }, {

                    schema_version: 1,

                    task_sequence: 10,

                    prev_event_sha256: null,

                    event_sha256: routingEventSha

                }),

                makeTimelineEvent('REVIEWER_INVOCATION_ATTESTED', 5, {

                    task_id: 'T-123',

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer',

                    reviewer_identity: 'agent:code-reviewer',

                    review_context_sha256: contextSha,

                    review_tree_state_sha256: treeStateSha,

                    routing_event_sha256: routingEventSha

                }, {

                    schema_version: 1,

                    task_sequence: 11,

                    prev_event_sha256: routingEventSha,

                    event_sha256: invocationEventSha

                }),

                makeTimelineEvent('REVIEW_RECORDED', 6, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 7)

            ];

            const result = validateReviewSkillEvidence(

                events,

                { code: true },

                {

                    code: {

                        path: '/reviews/T-123-code.md',

                        reviewContext: {

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

                        receipt: {

                            schema_version: 2,

                            task_id: 'T-123',

                            review_type: 'code',

                            preflight_sha256: null,

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

                                task_id: 'T-123',

                                review_type: 'code',

                                reviewer_execution_mode: 'delegated_subagent',

                                reviewer_identity: 'agent:code-reviewer',

                                review_context_sha256: contextSha,

                                review_tree_state_sha256: treeStateSha,

                                routing_event_sha256: routingEventSha

                            },

                            trust_level: 'INDEPENDENT_AUDITED',

                            reused_existing_review: false,

                            recorded_at_utc: '2026-01-01T00:00:00.000Z'

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Codex',

                'Codex',

                false,

                'explicit_provider'

            );


            assert.ok(result.violations.some((violation) => (

                violation.includes("Required review 'code' review-context is missing tree_state.tree_state_sha256")

            )), JSON.stringify(result, null, 2));

        });

    });
});

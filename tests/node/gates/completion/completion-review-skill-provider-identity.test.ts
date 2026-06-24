import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateReviewSkillEvidence } from '../../../../src/gates/completion';

import { makeTimelineEvent } from './completion-stage-evidence-fixtures';

describe('gates/completion — stage and evidence validation', () => {
    describe('validateReviewSkillEvidence', () => {

        it('fails when the latest reviewer routing telemetry records a different reviewer identity', () => {

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1),

                makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:fresh-reviewer'

                }),

                makeTimelineEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 6),

                makeTimelineEvent('SKILL_SELECTED', 7, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 8, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 9, {

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:stale-reviewer'

                }),

                makeTimelineEvent('REVIEW_RECORDED', 10, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 11)

            ];

            const result = validateReviewSkillEvidence(

                events,

                { code: true },

                {

                    code: {

                        path: '/reviews/T-123-code.md',

                        reviewContext: {

                            reviewer_routing: {

                                actual_execution_mode: 'delegated_subagent',

                                reviewer_session_id: 'agent:fresh-reviewer'

                            }

                        },

                        receipt: {

                            schema_version: 2,

                            task_id: 'T-123',

                            review_type: 'code',

                            preflight_sha256: null,

                            scope_sha256: null,

                            review_context_sha256: null,

                            review_artifact_sha256: null,

                            reviewer_execution_mode: 'delegated_subagent',

                            reviewer_identity: 'agent:fresh-reviewer',

                            reviewer_fallback_reason: null,

                            recorded_at_utc: '2026-01-01T00:00:00.000Z'

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Codex'

            );


            assert.ok(result.violations.some((entry) => (

                entry.includes('REVIEWER_DELEGATION_ROUTED telemetry')

                && entry.includes('agent:stale-reviewer')

                && entry.includes('agent:fresh-reviewer')

            )));

        });


        it('fails when review-context omits canonical_source_of_truth for a required review', () => {

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1),

                makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer'

                }),

                makeTimelineEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 6)

            ];

            const result = validateReviewSkillEvidence(

                events,

                { code: true },

                {

                    code: {

                        path: '/reviews/T-123-code.md',

                        reviewContext: {

                            reviewer_routing: {

                                execution_provider: 'Codex',

                                identity_status: 'resolved',

                                actual_execution_mode: 'delegated_subagent',

                                reviewer_session_id: 'agent:code-reviewer'

                            }

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Codex',

                'Codex'

            );


            assert.ok(result.violations.some((entry) => entry.includes('missing canonical_source_of_truth')));

        });


        it('fails when review-context omits execution_provider_source for a required review', () => {

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1),

                makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer'

                }),

                makeTimelineEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 6)

            ];

            const result = validateReviewSkillEvidence(

                events,

                { code: true },

                {

                    code: {

                        path: '/reviews/T-123-code.md',

                        reviewContext: {

                            reviewer_routing: {

                                canonical_source_of_truth: 'Codex',

                                execution_provider: 'Codex',

                                identity_status: 'resolved',

                                actual_execution_mode: 'delegated_subagent',

                                reviewer_session_id: 'agent:code-reviewer'

                            }

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Codex',

                'Codex',

                false,

                'provider_entrypoint'

            );


            assert.ok(result.violations.some((entry) => entry.includes('missing execution_provider_source')));

        });


        it('fails when canonical SourceOfTruth is unavailable for required review validation', () => {

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1),

                makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer'

                }),

                makeTimelineEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 6)

            ];

            const result = validateReviewSkillEvidence(

                events,

                { code: true },

                {

                    code: {

                        path: '/reviews/T-123-code.md',

                        reviewContext: {

                            reviewer_routing: {

                                canonical_source_of_truth: 'Codex',

                                execution_provider: 'Codex',

                                identity_status: 'resolved',

                                actual_execution_mode: 'delegated_subagent',

                                reviewer_session_id: 'agent:code-reviewer'

                            }

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Codex',

                null

            );


            assert.ok(result.violations.some((entry) => entry.includes('missing canonical SourceOfTruth')));

        });


        it('fails when review-context omits execution_provider and identity_status for a required review', () => {

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1),

                makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer'

                }),

                makeTimelineEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 6)

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

                                actual_execution_mode: 'delegated_subagent',

                                reviewer_session_id: 'agent:code-reviewer'

                            }

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Codex',

                'Codex'

            );


            assert.ok(result.violations.some((entry) => entry.includes('missing execution_provider')));

            assert.ok(result.violations.some((entry) => entry.includes('missing identity_status')));

        });


        it('allows delegated_subagent for Qwen after fallback removal', () => {

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1),

                makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer'

                }),

                makeTimelineEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 6)

            ];

            const result = validateReviewSkillEvidence(

                events,

                { code: true },

                {

                    code: {

                        path: '/reviews/T-123-code.md',

                        reviewContext: {

                            reviewer_routing: {

                                source_of_truth: 'Antigravity',

                                canonical_source_of_truth: 'Codex',

                                execution_provider: 'Antigravity',

                                execution_provider_source: 'provider_bridge',

                                actual_execution_mode: 'delegated_subagent',

                                reviewer_session_id: 'agent:code-reviewer'

                            }

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Qwen'

            );


            assert.equal(result.violations.some(v =>

                v.includes('receipt cannot use delegated_subagent') && v.includes('Gemini')

            ), false);

        });


        it('fails when review-context uses an invalid reviewer execution mode', () => {

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1),

                makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer'

                }),

                makeTimelineEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 6)

            ];

            const result = validateReviewSkillEvidence(

                events,

                { code: true },

                {

                    code: {

                        path: '/reviews/T-123-code.md',

                        reviewContext: {

                            reviewer_routing: {

                                actual_execution_mode: 'delegated_magic',

                                reviewer_session_id: 'agent:code-reviewer'

                            }

                        },

                        receipt: {

                            schema_version: 2,

                            task_id: 'T-123',

                            review_type: 'code',

                            preflight_sha256: null,

                            scope_sha256: null,

                            review_context_sha256: null,

                            review_artifact_sha256: null,

                            reviewer_execution_mode: 'delegated_subagent',

                            reviewer_identity: 'agent:code-reviewer',

                            reviewer_fallback_reason: null,

                            recorded_at_utc: '2026-01-01T00:00:00.000Z'

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Codex'

            );


            assert.ok(result.violations.some((entry) => entry.includes('invalid reviewer_routing.actual_execution_mode')));

        });


        it('fails when receipt reviewer identity disagrees with review-context reviewer session', () => {

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1),

                makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer'

                }),

                makeTimelineEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 6)

            ];

            const result = validateReviewSkillEvidence(

                events,

                { code: true },

                {

                    code: {

                        path: '/reviews/T-123-code.md',

                        reviewContext: {

                            tree_state: {

                                tree_state_sha256: '1'.repeat(64)

                            },

                            reviewer_routing: {

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

                            review_context_sha256: null,

                            review_artifact_sha256: null,

                            reviewer_execution_mode: 'delegated_subagent',

                            reviewer_identity: 'agent:other-reviewer',

                            reviewer_fallback_reason: null,

                            recorded_at_utc: '2026-01-01T00:00:00.000Z'

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Codex'

            );


            assert.ok(result.violations.some((entry) => entry.includes('inconsistent reviewer identity')));

        });


        it('fails when receipt execution mode disagrees with review-context execution mode', () => {

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1),

                makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                    review_type: 'code',

                    reviewer_execution_mode: 'same_agent_fallback',

                    reviewer_session_id: 'self:T-123'

                }),

                makeTimelineEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 6)

            ];

            const result = validateReviewSkillEvidence(

                events,

                { code: true },

                {

                    code: {

                        path: '/reviews/T-123-code.md',

                        reviewContext: {

                            reviewer_routing: {

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

                            review_context_sha256: null,

                            review_artifact_sha256: null,

                            reviewer_execution_mode: 'same_agent_fallback',

                            reviewer_identity: 'self:T-123',

                            reviewer_fallback_reason: 'provider limitation',

                            recorded_at_utc: '2026-01-01T00:00:00.000Z'

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Antigravity'

            );


            assert.ok(result.violations.some(v => v.includes('inconsistent execution mode')));

        });


        it('fails when telemetry execution mode contradicts review-context execution mode', () => {

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1),

                makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer'

                }),

                makeTimelineEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 6)

            ];

            const result = validateReviewSkillEvidence(

                events,

                { code: true },

                {

                    code: {

                        path: '/reviews/T-123-code.md',

                        reviewContext: {

                            reviewer_routing: {

                                actual_execution_mode: 'same_agent_fallback',

                                reviewer_session_id: 'self:T-123'

                            }

                        },

                        receipt: {

                            schema_version: 2,

                            task_id: 'T-123',

                            review_type: 'code',

                            preflight_sha256: null,

                            scope_sha256: null,

                            review_context_sha256: null,

                            review_artifact_sha256: null,

                            reviewer_execution_mode: 'same_agent_fallback',

                            reviewer_identity: 'self:T-123',

                            reviewer_fallback_reason: 'provider limitation',

                            recorded_at_utc: '2026-01-01T00:00:00.000Z'

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Antigravity'

            );


            assert.ok(result.violations.some(v =>

                v.includes('inconsistent execution mode') && v.includes('REVIEWER_DELEGATION_ROUTED')

            ));

        });


    });
});

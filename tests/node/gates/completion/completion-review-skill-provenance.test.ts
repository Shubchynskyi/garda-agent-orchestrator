import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateReviewSkillEvidence } from '../../../../src/gates/completion';
import type { TimelineEventEntry } from '../../../../src/gates/completion';

import { makeTimelineEvent } from './completion-stage-evidence-fixtures';

describe('gates/completion — stage and evidence validation', () => {
    describe('validateReviewSkillEvidence', () => {

        it('rejects local asserted delegated review telemetry even when artifacts and routing hashes are present', () => {

            const codeRoutingIntegrity = {

                schema_version: 1,

                task_sequence: 5,

                prev_event_sha256: 'a'.repeat(64),

                event_sha256: 'b'.repeat(64)

            } satisfies TimelineEventEntry['integrity'];

            const testRoutingIntegrity = {

                schema_version: 1,

                task_sequence: 10,

                prev_event_sha256: 'c'.repeat(64),

                event_sha256: 'd'.repeat(64)

            } satisfies TimelineEventEntry['integrity'];

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

                }, codeRoutingIntegrity),

                makeTimelineEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 6, { review_type: 'test' }),

                makeTimelineEvent('SKILL_SELECTED', 7, { skill_id: 'testing-strategy' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 8, {

                    skill_id: 'testing-strategy',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/testing-strategy/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 9, {

                    review_type: 'test',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:test-reviewer'

                }, testRoutingIntegrity),

                makeTimelineEvent('REVIEW_RECORDED', 10, { review_type: 'test' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 11)

            ];

            const requiredReviews = { code: true, test: true };

            const reviewArtifacts = {

                code: {

                    path: '/reviews/T-123-code.md',

                        reviewContext: {

                            reviewer_routing: {

                                canonical_source_of_truth: 'Codex',

                                source_of_truth: 'Antigravity',

                                execution_provider: 'Antigravity',

                                execution_provider_source: 'provider_bridge',

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

                        review_context_sha256: null,

                        review_artifact_sha256: null,

                        reviewer_execution_mode: 'delegated_subagent',

                        reviewer_identity: 'agent:code-reviewer',

                        reviewer_fallback_reason: null,

                        reviewer_provenance: {

                            schema_version: 1,

                            attestation_type: 'controller_event_integrity' as const,

                            controller_event_type: 'REVIEWER_DELEGATION_ROUTED' as const,

                            task_sequence: codeRoutingIntegrity.task_sequence,

                            prev_event_sha256: codeRoutingIntegrity.prev_event_sha256,

                            event_sha256: codeRoutingIntegrity.event_sha256

                        },

                        trust_level: 'LOCAL_ASSERTED',

                        recorded_at_utc: '2026-01-01T00:00:00.000Z'

                    }

                },

                test: {

                    path: '/reviews/T-123-test.md',

                        reviewContext: {

                            reviewer_routing: {

                                canonical_source_of_truth: 'Codex',

                                source_of_truth: 'Antigravity',

                                execution_provider: 'Antigravity',

                                execution_provider_source: 'provider_bridge',

                                identity_status: 'resolved',

                                actual_execution_mode: 'delegated_subagent',

                                reviewer_session_id: 'agent:test-reviewer'

                        }

                    },

                    receipt: {

                        schema_version: 2,

                        task_id: 'T-123',

                        review_type: 'test',

                        preflight_sha256: null,

                        scope_sha256: null,

                        review_context_sha256: null,

                        review_artifact_sha256: null,

                        reviewer_execution_mode: 'delegated_subagent',

                        reviewer_identity: 'agent:test-reviewer',

                        reviewer_fallback_reason: null,

                        reviewer_provenance: {

                            schema_version: 1,

                            attestation_type: 'controller_event_integrity' as const,

                            controller_event_type: 'REVIEWER_DELEGATION_ROUTED' as const,

                            task_sequence: testRoutingIntegrity.task_sequence,

                            prev_event_sha256: testRoutingIntegrity.prev_event_sha256,

                            event_sha256: testRoutingIntegrity.event_sha256

                        },

                        trust_level: 'LOCAL_ASSERTED',

                        recorded_at_utc: '2026-01-01T00:00:00.000Z'

                    }

                }

            };


            const fsMock = require('node:fs');

            const originalExists = fsMock.existsSync;

            const originalRead = fsMock.readFileSync;

            

            // normalize slashes for cross-platform matching in mocks

            const norm = (p: string) => p.replace(/\\/g, '/');


            fsMock.existsSync = (p: string) => norm(p).includes('T-123-code.md') || norm(p).includes('T-123-test.md') || originalExists(p);

            fsMock.readFileSync = (p: string, e: string) => {

                if (norm(p).includes('T-123-code.md') || norm(p).includes('T-123-test.md')) {

                    return '# Review\nVerified changes in `src/main.ts`. This content is now intentionally made much longer so that it easily exceeds the thirty word minimum threshold required to pass the triviality check implemented in the completion gate logic.\n## Findings by Severity\nnone\n## Residual Risks\nnone\n## Verdict\nREVIEW PASSED';

                }

                return originalRead(p, e);

            };


            try {

                // timelinePath must be such that construction yields the mocked paths

                const result = validateReviewSkillEvidence(

                    events,

                    requiredReviews,

                    reviewArtifacts,

                    true,

                    '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                    'Antigravity',

                    'Codex',

                    false,

                    'provider_bridge'

                );

                assert.equal(

                    result.violations.filter((entry) => entry.includes('independent reviewer launch attestation')).length,

                    2,

                    JSON.stringify(result, null, 2)

                );

                assert.deepEqual(result.reviewer_execution_modes, ['delegated_subagent']);

            } finally {

                fsMock.existsSync = originalExists;

                fsMock.readFileSync = originalRead;

            }

        });


        it('uses the latest reviewer routing telemetry for repeated review attempts', () => {

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

                    reviewer_session_id: 'agent:stale-reviewer'

                }, {

                    schema_version: 1,

                    task_sequence: 5,

                    prev_event_sha256: 'a'.repeat(64),

                    event_sha256: 'b'.repeat(64)

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

                    reviewer_session_id: 'agent:fresh-reviewer'

                }, {

                    schema_version: 1,

                    task_sequence: 10,

                    prev_event_sha256: 'c'.repeat(64),

                    event_sha256: 'd'.repeat(64)

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

                            tree_state: {

                                tree_state_sha256: '1'.repeat(64)

                            },

                            reviewer_routing: {

                                canonical_source_of_truth: 'Codex',

                                source_of_truth: 'Antigravity',

                                execution_provider: 'Antigravity',

                                execution_provider_source: 'provider_bridge',

                                identity_status: 'resolved',

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

                            review_tree_state_sha256: '1'.repeat(64),

                            reviewer_execution_mode: 'delegated_subagent',

                            reviewer_identity: 'agent:fresh-reviewer',

                            reviewer_fallback_reason: null,

                            reviewer_provenance: {

                                schema_version: 1,

                                attestation_type: 'controller_event_integrity' as const,

                                controller_event_type: 'REVIEWER_DELEGATION_ROUTED' as const,

                                task_sequence: 10,

                                prev_event_sha256: 'c'.repeat(64),

                                event_sha256: 'd'.repeat(64)

                            },

                            trust_level: 'LOCAL_ASSERTED',

                            recorded_at_utc: '2026-01-01T00:00:00.000Z'

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Antigravity',

                'Codex',

                false,

                'provider_bridge'

            );


            assert.ok(result.violations.some((entry) => entry.includes('independent reviewer launch attestation')));

            assert.ok(!result.violations.some((entry) => entry.includes('does not match REVIEWER_DELEGATION_ROUTED')));

        });


        it('fails when delegation-required provider records same-agent fallback for a required review', () => {

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1),

                makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'testing-strategy' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                    skill_id: 'testing-strategy',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/testing-strategy/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                    review_type: 'test',

                    reviewer_execution_mode: 'same_agent_fallback'

                }),

                makeTimelineEvent('REVIEW_RECORDED', 5, { review_type: 'test' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 6)

            ];

            const result = validateReviewSkillEvidence(

                events,

                { test: true },

                {

                    test: {

                        path: '/reviews/T-123-test.md',

                        reviewContext: {

                            reviewer_routing: {

                                source_of_truth: 'GitHubCopilot',

                                canonical_source_of_truth: 'Codex',

                                execution_provider: 'GitHubCopilot',

                                execution_provider_source: 'provider_bridge',

                                actual_execution_mode: 'same_agent_fallback',

                                reviewer_session_id: 'self:T-123'

                            }

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'GitHubCopilot',

                'Codex',

                false,

                'provider_bridge'

            );


            assert.ok(result.violations.some((entry) => entry.includes('delegated_subagent')));

        });


        it('fails when LOCAL_AUDITED delegated receipts omit reviewer_provenance', () => {

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

                    task_sequence: 5,

                    prev_event_sha256: 'a'.repeat(64),

                    event_sha256: 'b'.repeat(64)

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

                            review_tree_state_sha256: '1'.repeat(64),

                            reviewer_execution_mode: 'delegated_subagent',

                            reviewer_identity: 'agent:code-reviewer',

                            reviewer_fallback_reason: null,

                            trust_level: 'LOCAL_ASSERTED',

                            recorded_at_utc: '2026-01-01T00:00:00.000Z'

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Codex'

            );


            assert.ok(result.violations.some(v => v.includes('missing reviewer_provenance')));

        });


        it('normalizes non-canonical delegated LOCAL_AUDITED trust strings before enforcement', () => {

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

                    task_sequence: 5,

                    prev_event_sha256: 'a'.repeat(64),

                    event_sha256: 'b'.repeat(64)

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

                            reviewer_execution_mode: 'delegated_subagent',

                            reviewer_identity: 'agent:code-reviewer',

                            reviewer_fallback_reason: null,

                            trust_level: ' local_audited ',

                            recorded_at_utc: '2026-01-01T00:00:00.000Z'

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Codex'

            );


            assert.ok(result.violations.some(v => v.includes('missing reviewer_provenance')));

        });


        it('fails when reviewer_provenance does not match REVIEWER_DELEGATION_ROUTED telemetry integrity', () => {

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

                    task_sequence: 5,

                    prev_event_sha256: 'a'.repeat(64),

                    event_sha256: 'b'.repeat(64)

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

                            reviewer_execution_mode: 'delegated_subagent',

                            reviewer_identity: 'agent:code-reviewer',

                            reviewer_fallback_reason: null,

                            reviewer_provenance: {

                                schema_version: 1,

                                attestation_type: 'controller_event_integrity' as const,

                                controller_event_type: 'REVIEWER_DELEGATION_ROUTED' as const,

                                task_sequence: 6,

                                prev_event_sha256: 'c'.repeat(64),

                                event_sha256: 'd'.repeat(64)

                            },

                            trust_level: 'LOCAL_ASSERTED',

                            recorded_at_utc: '2026-01-01T00:00:00.000Z'

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Antigravity',

                'Codex',

                false,

                'provider_bridge'

            );


            assert.ok(result.violations.some(v => v.includes('reviewer_provenance does not match')));

        });


        it('fails when same_agent_fallback receipts appear in the current cycle even if they claim LOCAL_AUDITED trust', () => {

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

                    reviewer_execution_mode: 'same_agent_fallback',

                    reviewer_session_id: 'self:T-123'

                }, {

                    schema_version: 1,

                    task_sequence: 5,

                    prev_event_sha256: 'a'.repeat(64),

                    event_sha256: 'b'.repeat(64)

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

                                reviewer_session_id: 'self:T-123',

                                fallback_reason: 'provider limitation'

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

                            trust_level: 'LOCAL_AUDITED',

                            recorded_at_utc: '2026-01-01T00:00:00.000Z'

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Qwen'

            );


            assert.ok(result.violations.some(v => v.includes('deprecated same_agent_fallback execution')));

        });


        it('fails when delegated LOCAL_AUDITED receipts rely on provider-like launch markers that are out of scope for the current contract', () => {

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

                    reviewer_session_id: 'agent:code-reviewer',

                    reviewer_launch_attestation_type: 'provider_artifact',

                    reviewer_launch_artifact_path: '/tmp/provider-artifact.json'

                }, {

                    schema_version: 1,

                    task_sequence: 5,

                    prev_event_sha256: 'a'.repeat(64),

                    event_sha256: 'b'.repeat(64)

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

                            reviewer_execution_mode: 'delegated_subagent',

                            reviewer_identity: 'agent:code-reviewer',

                            reviewer_fallback_reason: null,

                            reviewer_provenance: {

                                schema_version: 1,

                                attestation_type: 'controller_event_integrity' as const,

                                controller_event_type: 'REVIEWER_DELEGATION_ROUTED' as const,

                                task_sequence: 5,

                                prev_event_sha256: 'a'.repeat(64),

                                event_sha256: 'b'.repeat(64)

                            },

                            trust_level: 'LOCAL_AUDITED',

                            recorded_at_utc: '2026-01-01T00:00:00.000Z'

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Codex'

            );


            assert.ok(result.violations.some(v => v.includes('cannot claim LOCAL_AUDITED')));

        });


        it('fails when delegated_subagent receipts omit reviewer_provenance even with asserted trust', () => {

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

                    task_sequence: 5,

                    prev_event_sha256: 'a'.repeat(64),

                    event_sha256: 'b'.repeat(64)

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

                            reviewer_execution_mode: 'delegated_subagent',

                            reviewer_identity: 'agent:code-reviewer',

                            reviewer_fallback_reason: null,

                            trust_level: 'LOCAL_ASSERTED',

                            recorded_at_utc: '2026-01-01T00:00:00.000Z'

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Codex'

            );


            assert.ok(result.violations.some(v => v.includes('missing reviewer_provenance')));

        });


        it('fails when delegated reviewer telemetry exists but its integrity payload is missing', () => {

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

                            reviewer_execution_mode: 'delegated_subagent',

                            reviewer_identity: 'agent:code-reviewer',

                            reviewer_fallback_reason: null,

                            reviewer_provenance: {

                                schema_version: 1,

                                attestation_type: 'controller_event_integrity' as const,

                                controller_event_type: 'REVIEWER_DELEGATION_ROUTED' as const,

                                task_sequence: 5,

                                prev_event_sha256: 'a'.repeat(64),

                                event_sha256: 'b'.repeat(64)

                            },

                            trust_level: 'LOCAL_AUDITED',

                            recorded_at_utc: '2026-01-01T00:00:00.000Z'

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Codex'

            );


            assert.ok(result.violations.some(v => v.includes('missing integrity')));

        });


        it('matches reviewer_provenance against the attested routing event instead of a newer stale routed residue', () => {

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

                    task_sequence: 5,

                    prev_event_sha256: 'a'.repeat(64),

                    event_sha256: 'b'.repeat(64)

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 6, {

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer'

                }, {

                    schema_version: 1,

                    task_sequence: 7,

                    prev_event_sha256: 'c'.repeat(64),

                    event_sha256: 'd'.repeat(64)

                }),

                makeTimelineEvent('REVIEW_RECORDED', 7, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 8)

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

                                source_of_truth: 'Antigravity',

                                execution_provider: 'Antigravity',

                                execution_provider_source: 'provider_bridge',

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

                            review_context_sha256: null,

                            review_artifact_sha256: null,

                            reviewer_execution_mode: 'delegated_subagent',

                            reviewer_identity: 'agent:code-reviewer',

                            reviewer_fallback_reason: null,

                            reviewer_provenance: {

                                schema_version: 1,

                                attestation_type: 'controller_event_integrity' as const,

                                controller_event_type: 'REVIEWER_DELEGATION_ROUTED' as const,

                                task_sequence: 5,

                                prev_event_sha256: 'a'.repeat(64),

                                event_sha256: 'b'.repeat(64)

                            },

                            trust_level: 'LOCAL_ASSERTED',

                            recorded_at_utc: '2026-01-01T00:00:00.000Z'

                        }

                    }

                },

                true,

                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                'Antigravity',

                'Codex',

                false,

                'provider_bridge'

            );


            assert.ok(result.violations.some((entry) => entry.includes('independent reviewer launch attestation')));

            assert.ok(!result.violations.some((entry) => entry.includes('does not match REVIEWER_DELEGATION_ROUTED')));

        });


        it('fails when code changed but review telemetry is missing', () => {

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1),

                makeTimelineEvent('REVIEW_GATE_PASSED', 2)

            ];

            const requiredReviews = { code: true };

            const result = validateReviewSkillEvidence(events, requiredReviews, {}, true, '/T-123.jsonl', 'Codex');

            assert.ok(result.violations.some(v => v.includes('SKILL_SELECTED telemetry') && v.includes("'code'")));

        });


        it('fails when reviewer delegation telemetry is missing', () => {

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1),

                makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEW_RECORDED', 4, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 5)

            ];

            const requiredReviews = { code: true };

            const result = validateReviewSkillEvidence(

                events,

                requiredReviews,

                { code: { path: '/reviews/T-123-code.md' } },

                true,

                '/T-123.jsonl',

                'Codex'

            );

            assert.ok(result.violations.some(v => v.includes('REVIEWER_DELEGATION_ROUTED telemetry')));

        });


        it('fails reused review receipts when REVIEW_RECORDED reuse telemetry lacks integrity', () => {

            const originalContextSha = '1'.repeat(64);

            const currentContextSha = '2'.repeat(64);

            const contextReuseSha = '3'.repeat(64);

            const routingEventSha = '4'.repeat(64);

            const invocationEventSha = '5'.repeat(64);

            const artifactSha = '6'.repeat(64);

            const originalTreeStateSha = '7'.repeat(64);

            const currentTreeStateSha = '8'.repeat(64);

            const events = [

                makeTimelineEvent('REVIEWER_INVOCATION_ATTESTED', 0, {

                    task_id: 'T-123',

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent',

                    reviewer_session_id: 'agent:code-reviewer',

                    reviewer_identity: 'agent:code-reviewer',

                    review_context_sha256: originalContextSha,

                    review_tree_state_sha256: originalTreeStateSha,

                    routing_event_sha256: routingEventSha

                }, {

                    schema_version: 1,

                    task_sequence: 12,

                    prev_event_sha256: null,

                    event_sha256: invocationEventSha

                }),

                makeTimelineEvent('COMPILE_GATE_PASSED', 1),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 2, { review_type: 'code' }),

                makeTimelineEvent('SKILL_SELECTED', 3, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 4, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEW_RECORDED', 5, {

                    review_type: 'code',

                    reused_existing_review: true,

                    receipt_path: '/reviews/T-123-code-receipt.json',

                    review_context_sha256: currentContextSha,

                    review_tree_state_sha256: currentTreeStateSha,

                    review_artifact_sha256: artifactSha,

                    reused_from_receipt_path: '/reviews/T-123-code-receipt.json',

                    reused_from_review_context_sha256: originalContextSha,

                    reused_from_review_context_reuse_sha256: contextReuseSha,

                    reused_from_review_tree_state_sha256: originalTreeStateSha

                }),

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

                                execution_provider: 'Codex',

                                execution_provider_source: 'explicit_provider',

                                identity_status: 'resolved',

                                actual_execution_mode: null,

                                reviewer_session_id: null

                            }

                        },

                        receipt: {

                            schema_version: 2,

                            task_id: 'T-123',

                            review_type: 'code',

                            preflight_sha256: null,

                            scope_sha256: null,

                            review_context_sha256: currentContextSha,

                            review_tree_state_sha256: currentTreeStateSha,

                            review_context_reuse_sha256: contextReuseSha,

                            review_artifact_sha256: artifactSha,

                            reviewer_execution_mode: 'delegated_subagent',

                            reviewer_identity: 'agent:code-reviewer',

                            reviewer_fallback_reason: null,

                            reviewer_provenance: {

                                schema_version: 1,

                                attestation_type: 'reviewer_invocation_attestation',

                                controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',

                                task_sequence: 12,

                                prev_event_sha256: null,

                                event_sha256: invocationEventSha,

                                task_id: 'T-123',

                                review_type: 'code',

                                reviewer_execution_mode: 'delegated_subagent',

                                reviewer_identity: 'agent:code-reviewer',

                                review_context_sha256: originalContextSha,

                                routing_event_sha256: routingEventSha

                            },

                            trust_level: 'INDEPENDENT_AUDITED',

                            reused_existing_review: true,

                            reused_from_receipt_path: '/reviews/T-123-code-receipt.json',

                            reused_from_review_context_sha256: originalContextSha,

                            reused_from_review_context_reuse_sha256: contextReuseSha,

                            reused_from_review_tree_state_sha256: originalTreeStateSha,

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

                violation.includes("Required review 'code' REVIEW_RECORDED reuse telemetry is missing integrity")

            )), JSON.stringify(result, null, 2));

        });


    });
});

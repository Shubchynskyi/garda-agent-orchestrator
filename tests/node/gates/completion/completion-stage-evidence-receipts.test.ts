import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateReviewSkillEvidence } from '../../../../src/gates/completion';

import { makeTimelineEvent } from './completion-stage-evidence-fixtures';

describe('gates/completion — review receipt field validation', () => {
    it('fails when receipt is missing reviewer_execution_mode', () => {
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
                        reviewer_execution_mode: null,
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

        assert.ok(result.violations.some(v => v.includes('receipt is missing reviewer_execution_mode')));
    });

    it('fails when receipt is missing reviewer_identity', () => {
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
                        reviewer_identity: null,
                        reviewer_fallback_reason: null,
                        recorded_at_utc: '2026-01-01T00:00:00.000Z'
                    }
                }
            },
            true,
            '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
            'Codex'
        );

        assert.ok(result.violations.some(v => v.includes('receipt is missing reviewer_identity')));
    });

    it('fails when receipt uses deprecated same_agent_fallback without reviewer_fallback_reason', () => {
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
                            actual_execution_mode: 'same_agent_fallback',
                            reviewer_session_id: 'self:T-123',
                            fallback_reason: null
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
                        reviewer_fallback_reason: null,
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

    it('fails when receipt claims delegated_subagent on delegation-required provider but execution mode is fallback', () => {
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
                            source_of_truth: 'GitHubCopilot',
                            canonical_source_of_truth: 'Codex',
                            execution_provider: 'GitHubCopilot',
                            execution_provider_source: 'provider_bridge',
                            actual_execution_mode: 'same_agent_fallback',
                            reviewer_session_id: 'self:T-123',
                            fallback_reason: 'provider does not support delegation'
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
                        reviewer_fallback_reason: 'provider does not support delegation',
                        recorded_at_utc: '2026-01-01T00:00:00.000Z'
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

        assert.ok(result.violations.some(v =>
            v.includes('receipt must use delegated_subagent') && v.includes('GitHubCopilot')
        ));
        assert.ok(result.violations.some(v => v.includes('deprecated same_agent_fallback execution')));
    });

    it('allows delegated_subagent on direct-entrypoint providers after fallback removal', () => {
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
                        recorded_at_utc: '2026-01-01T00:00:00.000Z'
                    }
                }
            },
            true,
            '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
            'Gemini'
        );

        assert.equal(result.violations.some(v =>
            v.includes('receipt cannot use delegated_subagent') && v.includes('Gemini')
        ), false);
    });
});

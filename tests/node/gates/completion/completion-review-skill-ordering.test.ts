import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateReviewSkillEvidence } from '../../../../src/gates/completion';
import type { TimelineEventEntry } from '../../../../src/gates/completion';

import { makeTimelineEvent } from './completion-stage-evidence-fixtures';

describe('gates/completion — stage and evidence validation', () => {
    describe('validateReviewSkillEvidence', () => {

        it('fails when downstream test review starts before upstream code review is recorded in the same cycle', () => {

            const events = [

                makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'test' }),

                makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'testing-strategy' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                    skill_id: 'testing-strategy',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/testing-strategy/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                    review_type: 'test',

                    reviewer_execution_mode: 'delegated_subagent'

                }),

                makeTimelineEvent('REVIEW_RECORDED', 5, { review_type: 'test' }),

                makeTimelineEvent('REVIEW_PHASE_STARTED', 6, { review_type: 'code' }),

                makeTimelineEvent('SKILL_SELECTED', 7, { skill_id: 'code-review' }),

                makeTimelineEvent('SKILL_REFERENCE_LOADED', 8, {

                    skill_id: 'code-review',

                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'

                }),

                makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 9, {

                    review_type: 'code',

                    reviewer_execution_mode: 'delegated_subagent'

                }),

                makeTimelineEvent('REVIEW_RECORDED', 10, { review_type: 'code' }),

                makeTimelineEvent('REVIEW_GATE_PASSED', 11)

            ];

            const requiredReviews = { code: true, test: true };

            const reviewArtifacts = {

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

                },

                test: {

                    path: '/reviews/T-123-test.md',

                    reviewContext: {

                        reviewer_routing: {

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

                        recorded_at_utc: '2026-01-01T00:00:00.000Z'

                    }

                }

            };


            const fsMock = require('node:fs');

            const originalExists = fsMock.existsSync;

            const originalRead = fsMock.readFileSync;

            const norm = (p: string) => p.replace(/\\/g, '/');


            fsMock.existsSync = (p: string) => norm(p).includes('T-123-code.md') || norm(p).includes('T-123-test.md') || originalExists(p);

            fsMock.readFileSync = (p: string, e: string) => {

                if (norm(p).includes('T-123-code.md') || norm(p).includes('T-123-test.md')) {

                    return '# Review\nValidated `src/gates/completion.ts` and the matching review context ordering for this review type. This review text is intentionally detailed enough to exceed the triviality filter and documents why the recovery-cycle evidence is acceptable.\n## Findings by Severity\nnone\n## Residual Risks\nnone\n## Verdict\nREVIEW PASSED';

                }

                return originalRead(p, e);

            };


            try {

                const result = validateReviewSkillEvidence(

                    events,

                    requiredReviews,

                    reviewArtifacts,

                    true,

                    '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                    'Codex'

                );

                assert.ok(

                    result.violations.some((entry) => entry.includes("Required review 'test' started before upstream review 'code' completed")),

                    JSON.stringify(result, null, 2)

                );

            } finally {

                fsMock.existsSync = originalExists;

                fsMock.readFileSync = originalRead;

            }

        });


        it('accepts downstream remediation when later upstream reuse follows an earlier upstream PASS for any required review type', () => {

            const upstreamReviewTypes = [

                'code',

                'api',

                'db',

                'security',

                'refactor',

                'performance',

                'infra',

                'dependency'

            ] as const;

            const skillIds: Record<typeof upstreamReviewTypes[number], string> = {

                code: 'code-review',

                api: 'api-review',

                db: 'db-review',

                security: 'security-review',

                refactor: 'refactor-review',

                performance: 'performance-review',

                infra: 'infra-review',

                dependency: 'dependency-review'

            };


            const fsMock = require('node:fs');

            const originalExists = fsMock.existsSync;

            const originalRead = fsMock.readFileSync;

            const norm = (p: string) => p.replace(/\\/g, '/');


            fsMock.existsSync = (p: string) => /T-123-(code|api|db|security|refactor|performance|infra|dependency|test)\.md/.test(norm(p)) || originalExists(p);

            fsMock.readFileSync = (p: string, e: string) => {

                if (/T-123-(code|api|db|security|refactor|performance|infra|dependency|test)\.md/.test(norm(p))) {

                    return '# Review\nValidated `src/gates/completion.ts` and the matching review context ordering for this review type. This review text is intentionally detailed enough to exceed the triviality filter and documents why the recovery-cycle evidence is acceptable.\n## Findings by Severity\nnone\n## Residual Risks\nnone\n## Verdict\nREVIEW PASSED';

                }

                return originalRead(p, e);

            };


            try {

                for (const upstreamReviewType of upstreamReviewTypes) {

                    const events = [

                        makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                        makeTimelineEvent('REVIEW_PHASE_STARTED', 1, { review_type: upstreamReviewType }),

                        makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: skillIds[upstreamReviewType] }),

                        makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                            skill_id: skillIds[upstreamReviewType],

                            reference_path: `/repo/garda-agent-orchestrator/live/skills/${skillIds[upstreamReviewType]}/SKILL.md`

                        }),

                        makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                            review_type: upstreamReviewType,

                            reviewer_execution_mode: 'delegated_subagent'

                        }),

                        makeTimelineEvent('REVIEW_RECORDED', 5, { review_type: upstreamReviewType }),

                        makeTimelineEvent('REVIEW_PHASE_STARTED', 6, { review_type: 'test' }),

                        makeTimelineEvent('SKILL_SELECTED', 7, { skill_id: 'testing-strategy' }),

                        makeTimelineEvent('SKILL_REFERENCE_LOADED', 8, {

                            skill_id: 'testing-strategy',

                            reference_path: '/repo/garda-agent-orchestrator/live/skills/testing-strategy/SKILL.md'

                        }),

                        makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 9, {

                            review_type: 'test',

                            reviewer_execution_mode: 'delegated_subagent'

                        }),

                        makeTimelineEvent('REVIEW_RECORDED', 10, { review_type: 'test' }),

                        makeTimelineEvent('REVIEW_RECORDED', 11, {

                            review_type: upstreamReviewType,

                            reused_existing_review: true

                        }),

                        makeTimelineEvent('REVIEW_GATE_PASSED', 12)

                    ];

                    const requiredReviews = { [upstreamReviewType]: true, test: true };

                    const reviewArtifacts = {

                        [upstreamReviewType]: {

                            path: `/reviews/T-123-${upstreamReviewType}.md`,

                            reviewContext: {

                                reviewer_routing: {

                                    actual_execution_mode: 'delegated_subagent',

                                    reviewer_session_id: `agent:${upstreamReviewType}-reviewer`

                                }

                            },

                            receipt: {

                                schema_version: 2,

                                task_id: 'T-123',

                                review_type: upstreamReviewType,

                                preflight_sha256: null,

                                scope_sha256: null,

                                review_context_sha256: null,

                                review_artifact_sha256: null,

                                reviewer_execution_mode: 'delegated_subagent',

                                reviewer_identity: `agent:${upstreamReviewType}-reviewer`,

                                reviewer_fallback_reason: null,

                                recorded_at_utc: '2026-01-01T00:00:00.000Z'

                            }

                        },

                        test: {

                            path: '/reviews/T-123-test.md',

                            reviewContext: {

                                reviewer_routing: {

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

                                recorded_at_utc: '2026-01-01T00:00:00.000Z'

                            }

                        }

                    };


                    const result = validateReviewSkillEvidence(

                        events,

                        requiredReviews,

                        reviewArtifacts,

                        true,

                        '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                        'Codex'

                    );

                    assert.equal(

                        result.violations.some((entry) => entry.includes(`Required review 'test' started before upstream review '${upstreamReviewType}' completed`)),

                        false,

                        `${upstreamReviewType}: ${JSON.stringify(result, null, 2)}`

                    );

                }

            } finally {

                fsMock.existsSync = originalExists;

                fsMock.readFileSync = originalRead;

            }

        });


        it('fails when downstream test review starts before required non-test upstream reviews are recorded in the same cycle', () => {

            const upstreamReviewTypes = [

                'api',

                'db',

                'security',

                'refactor',

                'performance',

                'infra',

                'dependency'

            ] as const;

            const skillIds: Record<typeof upstreamReviewTypes[number], string> = {

                api: 'api-review',

                db: 'db-review',

                security: 'security-review',

                refactor: 'refactor-review',

                performance: 'performance-review',

                infra: 'infra-review',

                dependency: 'dependency-review'

            };

            const verdictTokens: Record<typeof upstreamReviewTypes[number], string> = {

                api: 'API REVIEW PASSED',

                db: 'DB REVIEW PASSED',

                security: 'SECURITY REVIEW PASSED',

                refactor: 'REFACTOR REVIEW PASSED',

                performance: 'PERFORMANCE REVIEW PASSED',

                infra: 'INFRA REVIEW PASSED',

                dependency: 'DEPENDENCY REVIEW PASSED'

            };


            const fsMock = require('node:fs');

            const originalExists = fsMock.existsSync;

            const originalRead = fsMock.readFileSync;

            const norm = (p: string) => p.replace(/\\/g, '/');


            try {

                for (const upstreamReviewType of upstreamReviewTypes) {

                    const events = [

                        makeTimelineEvent('COMPILE_GATE_PASSED', 0),

                        makeTimelineEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'test' }),

                        makeTimelineEvent('SKILL_SELECTED', 2, { skill_id: 'testing-strategy' }),

                        makeTimelineEvent('SKILL_REFERENCE_LOADED', 3, {

                            skill_id: 'testing-strategy',

                            reference_path: '/repo/garda-agent-orchestrator/live/skills/testing-strategy/SKILL.md'

                        }),

                        makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 4, {

                            review_type: 'test',

                            reviewer_execution_mode: 'delegated_subagent'

                        }),

                        makeTimelineEvent('REVIEW_RECORDED', 5, { review_type: 'test' }),

                        makeTimelineEvent('REVIEW_PHASE_STARTED', 6, { review_type: upstreamReviewType }),

                        makeTimelineEvent('SKILL_SELECTED', 7, { skill_id: skillIds[upstreamReviewType] }),

                        makeTimelineEvent('SKILL_REFERENCE_LOADED', 8, {

                            skill_id: skillIds[upstreamReviewType],

                            reference_path: `/repo/garda-agent-orchestrator/live/skills/${skillIds[upstreamReviewType]}/SKILL.md`

                        }),

                        makeTimelineEvent('REVIEWER_DELEGATION_ROUTED', 9, {

                            review_type: upstreamReviewType,

                            reviewer_execution_mode: 'delegated_subagent'

                        }),

                        makeTimelineEvent('REVIEW_RECORDED', 10, { review_type: upstreamReviewType }),

                        makeTimelineEvent('REVIEW_GATE_PASSED', 11)

                    ];

                    const requiredReviews = { [upstreamReviewType]: true, test: true };

                    const reviewArtifacts = {

                        [upstreamReviewType]: {

                            path: `/reviews/T-123-${upstreamReviewType}.md`,

                            reviewContext: {

                                reviewer_routing: {

                                    actual_execution_mode: 'delegated_subagent',

                                    reviewer_session_id: `agent:${upstreamReviewType}-reviewer`

                                }

                            },

                            receipt: {

                                schema_version: 2,

                                task_id: 'T-123',

                                review_type: upstreamReviewType,

                                preflight_sha256: null,

                                scope_sha256: null,

                                review_context_sha256: null,

                                review_artifact_sha256: null,

                                reviewer_execution_mode: 'delegated_subagent',

                                reviewer_identity: `agent:${upstreamReviewType}-reviewer`,

                                reviewer_fallback_reason: null,

                                recorded_at_utc: '2026-01-01T00:00:00.000Z'

                            }

                        },

                        test: {

                            path: '/reviews/T-123-test.md',

                            reviewContext: {

                                reviewer_routing: {

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

                                recorded_at_utc: '2026-01-01T00:00:00.000Z'

                            }

                        }

                    };


                    fsMock.existsSync = (p: string) => (

                        norm(p).includes(`T-123-${upstreamReviewType}.md`)

                        || norm(p).includes('T-123-test.md')

                        || originalExists(p)

                    );

                    fsMock.readFileSync = (p: string, e: string) => {

                        if (norm(p).includes(`T-123-${upstreamReviewType}.md`)) {

                            return `# Review\nValidated the ${upstreamReviewType} sequencing contract with enough detail to satisfy authenticity checks.\n## Findings by Severity\nnone\n## Residual Risks\nnone\n## Verdict\n${verdictTokens[upstreamReviewType]}`;

                        }

                        if (norm(p).includes('T-123-test.md')) {

                            return '# Review\nValidated the downstream test review artifact for the sequencing contract with enough detail to satisfy authenticity checks.\n## Findings by Severity\nnone\n## Residual Risks\nnone\n## Verdict\nTEST REVIEW PASSED';

                        }

                        return originalRead(p, e);

                    };


                    const result = validateReviewSkillEvidence(

                        events,

                        requiredReviews,

                        reviewArtifacts,

                        true,

                        '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',

                        'Codex'

                    );

                    assert.ok(

                        result.violations.some((entry) => entry.includes(`Required review 'test' started before upstream review '${upstreamReviewType}' completed`)),

                        `${upstreamReviewType}: ${JSON.stringify(result, null, 2)}`

                    );

                }

            } finally {

                fsMock.existsSync = originalExists;

                fsMock.readFileSync = originalRead;

            }

        });


    });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    validateStageSequence,
    detectCodeChanged,
    preflightRequiresAnyReview,
    validateReviewSkillEvidence,
    STAGE_SEQUENCE_ORDER,
    NON_CODE_STAGE_SEQUENCE_ORDER
} from '../../../src/gates/completion';

import type { TimelineEventEntry } from '../../../src/gates/completion';
describe('gates/completion — stage and evidence validation', () => {
    describe('validateStageSequence', () => {
        function makeEvents(...types: (string | { type: string, details: any })[]): TimelineEventEntry[] {
            return types.map((t, i) => {
                const type = typeof t === 'string' ? t : t.type;
                const details = typeof t === 'object' ? t.details : null;
                return {
                    event_type: type,
                    timestamp_utc: `2026-01-01T00:0${i}:00.000Z`,
                    sequence: i,
                    details
                };
            });
        }

        it('passes when stages are in correct order for code-changing task', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED', 'RULE_PACK_LOADED', 'HANDSHAKE_DIAGNOSTICS_RECORDED', 'SHELL_SMOKE_PREFLIGHT_RECORDED', 'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED', 'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED', 'REVIEW_RECORDED', 'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl');
            assert.equal(result.violations.some((entry) => entry.includes('single-agent providers')), false);
        });

        it('requires canonical preflight and implementation stages for non-code tasks too', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, false, '/timeline.jsonl');
            assert.equal(result.violations.some((entry) => entry.includes('single-agent providers')), false);
            assert.deepEqual(result.observed_order, [...NON_CODE_STAGE_SEQUENCE_ORDER]);
        });

        it('rejects non-code latest-cycle review evidence when preflight and implementation only exist in an older cycle', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, false, '/timeline.jsonl');
            assert.ok(result.violations.some((item) => item.includes("Do not backfill 'PREFLIGHT_CLASSIFIED' from an older execution cycle.")));
            assert.ok(result.violations.some((item) => item.includes("Do not backfill 'IMPLEMENTATION_STARTED' from an older execution cycle.")));
        });

        it('does not require REVIEW_RECORDED when the current code-changing cycle required zero reviews', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl', false);
            assert.equal(result.violations.length, 0);
            assert.deepEqual(result.expected_order, [...NON_CODE_STAGE_SEQUENCE_ORDER]);
        });

        it('still requires REVIEW_RECORDED when the current code-changing cycle required reviews', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl', true);
            assert.ok(result.violations.some((item) => item.includes("latest 'REVIEW_GATE_PASSED' evidence")));
            assert.ok(result.violations.some((item) => item.includes("'REVIEW_RECORDED'")));
        });

        it('uses the latest coherent cycle instead of the first stale stage occurrences', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'REVIEW_PHASE_STARTED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_RECORDED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl');
            assert.equal(result.violations.length, 0);
            assert.deepEqual(result.observed_order, [...STAGE_SEQUENCE_ORDER]);
        });

        it('does not let an early task-entry rule-pack misorder poison a later valid cycle', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                { type: 'RULE_PACK_LOADED', details: { stage: 'TASK_ENTRY' } },
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_RECORDED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl');
            assert.equal(result.violations.some(v =>
                v.includes('receipt cannot use delegated_subagent') && v.includes('Gemini')
            ), false);
        });

        it('rejects backfilling compile evidence from an older cycle when the latest cycle is misordered', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'REVIEW_PHASE_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_RECORDED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl');
            assert.ok(result.violations.some((item) => item.includes("Do not backfill 'COMPILE_GATE_PASSED' from an older execution cycle.")));
        });

        it('rejects latest-cycle review evidence when compile and implementation only exist in an older cycle', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED',
                'PREFLIGHT_CLASSIFIED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_RECORDED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl');
            assert.ok(result.violations.some((item) => item.includes("Do not backfill 'IMPLEMENTATION_STARTED' from an older execution cycle.")));
            assert.ok(result.violations.some((item) => item.includes("Do not backfill 'COMPILE_GATE_PASSED' from an older execution cycle.")));
        });
    });

    describe('detectCodeChanged', () => {
        it('detects when preflight requires any review', () => {
            assert.equal(preflightRequiresAnyReview({
                required_reviews: {
                    code: false,
                    test: true
                }
            }), true);
            assert.equal(preflightRequiresAnyReview({
                required_reviews: {
                    code: false,
                    test: false
                }
            }), false);
        });

        it('returns false for docs-only preflight with non-zero diff but no code-like changes or required reviews', () => {
            const result = detectCodeChanged({
                scope_category: 'docs-only',
                changed_files: ['docs/runbook.md'],
                metrics: {
                    changed_lines_total: 12,
                    code_like_changed_count: 0,
                    runtime_code_like_changed_count: 0
                },
                required_reviews: {
                    code: false,
                    test: false
                },
                triggers: {
                    runtime_code_changed: false
                }
            });

            assert.equal(result, false);
        });

        it('returns false for other explicit non-code scope categories without required reviews', () => {
            const scopeCategories = ['config-only', 'audit-only', 'empty'];
            for (const scopeCategory of scopeCategories) {
                const result = detectCodeChanged({
                    scope_category: scopeCategory,
                    changed_files: scopeCategory === 'empty' ? [] : [`meta/${scopeCategory}.txt`],
                    metrics: {
                        changed_lines_total: scopeCategory === 'empty' ? 0 : 5,
                        code_like_changed_count: 0,
                        runtime_code_like_changed_count: 0
                    },
                    required_reviews: {
                        code: false,
                        test: false
                    },
                    triggers: {
                        runtime_code_changed: false
                    }
                });

                assert.equal(result, false, `Expected ${scopeCategory} to remain non-code.`);
            }
        });

        it('returns false for legacy docs-only preflight artifacts without new classifier fields', () => {
            const result = detectCodeChanged({
                changed_files: ['docs/runbook.md'],
                metrics: {
                    changed_lines_total: 12
                },
                required_reviews: {
                    code: false,
                    test: false
                }
            });

            assert.equal(result, false);
        });

        it('uses workspace paths config for legacy fallback classification', () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-completion-paths-'));

            try {
                const configPath = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config', 'paths.json');
                fs.mkdirSync(path.dirname(configPath), { recursive: true });
                fs.writeFileSync(configPath, JSON.stringify({
                    runtime_roots: ['docs/'],
                    code_like_regexes: ['\\.md$']
                }, null, 2), 'utf8');

                const result = detectCodeChanged({
                    changed_files: ['docs/runbook.md'],
                    metrics: {
                        changed_lines_total: 12
                    },
                    required_reviews: {
                        code: false,
                        test: false
                    }
                }, tempDir);

                assert.equal(result, true);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('returns true when reviews are required even if code-like metrics are absent', () => {
            const result = detectCodeChanged({
                changed_files: ['src/main.ts'],
                required_reviews: {
                    code: true,
                    test: true
                }
            });

            assert.equal(result, true);
        });
    });

    describe('validateReviewSkillEvidence', () => {
        function makeEvent(
            eventType: string,
            sequence: number,
            details: Record<string, unknown> | null = null,
            integrity: Record<string, unknown> | null = null
        ): TimelineEventEntry {
            return {
                event_type: eventType,
                timestamp_utc: `2026-01-01T00:0${sequence}:00.000Z`,
                sequence,
                details,
                integrity: integrity as TimelineEventEntry['integrity']
            };
        }

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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'code' }),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }, codeRoutingIntegrity),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_PHASE_STARTED', 6, { review_type: 'test' }),
                makeEvent('SKILL_SELECTED', 7, { skill_id: 'testing-strategy' }),
                makeEvent('SKILL_REFERENCE_LOADED', 8, {
                    skill_id: 'testing-strategy',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/testing-strategy/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 9, {
                    review_type: 'test',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:test-reviewer'
                }, testRoutingIntegrity),
                makeEvent('REVIEW_RECORDED', 10, { review_type: 'test' }),
                makeEvent('REVIEW_GATE_PASSED', 11)
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

        it('fails when downstream test review starts before upstream code review is recorded in the same cycle', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'test' }),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'testing-strategy' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'testing-strategy',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/testing-strategy/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'test',
                    reviewer_execution_mode: 'delegated_subagent'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'test' }),
                makeEvent('REVIEW_PHASE_STARTED', 6, { review_type: 'code' }),
                makeEvent('SKILL_SELECTED', 7, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 8, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 9, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent'
                }),
                makeEvent('REVIEW_RECORDED', 10, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 11)
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
                        makeEvent('COMPILE_GATE_PASSED', 0),
                        makeEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'test' }),
                        makeEvent('SKILL_SELECTED', 2, { skill_id: 'testing-strategy' }),
                        makeEvent('SKILL_REFERENCE_LOADED', 3, {
                            skill_id: 'testing-strategy',
                            reference_path: '/repo/garda-agent-orchestrator/live/skills/testing-strategy/SKILL.md'
                        }),
                        makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                            review_type: 'test',
                            reviewer_execution_mode: 'delegated_subagent'
                        }),
                        makeEvent('REVIEW_RECORDED', 5, { review_type: 'test' }),
                        makeEvent('REVIEW_PHASE_STARTED', 6, { review_type: upstreamReviewType }),
                        makeEvent('SKILL_SELECTED', 7, { skill_id: skillIds[upstreamReviewType] }),
                        makeEvent('SKILL_REFERENCE_LOADED', 8, {
                            skill_id: skillIds[upstreamReviewType],
                            reference_path: `/repo/garda-agent-orchestrator/live/skills/${skillIds[upstreamReviewType]}/SKILL.md`
                        }),
                        makeEvent('REVIEWER_DELEGATION_ROUTED', 9, {
                            review_type: upstreamReviewType,
                            reviewer_execution_mode: 'delegated_subagent'
                        }),
                        makeEvent('REVIEW_RECORDED', 10, { review_type: upstreamReviewType }),
                        makeEvent('REVIEW_GATE_PASSED', 11)
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

        it('uses the latest reviewer routing telemetry for repeated review attempts', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:stale-reviewer'
                }, {
                    schema_version: 1,
                    task_sequence: 5,
                    prev_event_sha256: 'a'.repeat(64),
                    event_sha256: 'b'.repeat(64)
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_PHASE_STARTED', 6),
                makeEvent('SKILL_SELECTED', 7, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 8, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 9, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:fresh-reviewer'
                }, {
                    schema_version: 1,
                    task_sequence: 10,
                    prev_event_sha256: 'c'.repeat(64),
                    event_sha256: 'd'.repeat(64)
                }),
                makeEvent('REVIEW_RECORDED', 10, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 11)
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

            assert.equal(result.violations.length, 1, JSON.stringify(result, null, 2));
            assert.ok(result.violations[0].includes('independent reviewer launch attestation'));
            assert.ok(!result.violations.some((entry) => entry.includes('does not match REVIEWER_DELEGATION_ROUTED')));
        });

        it('fails when the latest reviewer routing telemetry records a different reviewer identity', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:fresh-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_PHASE_STARTED', 6),
                makeEvent('SKILL_SELECTED', 7, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 8, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 9, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:stale-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 10, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 11)
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

        it('fails when delegation-required provider records same-agent fallback for a required review', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'testing-strategy' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'testing-strategy',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/testing-strategy/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'test',
                    reviewer_execution_mode: 'same_agent_fallback'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'test' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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

        it('fails when review-context omits canonical_source_of_truth for a required review', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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

        it('fails when LOCAL_AUDITED delegated receipts omit reviewer_provenance', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'code' }),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }, {
                    schema_version: 1,
                    task_sequence: 5,
                    prev_event_sha256: 'a'.repeat(64),
                    event_sha256: 'b'.repeat(64)
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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

        it('normalizes non-canonical delegated LOCAL_AUDITED trust strings before enforcement', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'code' }),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }, {
                    schema_version: 1,
                    task_sequence: 5,
                    prev_event_sha256: 'a'.repeat(64),
                    event_sha256: 'b'.repeat(64)
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'code' }),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }, {
                    schema_version: 1,
                    task_sequence: 5,
                    prev_event_sha256: 'a'.repeat(64),
                    event_sha256: 'b'.repeat(64)
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'code' }),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: 'self:T-123'
                }, {
                    schema_version: 1,
                    task_sequence: 5,
                    prev_event_sha256: 'a'.repeat(64),
                    event_sha256: 'b'.repeat(64)
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'code' }),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
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
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'code' }),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }, {
                    schema_version: 1,
                    task_sequence: 5,
                    prev_event_sha256: 'a'.repeat(64),
                    event_sha256: 'b'.repeat(64)
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'code' }),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'code' }),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }, {
                    schema_version: 1,
                    task_sequence: 5,
                    prev_event_sha256: 'a'.repeat(64),
                    event_sha256: 'b'.repeat(64)
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 6, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }, {
                    schema_version: 1,
                    task_sequence: 7,
                    prev_event_sha256: 'c'.repeat(64),
                    event_sha256: 'd'.repeat(64)
                }),
                makeEvent('REVIEW_RECORDED', 7, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 8)
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

            assert.equal(result.violations.length, 1);
            assert.ok(result.violations[0].includes('independent reviewer launch attestation'));
            assert.ok(!result.violations.some((entry) => entry.includes('does not match REVIEWER_DELEGATION_ROUTED')));
        });

        it('fails when receipt execution mode disagrees with review-context execution mode', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: 'self:T-123'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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

        it('fails when code changed but review telemetry is missing', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('REVIEW_GATE_PASSED', 2)
            ];
            const requiredReviews = { code: true };
            const result = validateReviewSkillEvidence(events, requiredReviews, {}, true, '/T-123.jsonl', 'Codex');
            assert.ok(result.violations.some(v => v.includes('SKILL_SELECTED telemetry') && v.includes("'code'")));
        });

        it('fails when reviewer delegation telemetry is missing', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEW_RECORDED', 4, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 5)
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
            const events = [
                makeEvent('REVIEWER_INVOCATION_ATTESTED', 0, {
                    task_id: 'T-123',
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer',
                    reviewer_identity: 'agent:code-reviewer',
                    review_context_sha256: originalContextSha,
                    routing_event_sha256: routingEventSha
                }, {
                    schema_version: 1,
                    task_sequence: 12,
                    prev_event_sha256: null,
                    event_sha256: invocationEventSha
                }),
                makeEvent('COMPILE_GATE_PASSED', 1),
                makeEvent('REVIEW_PHASE_STARTED', 2, { review_type: 'code' }),
                makeEvent('SKILL_SELECTED', 3, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 4, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEW_RECORDED', 5, {
                    review_type: 'code',
                    reused_existing_review: true,
                    receipt_path: '/reviews/T-123-code-receipt.json',
                    review_context_sha256: currentContextSha,
                    review_artifact_sha256: artifactSha,
                    reused_from_receipt_path: '/reviews/T-123-code-receipt.json',
                    reused_from_review_context_sha256: originalContextSha,
                    reused_from_review_context_reuse_sha256: contextReuseSha
                }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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

        // T-1005: Receipt field presence enforcement tests
        it('fails when receipt is missing reviewer_execution_mode', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: 'self:T-123'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: 'self:T-123'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
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
});

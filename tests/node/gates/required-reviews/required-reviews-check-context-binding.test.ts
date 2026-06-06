import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    checkRequiredReviews,
    validateReviewArtifactGateEligibility,
} from '../../../../src/gates/required-reviews/required-reviews-check';


describe('gates/required-reviews-check', () => {
    describe('validateReviewArtifactGateEligibility', () => {

        it('rejects specialist review contexts that opt out of preflight-required scoped diff metadata', () => {
            const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-eligibility-scoped-'));
            const preflightPath = path.join(tempRoot, 'T-272-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-272',
                scope_category: 'code',
                changed_files: ['src/auth.ts'],
                required_reviews: { security: true },
                budget_forecast: { token_economy_active_for_depth: true },
                risk_aware_depth: { compression: { scoped_diffs: true } }
            }), 'utf8');

            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-272',
                reviewKey: 'security',
                required: true,
                skippedByOverride: false,
                preflightPath,
                preflightSha256: 'abc123',
                reviewArtifact: {
                    path: path.join(tempRoot, 'T-272-security.md'),
                    content: [
                        '# Review',
                        '',
                        'Validated the security review context binding and confirmed the artifact is intentionally non-trivial.',
                        '',
                        '## Findings by Severity',
                        'none',
                        '',
                        '## Residual Risks',
                        'none',
                        '',
                        '## Verdict',
                        'SECURITY REVIEW PASSED'
                    ].join('\n'),
                    reviewContextPath: path.join(tempRoot, 'T-272-security-review-context.json'),
                    reviewContext: {
                        schema_version: 2,
                        task_id: 'T-272',
                        review_type: 'security',
                        preflight_path: preflightPath,
                        preflight_sha256: 'abc123',
                        task_scope: {
                            changed_files: ['src/auth.ts'],
                            diff: { available: true, source: 'fixture', char_count: 120 }
                        },
                        scoped_diff: {
                            expected: false,
                            metadata_path: path.join(tempRoot, 'T-272-security-scoped.json'),
                            metadata: null
                        },
                        reviewer_routing: {
                            source_of_truth: 'Codex',
                            canonical_source_of_truth: 'Codex',
                            execution_provider: 'Codex',
                            execution_provider_source: 'provider_entrypoint',
                            identity_status: 'resolved',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:T-272'
                        }
                    },
                    reviewContextSha256: 'ctx',
                    artifactSha256: 'artifact'
                },
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'provider_entrypoint'
            });

            assert.ok(result.violations.some((violation) => violation.includes('must declare scoped_diff.expected=true')));
            fs.rmSync(tempRoot, { recursive: true, force: true });
        });

        it('rejects a review-context artifact whose review_type does not match the expected review', () => {
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-053',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-053-preflight.json',
                preflightSha256: 'abc123',
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-053-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated the current implementation and found no blocking issues in the scoped change.',
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
                    reviewContextPath: '/repo/garda-agent-orchestrator/runtime/reviews/custom-test-context.json',
                    reviewContext: {
                        schema_version: 2,
                        task_id: 'T-053',
                        review_type: 'test',
                        preflight_path: '/repo/garda-agent-orchestrator/runtime/reviews/T-053-preflight.json',
                        preflight_sha256: 'abc123',
                        reviewer_routing: {
                            source_of_truth: 'Codex',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:test-reviewer'
                        }
                    },
                    reviewContextSha256: 'ctx',
                    artifactSha256: 'artifact'
                },
                sourceOfTruth: 'Codex'
            });

            assert.ok(result.violations.some((violation) => (
                violation.includes('custom-test-context.json') && violation.includes("review_type 'test'")
            )));
        });

        it('requires task and preflight binding metadata for custom review-context paths', () => {
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-053',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-053-preflight.json',
                preflightSha256: 'abc123',
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-053-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated the current implementation and found no blocking issues in the scoped change.',
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
                    reviewContextPath: '/repo/garda-agent-orchestrator/runtime/reviews/custom-code-context.json',
                    reviewContext: {
                        review_type: 'code',
                        reviewer_routing: {
                            source_of_truth: 'Codex',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:test-reviewer'
                        }
                    },
                    reviewContextSha256: 'ctx',
                    artifactSha256: 'artifact'
                },
                sourceOfTruth: 'Codex'
            });

            assert.ok(result.violations.some((violation) => violation.includes('missing task_id')));
            assert.ok(result.violations.some((violation) => violation.includes('missing preflight_path')));
            assert.ok(result.violations.some((violation) => violation.includes('missing preflight_sha256')));
        });

        it('requires task and preflight binding metadata for canonical required review-context paths', () => {
            const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-eligibility-canonical-binding-'));
            const preflightPath = path.join(tempRoot, 'T-272-preflight.json');
            const artifactPath = path.join(tempRoot, 'T-272-code.md');
            const reviewContextPath = path.join(tempRoot, 'T-272-code-review-context.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-272',
                scope_category: 'code',
                changed_files: ['src/app.ts'],
                required_reviews: { code: true }
            }), 'utf8');

            try {
                const result = validateReviewArtifactGateEligibility({
                    resolvedTaskId: 'T-272',
                    reviewKey: 'code',
                    required: true,
                    skippedByOverride: false,
                    preflightPath,
                    preflightSha256: 'abc123',
                    reviewArtifact: {
                        path: artifactPath,
                        content: [
                            '# Review',
                            '',
                            'Validated the required review context binding and confirmed this artifact has meaningful implementation detail.',
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
                        reviewContextPath,
                        reviewContext: {
                            schema_version: 2,
                            review_type: 'code',
                            task_scope: {
                                changed_files: ['src/app.ts'],
                                diff: { available: true, source: 'fixture', char_count: 120 }
                            },
                            reviewer_routing: {
                                source_of_truth: 'Codex',
                                canonical_source_of_truth: 'Codex',
                                execution_provider: 'Codex',
                                execution_provider_source: 'provider_entrypoint',
                                identity_status: 'resolved',
                                actual_execution_mode: 'delegated_subagent',
                                reviewer_session_id: 'agent:T-272'
                            }
                        },
                        reviewContextSha256: 'ctx',
                        artifactSha256: 'artifact'
                    },
                    canonicalSourceOfTruth: 'Codex',
                    executionProvider: 'Codex',
                    executionProviderSource: 'provider_entrypoint'
                });

                assert.ok(result.violations.some((violation) => violation.includes('missing task_id')));
                assert.ok(result.violations.some((violation) => violation.includes('missing preflight_path')));
                assert.ok(result.violations.some((violation) => violation.includes('missing preflight_sha256')));
            } finally {
                fs.rmSync(tempRoot, { recursive: true, force: true });
            }
        });

        it('rejects review-context runtime identity mismatches even when canonical ownership matches', () => {
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-105',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Antigravity',
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated routed execution identity separation across handshake, review-context, and completion enforcement.',
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
                    reviewContextPath: '/repo/garda-agent-orchestrator/runtime/reviews/custom-code-context.json',
                    reviewContext: {
                        schema_version: 2,
                        task_id: 'T-105',
                        review_type: 'code',
                        preflight_path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-preflight.json',
                        preflight_sha256: 'abc123',
                        reviewer_routing: {
                            source_of_truth: 'Antigravity',
                            canonical_source_of_truth: 'Codex',
                            execution_provider: 'Codex',
                            identity_status: 'legacy_fallback',
                            actual_execution_mode: 'same_agent_fallback',
                            reviewer_session_id: 'self:T-105',
                            fallback_reason: 'provider limitation'
                        }
                    },
                    reviewContextSha256: 'ctx',
                    artifactSha256: 'artifact'
                }
            });

            assert.ok(result.violations.some((violation) => violation.includes('execution_provider') && violation.includes('Antigravity')));
            assert.ok(result.violations.some((violation) => violation.includes("runtime identity status must be 'resolved'")));
        });


        it('rejects receipts whose fallback reason diverges from review-context routing metadata', () => {
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-105',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Antigravity',
                executionProviderSource: 'provider_bridge',
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated receipt fallback binding with concrete file references and realistic detail.',
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
                    reviewContextPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-code-review-context.json',
                    reviewContext: {
                        schema_version: 2,
                        task_id: 'T-105',
                        review_type: 'code',
                        preflight_path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-preflight.json',
                        preflight_sha256: 'abc123',
                        reviewer_routing: {
                            source_of_truth: 'Antigravity',
                            canonical_source_of_truth: 'Codex',
                            execution_provider: 'Antigravity',
                            execution_provider_source: 'provider_bridge',
                            identity_status: 'resolved',
                            actual_execution_mode: 'same_agent_fallback',
                            reviewer_session_id: 'self:T-105',
                            fallback_reason: 'provider limitation'
                        }
                    },
                    reviewContextSha256: 'ctx',
                    artifactSha256: 'artifact',
                    receipt: {
                        schema_version: 2,
                        task_id: 'T-105',
                        review_type: 'code',
                        preflight_sha256: 'abc123',
                        scope_sha256: null,
                        review_context_sha256: 'ctx',
                        review_artifact_sha256: 'artifact',
                        reviewer_execution_mode: 'same_agent_fallback',
                        reviewer_identity: 'self:T-105',
                        reviewer_fallback_reason: 'tampered fallback',
                        recorded_at_utc: '2026-01-01T00:00:00.000Z'
                    }
                }
            });

            assert.ok(result.violations.some((violation) => violation.includes('inconsistent fallback reason')));
        });
    });

});

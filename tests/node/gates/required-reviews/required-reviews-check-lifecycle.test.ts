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
    describe('checkRequiredReviews', () => {
        it('fails closed when the task timeline is missing or unreadable', () => {
            const result = checkRequiredReviews({
                validatedPreflight: {
                    errors: [],
                    resolved_task_id: 'T-105',
                    required_reviews: { code: true },
                    preflight_path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-preflight.json',
                    preflight_hash: 'abc123'
                },
                verdicts: { code: 'REVIEW PASSED' },
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'provider_entrypoint',
                reviewArtifacts: {
                    code: {
                        path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-code.md',
                        content: [
                            '# Review',
                            '',
                            'Validated required review evidence with concrete implementation detail and a non-trivial receipt fixture.',
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
                                source_of_truth: 'Codex',
                                canonical_source_of_truth: 'Codex',
                                execution_provider: 'Codex',
                                execution_provider_source: 'provider_entrypoint',
                                identity_status: 'resolved',
                                actual_execution_mode: 'delegated_subagent',
                                reviewer_session_id: 'agent:T-105'
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
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:T-105',
                            reviewer_fallback_reason: null,
                            trust_level: 'LOCAL_AUDITED',
                            reviewer_provenance: {
                                schema_version: 1,
                                attestation_type: 'controller_event_integrity',
                                controller_event_type: 'REVIEWER_DELEGATION_ROUTED',
                                task_sequence: 5,
                                prev_event_sha256: 'a'.repeat(64),
                                event_sha256: 'b'.repeat(64)
                            },
                            recorded_at_utc: '2026-01-01T00:00:00.000Z'
                        }
                    }
                }
            });

            assert.ok(result.violations.some((violation) => violation.includes('Task timeline missing or unreadable')));
        });

        it('does not create review read-barrier directories for missing synthetic receipt paths', () => {
            const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-required-review-synthetic-'));
            const blockedRoot = path.join(tempRoot, 'blocked-root');
            fs.writeFileSync(blockedRoot, 'not a directory', 'utf8');
            const artifactPath = path.join(blockedRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-105-code.md');
            try {
                const result = validateReviewArtifactGateEligibility({
                    resolvedTaskId: 'T-105',
                    reviewKey: 'code',
                    required: true,
                    skippedByOverride: false,
                    preflightPath: artifactPath.replace(/T-105-code\.md$/, 'T-105-preflight.json'),
                    preflightSha256: 'abc123',
                    reviewArtifact: {
                        path: artifactPath,
                        content: [
                            '# Review',
                            '',
                            'Validated the synthetic review artifact path without touching the filesystem outside the test-owned root.',
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
                        reviewContextPath: artifactPath.replace(/\.md$/, '-review-context.json'),
                        reviewContext: {
                            schema_version: 2,
                            task_id: 'T-105',
                            review_type: 'code',
                            preflight_path: artifactPath.replace(/T-105-code\.md$/, 'T-105-preflight.json'),
                            preflight_sha256: 'abc123',
                            tree_state: {
                                tree_state_sha256: 'c'.repeat(64)
                            },
                            reviewer_routing: {
                                source_of_truth: 'Codex',
                                canonical_source_of_truth: 'Codex',
                                execution_provider: 'Codex',
                                execution_provider_source: 'provider_entrypoint',
                                identity_status: 'resolved',
                                actual_execution_mode: 'delegated_subagent',
                                reviewer_session_id: 'agent:T-105'
                            }
                        },
                        reviewContextSha256: 'ctx',
                        artifactSha256: 'artifact'
                    },
                    sourceOfTruth: 'Codex',
                    canonicalSourceOfTruth: 'Codex',
                    executionProvider: 'Codex',
                    executionProviderSource: 'provider_entrypoint'
                });
                assert.ok(
                    result.violations.some((violation) => violation.includes("Verifiable review receipt missing for 'code'")),
                    'synthetic missing receipt should still fail closed without creating lock directories'
                );
            } finally {
                fs.rmSync(tempRoot, { recursive: true, force: true });
            }
        });
    });


    describe('validateReviewArtifactGateEligibility', () => {

        it('rejects unsafe derived receipt paths before fallback reading receipt JSON', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-receipt-root-'));
            const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-receipt-outside-'));
            try {
                const artifactPath = path.join(outsideRoot, 'T-265-code.md');
                const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
                fs.writeFileSync(artifactPath, 'outside artifact\n', 'utf8');
                fs.writeFileSync(receiptPath, '{not-valid-json', 'utf8');

                const result = validateReviewArtifactGateEligibility({
                    resolvedTaskId: 'T-265',
                    reviewKey: 'code',
                    required: true,
                    skippedByOverride: false,
                    repoRoot,
                    canonicalSourceOfTruth: 'Codex',
                    executionProvider: 'Codex',
                    executionProviderSource: 'provider_entrypoint',
                    reviewArtifact: {
                        path: artifactPath,
                        content: [
                            '# Review',
                            '',
                            'Validated the required receipt path hardening with concrete implementation detail.',
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
                        reviewContextPath: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-265-code-review-context.json'),
                        reviewContext: {
                            schema_version: 2,
                            task_id: 'T-265',
                            review_type: 'code',
                            reviewer_routing: {
                                canonical_source_of_truth: 'Codex',
                                execution_provider: 'Codex',
                                execution_provider_source: 'provider_entrypoint',
                                identity_status: 'resolved',
                                actual_execution_mode: 'delegated_subagent',
                                reviewer_session_id: 'agent:T-265'
                            }
                        },
                        reviewContextSha256: 'ctx',
                        artifactSha256: 'artifact'
                    }
                });

                assert.ok(
                    result.violations.some((line) => line.includes("Review receipt path for 'code' must resolve inside repo root")),
                    result.violations.join('\n')
                );
                assert.equal(
                    result.violations.some((line) => line.includes("Review receipt for 'code' is invalid JSON")),
                    false,
                    result.violations.join('\n')
                );
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
                fs.rmSync(outsideRoot, { recursive: true, force: true });
            }
        });

        it('loads preflight payload from path before validating required diff material', () => {
            const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-eligibility-preflight-'));
            const preflightPath = path.join(tempRoot, 'T-272-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-272',
                scope_category: 'code',
                changed_files: ['src/app.ts'],
                required_reviews: { code: true }
            }), 'utf8');

            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-272',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath,
                preflightSha256: 'abc123',
                reviewArtifact: {
                    path: path.join(tempRoot, 'T-272-code.md'),
                    content: [
                        '# Review',
                        '',
                        'Validated the required review context binding and confirmed the artifact is intentionally non-trivial.',
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
                    reviewContextPath: path.join(tempRoot, 'T-272-code-review-context.json'),
                    reviewContext: {
                        schema_version: 2,
                        task_id: 'T-272',
                        review_type: 'code',
                        preflight_path: preflightPath,
                        preflight_sha256: 'abc123',
                        reviewer_routing: {
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

            assert.ok(result.violations.some((violation) => violation.includes('missing task_scope')));
            fs.rmSync(tempRoot, { recursive: true, force: true });
        });


    });

});

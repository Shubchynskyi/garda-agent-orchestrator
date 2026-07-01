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

        it('accepts lane-domain-current historical review evidence without requiring a fresh context binding', () => {
            const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-required-review-lane-domain-'));
            const taskId = 'T-888-lane-domain';
            const reviewsRoot = path.join(tempRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsRoot = path.join(tempRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(eventsRoot, { recursive: true });

            const oldPreflightPath = path.join(reviewsRoot, `${taskId}-old-preflight.json`);
            const currentPreflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            const oldPreflightSha256 = '1'.repeat(64);
            const currentPreflightSha256 = '2'.repeat(64);
            const reviewContextSha256 = '3'.repeat(64);
            const reviewTreeStateSha256 = '4'.repeat(64);
            const artifactSha256 = '5'.repeat(64);
            const routingEventSha256 = '6'.repeat(64);
            const invocationEventSha256 = '7'.repeat(64);
            const providerInvocationId = 'test-subagent-spawn-lane-domain';
            const laneScopeSha256 = '8'.repeat(64);
            const domainScopeFingerprints = {
                schema_version: 1,
                detection_source: 'explicit_changed_files',
                include_untracked: true,
                use_staged: false,
                domains: {},
                legacy: {
                    review_scope_sha256: laneScopeSha256,
                    code_scope_sha256: laneScopeSha256,
                    non_test_review_scope_sha256: laneScopeSha256,
                    code_review_scope_sha256: laneScopeSha256
                }
            };
            const preflightPayload = {
                task_id: taskId,
                detection_source: 'explicit_changed_files',
                include_untracked: true,
                changed_files: ['src/gates/next-step/next-step-review-evidence.ts'],
                required_reviews: { code: true },
                metrics: {
                    domain_scope_fingerprints: domainScopeFingerprints
                }
            };
            fs.writeFileSync(currentPreflightPath, `${JSON.stringify(preflightPayload, null, 2)}\n`, 'utf8');
            fs.writeFileSync(oldPreflightPath, `${JSON.stringify({
                ...preflightPayload,
                changed_files: ['tests/old-review.test.ts']
            }, null, 2)}\n`, 'utf8');

            const timelineEvents = [
                {
                    event_type: 'REVIEW_PHASE_STARTED',
                    details: { review_type: 'code' },
                    integrity: { schema_version: 1, task_sequence: 10, prev_event_sha256: null, event_sha256: 'a'.repeat(64) }
                },
                {
                    event_type: 'REVIEWER_DELEGATION_ROUTED',
                    details: {
                        review_type: 'code',
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_session_id: 'agent:code-reviewer'
                    },
                    integrity: { schema_version: 1, task_sequence: 11, prev_event_sha256: null, event_sha256: routingEventSha256 }
                },
                {
                    event_type: 'REVIEWER_INVOCATION_ATTESTED',
                    details: {
                        task_id: taskId,
                        review_type: 'code',
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_session_id: 'agent:code-reviewer',
                        reviewer_identity: 'agent:code-reviewer',
                        review_context_sha256: reviewContextSha256,
                        review_tree_state_sha256: reviewTreeStateSha256,
                        routing_event_sha256: routingEventSha256,
                        provider_invocation_id: providerInvocationId,
                        reviewer_launch_attestation_source: 'test-subagent-spawn',
                        launch_prepared_at_utc: '2026-05-17T21:00:00.000Z',
                        delegation_started_at_utc: '2026-05-17T21:00:01.000Z',
                        launched_at_utc: '2026-05-17T21:00:01.000Z',
                        launch_completed_at_utc: '2026-05-17T21:00:12.000Z',
                        invocation_attested_at_utc: '2026-05-17T21:00:13.000Z'
                    },
                    integrity: { schema_version: 1, task_sequence: 12, prev_event_sha256: routingEventSha256, event_sha256: invocationEventSha256 }
                },
                {
                    event_type: 'COMPILE_GATE_PASSED',
                    details: { task_id: taskId },
                    integrity: { schema_version: 1, task_sequence: 13, prev_event_sha256: invocationEventSha256, event_sha256: 'b'.repeat(64) }
                }
            ];
            fs.writeFileSync(
                path.join(eventsRoot, `${taskId}.jsonl`),
                `${timelineEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
                'utf8'
            );

            try {
                const result = checkRequiredReviews({
                    validatedPreflight: {
                        errors: [],
                        resolved_task_id: taskId,
                        required_reviews: { code: true },
                        preflight_path: currentPreflightPath,
                        preflight_hash: currentPreflightSha256
                    },
                    preflightPayload,
                    verdicts: { code: 'REVIEW PASSED' },
                    canonicalSourceOfTruth: 'Codex',
                    executionProvider: 'Codex',
                    executionProviderSource: 'explicit_provider',
                    reviewArtifacts: {
                        code: {
                            path: path.join(reviewsRoot, `${taskId}-code.md`),
                            content: [
                                '# Review',
                                '',
                                'Validated `src/gates/next-step/next-step-review-evidence.ts` and `src/gates/required-reviews/required-reviews-check-output.ts` against the lane-domain-current review reuse contract. The review confirmed that the historical review context is intentionally bound to the previous preflight while the current preflight carries the same code-lane domain scope fingerprint.',
                                '',
                                '## Findings by Severity',
                                'None. The direct required-review gate should accept this artifact only because reviewer provenance, tree-state binding, verdict, timing evidence, and lane-domain scope all match.',
                                '',
                                '## Deferred Findings',
                                'none',
                                '',
                                '## Residual Risks',
                                'none',
                                '',
                                '## Verdict',
                                'REVIEW PASSED'
                            ].join('\n'),
                            reviewContextPath: path.join(reviewsRoot, `${taskId}-code-review-context.json`),
                            reviewContextSha256,
                            artifactSha256,
                            reviewContext: {
                                schema_version: 2,
                                task_id: taskId,
                                review_type: 'code',
                                preflight_path: oldPreflightPath,
                                preflight_sha256: oldPreflightSha256,
                                tree_state: {
                                    tree_state_sha256: reviewTreeStateSha256,
                                    domain_scope_fingerprints: domainScopeFingerprints
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
                                task_id: taskId,
                                review_type: 'code',
                                preflight_sha256: oldPreflightSha256,
                                scope_sha256: null,
                                review_context_sha256: reviewContextSha256,
                                review_tree_state_sha256: reviewTreeStateSha256,
                                review_artifact_sha256: artifactSha256,
                                reviewer_execution_mode: 'delegated_subagent',
                                reviewer_identity: 'agent:code-reviewer',
                                reviewer_fallback_reason: null,
                                trust_level: 'INDEPENDENT_AUDITED',
                                reviewer_provenance: {
                                    schema_version: 1,
                                    attestation_type: 'reviewer_invocation_attestation',
                                    controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                                    task_sequence: 12,
                                    prev_event_sha256: routingEventSha256,
                                    event_sha256: invocationEventSha256,
                                    task_id: taskId,
                                    review_type: 'code',
                                    reviewer_execution_mode: 'delegated_subagent',
                                    reviewer_identity: 'agent:code-reviewer',
                                    review_context_sha256: reviewContextSha256,
                                    review_tree_state_sha256: reviewTreeStateSha256,
                                    routing_event_sha256: routingEventSha256,
                                    launch_prepared_at_utc: '2026-05-17T21:00:00.000Z',
                                    delegation_started_at_utc: '2026-05-17T21:00:01.000Z',
                                    launched_at_utc: '2026-05-17T21:00:01.000Z',
                                    launch_completed_at_utc: '2026-05-17T21:00:12.000Z',
                                    invocation_attested_at_utc: '2026-05-17T21:00:13.000Z'
                                },
                                recorded_at_utc: '2026-05-17T21:01:00.000Z',
                                review_result_recorded_at_utc: '2026-05-17T21:01:00.000Z',
                                review_output_source_mtime_utc: '2026-05-17T21:00:59.000Z'
                            }
                        }
                    }
                });

                assert.equal(result.status, 'PASSED', result.violations.join('\n'));
                assert.deepEqual(result.violations, []);
            } finally {
                fs.rmSync(tempRoot, { recursive: true, force: true });
            }
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

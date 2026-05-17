import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    checkRequiredReviews,
    parseSkipReviews,
    resolveExpectedReviewVerdicts,
    testExpectedVerdict,
    REVIEW_CONTRACTS,
    detectZeroDiffFromPreflight,
    validateReviewArtifactGateEligibility,
    validateZeroDiffForReviewGate
} from '../../../src/gates/required-reviews-check';

describe('gates/required-reviews-check', () => {
    describe('parseSkipReviews', () => {
        it('parses comma-separated list', () => {
            assert.deepEqual(parseSkipReviews('code,db,security'), ['code', 'db', 'security']);
        });
        it('parses semicolon-separated list', () => {
            assert.deepEqual(parseSkipReviews('code;db'), ['code', 'db']);
        });
        it('returns empty for empty input', () => {
            assert.deepEqual(parseSkipReviews(''), []);
            assert.deepEqual(parseSkipReviews(null), []);
        });
        it('deduplicates and sorts', () => {
            assert.deepEqual(parseSkipReviews('db,db,api'), ['api', 'db']);
        });
        it('lowercases', () => {
            assert.deepEqual(parseSkipReviews('CODE,DB'), ['code', 'db']);
        });
    });

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

    describe('resolveExpectedReviewVerdicts', () => {
        it('normalizes explicit verdict aliases to canonical review tokens', () => {
            const verdicts = resolveExpectedReviewVerdicts(
                {
                    code: true,
                    db: true
                },
                {
                    code: 'CODE REVIEW PASSED',
                    db: 'DB REVIEW FAILED'
                }
            );

            assert.equal(verdicts.code, 'REVIEW PASSED');
            assert.equal(verdicts.db, 'DB REVIEW FAILED');
        });

        it('does not normalize generic verdict aliases for typed review contracts', () => {
            const verdicts = resolveExpectedReviewVerdicts(
                {
                    security: true
                },
                {
                    security: 'REVIEW PASSED'
                }
            );

            assert.equal(verdicts.security, 'REVIEW PASSED');
        });
    });

    describe('testExpectedVerdict', () => {
        it('adds error when required review not passed', () => {
            const errors: string[] = [];
            testExpectedVerdict(errors, "Review 'code'", true, false, 'NOT_REQUIRED', 'REVIEW PASSED');
            assert.equal(errors.length, 1);
            assert.ok(errors[0].includes("is required"));
        });

        it('accepts pass when required', () => {
            const errors: string[] = [];
            testExpectedVerdict(errors, "Review 'code'", true, false, 'REVIEW PASSED', 'REVIEW PASSED');
            assert.equal(errors.length, 0);
        });

        it('accepts NOT_REQUIRED when not required', () => {
            const errors: string[] = [];
            testExpectedVerdict(errors, "Review 'api'", false, false, 'NOT_REQUIRED', 'API REVIEW PASSED');
            assert.equal(errors.length, 0);
        });

        it('accepts SKIPPED_BY_OVERRIDE when overridden', () => {
            const errors: string[] = [];
            testExpectedVerdict(errors, "Review 'code'", true, true, 'SKIPPED_BY_OVERRIDE', 'REVIEW PASSED');
            assert.equal(errors.length, 0);
        });

        it('rejects unexpected verdict when overridden', () => {
            const errors: string[] = [];
            testExpectedVerdict(errors, "Review 'code'", true, true, 'FAILED', 'REVIEW PASSED');
            assert.equal(errors.length, 1);
            assert.ok(errors[0].includes('override'));
        });
    });

    describe('REVIEW_CONTRACTS', () => {
        it('has 9 review types', () => {
            assert.equal(REVIEW_CONTRACTS.length, 9);
        });
        it('includes code, db, security, refactor, api, test, performance, infra, dependency', () => {
            const types = REVIEW_CONTRACTS.map(([key]) => key);
            assert.ok(types.includes('code'));
            assert.ok(types.includes('db'));
            assert.ok(types.includes('security'));
            assert.ok(types.includes('refactor'));
            assert.ok(types.includes('api'));
            assert.ok(types.includes('test'));
            assert.ok(types.includes('performance'));
            assert.ok(types.includes('infra'));
            assert.ok(types.includes('dependency'));
        });
        it('has matching pass tokens per review', () => {
            const codeContract = REVIEW_CONTRACTS.find(([k]) => k === 'code');
            assert.equal(codeContract![1], 'REVIEW PASSED');
            const dbContract = REVIEW_CONTRACTS.find(([k]) => k === 'db');
            assert.equal(dbContract![1], 'DB REVIEW PASSED');
        });
    });

    describe('detectZeroDiffFromPreflight', () => {
        it('returns true for zero-diff preflight with guard block', () => {
            const preflight = {
                changed_files: [],
                metrics: { changed_lines_total: 0, changed_files_count: 0 },
                zero_diff_guard: { zero_diff_detected: true, status: 'BASELINE_ONLY' }
            };
            assert.equal(detectZeroDiffFromPreflight(preflight), true);
        });

        it('returns true for zero-diff preflight without guard block', () => {
            const preflight = {
                changed_files: [],
                metrics: { changed_lines_total: 0 }
            };
            assert.equal(detectZeroDiffFromPreflight(preflight), true);
        });

        it('returns false when changed files exist', () => {
            const preflight = {
                changed_files: ['src/index.ts'],
                metrics: { changed_lines_total: 10 },
                zero_diff_guard: { zero_diff_detected: false, status: 'DIFF_PRESENT' }
            };
            assert.equal(detectZeroDiffFromPreflight(preflight), false);
        });

        it('returns false when guard explicitly says false even with zero metrics', () => {
            const preflight = {
                changed_files: [],
                metrics: { changed_lines_total: 0 },
                zero_diff_guard: { zero_diff_detected: false, status: 'DIFF_PRESENT' }
            };
            assert.equal(detectZeroDiffFromPreflight(preflight), false);
        });

        it('returns false for null preflight', () => {
            assert.equal(detectZeroDiffFromPreflight(null), false);
        });

        it('returns false when only changed_lines_total is non-zero', () => {
            const preflight = {
                changed_files: [],
                metrics: { changed_lines_total: 5 }
            };
            assert.equal(detectZeroDiffFromPreflight(preflight), false);
        });
    });

    describe('validateZeroDiffForReviewGate', () => {
        it('returns NOT_APPLICABLE when diff is present', () => {
            const preflight = {
                changed_files: ['src/index.ts'],
                metrics: { changed_lines_total: 10 }
            };
            const result = validateZeroDiffForReviewGate(preflight, 'T-902', '/nonexistent-repo');
            assert.equal(result.zero_diff_detected, false);
            assert.equal(result.status, 'NOT_APPLICABLE');
            assert.equal(result.violations.length, 0);
        });

        it('returns REQUIRES_DIFF_OR_NO_OP when zero-diff without no-op artifact', () => {
            const preflight = {
                changed_files: [],
                metrics: { changed_lines_total: 0 },
                zero_diff_guard: { zero_diff_detected: true, status: 'BASELINE_ONLY' }
            };
            const result = validateZeroDiffForReviewGate(preflight, 'T-902', '/nonexistent-repo');
            assert.equal(result.zero_diff_detected, true);
            assert.equal(result.status, 'REQUIRES_DIFF_OR_NO_OP');
            assert.equal(result.violations.length, 1);
            assert.ok(result.violations[0].includes('zero-diff'));
            assert.ok(result.violations[0].includes('T-902'));
        });

        it('violation message includes remediation options', () => {
            const preflight = {
                changed_files: [],
                metrics: { changed_lines_total: 0 }
            };
            const result = validateZeroDiffForReviewGate(preflight, 'T-099', '/nonexistent-repo');
            assert.ok(result.violations[0].includes('record-no-op'));
            assert.ok(result.violations[0].includes('BLOCKED'));
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

        it('rejects review-context artifacts that omit canonical_source_of_truth', () => {
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-105',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated runtime identity routing with concrete file references.',
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
                            execution_provider: 'Codex',
                            identity_status: 'resolved',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:T-105'
                        }
                    },
                    reviewContextSha256: 'ctx',
                    artifactSha256: 'artifact'
                }
            });

            assert.ok(result.violations.some((violation) => violation.includes('missing canonical_source_of_truth')));
        });

        it('rejects review-context artifacts that omit execution_provider_source', () => {
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-105',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'provider_entrypoint',
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated runtime identity routing with concrete file references.',
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
                            identity_status: 'resolved',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:T-105'
                        }
                    },
                    reviewContextSha256: 'ctx',
                    artifactSha256: 'artifact'
                }
            });

            assert.ok(result.violations.some((violation) => violation.includes('missing execution_provider_source')));
        });

        it('rejects review validation when canonical SourceOfTruth is unavailable', () => {
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-105',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: null,
                executionProvider: 'Codex',
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated canonical/runtime binding with concrete file references.',
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
                            identity_status: 'resolved',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:T-105'
                        }
                    },
                    reviewContextSha256: 'ctx',
                    artifactSha256: 'artifact'
                }
            });

            assert.ok(result.violations.some((violation) => violation.includes('missing canonical SourceOfTruth')));
        });

        it('rejects legacy-only routing metadata when explicit identity fields are omitted', () => {
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
                        'Validated split canonical/runtime routing with concrete file references.',
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
                            actual_execution_mode: 'same_agent_fallback',
                            reviewer_session_id: 'self:T-105',
                            fallback_reason: 'legacy fixture'
                        }
                    },
                    reviewContextSha256: 'ctx',
                    artifactSha256: 'artifact'
                }
            });

            assert.ok(result.violations.some((violation) => violation.includes('missing canonical_source_of_truth')));
            assert.ok(result.violations.some((violation) => violation.includes('missing execution_provider')));
            assert.ok(result.violations.some((violation) => violation.includes('missing identity_status')));
        });

        it('keeps legacy review-context identity backfill but blocks missing independent launch attestation', () => {
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-105',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Antigravity',
                allowLegacyReviewContextIdentityFallback: true,
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated resumed legacy provider-bridge review evidence against `src/gates/review-context-routing.ts`, `src/gates/required-reviews-check.ts`, and the routed task-mode backfill path, confirming that legacy routing metadata can still bind safely once runtime identity is reconstructed from the active provider bridge. The review explicitly covers artifact binding, reviewer identity, receipt integrity, and the required-review gate path so it remains concrete and non-trivial.',
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
                        tree_state: {
                            tree_state_sha256: 'a'.repeat(64)
                        },
                        reviewer_routing: {
                            source_of_truth: 'Codex',
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
                        review_tree_state_sha256: 'a'.repeat(64),
                        review_artifact_sha256: 'artifact',
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:T-105',
                        reviewer_fallback_reason: null,
                        recorded_at_utc: '2026-01-01T00:00:00.000Z'
                    }
                }
            });

            assert.equal(result.violations.length, 1);
            assert.ok(result.violations[0].includes('independent reviewer launch attestation'));
            assert.equal(result.reviewerRoutingPolicy?.legacy_identity_compatibility_applied, true);
        });

        it('rejects same_agent_fallback receipts for delegation-required providers when execution runs through a provider bridge', () => {
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-105',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'GitHubCopilot',
                executionProviderSource: 'provider_bridge',
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated reviewer routing policy enforcement with concrete file references and realistic detail.',
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
                            source_of_truth: 'GitHubCopilot',
                            canonical_source_of_truth: 'Codex',
                            execution_provider: 'GitHubCopilot',
                            execution_provider_source: 'provider_bridge',
                            identity_status: 'resolved',
                            actual_execution_mode: 'same_agent_fallback',
                            reviewer_session_id: 'self:T-105',
                            fallback_reason: 'tampered fallback'
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

            assert.ok(result.violations.length > 0);
            assert.ok(result.violations.some((violation) => (
                violation.includes('same_agent_fallback')
                || violation.includes('delegated_subagent')
            )));
        });

        it('rejects same_agent_fallback receipts for direct Codex execution when the provider remains delegation-required', () => {
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-105',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'explicit_provider',
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated direct Codex review routing enforcement with concrete file references and realistic detail.',
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
                            execution_provider_source: 'explicit_provider',
                            identity_status: 'resolved',
                            actual_execution_mode: 'same_agent_fallback',
                            reviewer_session_id: 'self:T-105',
                            fallback_reason: 'tampered fallback'
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

            assert.ok(result.violations.length > 0);
            assert.ok(result.violations.some((violation) => (
                violation.includes('same_agent_fallback')
                || violation.includes('delegated_subagent')
            )));
        });

        it('rejects delegated_subagent review-context artifacts with self-scoped reviewer identities', () => {
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-105',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'provider_entrypoint',
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated reviewer identity scoping with concrete implementation references.',
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
                            reviewer_session_id: 'self:T-105'
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
                        reviewer_identity: 'self:T-105',
                        reviewer_fallback_reason: null,
                        recorded_at_utc: '2026-01-01T00:00:00.000Z'
                    }
                }
            });

            assert.ok(result.violations.some((violation) => violation.includes('reviewer_identity is self-scoped')));
            assert.ok(result.violations.some((violation) => violation.includes('reviewer_session_id is self-scoped')));
        });

        it('rejects LOCAL_AUDITED delegated_subagent receipts without reviewer_provenance', () => {
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-105',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'provider_entrypoint',
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated provenance enforcement with concrete file references and non-trivial detail.',
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
                        recorded_at_utc: '2026-01-01T00:00:00.000Z'
                    }
                }
            });

            assert.ok(result.violations.some((violation) => violation.includes('missing reviewer_provenance')));
        });

        it('normalizes non-canonical delegated LOCAL_AUDITED trust strings before enforcement', () => {
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-105',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'provider_entrypoint',
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated trust normalization through the delegated review receipt path with concrete implementation detail.',
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
                        trust_level: ' local_audited ',
                        recorded_at_utc: '2026-01-01T00:00:00.000Z'
                    }
                }
            });

            assert.ok(result.violations.some((violation) => violation.includes('missing reviewer_provenance')));
        });

        it('rejects same_agent_fallback receipts as deprecated current-cycle evidence even when they claim LOCAL_AUDITED trust', () => {
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-105',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Qwen',
                executionProvider: 'Qwen',
                executionProviderSource: 'provider_entrypoint',
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated trust downgrade enforcement for same-agent fallback receipts with concrete implementation detail.',
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
                            source_of_truth: 'Qwen',
                            canonical_source_of_truth: 'Qwen',
                            execution_provider: 'Qwen',
                            execution_provider_source: 'provider_entrypoint',
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
                        reviewer_fallback_reason: 'provider limitation',
                        trust_level: 'LOCAL_AUDITED',
                        recorded_at_utc: '2026-01-01T00:00:00.000Z'
                    }
                }
            });

            assert.ok(result.violations.some((violation) => violation.includes('deprecated same_agent_fallback evidence')));
        });

        it('rejects delegated LOCAL_AUDITED claims even when routing telemetry carries provider-like launch markers', () => {
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-105',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'provider_entrypoint',
                timelineEvents: [{
                    event_type: 'COMPILE_GATE_PASSED',
                    sequence: 0,
                    details: null,
                    integrity: null
                }, {
                    event_type: 'REVIEW_PHASE_STARTED',
                    sequence: 1,
                    details: { review_type: 'code' },
                    integrity: null
                }, {
                    event_type: 'REVIEWER_DELEGATION_ROUTED',
                    sequence: 2,
                    details: {
                        review_type: 'code',
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_session_id: 'agent:T-105',
                        reviewer_launch_attestation_type: 'provider_artifact',
                        reviewer_launch_artifact_path: '/tmp/provider-artifact.json'
                    },
                    integrity: {
                        schema_version: 1,
                        task_sequence: 3,
                        prev_event_sha256: 'a'.repeat(64),
                        event_sha256: 'b'.repeat(64)
                    }
                }],
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated that current T-134 contract keeps delegated trust asserted-only even when provider-like routing markers are present in local telemetry.',
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
                        reviewer_provenance: {
                            schema_version: 1,
                            attestation_type: 'controller_event_integrity',
                            controller_event_type: 'REVIEWER_DELEGATION_ROUTED',
                            task_sequence: 3,
                            prev_event_sha256: 'a'.repeat(64),
                            event_sha256: 'b'.repeat(64)
                        },
                        trust_level: 'LOCAL_AUDITED',
                        recorded_at_utc: '2026-01-01T00:00:00.000Z'
                    }
                }
            });

            assert.ok(result.violations.some((violation) => violation.includes('cannot claim LOCAL_AUDITED trust')));
        });

        it('rejects delegated_subagent receipts that omit reviewer_provenance even when asserted trust is used', () => {
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-105',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-preflight.json',
                preflightSha256: 'abc123',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'provider_entrypoint',
                timelineEvents: [{
                    event_type: 'COMPILE_GATE_PASSED',
                    sequence: 0,
                    details: null,
                    integrity: null
                }, {
                    event_type: 'REVIEW_PHASE_STARTED',
                    sequence: 1,
                    details: { review_type: 'code' },
                    integrity: null
                }, {
                    event_type: 'REVIEWER_DELEGATION_ROUTED',
                    sequence: 2,
                    details: {
                        review_type: 'code',
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_session_id: 'agent:T-105'
                    },
                    integrity: {
                        schema_version: 1,
                        task_sequence: 3,
                        prev_event_sha256: 'a'.repeat(64),
                        event_sha256: 'b'.repeat(64)
                    }
                }],
                reviewArtifact: {
                    path: '/repo/garda-agent-orchestrator/runtime/reviews/T-105-code.md',
                    content: [
                        '# Review',
                        '',
                        'Validated delegated provenance enforcement with integrity-backed routing telemetry and concrete implementation detail.',
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
                        trust_level: 'LOCAL_ASSERTED',
                        recorded_at_utc: '2026-01-01T00:00:00.000Z'
                    }
                }
            });

            assert.ok(result.violations.some((violation) => violation.includes('missing reviewer_provenance')));
        });

        it('rejects reused review telemetry when the current-cycle REVIEW_RECORDED event has no integrity', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-required-reviews-'));
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const originalContextSha = '1'.repeat(64);
            const currentContextSha = '2'.repeat(64);
            const contextReuseSha = '3'.repeat(64);
            const routingEventSha = '4'.repeat(64);
            const invocationEventSha = '5'.repeat(64);
            const currentTreeStateSha = '6'.repeat(64);
            const originalTreeStateSha = '7'.repeat(64);
            const reviewScopeSha = '8'.repeat(64);
            const codeScopeSha = '9'.repeat(64);
            const originalReceiptSha = 'a'.repeat(64);
            const artifactContent = [
                '# Review',
                '',
                'Validated reused review evidence with concrete implementation detail and a non-trivial receipt fixture.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n');
            const crypto = require('node:crypto');
            const artifactSha = crypto.createHash('sha256').update(artifactContent).digest('hex');
            const artifactPath = path.join(reviewsRoot, 'T-053-code.md');
            const reviewContextPath = path.join(reviewsRoot, 'T-053-code-review-context.json');
            const receiptPath = path.join(reviewsRoot, 'T-053-code-receipt.json');
            const preflightPath = path.join(reviewsRoot, 'T-053-preflight.json');
            fs.writeFileSync(artifactPath, artifactContent, 'utf8');
            fs.writeFileSync(receiptPath, '{}\n', 'utf8');
            const result = validateReviewArtifactGateEligibility({
                resolvedTaskId: 'T-053',
                reviewKey: 'code',
                required: true,
                skippedByOverride: false,
                preflightPath,
                preflightSha256: 'abc123',
                repoRoot,
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'explicit_provider',
                timelineEvents: [
                    {
                        event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        sequence: 0,
                        details: {
                            task_id: 'T-053',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: originalContextSha,
                            review_tree_state_sha256: originalTreeStateSha,
                            routing_event_sha256: routingEventSha
                        },
                        integrity: {
                            schema_version: 1,
                            task_sequence: 12,
                            prev_event_sha256: null,
                            event_sha256: invocationEventSha
                        }
                    },
                    { event_type: 'COMPILE_GATE_PASSED', sequence: 1, details: {}, integrity: null },
                    {
                        event_type: 'REVIEW_RECORDED',
                        sequence: 2,
                        details: {
                            review_type: 'code',
                            reused_existing_review: true,
                            receipt_path: receiptPath.replace(/\\/g, '/'),
                            review_context_sha256: currentContextSha,
                            review_context_reuse_sha256: contextReuseSha,
                            review_tree_state_sha256: currentTreeStateSha,
                            review_scope_sha256: reviewScopeSha,
                            code_scope_sha256: codeScopeSha,
                            review_artifact_sha256: artifactSha,
                            reused_from_receipt_path: receiptPath.replace(/\\/g, '/'),
                            reused_from_receipt_sha256: originalReceiptSha,
                            reused_from_review_context_sha256: originalContextSha,
                            reused_from_review_context_reuse_sha256: contextReuseSha,
                            reused_from_review_tree_state_sha256: originalTreeStateSha,
                            reused_from_review_scope_sha256: reviewScopeSha,
                            reused_from_code_scope_sha256: codeScopeSha
                        },
                        integrity: null
                    }
                ],
                reviewArtifact: {
                    path: artifactPath,
                    content: artifactContent,
                    reviewContextPath,
                    reviewContext: {
                        schema_version: 2,
                        task_id: 'T-053',
                        review_type: 'code',
                        preflight_path: preflightPath,
                        preflight_sha256: 'abc123',
                        tree_state: {
                            tree_state_sha256: currentTreeStateSha
                        },
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
                    reviewContextSha256: currentContextSha,
                    artifactSha256: artifactSha,
                    receipt: {
                        schema_version: 2,
                        task_id: 'T-053',
                        review_type: 'code',
                        preflight_sha256: 'abc123',
                        scope_sha256: null,
                        review_scope_sha256: reviewScopeSha,
                        code_scope_sha256: codeScopeSha,
                        review_context_sha256: currentContextSha,
                        review_context_reuse_sha256: contextReuseSha,
                        review_tree_state_sha256: currentTreeStateSha,
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
                            task_id: 'T-053',
                            review_type: 'code',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            review_context_sha256: originalContextSha,
                            review_tree_state_sha256: originalTreeStateSha,
                            routing_event_sha256: routingEventSha
                        },
                        trust_level: 'INDEPENDENT_AUDITED',
                        reused_existing_review: true,
                        reused_from_receipt_path: receiptPath,
                        reused_from_receipt_sha256: originalReceiptSha,
                        reused_from_review_context_sha256: originalContextSha,
                        reused_from_review_context_reuse_sha256: contextReuseSha,
                        reused_from_review_tree_state_sha256: originalTreeStateSha,
                        reused_from_review_scope_sha256: reviewScopeSha,
                        reused_from_code_scope_sha256: codeScopeSha,
                        recorded_at_utc: '2026-04-28T00:00:00.000Z'
                    }
                }
            });

            assert.ok(result.violations.some((violation) => (
                violation.includes('missing current-cycle REVIEW_RECORDED reuse telemetry')
            )));
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

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

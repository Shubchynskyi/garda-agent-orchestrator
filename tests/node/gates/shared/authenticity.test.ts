import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { isTrivialReview } from '../../../../src/gates/completion';
import { checkRequiredReviews } from '../../../../src/gates/required-reviews/required-reviews-check';

describe('gates/authenticity', () => {
    describe('isTrivialReview', () => {
        it('returns true for very short content', () => {
            assert.equal(isTrivialReview('REVIEW PASSED'), true);
            assert.equal(isTrivialReview('Short review. REVIEW PASSED.'), true);
        });

        it('returns true for boilerplate content with no findings/risks', () => {
            const content = `
# Code Review T-900
## Summary
This is a summary that is long enough to pass the initial length check but contains absolutely no implementation details, no code references, and no findings.
## Findings by Severity
none
## Residual Risks
none
## Verdict
REVIEW PASSED
            `.trim();
            assert.equal(isTrivialReview(content), true);
        });

        it('returns false for meaningful content with code references', () => {
            const content = `
# Code Review T-900
## Summary
The changes in \`src/gates/completion.ts\` correctly implement the triviality check.
The logic handles word count and backtick detection.
## Findings by Severity
none
## Residual Risks
none
## Verdict
REVIEW PASSED
            `.trim();
            // Length > 100 and contains backticks
            assert.equal(isTrivialReview(content), false);
        });

        it('returns false for substantial prose review without backticks when it contains plain file references', () => {
            const content = `
# Code Review T-900
## Summary
Validated src/gates/completion.ts:305 and src/gates/required-reviews-check.ts:219 against the review contract, confirming that the gate now rejects obviously synthetic artifacts but still accepts detailed prose reviews that reference concrete files and lines without markdown code spans.
## Findings by Severity
none
## Residual Risks
none
## Verdict
REVIEW PASSED
            `.trim();
            assert.equal(isTrivialReview(content), false);
        });

        it('returns false for content with findings', () => {
            const content = `
# Code Review T-900
## Summary
I found some issues.
## Findings by Severity
- Low: Missing comment on line 42 in \`src/main.ts\`.
## Residual Risks
none
## Verdict
REVIEW PASSED
            `.trim();
            // Length > 100 and contains meaningful finding
            assert.equal(isTrivialReview(content), false);
        });
    });

    describe('checkRequiredReviews receipt validation', () => {
        const tempDir = path.join(os.tmpdir(), `garda-test-authenticity-${Date.now()}`);

        function writeReviewArtifact(baseName: string, content: string, contextOverride?: Record<string, unknown> | null) {
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            const artifactPath = path.join(tempDir, `${baseName}.md`);
            const receiptPath = path.join(tempDir, `${baseName}-receipt.json`);
            const reviewContextPath = path.join(tempDir, `${baseName}-review-context.json`);
            fs.writeFileSync(artifactPath, content);
            let reviewContextHash: string | null = null;
            if (contextOverride !== null) {
                const inferredReviewType = String(baseName.split('-').pop() || '').trim().toLowerCase() || 'code';
                const reviewContext = contextOverride || {
                    review_type: inferredReviewType,
                    reviewer_routing: {
                        source_of_truth: 'Codex',
                        actual_execution_mode: 'delegated_subagent',
                        reviewer_session_id: 'agent:reviewer-1'
                    }
                };
                if (!Object.prototype.hasOwnProperty.call(reviewContext, 'review_type')) {
                    (reviewContext as Record<string, unknown>).review_type = inferredReviewType;
                }
                const serializedContext = JSON.stringify(reviewContext, null, 2);
                fs.writeFileSync(reviewContextPath, serializedContext);
                reviewContextHash = crypto.createHash('sha256').update(serializedContext).digest('hex');
            }
            return {
                artifactPath,
                receiptPath,
                reviewContextPath,
                reviewContextHash,
                artifactHash: crypto.createHash('sha256').update(content).digest('hex')
            };
        }
        
        it('fails when verifiable receipt is missing for required review', () => {
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            const artifactPath = path.join(tempDir, 'T-900-code.md');
            fs.writeFileSync(artifactPath, '# Review\nREVIEW PASSED\n'.repeat(10));

            const options = {
                validatedPreflight: {
                    errors: [],
                    resolved_task_id: 'T-900',
                    required_reviews: { code: true } as any,
                    preflight_path: 'preflight.json',
                    preflight_hash: 'abc'
                },
                verdicts: { code: 'REVIEW PASSED' },
                reviewArtifacts: {
                    code: {
                        path: artifactPath,
                        content: fs.readFileSync(artifactPath, 'utf8')
                    }
                }
            };

            const result = checkRequiredReviews(options);
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some((entry: string) => entry.includes('Verifiable review receipt missing')));
        });

        it('fails when artifact hash mismatch with receipt', () => {
            const { artifactPath, receiptPath, reviewContextPath, reviewContextHash } = writeReviewArtifact(
                'T-900-hash-mismatch-code',
                '# Original Review\nREVIEW PASSED\n'.repeat(10)
            );
            const receipt = {
                schema_version: 2,
                task_id: 'T-900',
                review_type: 'code',
                review_artifact_sha256: 'fake-hash',
                review_context_sha256: reviewContextHash,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:reviewer-1'
            };
            fs.writeFileSync(receiptPath, JSON.stringify(receipt));

            const options = {
                validatedPreflight: {
                    errors: [],
                    resolved_task_id: 'T-900',
                    required_reviews: { code: true } as any,
                    preflight_path: 'preflight.json',
                    preflight_hash: 'abc'
                },
                verdicts: { code: 'REVIEW PASSED' },
                reviewArtifacts: {
                    code: {
                        path: artifactPath,
                        content: fs.readFileSync(artifactPath, 'utf8'),
                        reviewContext: JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')),
                        reviewContextSha256: reviewContextHash
                    }
                }
            };

            const result = checkRequiredReviews(options);
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some((entry: string) => entry.includes('artifact hash mismatch')));
        });

        it('fails when task_id mismatch in receipt', () => {
            const content = '# Valid Review\nREVIEW PASSED\n'.repeat(10);
            const { artifactPath, receiptPath, reviewContextPath, reviewContextHash, artifactHash } = writeReviewArtifact(
                'T-900-task-mismatch-code',
                content
            );

            const receipt = {
                schema_version: 2,
                task_id: 'WRONG-TASK',
                review_type: 'code',
                review_artifact_sha256: artifactHash,
                review_context_sha256: reviewContextHash,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:reviewer-1'
            };
            fs.writeFileSync(receiptPath, JSON.stringify(receipt));

            const options = {
                validatedPreflight: {
                    errors: [],
                    resolved_task_id: 'T-900',
                    required_reviews: { code: true } as any,
                    preflight_path: 'preflight.json',
                    preflight_hash: 'abc'
                },
                verdicts: { code: 'REVIEW PASSED' },
                reviewArtifacts: {
                    code: {
                        path: artifactPath,
                        content: fs.readFileSync(artifactPath, 'utf8'),
                        reviewContext: JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')),
                        reviewContextSha256: reviewContextHash
                    }
                }
            };

            const result = checkRequiredReviews(options);
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some((entry: string) => entry.includes('different task')));
        });

        it('fails same-agent fallback for direct provider-entrypoint Codex sessions even when an explicit reason is present', () => {
            const content = '# Review\nValidated `src/gates/required-reviews-check.ts` and `src/gates/reviewer-routing.ts` against the direct provider-entrypoint fallback contract, confirming that same-agent fallback stays explicitly attributed, carries a non-empty fallback reason, and does not claim delegated provenance.\n## Findings by Severity\nnone\n## Residual Risks\nnone\n## Verdict\nREVIEW PASSED';
            const reviewContext = {
                reviewer_routing: {
                    source_of_truth: 'Codex',
                    canonical_source_of_truth: 'Codex',
                    execution_provider: 'Codex',
                    execution_provider_source: 'provider_entrypoint',
                    identity_status: 'resolved',
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: 'self:T-901',
                    fallback_reason: 'manual fallback'
                }
            };
            const { artifactPath, receiptPath, artifactHash, reviewContextHash } = writeReviewArtifact('T-901-codex-code', content, reviewContext);
            fs.writeFileSync(receiptPath, JSON.stringify({
                schema_version: 2,
                task_id: 'T-901',
                review_type: 'code',
                review_artifact_sha256: artifactHash,
                review_context_sha256: reviewContextHash,
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: 'self:T-901',
                reviewer_fallback_reason: 'manual fallback',
                trust_level: 'LOCAL_ASSERTED'
            }));
            const runtimeRoot = path.join(tempDir, 'runtime');
            const reviewRuntimeDir = path.join(runtimeRoot, 'reviews');
            const taskEventsDir = path.join(runtimeRoot, 'task-events');
            const preflightPath = path.join(reviewRuntimeDir, 'preflight.json');
            const timelinePath = path.join(taskEventsDir, 'T-901.jsonl');
            fs.mkdirSync(reviewRuntimeDir, { recursive: true });
            fs.mkdirSync(taskEventsDir, { recursive: true });
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: 'T-901' }));
            fs.writeFileSync(
                timelinePath,
                `${JSON.stringify({
                    event_type: 'TASK_MODE_ENTERED',
                    timestamp_utc: '2026-04-22T00:00:00.000Z',
                    details: { task_id: 'T-901' }
                })}\n`
            );

            const result = checkRequiredReviews({
                validatedPreflight: {
                    errors: [],
                    resolved_task_id: 'T-901',
                    required_reviews: { code: true } as any,
                    preflight_path: preflightPath,
                    preflight_hash: 'abc'
                },
                verdicts: { code: 'REVIEW PASSED' },
                sourceOfTruth: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProvider: 'Codex',
                executionProviderSource: 'provider_entrypoint',
                reviewArtifacts: {
                    code: {
                        path: artifactPath,
                        content: fs.readFileSync(artifactPath, 'utf8'),
                        reviewContext,
                        reviewContextSha256: reviewContextHash
                    }
                }
            } as any);

            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some((entry: string) => entry.includes('delegated_subagent') || entry.includes('fallback is not allowed')));
        });

        it('fails delegated review for direct provider-entrypoint Codex sessions without attested launch evidence', () => {
            const content = '# Review\nValidated `src/gates/build-review-context.ts`, `src/gates/required-reviews-check.ts`, and the receipt-backed routing path end to end, confirming that delegated reviewer identity, context hash integrity, and verdict propagation remain consistent across the required review gate.\n## Findings by Severity\nnone\n## Residual Risks\nnone\n## Verdict\nREVIEW PASSED';
            const reviewContext = {
                reviewer_routing: {
                    source_of_truth: 'Codex',
                    actual_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:reviewer-1'
                }
            };
            const { artifactPath, receiptPath, artifactHash, reviewContextHash } = writeReviewArtifact('T-901-codex-pass-code', content, reviewContext);
            fs.writeFileSync(receiptPath, JSON.stringify({
                schema_version: 2,
                task_id: 'T-901',
                review_type: 'code',
                review_artifact_sha256: artifactHash,
                review_context_sha256: reviewContextHash,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:reviewer-1'
            }));

            const result = checkRequiredReviews({
                validatedPreflight: {
                    errors: [],
                    resolved_task_id: 'T-901',
                    required_reviews: { code: true } as any,
                    preflight_path: 'preflight.json',
                    preflight_hash: 'abc'
                },
                verdicts: { code: 'REVIEW PASSED' },
                sourceOfTruth: 'Codex',
                reviewArtifacts: {
                    code: {
                        path: artifactPath,
                        content: fs.readFileSync(artifactPath, 'utf8'),
                        reviewContext,
                        reviewContextSha256: reviewContextHash
                    }
                }
            });

            assert.equal(result.status, 'FAILED');
        });

        it('fails when receipt reviewer execution mode is invalid', () => {
            const content = '# Review\nValidated delegated routing enforcement with concrete file references.\n## Findings by Severity\nnone\n## Residual Risks\nnone\n## Verdict\nREVIEW PASSED';
            const reviewContext = {
                reviewer_routing: {
                    source_of_truth: 'Codex',
                    actual_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:reviewer-1'
                }
            };
            const { artifactPath, receiptPath, artifactHash, reviewContextHash } = writeReviewArtifact('T-901-invalid-mode-code', content, reviewContext);
            fs.writeFileSync(receiptPath, JSON.stringify({
                schema_version: 2,
                task_id: 'T-901',
                review_type: 'code',
                review_artifact_sha256: artifactHash,
                review_context_sha256: reviewContextHash,
                reviewer_execution_mode: 'delegated_magic',
                reviewer_identity: 'agent:reviewer-1'
            }));

            const result = checkRequiredReviews({
                validatedPreflight: {
                    errors: [],
                    resolved_task_id: 'T-901',
                    required_reviews: { code: true } as any,
                    preflight_path: 'preflight.json',
                    preflight_hash: 'abc'
                },
                verdicts: { code: 'REVIEW PASSED' },
                sourceOfTruth: 'Codex',
                reviewArtifacts: {
                    code: {
                        path: artifactPath,
                        content: fs.readFileSync(artifactPath, 'utf8'),
                        reviewContext,
                        reviewContextSha256: reviewContextHash
                    }
                }
            });

            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some((entry: string) => entry.includes('invalid reviewer_execution_mode')));
        });

        it('fails when receipt and review-context identities disagree', () => {
            const content = '# Review\nValidated delegated routing enforcement with concrete file references.\n## Findings by Severity\nnone\n## Residual Risks\nnone\n## Verdict\nREVIEW PASSED';
            const reviewContext = {
                reviewer_routing: {
                    source_of_truth: 'Codex',
                    actual_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:reviewer-1'
                }
            };
            const { artifactPath, receiptPath, artifactHash, reviewContextHash } = writeReviewArtifact('T-901-mismatched-identity-code', content, reviewContext);
            fs.writeFileSync(receiptPath, JSON.stringify({
                schema_version: 2,
                task_id: 'T-901',
                review_type: 'code',
                review_artifact_sha256: artifactHash,
                review_context_sha256: reviewContextHash,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:reviewer-2'
            }));

            const result = checkRequiredReviews({
                validatedPreflight: {
                    errors: [],
                    resolved_task_id: 'T-901',
                    required_reviews: { code: true } as any,
                    preflight_path: 'preflight.json',
                    preflight_hash: 'abc'
                },
                verdicts: { code: 'REVIEW PASSED' },
                sourceOfTruth: 'Codex',
                reviewArtifacts: {
                    code: {
                        path: artifactPath,
                        content: fs.readFileSync(artifactPath, 'utf8'),
                        reviewContext,
                        reviewContextSha256: reviewContextHash
                    }
                }
            });

            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some((entry: string) => entry.includes('inconsistent reviewer identity')));
        });

        it('fails deprecated same_agent_fallback evidence for tampered bridge-backed provider artifacts', () => {
            const content = '# Review\nChecked `src/gate-runtime/lifecycle-events.ts` receipt telemetry integration with concrete file references.\n## Findings by Severity\nnone\n## Residual Risks\nnone\n## Verdict\nREVIEW PASSED';
            const reviewContext = {
                reviewer_routing: {
                    source_of_truth: 'Antigravity',
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: 'self:T-901'
                }
            };
            const { artifactPath, receiptPath, artifactHash, reviewContextHash } = writeReviewArtifact('T-901-antigravity-code', content, reviewContext);
            fs.writeFileSync(receiptPath, JSON.stringify({
                schema_version: 2,
                task_id: 'T-901',
                review_type: 'code',
                review_artifact_sha256: artifactHash,
                review_context_sha256: reviewContextHash,
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: 'self:T-901'
            }));

            const result = checkRequiredReviews({
                validatedPreflight: {
                    errors: [],
                    resolved_task_id: 'T-901',
                    required_reviews: { code: true } as any,
                    preflight_path: 'preflight.json',
                    preflight_hash: 'abc'
                },
                verdicts: { code: 'REVIEW PASSED' },
                sourceOfTruth: 'Antigravity',
                reviewArtifacts: {
                    code: {
                        path: artifactPath,
                        content: fs.readFileSync(artifactPath, 'utf8'),
                        reviewContext,
                        reviewContextSha256: reviewContextHash
                    }
                }
            });

            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some((entry: string) => entry.includes('same_agent_fallback')));
        });

        it('fails deprecated same_agent_fallback evidence for tampered direct-entrypoint provider artifacts', () => {
            const content = '# Review\nChecked `src/gates/reviewer-routing.ts` enforcement with concrete file references.\n## Findings by Severity\nnone\n## Residual Risks\nnone\n## Verdict\nREVIEW PASSED';
            const reviewContext = {
                reviewer_routing: {
                    source_of_truth: 'Qwen',
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: 'self:T-901'
                }
            };
            const { artifactPath, receiptPath, artifactHash, reviewContextHash } = writeReviewArtifact('T-901-single-agent-code', content, reviewContext);
            fs.writeFileSync(receiptPath, JSON.stringify({
                schema_version: 2,
                task_id: 'T-901',
                review_type: 'code',
                review_artifact_sha256: artifactHash,
                review_context_sha256: reviewContextHash,
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: 'self:T-901'
            }));

            const result = checkRequiredReviews({
                validatedPreflight: {
                    errors: [],
                    resolved_task_id: 'T-901',
                    required_reviews: { code: true } as any,
                    preflight_path: 'preflight.json',
                    preflight_hash: 'abc'
                },
                verdicts: { code: 'REVIEW PASSED' },
                sourceOfTruth: 'Qwen',
                reviewArtifacts: {
                    code: {
                        path: artifactPath,
                        content: fs.readFileSync(artifactPath, 'utf8'),
                        reviewContext,
                        reviewContextSha256: reviewContextHash
                    }
                }
            });

            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some((entry: string) => entry.includes('same_agent_fallback')));
        });

        it('fails when review-context artifact hash changes after receipt recording', () => {
            const content = '# Review\nValidated delegated routing enforcement with concrete file references.\n## Findings by Severity\nnone\n## Residual Risks\nnone\n## Verdict\nREVIEW PASSED';
            const { artifactPath, receiptPath, artifactHash } = writeReviewArtifact('T-901-context-hash-code', content);
            const reviewContextContent = JSON.stringify({
                reviewer_routing: {
                    source_of_truth: 'Codex',
                    delegation_required: true
                }
            }, null, 2);
            const originalContextHash = crypto.createHash('sha256').update(reviewContextContent).digest('hex');
            const tamperedContext = JSON.parse(reviewContextContent);
            tamperedContext.reviewer_routing.source_of_truth = 'Gemini';
            const tamperedContextText = JSON.stringify(tamperedContext, null, 2);

            fs.writeFileSync(receiptPath, JSON.stringify({
                schema_version: 2,
                task_id: 'T-901',
                review_type: 'code',
                review_artifact_sha256: artifactHash,
                review_context_sha256: originalContextHash,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:reviewer-1'
            }));

            const result = checkRequiredReviews({
                validatedPreflight: {
                    errors: [],
                    resolved_task_id: 'T-901',
                    required_reviews: { code: true } as any,
                    preflight_path: 'preflight.json',
                    preflight_hash: 'abc'
                },
                verdicts: { code: 'REVIEW PASSED' },
                sourceOfTruth: 'Codex',
                reviewArtifacts: {
                    code: {
                        path: artifactPath,
                        content: fs.readFileSync(artifactPath, 'utf8'),
                        reviewContext: JSON.parse(tamperedContextText),
                        reviewContextSha256: crypto.createHash('sha256').update(tamperedContextText).digest('hex')
                    }
                }
            });

            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some((entry: string) => entry.includes('Review context hash mismatch')));
        });

        it('fails when required review receipt is recorded without a review-context artifact', () => {
            const content = '# Review\nValidated delegated routing enforcement with concrete file references.\n## Findings by Severity\nnone\n## Residual Risks\nnone\n## Verdict\nREVIEW PASSED';
            const { artifactPath, receiptPath, artifactHash } = writeReviewArtifact('T-901-missing-context-code', content);
            fs.writeFileSync(receiptPath, JSON.stringify({
                schema_version: 2,
                task_id: 'T-901',
                review_type: 'code',
                review_artifact_sha256: artifactHash,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:reviewer-1'
            }));

            const result = checkRequiredReviews({
                validatedPreflight: {
                    errors: [],
                    resolved_task_id: 'T-901',
                    required_reviews: { code: true } as any,
                    preflight_path: 'preflight.json',
                    preflight_hash: 'abc'
                },
                verdicts: { code: 'REVIEW PASSED' },
                sourceOfTruth: 'Codex',
                reviewArtifacts: {
                    code: {
                        path: artifactPath,
                        content: fs.readFileSync(artifactPath, 'utf8')
                    }
                }
            });

            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some((entry: string) => entry.includes('review-context')));
        });
    });
});

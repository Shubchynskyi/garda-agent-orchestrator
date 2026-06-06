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


    });

});

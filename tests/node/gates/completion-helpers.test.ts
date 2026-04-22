import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    collectOrderedTimelineEvents,
    extractMarkdownSectionLines,
    isMeaningfulReviewEntry,
    formatCompletionGateResult,
    getFindingsBySeverity,
    isTrivialReview
} from '../../../src/gates/completion';
import { buildReviewTrustSummary } from '../../../src/gates/review-trust-summary';
describe('gates/completion — helpers and formatters', () => {
    describe('collectOrderedTimelineEvents', () => {
        it('continues scanning valid events after an invalid JSON line', () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-completion-timeline-'));
            const timelinePath = path.join(tempDir, 'timeline.jsonl');

            try {
                fs.writeFileSync(
                    timelinePath,
                    [
                        JSON.stringify({ event_type: 'TASK_MODE_ENTERED', timestamp_utc: '2026-01-01T00:00:00.000Z' }),
                        '{"event_type":',
                        JSON.stringify({ event_type: 'COMPILE_GATE_PASSED', timestamp_utc: '2026-01-01T00:02:00.000Z' }),
                        JSON.stringify({ event_type: 'REVIEW_GATE_PASSED', timestamp_utc: '2026-01-01T00:03:00.000Z' })
                    ].join('\n') + '\n',
                    'utf8'
                );

                const errors: string[] = [];
                const events = collectOrderedTimelineEvents(timelinePath, errors);

                assert.equal(errors.length, 1);
                assert.deepEqual(
                    events.map((entry) => entry.event_type),
                    ['TASK_MODE_ENTERED', 'COMPILE_GATE_PASSED', 'REVIEW_GATE_PASSED']
                );
                assert.deepEqual(
                    events.map((entry) => entry.sequence),
                    [0, 2, 3]
                );
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('extractMarkdownSectionLines', () => {
        it('extracts lines under matching heading', () => {
            const lines = [
                '## Introduction',
                'Some intro text.',
                '',
                '## Findings by Severity',
                '- Critical: SQL injection',
                '- High: XSS vulnerability',
                '',
                '## Residual Risks',
                '- None'
            ];
            const result = extractMarkdownSectionLines(lines, 'Findings by Severity');
            assert.ok(result.length >= 2);
            assert.ok(result.some(l => l.includes('Critical')));
        });

        it('stops at next heading', () => {
            const lines = [
                '## Findings by Severity',
                '- Low: minor issue',
                '## Next Section',
                '- irrelevant'
            ];
            const result = extractMarkdownSectionLines(lines, 'Findings by Severity');
            assert.equal(result.length, 1);
        });
    });

    describe('isMeaningfulReviewEntry', () => {
        it('returns false for "none" variations', () => {
            assert.equal(isMeaningfulReviewEntry('none'), false);
            assert.equal(isMeaningfulReviewEntry('N/A'), false);
        });
        it('returns true for real content', () => {
            assert.equal(isMeaningfulReviewEntry('Found a bug'), true);
        });
    });

    describe('formatCompletionGateResult', () => {
        it('includes explicit review trust and policy summary lines when provided', () => {
            const output = formatCompletionGateResult({
                task_id: 'T-1001',
                status: 'PASSED',
                outcome: 'PASS',
                review_artifacts: {
                    code: {
                        receipt: {
                            trust_level: 'LOCAL_AUDITED'
                        }
                    }
                },
                review_trust_summary: {
                    visible_summary_line: 'Review trust: legacy LOCAL_AUDITED claim via delegated_subagent; treat as local historical evidence, not independent audited review.',
                    policy_summary_line: 'Review policy: asserted local review may finish this code task; independent audited review requires separate attestation or human sign-off.'
                }
            });

            assert.match(output, /Review trust: legacy LOCAL_AUDITED claim/);
            assert.match(output, /Review policy: asserted local review may finish this code task/);
            assert.doesNotMatch(output, /TrustStatus:/);
        });

        it('falls back to compatibility trust rendering when legacy review artifacts are present without a structured trust summary', () => {
            const output = formatCompletionGateResult({
                task_id: 'T-1002',
                status: 'FAILED',
                outcome: 'FAIL',
                scope_category: 'code',
                review_artifacts: {
                    code: {
                        content: '# Code Review\nREVIEW PASSED',
                        receipt: {
                            trust_level: 'LOCAL_AUDITED',
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            reviewer_provenance: {
                                schema_version: 1,
                                attestation_type: 'controller_event_integrity',
                                controller_event_type: 'REVIEWER_DELEGATION_ROUTED',
                                task_sequence: 1,
                                prev_event_sha256: null,
                                event_sha256: 'a'.repeat(64)
                            }
                        }
                    }
                }
            });

            assert.match(output, /Review trust: legacy LOCAL_AUDITED claim via DELEGATED_SUBAGENT/);
            assert.match(output, /Review policy: asserted local review may finish this code task/);
        });

        it('keeps an unavailable trust line visible for partial compatibility review artifacts', () => {
            const output = formatCompletionGateResult({
                task_id: 'T-1003',
                status: 'FAILED',
                outcome: 'FAIL',
                scope_category: 'code',
                review_artifacts: {
                    code: {
                        content: '# Code Review\nREVIEW PASSED'
                    }
                }
            });

            assert.match(output, /Review trust: unavailable \(required review trust evidence incomplete or invalid\)\./);
            assert.match(output, /Review policy: asserted local review may finish this code task/);
        });

        it('keeps an unavailable trust line visible for receipt-only compatibility review artifacts', () => {
            const output = formatCompletionGateResult({
                task_id: 'T-1004',
                status: 'FAILED',
                outcome: 'FAIL',
                scope_category: 'code',
                review_artifacts: {
                    code: {
                        receipt: {
                            trust_level: 'LOCAL_ASSERTED',
                            reviewer_execution_mode: 'same_agent_fallback',
                            reviewer_identity: 'self:T-1004',
                            reviewer_fallback_reason: 'provider limitation'
                        }
                    }
                }
            });

            assert.match(output, /Review trust: unavailable \(required review trust evidence incomplete or invalid\)\./);
            assert.match(output, /Review policy: asserted local review may finish this code task/);
        });
    });

    describe('buildReviewTrustSummary', () => {
        it('returns unavailable when required review trust evidence is incomplete', () => {
            const summary = buildReviewTrustSummary([
                {
                    review_type: 'code',
                    trust_level: 'LOCAL_ASSERTED',
                    reviewer_execution_mode: 'same_agent_fallback',
                    reviewer_provenance: null
                }
            ], 'code', 2);

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.match(summary?.visible_summary_line || '', /incomplete or invalid/i);
        });

        it('does not promote non-canonical independent-looking trust payloads', () => {
            const summary = buildReviewTrustSummary([
                {
                    review_type: 'code',
                    trust_level: 'INDEPENDENT_AUDITED',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_provenance: {
                        attestation_type: 'provider_artifact'
                    }
                }
            ], 'code', 1);

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.match(summary?.visible_summary_line || '', /incomplete or invalid/i);
        });

        it('degrades delegated trust receipts that omit reviewer provenance', () => {
            const summary = buildReviewTrustSummary([
                {
                    review_type: 'code',
                    trust_level: 'LOCAL_ASSERTED',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_identity: 'agent:code-reviewer',
                    reviewer_provenance: null
                }
            ], 'code', 1);

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.match(summary?.visible_summary_line || '', /incomplete or invalid/i);
        });

        it('degrades trust receipts with invalid execution mode or missing reviewer identity', () => {
            const summary = buildReviewTrustSummary([
                {
                    review_type: 'code',
                    trust_level: 'LOCAL_ASSERTED',
                    reviewer_execution_mode: 'delegated_magic',
                    reviewer_identity: null,
                    reviewer_provenance: null
                }
            ], 'code', 1);

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.match(summary?.visible_summary_line || '', /incomplete or invalid/i);
        });

        it('degrades same_agent_fallback trust receipts that omit reviewer_fallback_reason', () => {
            const summary = buildReviewTrustSummary([
                {
                    review_type: 'code',
                    trust_level: 'LOCAL_ASSERTED',
                    reviewer_execution_mode: 'same_agent_fallback',
                    reviewer_identity: 'self:T-135',
                    reviewer_fallback_reason: null,
                    reviewer_provenance: null
                }
            ], 'code', 1);

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.match(summary?.visible_summary_line || '', /incomplete or invalid/i);
        });

        it('allows same_agent_fallback trust receipts without reviewer_fallback_reason when policy marks it optional', () => {
            const summary = buildReviewTrustSummary([
                {
                    review_type: 'code',
                    trust_level: 'LOCAL_ASSERTED',
                    reviewer_execution_mode: 'same_agent_fallback',
                    reviewer_identity: 'self:T-135',
                    reviewer_fallback_reason: null,
                    reviewer_fallback_reason_required: false,
                    reviewer_provenance: null
                }
            ], 'code', 1);

            assert.equal(summary?.status, 'ASSERTED_LOCAL_ONLY');
            assert.equal(summary?.independent_review_attested, false);
            assert.match(summary?.visible_summary_line || '', /LOCAL_ASSERTED/i);
        });

        it('degrades delegated_subagent trust receipts with self-scoped reviewer identity', () => {
            const summary = buildReviewTrustSummary([
                {
                    review_type: 'code',
                    trust_level: 'LOCAL_ASSERTED',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_identity: 'self:T-135',
                    reviewer_provenance: {
                        attestation_type: 'provider_artifact'
                    }
                }
            ], 'code', 1);

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.match(summary?.visible_summary_line || '', /incomplete or invalid/i);
        });

        it('degrades same_agent_fallback trust receipts with agent-scoped reviewer identity', () => {
            const summary = buildReviewTrustSummary([
                {
                    review_type: 'code',
                    trust_level: 'LOCAL_ASSERTED',
                    reviewer_execution_mode: 'same_agent_fallback',
                    reviewer_identity: 'agent:code-reviewer',
                    reviewer_fallback_reason: 'provider limitation',
                    reviewer_provenance: null
                }
            ], 'code', 1);

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.match(summary?.visible_summary_line || '', /incomplete or invalid/i);
        });
    });
});

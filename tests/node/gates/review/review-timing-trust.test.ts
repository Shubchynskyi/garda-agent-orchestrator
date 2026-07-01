import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HIDDEN_REVIEW_TIMING_DISTRUST_MESSAGE,
    evaluateHiddenReviewTimingTrust
} from '../../../../src/gates/review/review-timing-trust';

const ROUTING_SHA = '1'.repeat(64);
const INVOCATION_SHA = '2'.repeat(64);

function invocationEvent(overrides: Record<string, unknown> = {}) {
    return {
        event_type: 'REVIEWER_INVOCATION_ATTESTED',
        details: {
            task_id: 'T-564-2',
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: 'agent:code-reviewer',
            review_context_sha256: '3'.repeat(64),
            routing_event_sha256: ROUTING_SHA,
            provider_invocation_id: 'provider-run-1',
            reviewer_launch_attestation_source: 'codex-subagent',
            launch_prepared_at_utc: '2026-05-17T20:00:00.000Z',
            delegation_started_at_utc: '2026-05-17T20:00:01.000Z',
            launched_at_utc: '2026-05-17T20:00:01.000Z',
            launch_completed_at_utc: '2026-05-17T20:00:02.000Z',
            invocation_attested_at_utc: '2026-05-17T20:00:03.000Z',
            ...overrides
        },
        integrity: {
            task_sequence: 12,
            prev_event_sha256: ROUTING_SHA,
            event_sha256: INVOCATION_SHA
        }
    };
}

function provenance(overrides: Record<string, unknown> = {}) {
    return {
        controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
        task_sequence: 12,
        prev_event_sha256: ROUTING_SHA,
        event_sha256: INVOCATION_SHA,
        launch_prepared_at_utc: '2026-05-17T20:00:00.000Z',
        delegation_started_at_utc: '2026-05-17T20:00:01.000Z',
        launched_at_utc: '2026-05-17T20:00:01.000Z',
        launch_completed_at_utc: '2026-05-17T20:00:02.000Z',
        invocation_attested_at_utc: '2026-05-17T20:00:03.000Z',
        ...overrides
    };
}

function reviewRecordedEvent(overrides: Record<string, unknown> = {}) {
    return {
        event_type: 'REVIEW_RECORDED',
        details: {
            task_id: 'T-564-2',
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: 'agent:code-reviewer',
            reviewer_provenance: provenance(),
            reused_existing_review: false,
            recorded_at_utc: '2026-05-17T20:00:30.000Z',
            ...overrides
        },
        integrity: {
            task_sequence: 13,
            prev_event_sha256: INVOCATION_SHA,
            event_sha256: '8'.repeat(64)
        }
    };
}

test('review timing trust rejects missing timing with generic remediation only', () => {
    const result = evaluateHiddenReviewTimingTrust({
        reviewType: 'code',
        reusedExistingReview: false,
        reviewerProvenance: provenance({ launch_prepared_at_utc: null }),
        recordedAtUtc: '2026-05-17T20:00:30.000Z',
        timelineEvents: [invocationEvent({ launch_prepared_at_utc: null })],
        nowMs: Date.parse('2026-05-17T20:01:00.000Z')
    });

    assert.equal(result.trusted, false);
    assert.equal(result.code, 'missing_timing');
    assert.equal(result.message, HIDDEN_REVIEW_TIMING_DISTRUST_MESSAGE);
    assert.equal(/timing|threshold|seconds|elapsed|duration/i.test(result.message || ''), false);
});

test('review timing trust re-evaluates reused review evidence instead of skipping hidden distrust', () => {
    const result = evaluateHiddenReviewTimingTrust({
        reviewType: 'code',
        reusedExistingReview: true,
        reviewerProvenance: provenance({ launch_prepared_at_utc: null }),
        recordedAtUtc: '2026-05-17T20:00:30.000Z',
        timelineEvents: [invocationEvent({ launch_prepared_at_utc: null })],
        nowMs: Date.parse('2026-05-17T20:01:00.000Z')
    });

    assert.equal(result.trusted, false);
    assert.equal(result.code, 'missing_timing');
    assert.equal(result.message, HIDDEN_REVIEW_TIMING_DISTRUST_MESSAGE);
    assert.equal(/timing|threshold|seconds|elapsed|duration/i.test(result.message || ''), false);
});

test('review timing trust uses historical review-recorded timing for reused evidence', () => {
    const historicalProvenance = provenance({
        launch_completed_at_utc: '2026-05-17T20:00:12.000Z',
        invocation_attested_at_utc: '2026-05-17T20:00:13.000Z'
    });
    const historicalReviewRecordedDetails = reviewRecordedEvent({
        reviewer_provenance: historicalProvenance,
        recorded_at_utc: null,
        review_result_recorded_at_utc: null
    }).details;
    const result = evaluateHiddenReviewTimingTrust({
        reviewType: 'code',
        reusedExistingReview: true,
        reviewerProvenance: historicalProvenance,
        recordedAtUtc: '2026-05-17T20:10:00.000Z',
        strictReusedReviewRecordedDetails: historicalReviewRecordedDetails,
        timelineEvents: [
            invocationEvent({
                launch_completed_at_utc: '2026-05-17T20:00:12.000Z',
                invocation_attested_at_utc: '2026-05-17T20:00:13.000Z'
            })
        ],
        nowMs: Date.parse('2026-05-17T20:11:00.000Z')
    });

    assert.equal(result.trusted, false);
    assert.equal(result.code, 'missing_timing');
    assert.equal(result.message, HIDDEN_REVIEW_TIMING_DISTRUST_MESSAGE);
});

test('review timing trust rejects reused evidence when original review-recorded timing is unavailable', () => {
    const historicalProvenance = provenance({
        launch_completed_at_utc: '2026-05-17T20:00:12.000Z',
        invocation_attested_at_utc: '2026-05-17T20:00:13.000Z'
    });
    const result = evaluateHiddenReviewTimingTrust({
        reviewType: 'code',
        reusedExistingReview: true,
        reviewerProvenance: historicalProvenance,
        recordedAtUtc: '2026-05-17T20:10:00.000Z',
        timelineEvents: [
            invocationEvent({
                launch_completed_at_utc: '2026-05-17T20:00:12.000Z',
                invocation_attested_at_utc: '2026-05-17T20:00:13.000Z'
            }),
            reviewRecordedEvent({
                reused_existing_review: true,
                reviewer_provenance: historicalProvenance,
                recorded_at_utc: '2026-05-17T20:00:30.000Z',
                review_result_recorded_at_utc: '2026-05-17T20:00:30.000Z'
            })
        ],
        nowMs: Date.parse('2026-05-17T20:11:00.000Z')
    });

    assert.equal(result.trusted, false);
    assert.equal(result.code, 'missing_timing');
    assert.equal(result.message, HIDDEN_REVIEW_TIMING_DISTRUST_MESSAGE);
});

test('review timing trust rejects too-short review result without strong provider evidence', () => {
    const result = evaluateHiddenReviewTimingTrust({
        reviewType: 'security',
        reusedExistingReview: false,
        reviewerProvenance: provenance(),
        reviewResultRecordedAtUtc: '2026-05-17T20:00:05.000Z',
        timelineEvents: [
            invocationEvent({
                review_type: 'security',
                provider_invocation_id: 'controller-local-1',
                reviewer_launch_attestation_source: 'controller'
            })
        ],
        nowMs: Date.parse('2026-05-17T20:01:00.000Z')
    });

    assert.equal(result.trusted, false);
    assert.equal(result.code, 'too_short_without_strong_provider_evidence');
});

test('review timing trust rejects reused historical reviews that were too short', () => {
    const historicalProvenance = provenance({
        launch_completed_at_utc: '2026-05-17T20:00:04.000Z',
        invocation_attested_at_utc: '2026-05-17T20:00:04.500Z'
    });
    const historicalReviewRecordedDetails = reviewRecordedEvent({
        review_type: 'security',
        reviewer_provenance: historicalProvenance,
        recorded_at_utc: '2026-05-17T20:00:05.000Z'
    }).details;
    const result = evaluateHiddenReviewTimingTrust({
        reviewType: 'security',
        reusedExistingReview: true,
        reviewerProvenance: historicalProvenance,
        recordedAtUtc: '2026-05-17T20:10:00.000Z',
        strictReusedReviewRecordedDetails: historicalReviewRecordedDetails,
        timelineEvents: [
            invocationEvent({
                review_type: 'security',
                provider_invocation_id: 'controller-local-1',
                reviewer_launch_attestation_source: 'controller',
                launch_completed_at_utc: '2026-05-17T20:00:04.000Z',
                invocation_attested_at_utc: '2026-05-17T20:00:04.500Z'
            })
        ],
        nowMs: Date.parse('2026-05-17T20:11:00.000Z')
    });

    assert.equal(result.trusted, false);
    assert.equal(result.code, 'too_short_without_strong_provider_evidence');
});

test('review timing trust rejects reused output artifacts older than the original reviewer launch', () => {
    const historicalProvenance = provenance();
    const historicalReviewRecordedDetails = reviewRecordedEvent({
        reviewer_provenance: historicalProvenance,
        recorded_at_utc: '2026-05-17T20:00:30.000Z',
        review_result_recorded_at_utc: '2026-05-17T20:00:30.000Z',
        review_output_source_mtime_utc: '2026-05-17T19:59:59.000Z'
    }).details;
    const result = evaluateHiddenReviewTimingTrust({
        reviewType: 'code',
        reusedExistingReview: true,
        reviewerProvenance: historicalProvenance,
        recordedAtUtc: '2026-05-17T20:10:00.000Z',
        strictReusedReviewRecordedDetails: historicalReviewRecordedDetails,
        timelineEvents: [invocationEvent()],
        nowMs: Date.parse('2026-05-17T20:11:00.000Z')
    });

    assert.equal(result.trusted, false);
    assert.equal(result.code, 'impossible_ordering');
    assert.equal(result.message, HIDDEN_REVIEW_TIMING_DISTRUST_MESSAGE);
});

test('review timing trust rejects Chronobot-shaped generic Antigravity review metadata', () => {
    const result = evaluateHiddenReviewTimingTrust({
        reviewType: 'db',
        reusedExistingReview: false,
        reviewerProvenance: provenance({
            delegation_started_at_utc: '2026-05-28T09:05:34.903Z',
            launched_at_utc: '2026-05-28T09:05:34.903Z',
            launch_completed_at_utc: '2026-05-28T09:05:35.095Z',
            invocation_attested_at_utc: '2026-05-28T09:05:35.300Z'
        }),
        reviewResultRecordedAtUtc: '2026-05-28T09:05:46.740Z',
        timelineEvents: [
            invocationEvent({
                review_type: 'db',
                reviewer_identity: 'agent:t088-db-reviewer-v1',
                reviewer_session_id: 'agent:t088-db-reviewer-v1',
                provider_invocation_id: 'agent:t088-db-reviewer-v1',
                reviewer_launch_attestation_source: 'provider_subagent',
                delegation_started_at_utc: '2026-05-28T09:05:34.903Z',
                launched_at_utc: '2026-05-28T09:05:34.903Z',
                launch_completed_at_utc: '2026-05-28T09:05:35.095Z',
                invocation_attested_at_utc: '2026-05-28T09:05:35.300Z'
            })
        ],
        nowMs: Date.parse('2026-05-28T09:06:30.000Z')
    });

    assert.equal(result.trusted, false);
    assert.equal(result.code, 'too_short_delegated_work_window');
    assert.equal(result.message, HIDDEN_REVIEW_TIMING_DISTRUST_MESSAGE);
});

test('review timing trust treats generic provider_subagent source as weak even with non-agent invocation id', () => {
    const result = evaluateHiddenReviewTimingTrust({
        reviewType: 'refactor',
        reusedExistingReview: false,
        reviewerProvenance: provenance(),
        recordedAtUtc: '2026-05-17T20:00:30.000Z',
        timelineEvents: [
            invocationEvent({
                review_type: 'refactor',
                provider_invocation_id: 'provider-run-weak-1',
                reviewer_launch_attestation_source: 'provider_subagent'
            })
        ],
        nowMs: Date.parse('2026-05-17T20:01:00.000Z')
    });

    assert.equal(result.trusted, false);
    assert.equal(result.code, 'too_short_delegated_work_window');
});

test('review timing trust accepts weak-provider evidence after the hidden baseline', () => {
    const result = evaluateHiddenReviewTimingTrust({
        reviewType: 'test',
        reusedExistingReview: false,
        reviewerProvenance: provenance({
            launch_completed_at_utc: '2026-05-17T20:00:15.000Z',
            invocation_attested_at_utc: '2026-05-17T20:00:16.000Z'
        }),
        recordedAtUtc: '2026-05-17T20:00:32.000Z',
        timelineEvents: [
            invocationEvent({
                review_type: 'test',
                provider_invocation_id: 'provider-run-weak-2',
                reviewer_launch_attestation_source: 'provider_subagent',
                launch_completed_at_utc: '2026-05-17T20:00:15.000Z',
                invocation_attested_at_utc: '2026-05-17T20:00:16.000Z'
            })
        ],
        nowMs: Date.parse('2026-05-17T20:03:00.000Z')
    });

    assert.equal(result.trusted, true);
    assert.equal(result.code, null);
});

test('review timing trust accepts short review with concrete provider-native invocation evidence', () => {
    const result = evaluateHiddenReviewTimingTrust({
        reviewType: 'code',
        reusedExistingReview: false,
        reviewerProvenance: provenance({
            launch_completed_at_utc: '2026-05-17T20:00:12.000Z',
            invocation_attested_at_utc: '2026-05-17T20:00:13.000Z'
        }),
        recordedAtUtc: '2026-05-17T20:00:20.000Z',
        timelineEvents: [
            invocationEvent({
                provider_invocation_id: 'codex-run-20260517-abc123',
                reviewer_launch_attestation_source: 'codex.spawn_agent',
                launch_completed_at_utc: '2026-05-17T20:00:12.000Z',
                invocation_attested_at_utc: '2026-05-17T20:00:13.000Z'
            })
        ],
        nowMs: Date.parse('2026-05-17T20:01:00.000Z')
    });

    assert.equal(result.trusted, true);
    assert.equal(result.code, null);
});

test('review timing trust rejects instant delegated-work windows even with concrete provider-native invocation evidence', () => {
    const result = evaluateHiddenReviewTimingTrust({
        reviewType: 'code',
        reusedExistingReview: false,
        reviewerProvenance: provenance(),
        recordedAtUtc: '2026-05-17T20:00:20.000Z',
        timelineEvents: [
            invocationEvent({
                provider_invocation_id: 'codex-run-20260517-short-window',
                reviewer_launch_attestation_source: 'codex.spawn_agent'
            })
        ],
        nowMs: Date.parse('2026-05-17T20:01:00.000Z')
    });

    assert.equal(result.trusted, false);
    assert.equal(result.code, 'too_short_delegated_work_window');
    assert.equal(result.message, HIDDEN_REVIEW_TIMING_DISTRUST_MESSAGE);
});

test('review timing trust accepts observed short Gemini invocation evidence', () => {
    const result = evaluateHiddenReviewTimingTrust({
        reviewType: 'db',
        reusedExistingReview: false,
        reviewerProvenance: provenance({
            launch_completed_at_utc: '2026-05-17T20:00:11.000Z',
            invocation_attested_at_utc: '2026-05-17T20:00:12.000Z'
        }),
        recordedAtUtc: '2026-05-17T20:00:13.000Z',
        timelineEvents: [
            invocationEvent({
                review_type: 'db',
                provider_invocation_id: 'invocation:generalist:T-063-db-v4',
                reviewer_launch_attestation_source: 'gemini',
                launch_completed_at_utc: '2026-05-17T20:00:11.000Z',
                invocation_attested_at_utc: '2026-05-17T20:00:12.000Z'
            })
        ],
        nowMs: Date.parse('2026-05-17T20:01:00.000Z')
    });

    assert.equal(result.trusted, true);
    assert.equal(result.code, null);
});

test('review timing trust rejects provider invocation id reuse across lanes', () => {
    const result = evaluateHiddenReviewTimingTrust({
        reviewType: 'code',
        reusedExistingReview: false,
        reviewerProvenance: provenance(),
        recordedAtUtc: '2026-05-17T20:00:30.000Z',
        timelineEvents: [
            { event_type: 'COMPILE_GATE_PASSED', details: {}, integrity: { task_sequence: 9, prev_event_sha256: null, event_sha256: '9'.repeat(64) } },
            {
                ...invocationEvent({
                    review_type: 'test',
                    provider_invocation_id: 'provider-run-1'
                }),
                integrity: {
                    task_sequence: 11,
                    prev_event_sha256: ROUTING_SHA,
                    event_sha256: '4'.repeat(64)
                }
            },
            invocationEvent()
        ],
        latestCompileSequence: 9,
        nowMs: Date.parse('2026-05-17T20:01:00.000Z')
    });

    assert.equal(result.trusted, false);
    assert.equal(result.code, 'duplicate_provider_invocation_id');
});

test('review timing trust rejects reused provider invocation id reuse before current compile', () => {
    const historicalProvenance = provenance({
        launch_completed_at_utc: '2026-05-17T20:00:12.000Z',
        invocation_attested_at_utc: '2026-05-17T20:00:13.000Z'
    });
    const historicalReviewRecordedDetails = reviewRecordedEvent({
        reviewer_provenance: historicalProvenance,
        recorded_at_utc: '2026-05-17T20:00:30.000Z',
        review_result_recorded_at_utc: '2026-05-17T20:00:30.000Z'
    }).details;
    const result = evaluateHiddenReviewTimingTrust({
        reviewType: 'code',
        reusedExistingReview: true,
        reviewerProvenance: historicalProvenance,
        recordedAtUtc: '2026-05-17T20:00:30.000Z',
        strictReusedReviewRecordedDetails: historicalReviewRecordedDetails,
        timelineEvents: [
            {
                ...invocationEvent({
                    review_type: 'test',
                    provider_invocation_id: 'provider-run-1'
                }),
                integrity: {
                    task_sequence: 5,
                    prev_event_sha256: ROUTING_SHA,
                    event_sha256: '4'.repeat(64)
                }
            },
            invocationEvent({
                launch_completed_at_utc: '2026-05-17T20:00:12.000Z',
                invocation_attested_at_utc: '2026-05-17T20:00:13.000Z'
            })
        ],
        latestCompileSequence: 9,
        nowMs: Date.parse('2026-05-17T20:01:00.000Z')
    });

    assert.equal(result.trusted, false);
    assert.equal(result.code, 'duplicate_provider_invocation_id');
});

test('review timing trust rejects output artifacts older than reviewer launch when mtime is available', () => {
    const result = evaluateHiddenReviewTimingTrust({
        reviewType: 'code',
        reusedExistingReview: false,
        reviewerProvenance: provenance(),
        reviewOutputSourceMtimeUtc: '2026-05-17T19:59:59.000Z',
        recordedAtUtc: '2026-05-17T20:00:30.000Z',
        timelineEvents: [invocationEvent()],
        nowMs: Date.parse('2026-05-17T20:01:00.000Z')
    });

    assert.equal(result.trusted, false);
    assert.equal(result.code, 'impossible_ordering');
    assert.equal(result.message, HIDDEN_REVIEW_TIMING_DISTRUST_MESSAGE);
});

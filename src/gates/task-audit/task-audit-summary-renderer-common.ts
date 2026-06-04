import type { FinalCloseoutArtifact } from './task-audit-summary';

export type ReviewIntegrityAttestation = NonNullable<FinalCloseoutArtifact['review_integrity_attestation']>;
export type ReviewTimingAuditEntry = NonNullable<FinalCloseoutArtifact['review_timing_audit']>['entries'][number];

export function buildFallbackReviewIntegrityAttestation(closeout: FinalCloseoutArtifact): ReviewIntegrityAttestation {
    const reviewVerdictCount = Object.keys(closeout.implementation_summary.review_verdicts || {}).length;
    const reason = 'Legacy final closeout artifact lacks the mandatory review integrity attestation; completion is not review-attested.';
    return {
        schema_version: 1, enforcement_mode: 'BLOCKING', status: 'DEGRADED_OR_UNVERIFIABLE', required_review_count: reviewVerdictCount,
        required_review_types: Object.keys(closeout.implementation_summary.review_verdicts || {}).sort(),
        independent_review_completed: false, completion_review_attested: false, completion_review_attestation_not_required: false, completion_allowed: false,
        fake_or_fallback_artifacts_observed: false, same_agent_fallback_observed: false, fallback_artifacts_observed: false,
        legacy_local_review_observed: true, missing_or_unverifiable_artifacts_observed: true, fabricated_artifacts_observed: false,
        observed_issues: ['legacy final closeout artifact lacks review integrity attestation'], reason,
        visible_summary_line:
            'Review integrity: DEGRADED_OR_UNVERIFIABLE; independent_review_completed=no; ' +
            'completion_review_attested=no; completion_allowed=no; fake/fallback/unverifiable artifacts observed=yes; enforcement=blocking.',
        final_report_lines: [
            'Review integrity: DEGRADED_OR_UNVERIFIABLE.',
            'Review integrity enforcement: blocking; final closeout is blocked until mandatory review trust is independently attested.',
            'Independent review completed: no.',
            'Completion review-attested: no.',
            'Fake/fallback artifacts observed: no.',
            'Same-agent fallback observed: no.',
            'Fallback artifacts observed: no.',
            'Legacy local review observed: yes.',
            'Missing/unverifiable artifacts observed: yes.',
            'Fabricated artifacts observed: no.',
            `Completion allowed: no. Reason: ${reason}`
        ]
    };
}

export function getReviewIntegrityAttestation(closeout: FinalCloseoutArtifact): ReviewIntegrityAttestation {
    return closeout.review_integrity_attestation || buildFallbackReviewIntegrityAttestation(closeout);
}

export function shouldRenderReviewTrustSummary(
    closeout: FinalCloseoutArtifact,
    reviewIntegrityAttestation: ReviewIntegrityAttestation
): boolean {
    if (!closeout.review_trust) {
        return false;
    }
    if (
        reviewIntegrityAttestation.completion_review_attested ||
        reviewIntegrityAttestation.completion_review_attestation_not_required ||
        reviewIntegrityAttestation.status === 'NO_REVIEW_REQUIRED'
    ) {
        return true;
    }
    return closeout.review_trust.independent_review_attested !== true;
}

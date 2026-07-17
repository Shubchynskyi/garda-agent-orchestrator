import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildReviewReceiptReviewerInvocationProvenance,
    providerInvocationProvenanceMatchesEventDetails
} from '../../../src/gate-runtime/review-context';

const eventSha256 = 'a'.repeat(64);
const routingEventSha256 = 'b'.repeat(64);
const treeStateSha256 = 'c'.repeat(64);
const launchBindingSha256 = 'd'.repeat(64);
const launchInputSha256 = 'e'.repeat(64);
const reviewerLaunchAttemptId = '12345678-1234-4123-8123-123456789abc';

function buildInvocationDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        task_id: 'T-979-24',
        review_type: 'security',
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: 'agent:reviewer-24',
        review_context_sha256: 'f'.repeat(64),
        review_tree_state_sha256: treeStateSha256,
        routing_event_sha256: routingEventSha256,
        provider_invocation_attestation_status: 'authenticated',
        provider_invocation_attestation_id: 'provider-attestation-24',
        provider_invocation_attestation_source: 'codex_spawn_agent',
        provider_invocation_id: 'provider-invocation-24',
        reviewer_launch_attempt_id: reviewerLaunchAttemptId,
        launch_binding_sha256: launchBindingSha256,
        launch_input_mode: 'launch_artifact_path',
        launch_input_sha256: launchInputSha256,
        provider_invocation_attested_at_utc: '2026-07-16T22:00:00.000Z',
        ...overrides
    };
}

function buildProvenance(details = buildInvocationDetails()) {
    return buildReviewReceiptReviewerInvocationProvenance(
        'REVIEWER_INVOCATION_ATTESTED',
        {
            schema_version: 1,
            task_sequence: 12,
            prev_event_sha256: null,
            event_sha256: eventSha256
        },
        details
    );
}

test('provider invocation provenance preserves the authenticated immutable launch attempt', () => {
    const details = buildInvocationDetails();
    const provenance = buildProvenance(details);

    assert.equal(provenance?.attestation_type, 'reviewer_invocation_attestation');
    if (provenance?.attestation_type !== 'reviewer_invocation_attestation') {
        assert.fail('Expected reviewer invocation provenance.');
    }
    assert.deepEqual(provenance.provider_invocation, {
        schema_version: 1,
        attestation_status: 'authenticated',
        attestation_id: 'provider-attestation-24',
        attestation_source: 'codex_spawn_agent',
        invocation_kind: 'provider',
        invocation_id: 'provider-invocation-24',
        reviewer_launch_attempt_id: reviewerLaunchAttemptId,
        launch_binding_sha256: launchBindingSha256,
        launch_input_mode: 'launch_artifact_path',
        launch_input_sha256: launchInputSha256,
        authenticated_at_utc: '2026-07-16T22:00:00.000Z'
    });
    assert.equal(
        providerInvocationProvenanceMatchesEventDetails(provenance.provider_invocation!, details),
        true
    );
});

test('provider invocation provenance fails closed for missing or non-authenticated evidence', () => {
    assert.equal(buildProvenance(buildInvocationDetails({ provider_invocation_attestation_id: null })), null);
    assert.equal(buildProvenance(buildInvocationDetails({ provider_invocation_attestation_status: 'not_found' })), null);
});

test('provider invocation provenance rejects a different, deleted, or superseded attempt binding', () => {
    const provenance = buildProvenance();
    assert.ok(provenance?.attestation_type === 'reviewer_invocation_attestation');
    if (provenance?.attestation_type !== 'reviewer_invocation_attestation' || !provenance.provider_invocation) {
        assert.fail('Expected authenticated provider invocation provenance.');
    }

    assert.equal(providerInvocationProvenanceMatchesEventDetails(
        provenance.provider_invocation,
        buildInvocationDetails({ provider_invocation_id: 'deleted-provider-invocation' })
    ), false);
    assert.equal(providerInvocationProvenanceMatchesEventDetails(
        provenance.provider_invocation,
        buildInvocationDetails({ reviewer_launch_attempt_id: '87654321-4321-4321-8321-cba987654321' })
    ), false);
    assert.equal(providerInvocationProvenanceMatchesEventDetails(
        provenance.provider_invocation,
        buildInvocationDetails({ launch_binding_sha256: '0'.repeat(64) })
    ), false);
});

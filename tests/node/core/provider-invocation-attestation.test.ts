import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    authenticateProviderInvocation,
    registerProviderInvocationAttestationAdapter,
    type ProviderInvocationAttestationRequest,
    type ProviderInvocationAttestationResult
} from '../../../src/core/provider/provider-invocation-attestation';

function requestFor(source: string): ProviderInvocationAttestationRequest {
    return {
        taskId: 'T-979-23',
        reviewType: 'security',
        reviewerLaunchAttemptId: 'attempt-23',
        invocationKind: 'provider',
        invocationId: 'provider-invocation-23',
        attestationSource: source,
        expectedReviewerIdentity: 'agent:reviewer-23',
        expectedFreshContextMode: 'non_forked',
        expectedLaunchInputMode: 'launch_artifact_path',
        expectedLaunchInputSha256: 'a'.repeat(64),
        launchPreparedAtUtc: '2026-07-16T10:00:00.000Z',
        requestedAtUtc: '2026-07-16T10:01:00.000Z',
        constraints: {
            allowNetwork: false,
            allowPaidOperations: false,
            maximumLaunchAgeMs: 30 * 60 * 1000
        }
    };
}

function existingResult(request: ProviderInvocationAttestationRequest): ProviderInvocationAttestationResult {
    return {
        status: 'existing',
        attestation: {
            attestationId: `attestation:${request.invocationId}`,
            taskId: request.taskId,
            reviewType: request.reviewType,
            reviewerLaunchAttemptId: request.reviewerLaunchAttemptId,
            invocationKind: request.invocationKind,
            invocationId: request.invocationId,
            reviewerIdentity: request.expectedReviewerIdentity,
            launchStartedAtUtc: '2026-07-16T10:00:30.000Z',
            freshContextMode: request.expectedFreshContextMode,
            launchInputMode: request.expectedLaunchInputMode,
            launchInputSha256: request.expectedLaunchInputSha256
        }
    };
}

async function withAdapter(
    source: string,
    result: ProviderInvocationAttestationResult,
    run: (request: ProviderInvocationAttestationRequest) => Promise<void>
): Promise<void> {
    const unregister = registerProviderInvocationAttestationAdapter({
        source,
        attestInvocation: () => result
    });
    try {
        await run(requestFor(source));
    } finally {
        unregister();
    }
}

describe('provider invocation attestation', () => {
    it('accepts authenticated invocation evidence that matches every immutable launch binding', async () => {
        const source = 'fake_existing_23';
        const request = requestFor(source);
        await withAdapter(source, existingResult(request), async (registeredRequest) => {
            const attestation = await authenticateProviderInvocation(registeredRequest);
            assert.equal(attestation.invocationId, registeredRequest.invocationId);
            assert.equal(attestation.reviewerIdentity, registeredRequest.expectedReviewerIdentity);
            assert.equal(attestation.launchInputSha256, registeredRequest.expectedLaunchInputSha256);
        });
    });

    for (const status of ['missing', 'not_found', 'replayed', 'expired', 'unavailable_provider'] as const) {
        it(`fails closed when the adapter returns ${status}`, async () => {
            const source = `fake_${status}_23`;
            await withAdapter(source, { status, diagnostic: `deterministic ${status} fixture` }, async (request) => {
                await assert.rejects(
                    authenticateProviderInvocation(request),
                    new RegExp(`returned '${status}'.*deterministic ${status} fixture`, 'i')
                );
            });
        });
    }

    it('fails closed when authenticated fields mismatch the requested launch', async () => {
        const source = 'fake_mismatched_23';
        const request = requestFor(source);
        const result = existingResult(request);
        assert.equal(result.status, 'existing');
        if (result.status === 'existing') {
            result.attestation.reviewerIdentity = 'agent:different-reviewer';
            result.attestation.launchInputSha256 = 'b'.repeat(64);
        }
        await withAdapter(source, result, async (registeredRequest) => {
            await assert.rejects(
                authenticateProviderInvocation(registeredRequest),
                /returned 'mismatched'.*reviewer_identity.*launch_input_sha256/i
            );
        });
    });

    it('classifies authenticated evidence older than the request bound as expired', async () => {
        const source = 'fake_time_expired_23';
        const request = requestFor(source);
        const result = existingResult(request);
        assert.equal(result.status, 'existing');
        if (result.status === 'existing') {
            result.attestation.launchStartedAtUtc = '2026-07-16T09:00:00.000Z';
        }
        await withAdapter(source, result, async (registeredRequest) => {
            await assert.rejects(authenticateProviderInvocation(registeredRequest), /returned 'expired'/i);
        });
    });

    it('rejects unsupported sources without falling back to raw caller evidence', async () => {
        await assert.rejects(
            authenticateProviderInvocation(requestFor('unsupported_provider_23')),
            /unsupported.*no provider\/controller adapter.*Raw invocation ids.*caller text are not accepted as proof/i
        );
    });

    it('maps adapter failures to unavailable-provider diagnostics', async () => {
        const source = 'fake_throwing_provider_23';
        const unregister = registerProviderInvocationAttestationAdapter({
            source,
            attestInvocation: () => {
                throw new Error('controller IPC unavailable');
            }
        });
        try {
            await assert.rejects(
                authenticateProviderInvocation(requestFor(source)),
                /returned 'unavailable_provider'.*controller IPC unavailable/i
            );
        } finally {
            unregister();
        }
    });
});

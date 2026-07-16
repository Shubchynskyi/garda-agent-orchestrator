export const PROVIDER_INVOCATION_MAXIMUM_AGE_MS = 30 * 60 * 1000;
export const PROVIDER_INVOCATION_CLOCK_SKEW_MS = 2 * 60 * 1000;

export type ProviderInvocationKind = 'provider' | 'controller';
export type ProviderFreshContextMode = 'fresh' | 'isolated' | 'non_forked';
export type ProviderLaunchInputMode = 'launch_artifact_path' | 'copy_paste_prompt';

export interface ProviderInvocationAttestationRequest {
    taskId: string;
    reviewType: string;
    reviewerLaunchAttemptId: string;
    invocationKind: ProviderInvocationKind;
    invocationId: string;
    attestationSource: string;
    expectedReviewerIdentity: string;
    expectedFreshContextMode: ProviderFreshContextMode;
    expectedLaunchInputMode: ProviderLaunchInputMode;
    expectedLaunchInputSha256: string;
    launchPreparedAtUtc: string;
    requestedAtUtc: string;
    constraints: {
        allowNetwork: false;
        allowPaidOperations: false;
        maximumLaunchAgeMs: number;
    };
}

export interface AuthenticatedProviderInvocation {
    attestationId: string;
    taskId: string;
    reviewType: string;
    reviewerLaunchAttemptId: string;
    invocationKind: ProviderInvocationKind;
    invocationId: string;
    reviewerIdentity: string;
    launchStartedAtUtc: string;
    freshContextMode: ProviderFreshContextMode;
    launchInputMode: ProviderLaunchInputMode;
    launchInputSha256: string;
}

export type ProviderInvocationAttestationResult =
    | { status: 'existing'; attestation: AuthenticatedProviderInvocation }
    | { status: 'missing'; diagnostic?: string }
    | { status: 'not_found'; diagnostic?: string }
    | { status: 'replayed'; diagnostic?: string }
    | { status: 'expired'; diagnostic?: string }
    | { status: 'unavailable_provider'; diagnostic?: string };

export interface ProviderInvocationAttestationAdapter {
    readonly source: string;
    attestInvocation(
        request: Readonly<ProviderInvocationAttestationRequest>
    ): Promise<ProviderInvocationAttestationResult> | ProviderInvocationAttestationResult;
}

const registeredAdapters = new Map<string, ProviderInvocationAttestationAdapter>();

function normalizeSource(source: string): string {
    return String(source || '').trim().toLowerCase();
}

export function registerProviderInvocationAttestationAdapter(
    adapter: ProviderInvocationAttestationAdapter
): () => void {
    const source = normalizeSource(adapter.source);
    if (!source) {
        throw new Error('Provider invocation attestation adapter source is required.');
    }
    if (registeredAdapters.has(source)) {
        throw new Error(`Provider invocation attestation adapter '${source}' is already registered.`);
    }
    registeredAdapters.set(source, adapter);
    return () => {
        if (registeredAdapters.get(source) === adapter) {
            registeredAdapters.delete(source);
        }
    };
}

function buildStatusError(
    source: string,
    status: Exclude<ProviderInvocationAttestationResult['status'], 'existing'>,
    diagnostic?: string
): Error {
    const hasProviderDiagnostic = String(diagnostic || '').trim().length > 0;
    const remediation = status === 'unavailable_provider'
        ? 'Restore the provider/controller connection and retry the same immutable launch attempt.'
        : status === 'replayed'
            ? 'Launch a new clean-context reviewer through the provider/controller before retrying.'
            : status === 'expired'
                ? 'Launch a new clean-context reviewer; expired invocation evidence cannot be reused.'
                : 'Verify the provider invocation id and retry only after the provider/controller can authenticate it.';
    return new Error(
        `Provider invocation attestation '${source}' returned '${status}'.` +
        (hasProviderDiagnostic ? ' Provider/controller diagnostic: <redacted>.' : '') +
        ` ${remediation}`
    );
}

function parseUtc(value: string): number | null {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : null;
}

function assertAuthenticatedInvocationMatches(
    request: Readonly<ProviderInvocationAttestationRequest>,
    attestation: AuthenticatedProviderInvocation
): void {
    const mismatches: string[] = [];
    const exactFields: Array<[string, string, string]> = [
        ['task_id', attestation.taskId, request.taskId],
        ['review_type', attestation.reviewType, request.reviewType],
        ['reviewer_launch_attempt_id', attestation.reviewerLaunchAttemptId, request.reviewerLaunchAttemptId],
        ['invocation_kind', attestation.invocationKind, request.invocationKind],
        ['invocation_id', attestation.invocationId, request.invocationId],
        ['reviewer_identity', attestation.reviewerIdentity, request.expectedReviewerIdentity],
        ['fresh_context_mode', attestation.freshContextMode, request.expectedFreshContextMode],
        ['launch_input_mode', attestation.launchInputMode, request.expectedLaunchInputMode],
        ['launch_input_sha256', attestation.launchInputSha256, request.expectedLaunchInputSha256]
    ];
    for (const [field, actual, expected] of exactFields) {
        if (String(actual || '').trim() !== expected) {
            mismatches.push(`${field} must equal '${expected}'`);
        }
    }
    if (!String(attestation.attestationId || '').trim()) {
        mismatches.push('attestation_id is required');
    }

    const launchStartedAtMs = parseUtc(attestation.launchStartedAtUtc);
    const launchPreparedAtMs = parseUtc(request.launchPreparedAtUtc);
    const requestedAtMs = parseUtc(request.requestedAtUtc);
    if (launchStartedAtMs === null) {
        mismatches.push('launch_started_at_utc must be a valid UTC timestamp');
    } else if (launchPreparedAtMs === null || requestedAtMs === null) {
        mismatches.push('gate-owned launch timing inputs are invalid');
    } else {
        if (launchStartedAtMs < launchPreparedAtMs - PROVIDER_INVOCATION_CLOCK_SKEW_MS) {
            mismatches.push('launch_started_at_utc predates the prepared launch attempt');
        }
        if (launchStartedAtMs > requestedAtMs + PROVIDER_INVOCATION_CLOCK_SKEW_MS) {
            mismatches.push('launch_started_at_utc is in the future');
        }
        if (requestedAtMs - launchStartedAtMs > request.constraints.maximumLaunchAgeMs) {
            throw buildStatusError(request.attestationSource, 'expired', 'Authenticated launch time exceeds the allowed age.');
        }
    }

    if (mismatches.length > 0) {
        throw new Error(
            `Provider invocation attestation '${request.attestationSource}' returned 'mismatched': ` +
            `${mismatches.join('; ')}. The provider/controller evidence must match the immutable reviewer launch input.`
        );
    }
}

export async function authenticateProviderInvocation(
    request: Readonly<ProviderInvocationAttestationRequest>
): Promise<AuthenticatedProviderInvocation> {
    const source = normalizeSource(request.attestationSource);
    const adapter = registeredAdapters.get(source);
    if (!adapter) {
        throw new Error(
            `Provider invocation attestation source '${source}' is unsupported: no provider/controller adapter is registered. ` +
            'Configure an authenticated provider/controller integration and retry. Raw invocation ids, mutable local JSON, ' +
            'and caller text are not accepted as proof.'
        );
    }

    let result: ProviderInvocationAttestationResult;
    try {
        result = await adapter.attestInvocation(Object.freeze({
            ...request,
            constraints: Object.freeze({ ...request.constraints })
        }));
    } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw buildStatusError(source, 'unavailable_provider', detail);
    }
    if (!result || typeof result !== 'object') {
        throw buildStatusError(source, 'missing', 'The adapter returned no attestation result.');
    }
    if (result.status !== 'existing') {
        throw buildStatusError(source, result.status, result.diagnostic);
    }
    assertAuthenticatedInvocationMatches(request, result.attestation);
    return result.attestation;
}

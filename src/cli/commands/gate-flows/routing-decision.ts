import { resolveRuntimeReviewerIdentity } from '../../../gates/reviewer-routing';

export function readRoutingDecision(
    repoRoot: string,
    providerOverride?: unknown,
    routedToOverride?: unknown,
    taskId?: string | null
): {
    provider: string | null;
    routedTo: string | null;
    canonicalSourceOfTruth: string | null;
    canonicalEntrypoint: string | null;
    executionProviderSource: string | null;
    providerBridge: string | null;
    identityStatus: string;
    violations: string[];
} {
    const identity = resolveRuntimeReviewerIdentity({
        repoRoot,
        taskId,
        executionProvider: providerOverride,
        routedTo: routedToOverride,
        allowLegacyFallback: true
    });
    return {
        provider: identity.execution_provider,
        routedTo: identity.routed_to,
        canonicalSourceOfTruth: identity.canonical_source_of_truth,
        canonicalEntrypoint: identity.canonical_entrypoint,
        executionProviderSource: identity.execution_provider_source,
        providerBridge: identity.provider_bridge,
        identityStatus: identity.identity_status,
        violations: identity.violations
    };
}

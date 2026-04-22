import { resolveRuntimeReviewerIdentity } from '../../../gates/reviewer-routing';

export function readRoutingDecision(
    repoRoot: string,
    providerOverride?: unknown,
    routedToOverride?: unknown,
    taskId?: string | null,
    taskModePath?: string | null
): {
    provider: string | null;
    routedTo: string | null;
    canonicalSourceOfTruth: string | null;
    canonicalEntrypoint: string | null;
    executionEntrypoint: string | null;
    executionProviderSource: string | null;
    providerBridge: string | null;
    identityStatus: string;
    reviewerSubagentLaunchStatus: string;
    reviewerSubagentLaunchRoute: string | null;
    reviewerSubagentLaunchReason: string;
    reviewerSubagentLaunchRemediation: string | null;
    violations: string[];
} {
    const identity = resolveRuntimeReviewerIdentity({
        repoRoot,
        taskId,
        taskModePath,
        executionProvider: providerOverride,
        routedTo: routedToOverride,
        allowLegacyFallback: true
    });
    return {
        provider: identity.execution_provider,
        routedTo: identity.routed_to,
        canonicalSourceOfTruth: identity.canonical_source_of_truth,
        canonicalEntrypoint: identity.canonical_entrypoint,
        executionEntrypoint: identity.execution_entrypoint,
        executionProviderSource: identity.execution_provider_source,
        providerBridge: identity.provider_bridge,
        identityStatus: identity.identity_status,
        reviewerSubagentLaunchStatus: identity.reviewer_subagent_launch_status,
        reviewerSubagentLaunchRoute: identity.reviewer_subagent_launch_route,
        reviewerSubagentLaunchReason: identity.reviewer_subagent_launch_reason,
        reviewerSubagentLaunchRemediation: identity.reviewer_subagent_launch_remediation,
        violations: identity.violations
    };
}

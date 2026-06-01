import * as fs from 'node:fs';
import * as path from 'node:path';
import { SOURCE_OF_TRUTH_VALUES, resolveBundleName } from '../../core/constants';
import {
    getProviderEntriesByEntrypointFile,
    normalizeProviderId,
    getReviewerCapabilityTier
} from '../../core/provider-registry';
import { getCanonicalEntrypointFile, getProviderOrchestratorProfileDefinitions } from '../../materialization/common';
import { getTaskModeEvidence, getTaskModeEvidenceViolations } from '../task-mode';

export type ReviewerExecutionMode = 'delegated_subagent';
export type ReviewerCapabilityLevel = 'delegation_required' | 'delegation_conditional' | 'single_agent_only' | 'unknown';
export type RuntimeProviderIdentityStatus = 'resolved' | 'legacy_fallback' | 'missing' | 'contradictory';
export type ReviewerSubagentLaunchStatus = 'launchable' | 'blocked' | 'unknown';
export type RuntimeProviderIdentitySource =
    | 'provider_bridge'
    | 'provider_entrypoint'
    | 'explicit_provider'
    | 'task_mode'
    | 'legacy_source_of_truth'
    | null;

export interface ReviewerRoutingPolicy {
    source_of_truth: string | null;
    capability_level: ReviewerCapabilityLevel;
    delegation_required: boolean;
    fallback_allowed: boolean;
    fallback_reason_required: boolean;
    expected_execution_mode: ReviewerExecutionMode;
    note: string;
}

export interface RuntimeReviewerIdentity {
    canonical_source_of_truth: string | null;
    canonical_entrypoint: string | null;
    execution_entrypoint: string | null;
    execution_provider: string | null;
    execution_provider_source: RuntimeProviderIdentitySource;
    task_mode_identity_backfilled: boolean;
    routed_to: string | null;
    provider_bridge: string | null;
    identity_status: RuntimeProviderIdentityStatus;
    capability_level: ReviewerCapabilityLevel;
    delegation_required: boolean;
    fallback_allowed: boolean;
    fallback_reason_required: boolean;
    expected_execution_mode: ReviewerExecutionMode;
    reviewer_subagent_launch_status: ReviewerSubagentLaunchStatus;
    reviewer_subagent_launch_route: string | null;
    reviewer_subagent_launch_reason: string;
    reviewer_subagent_launch_remediation: string | null;
    note: string;
    violations: string[];
}

export function normalizeSourceOfTruthValue(value: unknown): string | null {
    return normalizeProviderId(value);
}

function normalizeRuntimeIdentityStatus(value: unknown): RuntimeProviderIdentityStatus | null {
    const normalized = String(value || '').trim().toLowerCase();
    switch (normalized) {
        case 'resolved':
        case 'legacy_fallback':
        case 'missing':
        case 'contradictory':
            return normalized;
        default:
            return null;
    }
}

export function normalizeRuntimeIdentitySource(value: unknown): RuntimeProviderIdentitySource {
    const normalized = String(value || '').trim();
    switch (normalized) {
        case 'provider_bridge':
        case 'provider_entrypoint':
        case 'explicit_provider':
        case 'task_mode':
        case 'legacy_source_of_truth':
            return normalized;
        default:
            return null;
    }
}

function normalizeReviewerSubagentLaunchStatus(value: unknown): ReviewerSubagentLaunchStatus | null {
    const normalized = String(value || '').trim().toLowerCase();
    switch (normalized) {
        case 'launchable':
        case 'blocked':
        case 'unknown':
            return normalized;
        default:
            return null;
    }
}

function normalizeRoutePath(value: unknown): string | null {
    const text = String(value || '').trim().replace(/\\/g, '/');
    if (!text) {
        return null;
    }
    return text.replace(/^\.\//, '');
}

function readJsonObjectIfExists(filePath: string): Record<string, unknown> | null {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return null;
    }
    try {
        const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            return payload as Record<string, unknown>;
        }
    } catch {
        // Compatibility fallback only.
    }
    return null;
}

export function resolveReviewerRoutingPolicy(
    sourceOfTruth: unknown,
    executionProviderSource?: unknown
): ReviewerRoutingPolicy {
    const normalized = normalizeSourceOfTruthValue(sourceOfTruth);
    const tier = normalized ? getReviewerCapabilityTier(normalized) : null;
    void executionProviderSource;

    if (tier === 'delegation_required') {
        return {
            source_of_truth: normalized,
            capability_level: 'delegation_required',
            delegation_required: true,
            fallback_allowed: false,
            fallback_reason_required: false,
            expected_execution_mode: 'delegated_subagent',
            note: `${normalized} requires delegated_subagent execution for mandatory reviews.`
        };
    }

    return {
        source_of_truth: normalized,
        capability_level: 'unknown',
        delegation_required: true,
        fallback_allowed: false,
        fallback_reason_required: false,
        expected_execution_mode: 'delegated_subagent',
        note: 'Provider delegation capability is unknown. Mandatory reviews still require delegated_subagent execution.'
    };
}

export function readCanonicalSourceOfTruth(repoRoot: string): string | null {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const initAnswersPath = path.join(normalizedRepoRoot, resolveBundleName(), 'runtime', 'init-answers.json');
    const initAnswersPayload = readJsonObjectIfExists(initAnswersPath);
    if (initAnswersPayload) {
        const sourceOfTruth = normalizeSourceOfTruthValue(initAnswersPayload.SourceOfTruth);
        if (sourceOfTruth) {
            return sourceOfTruth;
        }
    }

    const liveVersionPath = path.join(normalizedRepoRoot, resolveBundleName(), 'live', 'version.json');
    const liveVersionPayload = readJsonObjectIfExists(liveVersionPath);
    if (liveVersionPayload) {
        return normalizeSourceOfTruthValue(liveVersionPayload.SourceOfTruth);
    }

    return null;
}

export function readSourceOfTruthFromInitAnswers(repoRoot: string): string | null {
    return readCanonicalSourceOfTruth(repoRoot);
}

function resolveCanonicalEntrypoint(canonicalSourceOfTruth: string | null): string | null {
    if (!canonicalSourceOfTruth) {
        return null;
    }
    try {
        return getCanonicalEntrypointFile(canonicalSourceOfTruth);
    } catch {
        return null;
    }
}

function resolveKnownBridgePath(provider: string | null): string | null {
    if (!provider) {
        return null;
    }
    for (const profile of getProviderOrchestratorProfileDefinitions()) {
        if (normalizeSourceOfTruthValue(profile.providerId) === provider) {
            return profile.orchestratorRelativePath;
        }
    }
    return null;
}

function buildReviewerSubagentLaunchability(options: {
    repoRoot: string;
    executionProvider: string | null;
    executionProviderSource: RuntimeProviderIdentitySource;
    identityStatus: RuntimeProviderIdentityStatus;
    executionEntrypoint: string | null;
    providerBridge: string | null;
    routedTo: string | null;
    preserveTaskModeLaunchability: boolean;
    taskModeReviewerSubagentLaunchStatus: ReviewerSubagentLaunchStatus | null;
    taskModeReviewerSubagentLaunchRoute: string | null;
    taskModeReviewerSubagentLaunchReason: string | null;
    taskModeReviewerSubagentLaunchRemediation: string | null;
}): {
    status: ReviewerSubagentLaunchStatus;
    route: string | null;
    reason: string;
    remediation: string | null;
} {
    const routeHint = options.routedTo || options.providerBridge || options.executionEntrypoint || null;
    if (!options.executionProvider || options.identityStatus !== 'resolved') {
        return {
            status: 'unknown',
            route: routeHint,
            reason: options.identityStatus === 'legacy_fallback'
                ? 'Reviewer subagent launchability is unknown because runtime identity still relies on legacy SourceOfTruth fallback.'
                : options.identityStatus === 'missing'
                    ? 'Reviewer subagent launchability is unknown because runtime identity is missing.'
                    : options.identityStatus === 'contradictory'
                        ? 'Reviewer subagent launchability is unknown because runtime identity is contradictory.'
                        : 'Reviewer subagent launchability is unknown because runtime identity is unresolved.',
            remediation: routeHint
                ? `Re-enter task mode through '${routeHint}' and rerun handshake-diagnostics before preparing required reviews.`
                : 'Re-enter task mode with explicit runtime identity and rerun handshake-diagnostics before preparing required reviews.'
        };
    }

    if (options.preserveTaskModeLaunchability && options.taskModeReviewerSubagentLaunchStatus === 'blocked') {
        return {
            status: 'blocked',
            route: options.taskModeReviewerSubagentLaunchRoute || routeHint,
            reason: options.taskModeReviewerSubagentLaunchReason
                || `Reviewer subagent launch is blocked for persisted task-mode runtime '${options.executionProvider}'.`,
            remediation: options.taskModeReviewerSubagentLaunchRemediation
                || 'Re-enter task mode with a runtime session that can launch delegated reviewer subagents and rerun handshake-diagnostics before preparing required reviews.'
        };
    }

    if (options.executionProviderSource === 'provider_bridge' || options.executionProviderSource === 'provider_entrypoint') {
        return {
            status: 'launchable',
            route: options.routedTo || routeHint,
            reason: `Reviewer subagent launch is attested via ${options.executionProviderSource} '${options.routedTo || routeHint || options.executionProvider}'.`,
            remediation: null
        };
    }

    if (options.executionProviderSource === 'explicit_provider') {
        return {
            status: 'launchable',
            route: routeHint,
            reason: `Reviewer subagent launch is attested via explicit provider selection '${options.executionProvider}' inside the orchestrator runtime.`,
            remediation: null
        };
    }

    if (options.executionProviderSource === 'task_mode') {
        return {
            status: 'launchable',
            route: routeHint,
            reason: `Reviewer subagent launch is attested via persisted task-mode runtime identity for '${options.executionProvider}'.`,
            remediation: null
        };
    }

    return {
        status: 'unknown',
        route: routeHint,
        reason: `Reviewer subagent launchability is unknown for runtime identity source '${options.executionProviderSource || 'unknown'}'.`,
        remediation: routeHint
            ? `Re-enter task mode through '${routeHint}' and rerun handshake-diagnostics before preparing required reviews.`
            : 'Re-enter task mode with explicit runtime identity and rerun handshake-diagnostics before preparing required reviews.'
    };
}

function resolveExecutionProviderFromRoutePath(routedTo: string | null): {
    provider: string | null;
    routeKind: Extract<RuntimeProviderIdentitySource, 'provider_bridge' | 'provider_entrypoint'> | null;
    bridgePath: string | null;
    providerCandidates: readonly string[];
} {
    const normalizedRoutedTo = normalizeRoutePath(routedTo);
    if (!normalizedRoutedTo) {
        return {
            provider: null,
            routeKind: null,
            bridgePath: null,
            providerCandidates: Object.freeze([])
        };
    }
    for (const profile of getProviderOrchestratorProfileDefinitions()) {
        if (normalizeRoutePath(profile.orchestratorRelativePath) === normalizedRoutedTo) {
            return {
                provider: normalizeSourceOfTruthValue(profile.providerId),
                routeKind: 'provider_bridge',
                bridgePath: profile.orchestratorRelativePath,
                providerCandidates: Object.freeze([profile.providerId])
            };
        }
    }
    const providerCandidates = getProviderEntriesByEntrypointFile(normalizedRoutedTo)
        .map((entry) => normalizeSourceOfTruthValue(entry.id))
        .filter((candidate): candidate is string => candidate !== null);
    if (providerCandidates.length === 1) {
        const normalizedProvider = providerCandidates[0];
        return {
            provider: normalizedProvider,
            routeKind: 'provider_entrypoint',
            bridgePath: resolveKnownBridgePath(normalizedProvider),
            providerCandidates: Object.freeze([...providerCandidates])
        };
    }
    if (providerCandidates.length > 1) {
        return {
            provider: null,
            routeKind: 'provider_entrypoint',
            bridgePath: null,
            providerCandidates: Object.freeze([...providerCandidates])
        };
    }
    return {
        provider: null,
        routeKind: null,
        bridgePath: null,
        providerCandidates: Object.freeze([])
    };
}

export function resolveRuntimeReviewerIdentity(options: {
    repoRoot: string;
    taskId?: string | null;
    taskModePath?: string | null;
    taskModeEvidence?: ReturnType<typeof getTaskModeEvidence> | null;
    executionProvider?: unknown;
    routedTo?: unknown;
    allowLegacyFallback?: boolean;
}): RuntimeReviewerIdentity {
    const normalizedRepoRoot = path.resolve(options.repoRoot);
    const normalizedTaskId = String(options.taskId || '').trim();
    const workspaceCanonicalSourceOfTruth = readCanonicalSourceOfTruth(normalizedRepoRoot);
    const allowLegacyFallback = options.allowLegacyFallback !== false;
    const taskMode = normalizedTaskId
        ? (options.taskModeEvidence || getTaskModeEvidence(normalizedRepoRoot, normalizedTaskId, String(options.taskModePath || '').trim()))
        : null;
    const hasTaskModeArtifact = !!(
        normalizedTaskId
        && taskMode
        && taskMode.evidence_status !== 'TASK_ID_MISSING'
        && taskMode.evidence_status !== 'EVIDENCE_FILE_MISSING'
        && taskMode.evidence_status !== 'EVIDENCE_INVALID_JSON'
    );
    const hasPinnedTaskModeIdentity = !!(hasTaskModeArtifact && taskMode?.evidence_status === 'PASS');
    const taskModeIdentityBackfilled = !!(hasPinnedTaskModeIdentity && taskMode?.identity_backfilled_from_legacy);
    const taskModeCanonicalSourceOfTruth = hasPinnedTaskModeIdentity
        ? normalizeSourceOfTruthValue(taskMode?.canonical_source_of_truth)
        : null;
    const taskModeIdentityStatus = hasPinnedTaskModeIdentity
        ? normalizeRuntimeIdentityStatus(taskMode?.runtime_identity_status)
        : null;
    const taskModeExecutionProviderSource = hasPinnedTaskModeIdentity
        ? normalizeRuntimeIdentitySource(taskMode?.execution_provider_source)
        : null;
    const taskModeReviewerSubagentLaunchStatus = hasPinnedTaskModeIdentity
        ? normalizeReviewerSubagentLaunchStatus(taskMode?.reviewer_subagent_launch_status)
        : null;
    const taskModeReviewerSubagentLaunchRoute = hasPinnedTaskModeIdentity
        ? normalizeRoutePath(taskMode?.reviewer_subagent_launch_route)
        : null;
    const taskModeReviewerSubagentLaunchReason = hasPinnedTaskModeIdentity
        ? String(taskMode?.reviewer_subagent_launch_reason || '').trim() || null
        : null;
    const taskModeReviewerSubagentLaunchRemediation = hasPinnedTaskModeIdentity
        ? String(taskMode?.reviewer_subagent_launch_remediation || '').trim() || null
        : null;
    const canonicalSourceOfTruth = taskModeCanonicalSourceOfTruth ?? workspaceCanonicalSourceOfTruth;
    const canonicalEntrypoint = resolveCanonicalEntrypoint(canonicalSourceOfTruth);
    const taskModeProvider = hasPinnedTaskModeIdentity
        ? normalizeSourceOfTruthValue(taskMode?.provider)
        : null;
    const explicitProviderRaw = String(options.executionProvider || '').trim();
    const explicitProvider = normalizeSourceOfTruthValue(options.executionProvider);
    const explicitRoutedToRaw = String(options.routedTo || '').trim();
    const explicitRoutedTo = normalizeRoutePath(options.routedTo);
    const hasExplicitProviderOverride = explicitProviderRaw.length > 0;
    const hasExplicitRouteOverride = explicitRoutedToRaw.length > 0;
    const taskModeRoutedTo = hasPinnedTaskModeIdentity
        ? normalizeRoutePath(taskMode?.routed_to)
        : null;
    const routedTo = explicitRoutedTo || (!hasExplicitProviderOverride ? taskModeRoutedTo : null) || null;
    const routeIdentity = resolveExecutionProviderFromRoutePath(routedTo);
    const violations: string[] = [];

    if (
        hasTaskModeArtifact
        && taskMode
        && (taskMode.declares_runtime_identity_metadata || taskMode.timeline_declares_runtime_identity_metadata)
        && taskMode.evidence_status !== 'PASS'
    ) {
        violations.push(...getTaskModeEvidenceViolations(taskMode));
    }

    if (explicitProviderRaw && !explicitProvider) {
        violations.push(
            `Runtime execution provider override '${explicitProviderRaw}' is not recognized. ` +
            `Use one of the supported providers: ${SOURCE_OF_TRUTH_VALUES.join(', ')}.`
        );
    }
    if (explicitRoutedToRaw && routeIdentity.providerCandidates.length > 1 && !explicitProvider) {
        violations.push(
            `Runtime route override '${explicitRoutedToRaw}' is shared by multiple providers ` +
            `(${routeIdentity.providerCandidates.join(', ')}). Pass explicit --provider to disambiguate the shared entrypoint.`
        );
    } else if (explicitRoutedToRaw && !routeIdentity.provider && routeIdentity.providerCandidates.length === 0) {
        violations.push(
            `Runtime route override '${explicitRoutedToRaw}' is not a recognized provider bridge or canonical entrypoint.`
        );
    }

    if (hasPinnedTaskModeIdentity) {
        if (!taskModeCanonicalSourceOfTruth) {
            violations.push(`Task-mode artifact for '${normalizedTaskId}' is missing canonical_source_of_truth.`);
        }
        if (!taskModeExecutionProviderSource) {
            violations.push(`Task-mode artifact for '${normalizedTaskId}' is missing execution_provider_source.`);
        }
        if (!taskModeIdentityStatus) {
            violations.push(`Task-mode artifact for '${normalizedTaskId}' is missing runtime_identity_status.`);
        }
        if (workspaceCanonicalSourceOfTruth && taskModeCanonicalSourceOfTruth && workspaceCanonicalSourceOfTruth !== taskModeCanonicalSourceOfTruth) {
            violations.push(
                `Workspace canonical SourceOfTruth '${workspaceCanonicalSourceOfTruth}' contradicts ` +
                `task-mode canonical_source_of_truth '${taskModeCanonicalSourceOfTruth}'.`
            );
        }
    }

    if (taskModeProvider && explicitProvider && taskModeProvider !== explicitProvider) {
        violations.push(
            `Runtime execution provider '${explicitProvider}' contradicts task-mode provider '${taskModeProvider}'.`
        );
    }

    if (routeIdentity.provider && explicitProvider && routeIdentity.provider !== explicitProvider) {
        violations.push(
            `Runtime execution provider '${explicitProvider}' contradicts routed path '${routedTo}' ` +
            `which identifies provider '${routeIdentity.provider}'.`
        );
    }
    if (
        !routeIdentity.provider
        && routeIdentity.providerCandidates.length > 1
        && explicitProvider
        && !routeIdentity.providerCandidates.includes(explicitProvider)
    ) {
        violations.push(
            `Runtime execution provider '${explicitProvider}' contradicts shared routed path '${routedTo}' ` +
            `which is only valid for providers ${routeIdentity.providerCandidates.join(', ')}.`
        );
    }

    if (routeIdentity.provider && taskModeProvider && routeIdentity.provider !== taskModeProvider) {
        violations.push(
            `Runtime route '${routedTo}' identifies provider '${routeIdentity.provider}', ` +
            `but task-mode provider is '${taskModeProvider}'.`
        );
    }
    if (
        !routeIdentity.provider
        && routeIdentity.providerCandidates.length > 1
        && taskModeProvider
        && !routeIdentity.providerCandidates.includes(taskModeProvider)
    ) {
        violations.push(
            `Runtime route '${routedTo}' is shared by providers ${routeIdentity.providerCandidates.join(', ')}, ` +
            `but task-mode provider is '${taskModeProvider}'.`
        );
    }

    let executionProvider: string | null = null;
    let executionProviderSource: RuntimeProviderIdentitySource = null;

    if (routeIdentity.provider) {
        executionProvider = routeIdentity.provider;
        executionProviderSource = routeIdentity.routeKind;
    } else if (
        routeIdentity.routeKind === 'provider_entrypoint'
        && explicitProvider
        && routeIdentity.providerCandidates.includes(explicitProvider)
    ) {
        executionProvider = explicitProvider;
        executionProviderSource = 'provider_entrypoint';
    } else if (
        routeIdentity.routeKind === 'provider_entrypoint'
        && taskModeProvider
        && routeIdentity.providerCandidates.includes(taskModeProvider)
    ) {
        executionProvider = taskModeProvider;
        executionProviderSource = 'provider_entrypoint';
    } else if (explicitProvider) {
        executionProvider = explicitProvider;
        executionProviderSource = 'explicit_provider';
    } else if (taskModeProvider) {
        executionProvider = taskModeProvider;
        executionProviderSource = 'task_mode';
    } else if (allowLegacyFallback && canonicalSourceOfTruth) {
        executionProvider = canonicalSourceOfTruth;
        executionProviderSource = 'legacy_source_of_truth';
    }

    let resolvedExecutionProviderSource = executionProviderSource;
    if (hasPinnedTaskModeIdentity && taskModeExecutionProviderSource && !hasExplicitProviderOverride && !hasExplicitRouteOverride) {
        if (!resolvedExecutionProviderSource || resolvedExecutionProviderSource === 'task_mode') {
            executionProviderSource = taskModeExecutionProviderSource;
            resolvedExecutionProviderSource = taskModeExecutionProviderSource;
        }
    }
    if (
        hasPinnedTaskModeIdentity
        && taskModeExecutionProviderSource
        && resolvedExecutionProviderSource
        && taskModeExecutionProviderSource !== resolvedExecutionProviderSource
        && !hasExplicitProviderOverride
        && !hasExplicitRouteOverride
    ) {
        violations.push(
            `Task-mode execution_provider_source '${taskModeExecutionProviderSource}' contradicts resolved source '${resolvedExecutionProviderSource}'.`
        );
    }

    const policy = resolveReviewerRoutingPolicy(executionProvider, executionProviderSource);
    const executionEntrypoint = resolveCanonicalEntrypoint(executionProvider);
    let identityStatus: RuntimeProviderIdentityStatus = 'resolved';
    if (violations.length > 0) {
        identityStatus = 'contradictory';
    } else if (!executionProvider) {
        identityStatus = 'missing';
    } else if (hasPinnedTaskModeIdentity && taskModeIdentityStatus && !hasExplicitProviderOverride && !hasExplicitRouteOverride) {
        identityStatus = taskModeIdentityStatus;
    } else if (executionProviderSource === 'legacy_source_of_truth') {
        identityStatus = 'legacy_fallback';
    }
    const reviewerLaunchability = buildReviewerSubagentLaunchability({
        repoRoot: normalizedRepoRoot,
        executionProvider,
        executionProviderSource,
        identityStatus,
        executionEntrypoint,
        providerBridge: routeIdentity.bridgePath || resolveKnownBridgePath(executionProvider),
        routedTo,
        preserveTaskModeLaunchability: hasPinnedTaskModeIdentity && !hasExplicitProviderOverride && !hasExplicitRouteOverride,
        taskModeReviewerSubagentLaunchStatus,
        taskModeReviewerSubagentLaunchRoute,
        taskModeReviewerSubagentLaunchReason,
        taskModeReviewerSubagentLaunchRemediation
    });

    return {
        canonical_source_of_truth: canonicalSourceOfTruth,
        canonical_entrypoint: canonicalEntrypoint,
        execution_entrypoint: executionEntrypoint,
        execution_provider: executionProvider,
        execution_provider_source: executionProviderSource,
        task_mode_identity_backfilled: taskModeIdentityBackfilled,
        routed_to: routedTo,
        provider_bridge: routeIdentity.bridgePath || resolveKnownBridgePath(executionProvider),
        identity_status: identityStatus,
        capability_level: policy.capability_level,
        delegation_required: policy.delegation_required,
        fallback_allowed: policy.fallback_allowed,
        fallback_reason_required: policy.fallback_reason_required,
        expected_execution_mode: policy.expected_execution_mode,
        reviewer_subagent_launch_status: reviewerLaunchability.status,
        reviewer_subagent_launch_route: reviewerLaunchability.route,
        reviewer_subagent_launch_reason: reviewerLaunchability.reason,
        reviewer_subagent_launch_remediation: reviewerLaunchability.remediation,
        note: policy.note,
        violations
    };
}

export function readRuntimeReviewerProvider(repoRoot: string, taskId?: string | null): string | null {
    return resolveRuntimeReviewerIdentity({
        repoRoot,
        taskId,
        allowLegacyFallback: true
    }).execution_provider;
}

export function readRuntimeReviewerCanonicalSourceOfTruth(repoRoot: string, taskId?: string | null): string | null {
    return resolveRuntimeReviewerIdentity({
        repoRoot,
        taskId,
        allowLegacyFallback: true
    }).canonical_source_of_truth;
}

export function readRuntimeReviewerPolicy(repoRoot: string, taskId?: string | null): RuntimeReviewerIdentity {
    return resolveRuntimeReviewerIdentity({
        repoRoot,
        taskId,
        allowLegacyFallback: true
    });
}

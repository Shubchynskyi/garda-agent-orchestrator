import * as path from 'node:path';

import type {
    EffectiveReviewExecutionPolicyMode
} from '../../core/review-execution-policy';
import {
    buildCommand,
    toRepoDisplayPath
} from './next-step-command-formatters';
import {
    buildScopedDiffCommand
} from './next-step-review-command-builders';
import {
    buildRequiredReviewsCheckCommand,
    buildReviewContextCommand,
    getEffectiveDepthForPostPreflightRules
} from './next-step-lifecycle-command-builders';
import {
    getScopedDiffMetadataReadiness,
    scopedDiffExpectedForReview,
    type ReviewArtifactState
} from './next-step-review-artifact-readers';
import {
    buildReviewGateChainStatusSummary,
    findDownstreamReviewNeedingDependencyRebind,
    findReviewGateStaleContextPrecheckRecovery,
    findReviewGateStaleUpstreamRecovery,
    reviewStateHasSatisfiedEvidence,
    timelineHasReviewReuseRecordedAfterCompile
} from './next-step-review-evidence';
import {
    buildReviewerReadinessChainSummary
} from './next-step-reviewer-launch-evidence';
import {
    resolveDownstreamDependencyRebindRoute,
    resolveReviewGateStaleContextPrecheckRecoveryRoute,
    resolveReviewGateStaleUpstreamRecoveryRoute
} from './next-step-review-reuse-routing';
import {
    resolvePostReviewCloseoutRouteFromState,
    type PostReviewCloseoutRouteState
} from './next-step-closeout-routing';
import type {
    NextStepDecisionRoutePayload
} from './next-step-decision-route-groups';

type PostReviewRoute = NextStepDecisionRoutePayload;
type PostReviewRouteResolver = () => PostReviewRoute | null;
type PostReviewCommand = PostReviewRoute['commands'][number];

export interface PostReviewLifecycleRouteResolvers {
    resolveDownstreamDependencyRebindRoute: PostReviewRouteResolver;
    resolveStaleUpstreamRecoveryRoute: PostReviewRouteResolver;
    resolveStaleContextRecoveryRoute: PostReviewRouteResolver;
    resolveGroupedFollowUpRoute: PostReviewRouteResolver;
    resolveCloseoutRoute: PostReviewRouteResolver;
}

export interface PostReviewLifecycleStateOptions {
    repoRoot: string;
    eventsRoot: string;
    reviewsRoot: string;
    taskId: string;
    cliPrefix: string;
    preflight: Record<string, unknown> | null;
    preflightPath: string;
    preflightCommandPath: string;
    preflightSha256: string | null;
    taskMode: Record<string, unknown> | null;
    taskModePath: string | null;
    reviewGateAlreadyPassed: boolean;
    requiredReviewTypes: string[];
    requiredReviews: Record<string, boolean>;
    reviewPolicyMode: EffectiveReviewExecutionPolicyMode;
    reviewStates: readonly ReviewArtifactState[];
    closeoutState: Omit<PostReviewCloseoutRouteState, 'requiredReviewsCommand'>;
}

export function resolvePostReviewLifecycleDecisionRoute(
    resolvers: PostReviewLifecycleRouteResolvers
): PostReviewRoute | null {
    const orderedResolvers: readonly PostReviewRouteResolver[] = [
        resolvers.resolveDownstreamDependencyRebindRoute,
        resolvers.resolveStaleUpstreamRecoveryRoute,
        resolvers.resolveStaleContextRecoveryRoute,
        resolvers.resolveGroupedFollowUpRoute,
        resolvers.resolveCloseoutRoute
    ];
    for (const resolveRoute of orderedResolvers) {
        const route = resolveRoute();
        if (route) {
            return route;
        }
    }
    return null;
}

function buildReviewRecoveryRouteContext(
    options: PostReviewLifecycleStateOptions,
    reviewType: string,
    state: ReviewArtifactState,
    reason: string,
    buildReviewContextLabel: string
): {
    scopedDiffReadiness: { ready: boolean; reason: string };
    reviewerReadinessChain: string;
    reviewContextChain: string;
    commands: {
        buildScopedDiff: PostReviewCommand;
        buildReviewContext: PostReviewCommand;
    };
} {
    const reviewDepth = getEffectiveDepthForPostPreflightRules(options.preflight, options.taskMode);
    const reviewerReadinessChain = buildReviewerReadinessChainSummary(
        options.repoRoot,
        options.eventsRoot,
        options.taskId,
        reviewType,
        state,
        (candidateState) => reviewStateHasSatisfiedEvidence(
            options.repoRoot,
            options.eventsRoot,
            options.taskId,
            candidateState
        )
    );
    const reviewContextChain = buildReviewGateChainStatusSummary({
        repoRoot: options.repoRoot,
        eventsRoot: options.eventsRoot,
        taskId: options.taskId,
        reviewType,
        edgeId: 'compile-to-review-context',
        reason,
        preflightPath: options.preflightCommandPath,
        reviewContextPath: state.contextPath
            ? toRepoDisplayPath(options.repoRoot, state.contextPath)
            : undefined,
        depth: reviewDepth
    });
    const scopedDiffMetadataPath = path.join(options.reviewsRoot, `${options.taskId}-${reviewType}-scoped.json`);
    const scopedDiffOutputPath = path.join(options.reviewsRoot, `${options.taskId}-${reviewType}-scoped.diff`);
    const scopedDiffReadiness = scopedDiffExpectedForReview({
        preflight: options.preflight,
        reviewType
    })
        ? getScopedDiffMetadataReadiness({
            metadataPath: scopedDiffMetadataPath,
            preflight: options.preflight,
            preflightPath: options.preflightPath,
            preflightSha256: options.preflightSha256,
            reviewType
        })
        : { ready: true, reason: 'Scoped diff metadata is not required for this review context.' };
    return {
        scopedDiffReadiness,
        reviewerReadinessChain,
        reviewContextChain,
        commands: {
            buildScopedDiff: buildCommand(
                'Build scoped diff',
                buildScopedDiffCommand({
                    cliPrefix: options.cliPrefix,
                    reviewType,
                    preflightCommandPath: options.preflightCommandPath,
                    outputPath: toRepoDisplayPath(options.repoRoot, scopedDiffOutputPath),
                    metadataPath: toRepoDisplayPath(options.repoRoot, scopedDiffMetadataPath)
                })
            ),
            buildReviewContext: buildCommand(
                buildReviewContextLabel,
                buildReviewContextCommand(
                    options.repoRoot,
                    options.cliPrefix,
                    options.taskId,
                    reviewType,
                    reviewDepth,
                    options.preflightCommandPath,
                    options.taskModePath
                )
            )
        }
    };
}

function resolveDownstreamDependencyRebindDecisionRoute(
    options: PostReviewLifecycleStateOptions
): PostReviewRoute | null {
    const dependencyRebind = options.reviewGateAlreadyPassed
        ? null
        : findDownstreamReviewNeedingDependencyRebind({
            eventsRoot: options.eventsRoot,
            taskId: options.taskId,
            requiredReviewTypes: options.requiredReviewTypes,
            requiredReviews: options.requiredReviews,
            policyMode: options.reviewPolicyMode,
            reviewStates: options.reviewStates
        });
    if (!dependencyRebind) {
        return null;
    }
    const reviewType = dependencyRebind.downstreamState.reviewType;
    const context = buildReviewRecoveryRouteContext(
        options,
        reviewType,
        dependencyRebind.downstreamState,
        `latest upstream '${dependencyRebind.upstreamReviewType}' review evidence is recorded before re-binding '${reviewType}' review context`,
        'Build review context'
    );
    return resolveDownstreamDependencyRebindRoute({
        reviewPolicyMode: options.reviewPolicyMode,
        downstreamReviewType: reviewType,
        upstreamReviewType: dependencyRebind.upstreamReviewType,
        ...context
    });
}

function resolveStaleUpstreamRecoveryDecisionRoute(
    options: PostReviewLifecycleStateOptions
): PostReviewRoute | null {
    const recovery = options.reviewGateAlreadyPassed
        ? null
        : findReviewGateStaleUpstreamRecovery({
            repoRoot: options.repoRoot,
            eventsRoot: options.eventsRoot,
            taskId: options.taskId,
            requiredReviewTypes: options.requiredReviewTypes,
            requiredReviews: options.requiredReviews,
            policyMode: options.reviewPolicyMode,
            reviewStates: options.reviewStates
        });
    if (!recovery) {
        return null;
    }
    const reviewType = recovery.upstreamReviewType;
    const context = buildReviewRecoveryRouteContext(
        options,
        reviewType,
        recovery.upstreamState,
        `latest review gate failure seq ${recovery.latestReviewGateFailureSequence} ` +
            `rejected stale upstream '${reviewType}' context/routing before downstream ` +
            `'${recovery.downstreamReviewType}' closeout validation`,
        'Build upstream review context'
    );
    return resolveReviewGateStaleUpstreamRecoveryRoute({
        upstreamReviewType: reviewType,
        reuseCandidateHint:
            recovery.upstreamState.reusedExistingReview
            && timelineHasReviewReuseRecordedAfterCompile(
                options.eventsRoot,
                options.taskId,
                recovery.upstreamState
            )
                ? 'current-context-candidate'
                : 'validation-required',
        ...context
    });
}

function resolveStaleContextRecoveryDecisionRoute(
    options: PostReviewLifecycleStateOptions
): PostReviewRoute | null {
    const recovery = options.reviewGateAlreadyPassed
        ? null
        : findReviewGateStaleContextPrecheckRecovery({
            repoRoot: options.repoRoot,
            eventsRoot: options.eventsRoot,
            taskId: options.taskId,
            requiredReviewTypes: options.requiredReviewTypes,
            reviewStates: options.reviewStates
        });
    if (!recovery) {
        return null;
    }
    const context = buildReviewRecoveryRouteContext(
        options,
        recovery.reviewType,
        recovery.state,
        `current '${recovery.reviewType}' review context must be rebound before required-reviews-check`,
        'Build review context'
    );
    return resolveReviewGateStaleContextPrecheckRecoveryRoute({
        reviewType: recovery.reviewType,
        ...context
    });
}

function buildReviewAuthorshipAttestationDefaults(
    options: PostReviewLifecycleStateOptions
): Record<string, boolean> {
    return Object.fromEntries(options.requiredReviewTypes.map((reviewType) => {
        const state = options.reviewStates.find((candidate) => candidate.reviewType === reviewType);
        return [
            reviewType,
            state
                ? reviewStateHasSatisfiedEvidence(options.repoRoot, options.eventsRoot, options.taskId, state)
                : false
        ];
    }));
}

function resolveGroupedFollowUpDecisionRoute(
    options: PostReviewLifecycleStateOptions,
    authorshipDefaults: Record<string, boolean>
): PostReviewRoute | null {
    const allRequiredReviewLanesSatisfied = Object.values(authorshipDefaults).every(Boolean);
    const state = allRequiredReviewLanesSatisfied
        ? options.reviewStates.find((candidate) => (
            candidate.reviewFollowUpMaterializationMode === 'grouped_by_parent'
            && candidate.ready
            && candidate.reviewFindingsDisposition
            && candidate.reviewFindingsDisposition.counts_by_action.create_follow_up > 0
            && !candidate.reviewFindingsFollowUpSatisfied
        ))
        : null;
    if (!state) {
        return null;
    }
    const disposition = state.reviewFindingsDisposition;
    if (!disposition) {
        throw new Error(`Grouped follow-up state '${state.reviewType}' is missing disposition evidence.`);
    }
    const dispositionArtifactPath = state.reviewFindingsDispositionArtifactPath
        || path.join(options.reviewsRoot, `${options.taskId}-${state.reviewType}-findings-disposition.json`);
    const followUpArtifactPath = state.reviewFindingsFollowUpArtifactPath
        || dispositionArtifactPath.replace(/-findings-disposition\.json$/u, '-findings-follow-ups.json');
    return resolveGroupedReviewFollowUpRoute({
        allRequiredReviewLanesSatisfied,
        reviewType: state.reviewType,
        groupedByParent: state.reviewFollowUpMaterializationMode === 'grouped_by_parent',
        stateReady: state.ready,
        dispositionReady: true,
        followUpCount: disposition.counts_by_action.create_follow_up,
        followUpSatisfied: state.reviewFindingsFollowUpSatisfied,
        updateCommand: buildCommand(
            'Update grouped review follow-up task',
            `${options.cliPrefix} gate materialize-review-follow-up-tasks ` +
                `--task-id "${options.taskId}" ` +
                `--review-type "${state.reviewType}" ` +
                `--disposition-artifact-path "${toRepoDisplayPath(options.repoRoot, dispositionArtifactPath)}" ` +
                `--receipt-path "${toRepoDisplayPath(options.repoRoot, state.receiptPath)}" ` +
                `--artifact-path "${toRepoDisplayPath(options.repoRoot, followUpArtifactPath)}" ` +
                '--repo-root "."'
        )
    });
}

function resolveCloseoutDecisionRoute(
    options: PostReviewLifecycleStateOptions,
    authorshipDefaults: Record<string, boolean>
): PostReviewRoute {
    const route = resolvePostReviewCloseoutRouteFromState({
        ...options.closeoutState,
        requiredReviewsCommand: buildRequiredReviewsCheckCommand(
            options.repoRoot,
            options.cliPrefix,
            options.taskId,
            options.preflightCommandPath,
            options.taskModePath,
            authorshipDefaults
        )
    });
    return {
        status: route.status,
        nextGate: route.nextGate,
        title: route.title,
        reason: route.reason,
        commands: route.commands
    };
}

export function resolvePostReviewLifecycleDecisionRouteFromState(
    options: PostReviewLifecycleStateOptions
): PostReviewRoute {
    let authorshipDefaults: Record<string, boolean> | null = null;
    const getAuthorshipDefaults = (): Record<string, boolean> => {
        authorshipDefaults ||= buildReviewAuthorshipAttestationDefaults(options);
        return authorshipDefaults;
    };
    const route = resolvePostReviewLifecycleDecisionRoute({
        resolveDownstreamDependencyRebindRoute: () => resolveDownstreamDependencyRebindDecisionRoute(options),
        resolveStaleUpstreamRecoveryRoute: () => resolveStaleUpstreamRecoveryDecisionRoute(options),
        resolveStaleContextRecoveryRoute: () => resolveStaleContextRecoveryDecisionRoute(options),
        resolveGroupedFollowUpRoute: () => resolveGroupedFollowUpDecisionRoute(options, getAuthorshipDefaults()),
        resolveCloseoutRoute: () => resolveCloseoutDecisionRoute(options, getAuthorshipDefaults())
    });
    if (!route) {
        throw new Error('Post-review lifecycle routing did not produce a closeout decision.');
    }
    return route;
}

export function resolveGroupedReviewFollowUpRoute(options: {
    allRequiredReviewLanesSatisfied: boolean;
    reviewType: string;
    groupedByParent: boolean;
    stateReady: boolean;
    dispositionReady: boolean;
    followUpCount: number;
    followUpSatisfied: boolean;
    updateCommand: PostReviewCommand;
}): PostReviewRoute | null {
    if (
        !options.allRequiredReviewLanesSatisfied
        || !options.groupedByParent
        || !options.stateReady
        || !options.dispositionReady
        || options.followUpCount <= 0
        || options.followUpSatisfied
    ) {
        return null;
    }
    return {
        status: 'BLOCKED',
        nextGate: 'materialize-review-follow-up-tasks',
        title: `Add '${options.reviewType}' deferred items to the grouped follow-up task.`,
        reason:
            `All currently required review lanes are complete. Add ${options.followUpCount} ` +
            `'${options.reviewType}' deferred item(s) to the snapshot-bound grouped child before required-review closeout.`,
        commands: [options.updateCommand]
    };
}

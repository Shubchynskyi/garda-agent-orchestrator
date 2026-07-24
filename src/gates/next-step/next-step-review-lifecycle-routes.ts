import {
    DELEGATED_REVIEWER_IDENTITY_FROM_PROVIDER_PLACEHOLDER,
    isPlannedReviewerIdentity,
    isResolvedReviewerIdentity
} from '../../gate-runtime/review/reviewer-identity-contract';
import { normalizePath } from '../shared/helpers';
import type {
    NextStepDecisionRoutePayload
} from './next-step-decision-route-groups';
import {
    resolveDelegatedReviewDecisionRoute
} from './next-step-decision-route-groups';
import type {
    DelegatedReviewLaunchArtifactState
} from './next-step-review-readiness-routing';

type ReviewLifecycleRoute = NextStepDecisionRoutePayload;
type ReviewLifecycleRouteResolver = () => ReviewLifecycleRoute | null;
type ReviewLifecycleCommand = ReviewLifecycleRoute['commands'][number];

export function resolveFindingsFollowUpLifecycleRoute(options: {
    reviewType: string;
    findingsDispositionReady: boolean;
    followUpCount: number;
    followUpSatisfied: boolean;
    groupedByParent: boolean;
    validationArtifactDisplayPath: string | null;
    materializeFollowUpsCommand: ReviewLifecycleCommand;
}): ReviewLifecycleRoute | null {
    if (
        !options.findingsDispositionReady
        || options.followUpCount <= 0
        || options.followUpSatisfied
        || options.groupedByParent
    ) {
        return null;
    }
    return {
        status: 'BLOCKED',
        nextGate: 'materialize-review-follow-up-tasks',
        title: `Materialize '${options.reviewType}' review follow-up tasks.`,
        reason:
            `Accepted '${options.reviewType}' findings disposition requires ` +
            `${options.followUpCount} follow-up item(s). ` +
            'Materialize TASK.md follow-up rows before downstream review, reuse, required-review, or completion decisions treat this review as satisfied. ' +
            `Validation artifact: ${options.validationArtifactDisplayPath || 'unknown'}.`,
        commands: [options.materializeFollowUpsCommand]
    };
}

export interface ActiveReviewLifecycleRouteResolvers {
    resolveFindingsFollowUpRoute: ReviewLifecycleRouteResolver;
    resolveCurrentCycleReuseRoute: ReviewLifecycleRouteResolver;
    resolveDependencyPreparationRoute: ReviewLifecycleRouteResolver;
    resolveStrictSequentialUpstreamReuseRoute: ReviewLifecycleRouteResolver;
    resolveFailedReviewRemediationRoute: ReviewLifecycleRouteResolver;
    resolveContextPreparationRoute: ReviewLifecycleRouteResolver;
    resolveDelegatedReadinessRoute: ReviewLifecycleRouteResolver;
}

export function resolveActiveReviewLifecycleDecisionRoute(
    resolvers: ActiveReviewLifecycleRouteResolvers
): ReviewLifecycleRoute | null {
    const orderedResolvers: readonly ReviewLifecycleRouteResolver[] = [
        resolvers.resolveFindingsFollowUpRoute,
        resolvers.resolveCurrentCycleReuseRoute,
        resolvers.resolveDependencyPreparationRoute,
        resolvers.resolveStrictSequentialUpstreamReuseRoute,
        resolvers.resolveFailedReviewRemediationRoute,
        resolvers.resolveContextPreparationRoute,
        resolvers.resolveDelegatedReadinessRoute
    ];
    for (const resolveRoute of orderedResolvers) {
        const route = resolveRoute();
        if (route) {
            return route;
        }
    }
    return null;
}

export function resolveCurrentCycleReviewReuseRoute(options: {
    reviewType: string;
    stateReady: boolean;
    contextExists: boolean;
    domainScopeCurrent: boolean;
    reviewFailed: boolean;
    currentReviewEvidenceSatisfied: boolean;
    postReviewGateFreshnessRecoveryActive: boolean;
    postReviewGateFreshnessRecoveryReason: string;
    scopedDiffReadiness: {
        ready: boolean;
        reason: string;
    };
    reviewerReadinessChain: string;
    reviewContextChain: string;
    commands: {
        buildScopedDiff: ReviewLifecycleRoute['commands'][number];
        buildReviewContext: ReviewLifecycleRoute['commands'][number];
    };
}): ReviewLifecycleRoute | null {
    if (
        !options.stateReady
        || !options.contextExists
        || !options.domainScopeCurrent
        || options.reviewFailed
        || options.currentReviewEvidenceSatisfied
    ) {
        return null;
    }

    const reuseRecoveryTrigger = options.postReviewGateFreshnessRecoveryActive
        ? `Review gate already passed, but ${options.postReviewGateFreshnessRecoveryReason}`
        : `Current '${options.reviewType}' PASS evidence is lane-domain current but not bound as current-cycle review evidence after the latest compile`;
    if (!options.scopedDiffReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'build-scoped-diff',
            title: options.postReviewGateFreshnessRecoveryActive
                ? `Prepare '${options.reviewType}' scoped diff metadata for post-review reuse.`
                : `Prepare '${options.reviewType}' scoped diff metadata for review reuse.`,
            reason:
                `${options.scopedDiffReadiness.reason} ${reuseRecoveryTrigger}; ` +
                'Prepare scoped metadata so build-review-context can materialize reuse instead of launching a fresh reviewer. ' +
                `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
            commands: [options.commands.buildScopedDiff]
        };
    }

    return {
        status: 'BLOCKED',
        nextGate: 'build-review-context',
        title: options.postReviewGateFreshnessRecoveryActive
            ? `Materialize '${options.reviewType}' review reuse before closeout.`
            : `Materialize '${options.reviewType}' review reuse before continuing.`,
        reason:
            `${reuseRecoveryTrigger}. Rebuild the review context to materialize reuse before rerunning ` +
            'required-reviews-check or continuing dependent review work, without launching a fresh reviewer. ' +
            `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
        commands: [options.commands.buildReviewContext]
    };
}

export interface DelegatedReviewerIdentityBinding {
    delegatedReviewerIdentity: string;
    reviewerIdentity: string;
    reviewerIdentityIsPlanned: boolean;
}

export function resolveDelegatedReviewerIdentityBinding(options: {
    contextReviewerIdentity: string;
    launchArtifactState: DelegatedReviewLaunchArtifactState;
    launchReviewerIdentity: string | null;
}): DelegatedReviewerIdentityBinding {
    const resolvedLaunchReviewerIdentity = String(options.launchReviewerIdentity || '').trim();
    const delegatedReviewerIdentity = options.launchArtifactState !== 'prepared'
        && isResolvedReviewerIdentity(resolvedLaunchReviewerIdentity)
        ? resolvedLaunchReviewerIdentity
        : DELEGATED_REVIEWER_IDENTITY_FROM_PROVIDER_PLACEHOLDER;
    return {
        delegatedReviewerIdentity,
        reviewerIdentity: isResolvedReviewerIdentity(options.contextReviewerIdentity)
            ? options.contextReviewerIdentity
            : delegatedReviewerIdentity,
        reviewerIdentityIsPlanned: isPlannedReviewerIdentity(options.contextReviewerIdentity)
    };
}

export function buildReviewerOneShotLaunchHint(options: {
    launchArtifactState: DelegatedReviewLaunchArtifactState;
    launchInputArtifactPath: string | null;
    launchInputArtifactSha256: string | null;
}): string | null {
    if (
        options.launchArtifactState !== 'prepared'
        || !options.launchInputArtifactPath
        || !options.launchInputArtifactSha256
    ) {
        return null;
    }
    return (
        'ReviewerOneShotLaunchHint: launch a fresh delegated reviewer once with the exact opaque handoff ' +
        `ReviewerLaunchInputArtifactPath: ${normalizePath(options.launchInputArtifactPath)} ` +
        `(launch_input_sha256=${options.launchInputArtifactSha256}) ` +
        'or CopyPasteReviewerLaunchPrompt from prepare-reviewer-launch. ' +
        'ReviewerLaunchArtifactPath is main-agent control metadata, not the clean-context reviewer prompt. ' +
        'Then run record-reviewer-delegation-started immediately after provider launch.'
    );
}

export function resolveContextPreparationLifecycleRoute(options: {
    contextReady: boolean;
    reviewType: string;
    reviewerReadinessChain: string;
    reviewContextChain: string;
    preparationRoute: ReviewLifecycleRoute | null;
    buildReviewContextCommand: ReviewLifecycleCommand;
}): ReviewLifecycleRoute | null {
    if (options.contextReady) {
        return null;
    }
    if (options.preparationRoute) {
        return options.preparationRoute;
    }
    return {
        status: 'BLOCKED',
        nextGate: 'build-review-context',
        title: `Prepare '${options.reviewType}' review context.`,
        reason:
            `Required review '${options.reviewType}' review-context state is inconsistent for the current preflight. ` +
            `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
        commands: [options.buildReviewContextCommand]
    };
}

type DelegatedReviewDecisionOptions = Parameters<typeof resolveDelegatedReviewDecisionRoute>[0];

export function resolveDelegatedReadinessLifecycleRoute(options: {
    contextReady: boolean;
    contextReviewerIdentity: string;
    recordedReviewerIdentity: string;
    launchArtifactState: DelegatedReviewLaunchArtifactState;
    identityBinding: DelegatedReviewerIdentityBinding;
    launchInputArtifactPath: string | null;
    launchInputArtifactSha256: string | null;
    decision: Omit<
        DelegatedReviewDecisionOptions,
        | 'reviewerIdentity'
        | 'contextReviewerIdentity'
        | 'reviewerIdentityIsPlanned'
        | 'oneShotLaunchHint'
        | 'launchArtifactState'
    >;
}): ReviewLifecycleRoute | null {
    if (!options.contextReady) {
        return null;
    }
    return resolveDelegatedReviewDecisionRoute({
        ...options.decision,
        reviewerIdentity: options.recordedReviewerIdentity,
        contextReviewerIdentity: options.contextReviewerIdentity,
        reviewerIdentityIsPlanned: options.identityBinding.reviewerIdentityIsPlanned,
        launchArtifactState: options.launchArtifactState,
        oneShotLaunchHint: buildReviewerOneShotLaunchHint({
            launchArtifactState: options.launchArtifactState,
            launchInputArtifactPath: options.launchInputArtifactPath,
            launchInputArtifactSha256: options.launchInputArtifactSha256
        })
    });
}

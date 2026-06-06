export interface ReviewReuseRoutingCommand {
    label: string;
    command: string;
}

export interface ReviewReuseRoutingRoute {
    status: 'BLOCKED';
    nextGate: string;
    title: string;
    reason: string;
    commands: ReviewReuseRoutingCommand[];
}

export interface ReviewReuseScopedDiffReadiness {
    ready: boolean;
    reason: string;
}

export type ReviewReuseCandidateHint = 'current-context-candidate' | 'validation-required';

export interface StrictSequentialUpstreamReuseRouteOptions {
    reviewPolicyMode: string;
    downstreamReviewType: string;
    upstreamReviewType: string;
    reuseCandidateHint: ReviewReuseCandidateHint;
    upstreamScopedDiffReadiness: ReviewReuseScopedDiffReadiness;
    upstreamReviewerReadinessChain: string;
    upstreamReviewContextChain: string;
    commands: {
        buildScopedDiff: ReviewReuseRoutingCommand;
        buildReviewContext: ReviewReuseRoutingCommand;
    };
}

export function resolveStrictSequentialUpstreamReuseRoute(
    options: StrictSequentialUpstreamReuseRouteOptions
): ReviewReuseRoutingRoute {
    const validationRequired = options.reuseCandidateHint === 'validation-required';
    if (!options.upstreamScopedDiffReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'build-scoped-diff',
            title: `Prepare '${options.upstreamReviewType}' scoped diff metadata before downstream '${options.downstreamReviewType}'.`,
            reason:
                `${options.upstreamScopedDiffReadiness.reason} Configured review policy '${options.reviewPolicyMode}' ` +
                `requires lane-domain-current '${options.upstreamReviewType}' PASS evidence to be rebound before ` +
                `continuing to downstream '${options.downstreamReviewType}' after a domain-limited remediation. ` +
                `${validationRequired
                    ? 'Reuse eligibility validation is still required before treating that PASS evidence as reusable. '
                    : ''
                }` +
                `${options.upstreamReviewerReadinessChain} ${options.upstreamReviewContextChain}`,
            commands: [options.commands.buildScopedDiff]
        };
    }

    const reuseReason = validationRequired
        ? `The existing '${options.upstreamReviewType}' PASS evidence is lane-domain current after a domain-limited remediation, ` +
            'but its exact review-context/reuse hash eligibility has not been validated for the current preflight, ' +
            `so rebuild '${options.upstreamReviewType}' review context and let build-review-context validate reuse eligibility ` +
            'before treating that PASS evidence as reusable or deciding a fresh reviewer is required.'
        : `The existing '${options.upstreamReviewType}' PASS evidence is lane-domain current after a domain-limited remediation, ` +
            `so rebuild '${options.upstreamReviewType}' review context to materialize reuse instead of launching a fresh ` +
            `'${options.upstreamReviewType}' reviewer.`;

    return {
        status: 'BLOCKED',
        nextGate: 'build-review-context',
        title: `Materialize '${options.upstreamReviewType}' review reuse before downstream '${options.downstreamReviewType}'.`,
        reason:
            `Configured review policy '${options.reviewPolicyMode}' requires current-cycle '${options.upstreamReviewType}' ` +
            `binding before downstream '${options.downstreamReviewType}' review-context preparation. ${reuseReason} ` +
            `${options.upstreamReviewerReadinessChain} ${options.upstreamReviewContextChain}`,
        commands: [options.commands.buildReviewContext]
    };
}

export interface FailedReviewRemediationRouteOptions {
    taskId: string;
    reviewType: string;
    verdictToken: string;
    failureKind: string | null;
    failureReason: string | null;
    currentReviewRecordedEvidenceCurrent: boolean;
    currentReviewContextPrepared: boolean;
    scopedDiffReadiness: ReviewReuseScopedDiffReadiness;
    reviewerReadinessChain: string;
    reviewContextChain: string;
    downstreamReviewTypes: readonly string[];
    commands: {
        restartReviewCycle: ReviewReuseRoutingCommand;
        rerunNavigator: ReviewReuseRoutingCommand;
        buildScopedDiff: ReviewReuseRoutingCommand;
        buildReviewContext: ReviewReuseRoutingCommand;
    };
}

export function resolveFailedReviewRemediationRoute(
    options: FailedReviewRemediationRouteOptions
): ReviewReuseRoutingRoute | null {
    if (options.failureKind === 'launch-package' && options.currentReviewRecordedEvidenceCurrent) {
        return {
            status: 'BLOCKED',
            nextGate: 'reviewer-launch-retry',
            title: `Retry '${options.reviewType}' reviewer launch package.`,
            reason:
                `Recorded '${options.reviewType}' review verdict is '${options.verdictToken}', ` +
                `but the failure matches reviewer launch package or binding evidence (${options.failureReason || 'launch package mismatch'}). ` +
                'Preserve the failed review artifact and receipt as audit evidence; do not edit them by hand and do not make fake implementation changes. ' +
                `Restart the review cycle to rebuild '${options.reviewType}' launch metadata and launch a fresh reviewer before downstream reviews.`,
            commands: [options.commands.restartReviewCycle]
        };
    }

    if (options.failureKind === 'missing-validation-evidence' && options.currentReviewRecordedEvidenceCurrent) {
        const selectorPath = `garda-agent-orchestrator/runtime/manual-validation/${options.taskId}/review-evidence.json`;
        return {
            status: 'BLOCKED',
            nextGate: 'review-evidence-refresh',
            title: `Refresh '${options.reviewType}' review evidence attachments.`,
            reason:
                `Recorded '${options.reviewType}' review verdict is '${options.verdictToken}', ` +
                `but the failure matches missing attached validation evidence (${options.failureReason || 'missing validation evidence'}). ` +
                'Preserve the failed review artifact and receipt as audit evidence; do not edit them by hand and do not make fake implementation changes. ' +
                `Create or update the manual-validation evidence selector '${selectorPath}' with selected_logs entries for the already-run validation logs; each entry must include path, command, and exit_code or status, and may set review_types to ['${options.reviewType}']. ` +
                'Do not add task-scoped runtime/manual-validation files to preflight --changed-file scope; restart-review-cycle treats them as ignored attachment evidence and refreshes only the affected review lane plus policy-required dependencies. ' +
                'After the selector is current, run restart-review-cycle with task-specific impact analysis, then rebuild the failed review context and launch a fresh reviewer before downstream reviews.',
            commands: [options.commands.restartReviewCycle]
        };
    }

    if (options.currentReviewRecordedEvidenceCurrent) {
        const downstreamText = options.downstreamReviewTypes.length > 0
            ? ` Dependent reviews currently blocked by this failure: ${options.downstreamReviewTypes.join(', ')}.`
            : '';
        return {
            status: 'BLOCKED',
            nextGate: 'implementation',
            title: `Fix failed '${options.reviewType}' review findings before continuing.`,
            reason:
                `Recorded '${options.reviewType}' review verdict is '${options.verdictToken}'. ` +
                `Do not launch downstream reviewers or rerun '${options.reviewType}' before implementation changes are made. ` +
                `Fix the findings, rerun compile-gate, then rebuild and rerun '${options.reviewType}' review.${downstreamText}`,
            commands: [options.commands.rerunNavigator]
        };
    }

    if (options.currentReviewContextPrepared) {
        return null;
    }

    if (!options.scopedDiffReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'build-scoped-diff',
            title: `Prepare '${options.reviewType}' scoped diff metadata.`,
            reason:
                `${options.scopedDiffReadiness.reason} A previous '${options.reviewType}' review recorded ` +
                `'${options.verdictToken}', but scoped diff metadata must be refreshed ` +
                `before rebuilding '${options.reviewType}' review context. ${options.reviewerReadinessChain} ${options.reviewContextChain}`,
            commands: [options.commands.buildScopedDiff]
        };
    }

    return {
        status: 'BLOCKED',
        nextGate: 'build-review-context',
        title: `Refresh '${options.reviewType}' review context after implementation changes.`,
        reason:
            `A previous '${options.reviewType}' review recorded '${options.verdictToken}', ` +
            'but that failed-review routing is no longer current after the latest compile cycle. ' +
            `Rebuild '${options.reviewType}' review context and launch a fresh reviewer before any dependent reviews. ` +
            `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
        commands: [options.commands.buildReviewContext]
    };
}

export interface DownstreamDependencyRebindRouteOptions {
    reviewPolicyMode: string;
    downstreamReviewType: string;
    upstreamReviewType: string;
    scopedDiffReadiness: ReviewReuseScopedDiffReadiness;
    reviewerReadinessChain: string;
    reviewContextChain: string;
    commands: {
        buildScopedDiff: ReviewReuseRoutingCommand;
        buildReviewContext: ReviewReuseRoutingCommand;
    };
}

export function resolveDownstreamDependencyRebindRoute(
    options: DownstreamDependencyRebindRouteOptions
): ReviewReuseRoutingRoute {
    if (!options.scopedDiffReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'build-scoped-diff',
            title: `Prepare '${options.downstreamReviewType}' scoped diff metadata.`,
            reason:
                `${options.scopedDiffReadiness.reason} Rebinding '${options.downstreamReviewType}' after upstream ` +
                `'${options.upstreamReviewType}' review evidence requires current scoped diff metadata before rebuilding the review context. ` +
                `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
            commands: [options.commands.buildScopedDiff]
        };
    }

    return {
        status: 'BLOCKED',
        nextGate: 'build-review-context',
        title: `Refresh '${options.downstreamReviewType}' review context after upstream review reuse.`,
        reason:
            `Configured review policy '${options.reviewPolicyMode}' requires '${options.downstreamReviewType}' to start after upstream ` +
            `'${options.upstreamReviewType}' evidence. Current '${options.downstreamReviewType}' evidence is otherwise present, ` +
            `but its latest review phase predates the upstream review record, so rebind '${options.downstreamReviewType}' through build-review-context/reuse before required-reviews-check and completion. ` +
            `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
        commands: [options.commands.buildReviewContext]
    };
}

export interface ReviewGateStaleUpstreamRecoveryRouteOptions {
    upstreamReviewType: string;
    reuseCandidateHint: ReviewReuseCandidateHint;
    scopedDiffReadiness: ReviewReuseScopedDiffReadiness;
    reviewerReadinessChain: string;
    reviewContextChain: string;
    commands: {
        buildScopedDiff: ReviewReuseRoutingCommand;
        buildReviewContext: ReviewReuseRoutingCommand;
    };
}

export function resolveReviewGateStaleUpstreamRecoveryRoute(
    options: ReviewGateStaleUpstreamRecoveryRouteOptions
): ReviewReuseRoutingRoute {
    const validationRequired = options.reuseCandidateHint === 'validation-required';
    if (!options.scopedDiffReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'build-scoped-diff',
            title: `Prepare '${options.upstreamReviewType}' scoped diff metadata after review gate failure.`,
            reason:
                `${options.scopedDiffReadiness.reason} The latest required-reviews-check failure indicates stale upstream ` +
                `'${options.upstreamReviewType}' context/routing evidence; rebuild scoped metadata before re-binding that upstream lane. ` +
                `${validationRequired
                    ? 'Reuse eligibility validation is still required before treating that PASS evidence as reusable. '
                    : ''
                }` +
                `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
            commands: [options.commands.buildScopedDiff]
        };
    }

    const reuseReason = validationRequired
        ? `Rebind '${options.upstreamReviewType}' through build-review-context so reuse eligibility validation can run ` +
            'before treating that PASS evidence as reusable or deciding a fresh reviewer is required, preserving fail-closed review validation.'
        : `Rebind '${options.upstreamReviewType}' through build-review-context/reuse before rerunning required-reviews-check, ` +
            'preserving fail-closed review validation.';

    return {
        status: 'BLOCKED',
        nextGate: 'build-review-context',
        title: `Recover stale upstream '${options.upstreamReviewType}' review evidence after review gate failure.`,
        reason:
            `The latest required-reviews-check failed after compile, and upstream '${options.upstreamReviewType}' is lane-domain current ` +
            `but its review-context/routing binding is stale for the current preflight. ${reuseReason} ` +
            `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
        commands: [options.commands.buildReviewContext]
    };
}

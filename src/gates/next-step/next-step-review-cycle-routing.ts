import type {
    NextStepCommand,
    NextStepStatus
} from './';

export interface NextStepReviewCycleRoute {
    status: NextStepStatus;
    nextGate: string;
    title: string;
    reason: string;
    commands: NextStepCommand[];
}

export interface NextStepReviewCycleScopedDiffReadiness {
    ready: boolean;
    reason: string;
}

export interface NextStepReviewLaunchableLanePreparationOptions {
    reviewPolicyMode: string;
    reviewType: string;
    dependencies: readonly string[];
    dependencyDetails: string;
    reviewerReadinessChain: string;
    reviewContextChain: string;
    scopedDiffReadiness: NextStepReviewCycleScopedDiffReadiness;
    stateExists: boolean;
    contextExists: boolean;
    contextCurrent: boolean;
    contextDetailsSuffix: string;
    commands: {
        finishUpstreamReview: NextStepCommand;
        buildScopedDiff: NextStepCommand;
        buildReviewContext: NextStepCommand;
    };
}

export function resolveReviewLaunchableLanePreparationRoute(
    options: NextStepReviewLaunchableLanePreparationOptions
): NextStepReviewCycleRoute | null {
    if (options.dependencies.length > 0) {
        return {
            status: 'BLOCKED',
            nextGate: 'build-review-context',
            title: `Review '${options.reviewType}' is waiting for upstream review evidence.`,
            reason:
                `Configured review policy '${options.reviewPolicyMode}' requires upstream PASS evidence before ` +
                `'${options.reviewType}': ${options.dependencyDetails}. Do not launch '${options.reviewType}' ` +
                `reviewer until those dependencies pass. ${options.reviewerReadinessChain}`,
            commands: [options.commands.finishUpstreamReview]
        };
    }

    if (options.stateExists && options.contextExists && options.contextCurrent) {
        return null;
    }

    if (!options.scopedDiffReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'build-scoped-diff',
            title: `Prepare '${options.reviewType}' scoped diff metadata.`,
            reason:
                `${options.scopedDiffReadiness.reason} Required '${options.reviewType}' review contexts for ` +
                `code-changing scopes must include scoped diff metadata before reviewer routing. ` +
                `${options.reviewerReadinessChain} ${options.reviewContextChain}`,
            commands: [options.commands.buildScopedDiff]
        };
    }

    return {
        status: 'BLOCKED',
        nextGate: 'build-review-context',
        title: `Prepare '${options.reviewType}' review context.`,
        reason: !options.stateExists || !options.contextExists
            ? `Required review '${options.reviewType}' has no canonical review-context artifact. ` +
                `${options.reviewerReadinessChain} ${options.reviewContextChain}`
            : `Required review '${options.reviewType}' review-context artifact is stale for the current preflight.` +
                `${options.contextDetailsSuffix} ${options.reviewerReadinessChain} ${options.reviewContextChain}`,
        commands: [options.commands.buildReviewContext]
    };
}

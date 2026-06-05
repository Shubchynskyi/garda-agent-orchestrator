export type DelegatedReviewLaunchArtifactState = 'missing_or_invalid' | 'prepared' | 'delegation_started' | 'launched';

export interface DelegatedReviewReadinessCommand {
    label: string;
    command: string;
}

export interface DelegatedReviewReadinessRoute {
    status: 'BLOCKED';
    nextGate: string;
    title: string;
    reason: string;
    commands: DelegatedReviewReadinessCommand[];
}

export interface DelegatedReviewReadinessRouteOptions {
    reviewType: string;
    currentReviewReuseRecorded: boolean;
    currentReviewEvidenceSatisfied: boolean;
    currentReviewContextInvocationAttested: boolean;
    routingCurrent: boolean;
    artifactExists: boolean;
    receiptExists: boolean;
    reviewFailed: boolean;
    stateReady: boolean;
    stateViolationsText: string;
    reviewerIdentity: string;
    contextReviewerIdentity: string;
    launchArtifactState: DelegatedReviewLaunchArtifactState;
    providerLaunchTargetSummary: string;
    reviewerReadinessChain: string;
    reviewRoutingChain: string;
    launchPreparationChain: string;
    launchCompletionChain: string;
    reviewInvocationChain: string;
    reviewResultChain: string;
    acceptedVerdictTokens: string;
    hiddenTimingTrustRemediation: string | null;
    reusedExistingReview: boolean;
    instructions: {
        opaqueHandoff: string;
        freshContextLaunch: string;
        sessionReuseBoundary: string;
        realSubagentOrStop: string;
        cleanupAfterReceipt: string;
    };
    commands: {
        recordRouting: DelegatedReviewReadinessCommand;
        prepareLaunch: DelegatedReviewReadinessCommand;
        recordDelegationStarted: DelegatedReviewReadinessCommand;
        completeLaunch: DelegatedReviewReadinessCommand;
        recordInvocation: DelegatedReviewReadinessCommand;
        recordResult: DelegatedReviewReadinessCommand;
    };
}

export function resolveDelegatedReviewReadinessRoute(
    options: DelegatedReviewReadinessRouteOptions
): DelegatedReviewReadinessRoute | null {
    if (
        !options.currentReviewReuseRecorded
        && (
            !options.contextReviewerIdentity.startsWith('agent:')
            || !options.routingCurrent
        )
    ) {
        return {
            status: 'BLOCKED',
            nextGate: 'record-review-routing',
            title: `Record '${options.reviewType}' delegated reviewer routing.`,
            reason:
                `Required review '${options.reviewType}' needs current REVIEWER_DELEGATION_ROUTED telemetry after the latest compile pass before a review receipt can be recorded. ` +
                `${options.providerLaunchTargetSummary} ${options.instructions.opaqueHandoff} ` +
                `${options.instructions.freshContextLaunch} ${options.instructions.sessionReuseBoundary} ` +
                `${options.reviewerReadinessChain} ${options.reviewRoutingChain}`,
            commands: [options.commands.recordRouting]
        };
    }

    if (
        !options.currentReviewReuseRecorded
        && !options.currentReviewContextInvocationAttested
        && (
            !options.artifactExists
            || !options.receiptExists
            || options.reviewerIdentity !== options.contextReviewerIdentity
            || options.stateReady
            || options.reviewFailed
        )
    ) {
        if (options.launchArtifactState === 'missing_or_invalid') {
            return {
                status: 'BLOCKED',
                nextGate: 'prepare-reviewer-launch',
                title: `Prepare '${options.reviewType}' delegated reviewer launch metadata.`,
                reason:
                    `Required review '${options.reviewType}' needs task-owned reviewer launch metadata bound to the current routing event and review context before launch. ` +
                    `This prepares hashes and prompt paths only; it is not completed invocation evidence. ` +
                    `${options.providerLaunchTargetSummary} ${options.reviewerReadinessChain} ${options.launchPreparationChain}`,
                commands: [options.commands.prepareLaunch]
            };
        }

        if (options.launchArtifactState === 'prepared') {
            return {
                status: 'BLOCKED',
                nextGate: 'record-reviewer-delegation-started',
                title: `Record '${options.reviewType}' delegated reviewer start.`,
                reason:
                    `Required review '${options.reviewType}' has prepared launch metadata for the current routing event and review context. ` +
                    `Launch the delegated reviewer with the exact generated CopyPasteReviewerLaunchPrompt or ReviewerLaunchInputArtifactPath as an opaque handoff, then immediately run record-reviewer-delegation-started with the provider/controller invocation id so the gate records the real delegation start timestamp before the reviewer returns. For launch_artifact_path mode, pass the ReviewerLaunchInputArtifactSha256 value to the CLI flag --launch-input-sha256; do not invent a --launch-input-artifact-sha256 flag. Do not reconstruct reviewer prompts from memory. ` +
                    `Provider-owned placeholders in the command are only --provider-invocation-id and --attestation-source; replace them with the delegated reviewer launch result after provider launch. Launch-input artifact path, launch-input hash, reviewer identity, review type, and fork-context are already gate-owned command fragments when printed. ` +
                    `${options.providerLaunchTargetSummary} ${options.instructions.opaqueHandoff} ${options.instructions.realSubagentOrStop} ` +
                    `${options.reviewerReadinessChain} ${options.launchCompletionChain}`,
                commands: [options.commands.recordDelegationStarted]
            };
        }

        if (options.launchArtifactState === 'delegation_started') {
            return {
                status: 'BLOCKED',
                nextGate: 'complete-reviewer-launch',
                title: `Complete '${options.reviewType}' delegated reviewer launch metadata.`,
                reason:
                    `Required review '${options.reviewType}' has recorded reviewer delegation start evidence for the current routing event and review context. ` +
                    `After the delegated reviewer returns, run complete-reviewer-launch so the gate records completion attestation without redefining the reviewer start time. ` +
                    `${options.providerLaunchTargetSummary} ${options.instructions.opaqueHandoff} ${options.reviewerReadinessChain} ${options.launchCompletionChain}`,
                commands: [options.commands.completeLaunch]
            };
        }

        return {
            status: 'BLOCKED',
            nextGate: 'record-review-invocation',
            title: `Record '${options.reviewType}' delegated reviewer launch attestation.`,
            reason:
                `Required review '${options.reviewType}' has launch metadata for the current routing event and review context. ` +
                `The launch artifact already contains completed launch evidence; record that evidence with record-review-invocation. ` +
                `${options.reviewerReadinessChain} ${options.reviewInvocationChain}`,
            commands: [options.commands.recordInvocation]
        };
    }

    if (!options.stateReady) {
        return {
            status: 'BLOCKED',
            nextGate: 'record-review-result',
            title: `Record '${options.reviewType}' review result from a delegated reviewer.`,
            reason:
                `Required review '${options.reviewType}' needs a valid delegated artifact and receipt (${options.stateViolationsText}). ` +
                `${options.acceptedVerdictTokens} ${options.instructions.cleanupAfterReceipt} ` +
                `${options.reviewerReadinessChain} ${options.reviewResultChain}`,
            commands: [options.commands.recordResult]
        };
    }

    if (!options.currentReviewEvidenceSatisfied) {
        const missingEvidenceReason = options.hiddenTimingTrustRemediation
            ? `Required review '${options.reviewType}' evidence is not sufficiently trustworthy. ${options.hiddenTimingTrustRemediation}`
            : options.reusedExistingReview && !options.currentReviewReuseRecorded
            ? `Required review '${options.reviewType}' is reused, but current-cycle REVIEW_RECORDED reuse telemetry is missing or does not match the receipt, review artifact, review context, and tree-state provenance, so rerun review reuse materialization or record a fresh delegated review result.`
            : `Required review '${options.reviewType}' has stale or invalid reviewer_provenance; fresh delegated-review launch evidence is missing, stale, or spoof-like for the current receipt, so launch a fresh delegated reviewer with the printed handoff artifacts and record the exact reviewer output again.`;
        return {
            status: 'BLOCKED',
            nextGate: 'record-review-result',
            title: `Record '${options.reviewType}' review result from a delegated reviewer.`,
            reason:
                `${missingEvidenceReason} ${options.acceptedVerdictTokens} ` +
                `${options.instructions.cleanupAfterReceipt} ${options.reviewerReadinessChain}`,
            commands: [options.commands.recordResult]
        };
    }

    return null;
}

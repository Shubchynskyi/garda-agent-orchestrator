import {
    resolveReviewerRoutingPolicy
} from '../../../gates/reviewer-routing';
import {
    quotePowerShellCliValue,
    buildGateCommandBase
} from './task-mode-command-format';
import type { readRoutingDecision } from './routing-decision';

type RoutingDecision = ReturnType<typeof readRoutingDecision>;

function buildGateRerunCommand(repoRoot: string, taskId: string, gateName: string, taskModePath = ''): string {
    const parts = buildGateCommandBase(repoRoot, taskId, gateName);
    const trimmedTaskModePath = String(taskModePath || '').trim();
    if (trimmedTaskModePath) {
        parts.push(`--task-mode-path ${quotePowerShellCliValue(trimmedTaskModePath)}`);
    }
    return parts.join(' ');
}

export function resolveTaskModeReviewerRoutingFields(provider: string | null | undefined): {
    reviewerCapabilityLevel: string | null;
    reviewerExpectedExecutionMode: string | null;
    reviewerFallbackAllowed: boolean | null;
    reviewerFallbackReasonRequired: boolean | null;
} {
    if (!provider) {
        return {
            reviewerCapabilityLevel: null,
            reviewerExpectedExecutionMode: null,
            reviewerFallbackAllowed: null,
            reviewerFallbackReasonRequired: null
        };
    }
    const policy = resolveReviewerRoutingPolicy(provider);
    return {
        reviewerCapabilityLevel: policy.capability_level,
        reviewerExpectedExecutionMode: policy.expected_execution_mode,
        reviewerFallbackAllowed: policy.fallback_allowed,
        reviewerFallbackReasonRequired: policy.fallback_reason_required
    };
}

export function buildTaskModeIdentitySuggestionCommand(
    repoRoot: string,
    taskId: string,
    routingDecision: RoutingDecision,
    artifactPath = ''
): string {
    const commandParts = [
        ...buildGateCommandBase(repoRoot, taskId, 'enter-task-mode'),
        '--task-summary "<task-summary>"'
    ];
    if (routingDecision.provider) {
        commandParts.push(`--provider ${quotePowerShellCliValue(routingDecision.provider)}`);
    } else {
        commandParts.push('--provider "<provider>"');
    }
    const safeRoutedIdentityHint = routingDecision.identityStatus !== 'contradictory'
        ? (
            routingDecision.reviewerSubagentLaunchRoute
            || routingDecision.routedTo
            || routingDecision.providerBridge
            || routingDecision.executionEntrypoint
            || routingDecision.canonicalEntrypoint
        )
        : null;
    if (safeRoutedIdentityHint) {
        commandParts.push(`--routed-to ${quotePowerShellCliValue(safeRoutedIdentityHint)}`);
    }
    const trimmedArtifactPath = String(artifactPath || '').trim();
    if (trimmedArtifactPath) {
        commandParts.push(`--artifact-path ${quotePowerShellCliValue(trimmedArtifactPath)}`);
    }
    return commandParts.join(' ');
}

export function assertLaunchableReviewerSubagents(
    repoRoot: string,
    taskId: string,
    stageLabel: string,
    routingDecision: RoutingDecision,
    rerunGateName: string | null = null,
    taskModePath = ''
): void {
    const reviewerSubagentLaunchStatus = String(routingDecision.reviewerSubagentLaunchStatus || '').trim() || 'unknown';
    if (reviewerSubagentLaunchStatus === 'launchable') {
        return;
    }

    const reviewerSubagentLaunchReason = String(routingDecision.reviewerSubagentLaunchReason || '').trim();
    const reviewerSubagentLaunchRemediation = String(routingDecision.reviewerSubagentLaunchRemediation || '').trim();
    const errorParts = [
        `Reviewer subagent launchability is '${reviewerSubagentLaunchStatus}' ${stageLabel}.`
    ];
    if (reviewerSubagentLaunchReason) {
        errorParts.push(reviewerSubagentLaunchReason);
    }
    if (reviewerSubagentLaunchRemediation) {
        errorParts.push(reviewerSubagentLaunchRemediation);
    }
    if (rerunGateName) {
        errorParts.push(
            `Suggested commands: ${buildTaskModeIdentitySuggestionCommand(repoRoot, taskId, routingDecision, taskModePath)} ; ` +
            `${buildGateRerunCommand(repoRoot, taskId, rerunGateName, taskModePath)}`
        );
    } else {
        errorParts.push(`Suggested command: ${buildTaskModeIdentitySuggestionCommand(repoRoot, taskId, routingDecision, taskModePath)}`);
    }
    throw new Error(errorParts.join(' '));
}

export function assertTaskModeRuntimeIdentity(
    repoRoot: string,
    taskId: string,
    routingDecision: RoutingDecision,
    artifactPath = ''
): void {
    if (!routingDecision.canonicalSourceOfTruth) {
        throw new Error(
            'Canonical SourceOfTruth is missing at task-mode entry. Re-run setup/reinit to restore canonical owner files ' +
            `before starting '${taskId}'. Suggested command: ${buildTaskModeIdentitySuggestionCommand(repoRoot, taskId, routingDecision, artifactPath)}`
        );
    }

    if (routingDecision.identityStatus === 'resolved') {
        assertLaunchableReviewerSubagents(repoRoot, taskId, 'at task-mode entry', routingDecision, null, artifactPath);
        return;
    }

    const violationText = routingDecision.violations.length > 0
        ? ` ${routingDecision.violations.join(' ')}`
        : '';
    const remediation = 'Re-run enter-task-mode with explicit runtime identity via `--provider "<provider>"` ' +
        'and add `--routed-to "<provider-bridge-or-entrypoint>"` only when route telemetry must be pinned. ' +
        'Do not infer runtime provider from canonical SourceOfTruth.';

    throw new Error(
        `Runtime execution identity is '${routingDecision.identityStatus}' at task-mode entry.${violationText} ${remediation} ` +
        `Suggested command: ${buildTaskModeIdentitySuggestionCommand(repoRoot, taskId, routingDecision, artifactPath)}`
    );
}

export function assertResolvedRuntimeIdentityForDependentPreflightGate(
    repoRoot: string,
    taskId: string,
    gateName: string,
    routingDecision: RoutingDecision,
    taskModePath = ''
): void {
    if (!routingDecision.canonicalSourceOfTruth) {
        throw new Error(
            `Canonical SourceOfTruth is missing before ${gateName}. Re-run setup/reinit to restore canonical owner files, ` +
            `then re-enter task mode before ${gateName}. Suggested commands: ${buildTaskModeIdentitySuggestionCommand(repoRoot, taskId, routingDecision, taskModePath)} ; ` +
            `${buildGateRerunCommand(repoRoot, taskId, gateName, taskModePath)}`
        );
    }

    if (routingDecision.identityStatus === 'resolved') {
        assertLaunchableReviewerSubagents(
            repoRoot,
            taskId,
            `before ${gateName}`,
            routingDecision,
            gateName,
            taskModePath
        );
        return;
    }

    const violationText = routingDecision.violations.length > 0
        ? ` ${routingDecision.violations.join(' ')}`
        : '';
    const remediation = 'Re-enter task mode with explicit runtime identity via `--provider "<provider>"` ' +
        'and add `--routed-to "<provider-bridge-or-entrypoint>"` only when route telemetry must be pinned. ' +
        'Do not infer runtime provider from canonical SourceOfTruth.';

    throw new Error(
        `Runtime execution identity is '${routingDecision.identityStatus}' before ${gateName}.${violationText} ${remediation} ` +
        `Suggested commands: ${buildTaskModeIdentitySuggestionCommand(repoRoot, taskId, routingDecision, taskModePath)} ; ` +
        `${buildGateRerunCommand(repoRoot, taskId, gateName, taskModePath)}`
    );
}

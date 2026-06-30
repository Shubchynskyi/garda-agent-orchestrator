import type {
    NextStepCommand,
    NextStepStatus
} from './';
import { buildCommand } from './next-step-command-formatters';

export interface NextStepPreReviewRoute {
    status: NextStepStatus;
    nextGate: string;
    title: string;
    reason: string;
    commands: NextStepCommand[];
}

export interface NextStepReadinessState {
    ready: boolean;
    reason: string;
}

export interface NextStepWorkspaceReadinessState extends NextStepReadinessState {
    awaitingMaterializedPlannedScope?: boolean;
}

export interface NextStepProtectedControlPlaneRoutingOptions {
    touched: boolean;
    taskModeHasOrchestratorWork: boolean;
    selfGuardDeny: boolean;
    selfGuardGuidance: string;
    selfGuardPolicyChangeCommand: string;
    orchestratorWorkRestartCommand: string;
}

export interface NextStepPostPreflightRulePackRoutingOptions extends NextStepReadinessState {
    stage: string | null;
    canBind: boolean;
    rebindReason?: string;
    loadCommand: string;
    bindCommand: string;
}

export interface NextStepCompileGateRoutingOptions extends NextStepReadinessState {
    compileGatePassed: boolean;
    recoveryGate?: 'classify-change';
    refreshPreflightCommand: string;
    compileCommand: string;
}

export interface NextStepQualityChecklistRoutingOptions extends NextStepReadinessState {
    enabled: boolean;
    required: boolean;
    status: string | null;
    actionRequiredSummary?: string | null;
    command: string;
}

export interface NextStepPreGuardRoutingOptions {
    preflightCycleReadiness: NextStepReadinessState;
    preflightCycleRefreshCommand: string;
    protectedControlPlane: NextStepProtectedControlPlaneRoutingOptions;
    workspaceReadiness: NextStepWorkspaceReadinessState;
    workspaceRefreshCommand: string;
    failedReviewRemediation?: {
        reviewType: string;
        verdictToken: string;
        restartReviewCycleCommand: string;
    } | null;
    coherentCycleReadiness: NextStepReadinessState & { command?: string | null };
    navigatorCommand: string;
    postPreflightRulePack: NextStepPostPreflightRulePackRoutingOptions;
}

export function resolveNextStepPreGuardRoute(
    options: NextStepPreGuardRoutingOptions
): NextStepPreReviewRoute | null {
    if (!options.preflightCycleReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'classify-change',
            title: 'Refresh preflight for the current task cycle.',
            reason: options.preflightCycleReadiness.reason,
            commands: [
                buildCommand('Refresh preflight', options.preflightCycleRefreshCommand)
            ]
        };
    }

    if (options.protectedControlPlane.touched && !options.protectedControlPlane.taskModeHasOrchestratorWork) {
        if (options.protectedControlPlane.selfGuardDeny) {
            return {
                status: 'BLOCKED',
                nextGate: 'operator-maintenance',
                title: 'Garda self-guard blocks agent-owned protected control-plane work.',
                reason:
                    'The current preflight touches protected Garda control-plane files. ' +
                    options.protectedControlPlane.selfGuardGuidance,
                commands: [
                    buildCommand('Operator policy change', options.protectedControlPlane.selfGuardPolicyChangeCommand)
                ]
            };
        }
        return {
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Restart task mode as orchestrator work.',
            reason: 'The current preflight touches protected orchestrator control-plane files, but task-mode evidence does not declare --orchestrator-work. Fresh operator approval is required before the agent can rerun protected task-mode entry.',
            commands: [
                buildCommand('Restart task mode with orchestrator work', options.protectedControlPlane.orchestratorWorkRestartCommand)
            ]
        };
    }

    if (!options.workspaceReadiness.ready && options.failedReviewRemediation) {
        const remediation = options.failedReviewRemediation;
        return {
            status: 'BLOCKED',
            nextGate: 'restart-review-cycle',
            title: `Restart failed '${remediation.reviewType}' review remediation cycle.`,
            reason:
                `${options.workspaceReadiness.reason} ` +
                `The stale scope follows a recorded failed '${remediation.reviewType}' review verdict '${remediation.verdictToken}'. ` +
                'Use restart-review-cycle as the cheapest valid recovery path: it preserves the current task-mode authorization, ' +
                'runs any missing startup diagnostics before refreshing preflight, reloads POST_PREFLIGHT rules, reruns compile, ' +
                'and rebuilds the affected review context before downstream reviewers. This avoids a standalone classify-change ' +
                'that would refresh preflight after REVIEW_PHASE_STARTED and only later be rejected by coherent-cycle ordering. ' +
                'If the current cycle has already crossed a review-gate or completion boundary, restart-review-cycle fails closed ' +
                'with restart-coherent-cycle guidance instead of weakening startup evidence.',
            commands: [
                buildCommand('Restart failed-review remediation cycle', remediation.restartReviewCycleCommand)
            ]
        };
    }

    if (!options.workspaceReadiness.ready) {
        if (options.workspaceReadiness.awaitingMaterializedPlannedScope) {
            return {
                status: 'BLOCKED',
                nextGate: 'materialize-planned-scope',
                title: 'Materialize planned task changes before refreshing preflight.',
                reason: options.workspaceReadiness.reason,
                commands: []
            };
        }
        return {
            status: 'BLOCKED',
            nextGate: 'classify-change',
            title: 'Refresh preflight for the current workspace.',
            reason: options.workspaceReadiness.reason,
            commands: [
                buildCommand('Refresh preflight', options.workspaceRefreshCommand)
            ]
        };
    }

    if (!options.coherentCycleReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'restart-coherent-cycle',
            title: 'Restart the latest coherent task cycle.',
            reason: options.coherentCycleReadiness.reason,
            commands: [
                buildCommand(
                    'Restart coherent cycle',
                    options.coherentCycleReadiness.command || options.navigatorCommand
                )
            ]
        };
    }

    if (options.postPreflightRulePack.stage !== 'POST_PREFLIGHT' || !options.postPreflightRulePack.ready) {
        const canBindPostPreflightRules =
            options.postPreflightRulePack.stage === 'POST_PREFLIGHT'
            && options.postPreflightRulePack.canBind;
        return {
            status: 'BLOCKED',
            nextGate: canBindPostPreflightRules ? 'bind-rule-pack-to-preflight' : 'load-rule-pack',
            title: canBindPostPreflightRules
                ? 'Bind existing POST_PREFLIGHT rule-pack evidence to the current preflight.'
                : 'Read and record POST_PREFLIGHT rule files.',
            reason: canBindPostPreflightRules
                ? `${options.postPreflightRulePack.rebindReason || 'Rule files are already loaded.'} Rebind the machine-readable evidence to the latest preflight before compile.`
                : options.postPreflightRulePack.ready
                ? 'Preflight exists; downstream rule files and risk-specific packs must be recorded for the current scope.'
                : options.postPreflightRulePack.reason,
            commands: [
                buildCommand(
                    canBindPostPreflightRules
                        ? 'Bind POST_PREFLIGHT rules to current preflight'
                        : 'Load POST_PREFLIGHT rules',
                    canBindPostPreflightRules
                        ? options.postPreflightRulePack.bindCommand
                        : options.postPreflightRulePack.loadCommand
                )
            ]
        };
    }

    return null;
}

export function resolveNextStepQualityChecklistRoute(
    options: NextStepQualityChecklistRoutingOptions
): NextStepPreReviewRoute | null {
    if (!options.enabled || !options.required) {
        return null;
    }

    if (options.ready && ['PASS', 'WARN', 'SKIPPED_DISABLED'].includes(options.status || '')) {
        return null;
    }

    if (options.ready && options.status === 'ACTION_REQUIRED') {
        const actionSummary = options.actionRequiredSummary
            ? ` Action required: ${options.actionRequiredSummary}`
            : '';
        return {
            status: 'BLOCKED',
            nextGate: 'implementation',
            title: 'Resolve quality checklist action items.',
            reason:
                `${options.reason}${actionSummary} Address the required quality checklist follow-up in implementation, ` +
                'then refresh preflight if the workspace changed before rerunning compile, review, full-suite, or completion gates.',
            commands: []
        };
    }

    const label = options.ready && options.status === 'CONFIG_ERROR'
        ? 'Rerun quality checklist after repairing configuration or answers'
        : 'Run quality checklist';
    return {
        status: 'BLOCKED',
        nextGate: 'quality-checklist',
        title: options.ready && options.status === 'CONFIG_ERROR'
            ? 'Repair quality checklist evidence.'
            : 'Run optional quality checklist.',
        reason: options.reason,
        commands: [
            buildCommand(label, options.command)
        ]
    };
}

export function resolveNextStepCompileGateRoute(
    options: NextStepCompileGateRoutingOptions
): NextStepPreReviewRoute | null {
    if (options.compileGatePassed && options.ready) {
        return null;
    }

    if (options.recoveryGate === 'classify-change') {
        return {
            status: 'BLOCKED',
            nextGate: 'classify-change',
            title: 'Refresh preflight after compile scope drift.',
            reason: options.reason,
            commands: [
                buildCommand('Refresh preflight', options.refreshPreflightCommand)
            ]
        };
    }

    return {
        status: 'BLOCKED',
        nextGate: 'compile-gate',
        title: 'Run compile gate.',
        reason: options.reason,
        commands: [
            buildCommand('Run compile gate', options.compileCommand)
        ]
    };
}

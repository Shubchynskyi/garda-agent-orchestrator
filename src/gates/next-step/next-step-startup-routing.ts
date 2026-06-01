import type {
    NextStepCommand,
    NextStepStatus
} from './';
import { buildCommand } from './next-step-command-formatters';

export interface NextStepStartupCycleReadiness {
    ready: boolean;
    nextGate: string | null;
    title: string;
    reason: string;
}

export interface NextStepStartupRoute {
    status: NextStepStatus;
    nextGate: string;
    title: string;
    reason: string;
    commands: NextStepCommand[];
}

export interface NextStepStartupRouteOptions {
    enterTaskModePassed: boolean;
    defaultExecutionProvider: string | null;
    enterTaskModeCommand: string;
    startupCycleReadiness: NextStepStartupCycleReadiness;
    loadRulePackPassed: boolean;
    rulePackStage: string | null;
    preflightExists: boolean;
    taskEntryRulePackCommand: string;
    handshakeDiagnosticsPassed: boolean;
    handshakeDiagnosticsCommand: string;
    shellSmokePreflightPassed: boolean;
    shellSmokePreflightCommand: string;
}

function commandForStartupCycleGate(
    readiness: NextStepStartupCycleReadiness,
    options: NextStepStartupRouteOptions
): NextStepCommand {
    if (readiness.nextGate === 'load-rule-pack') {
        return buildCommand('Load TASK_ENTRY rules', options.taskEntryRulePackCommand);
    }
    if (readiness.nextGate === 'handshake-diagnostics') {
        return buildCommand('Run handshake diagnostics', options.handshakeDiagnosticsCommand);
    }
    return buildCommand('Run shell smoke preflight', options.shellSmokePreflightCommand);
}

export function resolveNextStepStartupRoute(
    options: NextStepStartupRouteOptions
): NextStepStartupRoute | null {
    if (!options.enterTaskModePassed) {
        return {
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Enter task mode first.',
            reason: options.defaultExecutionProvider
                ? 'No TASK_MODE_ENTERED event exists for this task.'
                : 'No TASK_MODE_ENTERED event exists for this task, and runtime provider could not be detected from GARDA_EXECUTION_PROVIDER or known provider environment markers. Set GARDA_EXECUTION_PROVIDER to the current execution provider before running the command; do not use SourceOfTruth as a runtime-provider fallback.',
            commands: [
                buildCommand('Enter task mode', options.enterTaskModeCommand)
            ]
        };
    }

    if (!options.startupCycleReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: options.startupCycleReadiness.nextGate || 'startup-readiness',
            title: options.startupCycleReadiness.title,
            reason: options.startupCycleReadiness.reason,
            commands: [commandForStartupCycleGate(options.startupCycleReadiness, options)]
        };
    }

    if (
        !options.loadRulePackPassed
        || options.rulePackStage !== 'TASK_ENTRY' && !options.preflightExists
    ) {
        return {
            status: 'BLOCKED',
            nextGate: 'load-rule-pack',
            title: 'Record TASK_ENTRY rule files.',
            reason: 'Task execution must record the loaded core workflow rule pack before preflight.',
            commands: [
                buildCommand('Load TASK_ENTRY rules', options.taskEntryRulePackCommand)
            ]
        };
    }

    if (!options.handshakeDiagnosticsPassed) {
        return {
            status: 'BLOCKED',
            nextGate: 'handshake-diagnostics',
            title: 'Run handshake diagnostics.',
            reason: 'Runtime identity and reviewer launchability have not been recorded.',
            commands: [
                buildCommand('Run handshake diagnostics', options.handshakeDiagnosticsCommand)
            ]
        };
    }

    if (!options.shellSmokePreflightPassed) {
        return {
            status: 'BLOCKED',
            nextGate: 'shell-smoke-preflight',
            title: 'Run shell smoke preflight.',
            reason: 'CLI launchability and filesystem probes have not been recorded.',
            commands: [
                buildCommand('Run shell smoke preflight', options.shellSmokePreflightCommand)
            ]
        };
    }

    return null;
}

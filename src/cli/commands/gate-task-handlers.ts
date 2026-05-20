import * as path from 'node:path';
import {
    emitMandatoryCompletionGateEventAsync
} from '../../gate-runtime/lifecycle-events';
import * as gateHelpers from '../../gates/helpers';
import { formatCompletionGateResult, runCompletionGate } from '../../gates/completion';
import { formatNextStepText, resolveNextStepFromCliOptions } from '../../gates/next-step';
import { withCompletionGateFinalizationLockAsync } from '../../gates/finalization-lock';
import {
    runBindRulePackToPreflightCommand,
    runEnterTaskModeCommand,
    runHandshakeDiagnosticsCommand,
    runHumanCommitCommand,
    runLoadRulePackCommand,
    runLogTaskEventCommand,
    runRecordNoOpCommand,
    runRecordStrictDecompositionDecisionCommand,
    runRestartCoherentCycleCommand,
    runRestartReviewCycleCommand,
    runShellSmokePreflightCommand,
    runCommandTimeoutDiagnosticsCommand,
    runIntermediateCommandCommand,
    runProjectMemoryImpactCommand
} from './gates';
import {
    parseOptions,
    normalizePathValue,
    ensureDirectoryExists,
    parseRequiredText
} from './cli-helpers';
import type { ParsedOptionsRecord } from './shared-command-utils';
import { reconcileSuccessfulCompletionFinalizationAsync } from './gate-flows/completion-finalization';
import { runFullSuiteValidationCommand } from './gate-flows/full-suite-validation-flow';
import { runTaskEventsSummaryCommand, runTaskAuditSummaryCommand } from './gate-flows/task-summary-flow';
import { runTaskResetCommand } from './gate-flows/task-reset-flow';
import { buildTaskResetMissingTaskIdMessage } from './task-reset-alias';
import { colorizeTaskAuditSummaryText } from './task-audit-human-format';
import { colorizeTaskEventsSummaryText } from './task-events-human-format';
import { EXIT_GATE_FAILURE } from '../exit-codes';

export async function handleEnterTaskMode(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--entry-mode': { key: 'entryMode', type: 'string' },
        '--requested-depth': { key: 'requestedDepth', type: 'string' },
        '--effective-depth': { key: 'effectiveDepth', type: 'string' },
        '--task-summary': { key: 'taskSummary', type: 'string' },
        '--start-banner': { key: 'startBanner', type: 'string' },
        '--planned-changed-file': { key: 'plannedChangedFiles', type: 'string[]' },
        '--planned-changed-files': { key: 'plannedChangedFiles', type: 'string[]' },
        '--orchestrator-work': { key: 'orchestratorWork', type: 'boolean' },
        '--workflow-config-work': { key: 'workflowConfigWork', type: 'boolean' },
        '--operator-confirmed': { key: 'operatorConfirmed', type: 'string' },
        '--operator-confirmed-at-utc': { key: 'operatorConfirmedAtUtc', type: 'string' },
        '--provider': { key: 'provider', type: 'string' },
        '--routed-to': { key: 'routedTo', type: 'string' },
        '--actor': { key: 'actor', type: 'string' },
        '--plan-path': { key: 'planPath', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runEnterTaskModeCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleLoadRulePack(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--stage': { key: 'stage', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--loaded-rule-file': { key: 'loadedRuleFiles', type: 'string[]' },
        '--loaded-rule-files': { key: 'loadedRuleFiles', type: 'string[]' },
        '--actor': { key: 'actor', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runLoadRulePackCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleBindRulePackToPreflight(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--actor': { key: 'actor', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runBindRulePackToPreflightCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleRestartCoherentCycle(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--preflight-output-path': { key: 'preflightOutputPath', type: 'string' },
        '--changed-file': { key: 'changedFiles', type: 'string[]' },
        '--changed-files': { key: 'changedFiles', type: 'string[]' },
        '--use-staged': { key: 'useStaged', type: 'boolean' },
        '--include-untracked': { key: 'includeUntracked', type: 'boolean' },
        '--task-intent': { key: 'taskIntent', type: 'string' },
        '--commands-path': { key: 'commandsPath', type: 'string' },
        '--output-filters-path': { key: 'outputFiltersPath', type: 'string' },
        '--fail-tail-lines': { key: 'failTailLines', type: 'string' },
        '--operator-confirmed': { key: 'operatorConfirmed', type: 'string' },
        '--operator-confirmed-at-utc': { key: 'operatorConfirmedAtUtc', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = await runRestartCoherentCycleCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleRestartReviewCycle(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--preflight-output-path': { key: 'preflightOutputPath', type: 'string' },
        '--changed-file': { key: 'changedFiles', type: 'string[]' },
        '--changed-files': { key: 'changedFiles', type: 'string[]' },
        '--use-staged': { key: 'useStaged', type: 'boolean' },
        '--include-untracked': { key: 'includeUntracked', type: 'boolean' },
        '--task-intent': { key: 'taskIntent', type: 'string' },
        '--impact-analysis': { key: 'impactAnalysis', type: 'string' },
        '--impact-analysis-path': { key: 'impactAnalysisPath', type: 'string' },
        '--commands-path': { key: 'commandsPath', type: 'string' },
        '--output-filters-path': { key: 'outputFiltersPath', type: 'string' },
        '--fail-tail-lines': { key: 'failTailLines', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = await runRestartReviewCycleCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleRecordNoOp(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--classification': { key: 'classification', type: 'string' },
        '--reason': { key: 'reason', type: 'string' },
        '--actor': { key: 'actor', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runRecordNoOpCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleRecordStrictDecompositionDecision(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--decision': { key: 'decision', type: 'string' },
        '--task-profile': { key: 'taskProfile', type: 'string' },
        '--task-summary': { key: 'taskSummary', type: 'string' },
        '--reason': { key: 'reason', type: 'string' },
        '--scope-risk': { key: 'scopeRisk', type: 'string' },
        '--expected-review-type': { key: 'expectedReviewTypes', type: 'string[]' },
        '--expected-review-types': { key: 'expectedReviewTypes', type: 'string[]' },
        '--atomicity-constraint': { key: 'atomicityConstraints', type: 'string[]' },
        '--atomicity-constraints': { key: 'atomicityConstraints', type: 'string[]' },
        '--proposed-child-task-id': { key: 'proposedChildTaskIds', type: 'string[]' },
        '--proposed-child-task-ids': { key: 'proposedChildTaskIds', type: 'string[]' },
        '--actor': { key: 'actor', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runRecordStrictDecompositionDecisionCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleHandshakeDiagnostics(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--provider': { key: 'provider', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--cli-path': { key: 'cliPath', type: 'string' },
        '--effective-cwd': { key: 'effectiveCwd', type: 'string' },
        '--canonical-entrypoint': { key: 'canonicalEntrypoint', type: 'string' },
        '--provider-bridge': { key: 'providerBridge', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runHandshakeDiagnosticsCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleShellSmokePreflight(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--provider': { key: 'provider', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--effective-cwd': { key: 'effectiveCwd', type: 'string' },
        '--probe-timeout-ms': { key: 'probeTimeoutMs', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runShellSmokePreflightCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleCommandTimeoutDiagnostics(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--provider': { key: 'provider', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--effective-cwd': { key: 'effectiveCwd', type: 'string' },
        '--command-records-path': { key: 'commandRecordsPath', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runCommandTimeoutDiagnosticsCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleRunIntermediateCommand(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--command': { key: 'command', type: 'string' },
        '--command-source': { key: 'commandSource', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--output-path': { key: 'outputPath', type: 'string' },
        '--timeout-ms': { key: 'timeoutMs', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--events-root': { key: 'eventsRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = await runIntermediateCommandCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleProjectMemoryImpact(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--changed-file': { key: 'changedFiles', type: 'string[]' },
        '--changed-files': { key: 'changedFiles', type: 'string[]' },
        '--confirm-updated': { key: 'confirmUpdated', type: 'boolean' },
        '--updated-memory-file': { key: 'updatedMemoryFiles', type: 'string[]' },
        '--updated-memory-files': { key: 'updatedMemoryFiles', type: 'string[]' },
        '--mode': { key: 'mode', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--update-artifact-path': { key: 'updateArtifactPath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runProjectMemoryImpactCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleLogTaskEvent(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--event-type': { key: 'eventType', type: 'string' },
        '--outcome': { key: 'outcome', type: 'string' },
        '--message': { key: 'message', type: 'string' },
        '--actor': { key: 'actor', type: 'string' },
        '--details-json': { key: 'detailsJson', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--events-root': { key: 'eventsRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runLogTaskEventCommand(options);
    process.stdout.write(result.outputText);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleTaskEventsSummary(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--events-root': { key: 'eventsRoot', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--output-path': { key: 'outputPath', type: 'string' },
        '--as-json': { key: 'asJson', type: 'boolean' },
        '--include-details': { key: 'includeDetails', type: 'boolean' },
        '--compact-latest-cycle': { key: 'compactLatestCycle', type: 'boolean' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runTaskEventsSummaryCommand(options);
    const shouldColorHumanStdout = options.asJson !== true
        && options.compactLatestCycle !== true
        && !options.outputPath;
    process.stdout.write(shouldColorHumanStdout ? colorizeTaskEventsSummaryText(result.rendered) : result.rendered);
}

export async function handleTaskAuditSummary(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--events-root': { key: 'eventsRoot', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--output-path': { key: 'outputPath', type: 'string' },
        '--as-json': { key: 'asJson', type: 'boolean' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runTaskAuditSummaryCommand(options);
    const shouldColorHumanStdout = options.asJson !== true
        && !options.outputPath;
    process.stdout.write(shouldColorHumanStdout ? colorizeTaskAuditSummaryText(result.rendered) : result.rendered);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleNextStep(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--target-root': { key: 'repoRoot', type: 'string' },
        '--events-root': { key: 'eventsRoot', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--as-json': { key: 'asJson', type: 'boolean' }
    };
    const { options, positionals } = parseOptions(gateArgv, defs, { allowPositionals: true, maxPositionals: 1 });
    const result = resolveNextStepFromCliOptions({ ...options, positionals });
    process.stdout.write(options.asJson === true
        ? `${JSON.stringify(result, null, 2)}\n`
        : formatNextStepText(result));
}

export async function handleFullSuiteValidation(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = await runFullSuiteValidationCommand(options);
    process.stdout.write(result.outputText);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleCompletionGate(gateArgv: string[]): Promise<void> {
    const defs = {
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--task-id': { key: 'taskId', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--rule-pack-path': { key: 'rulePackPath', type: 'string' },
        '--timeline-path': { key: 'timelinePath', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--compile-evidence-path': { key: 'compileEvidencePath', type: 'string' },
        '--review-evidence-path': { key: 'reviewEvidencePath', type: 'string' },
        '--doc-impact-path': { key: 'docImpactPath', type: 'string' },
        '--no-op-artifact-path': { key: 'noOpArtifactPath', type: 'string' },
        '--handshake-path': { key: 'handshakePath', type: 'string' },
        '--shell-smoke-path': { key: 'shellSmokePath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs);
    const options = rawOptions as ParsedOptionsRecord;
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    ensureDirectoryExists(repoRoot, 'Repo root');
    const completionTaskId = parseRequiredText(options.taskId, 'TaskId');
    const reviewsRoot = gateHelpers.resolvePathInsideRepo(String(options.reviewsRoot || ''), repoRoot, { allowMissing: true })
        || gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const { result } = await withCompletionGateFinalizationLockAsync(reviewsRoot, completionTaskId, async () => {
        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath: parseRequiredText(options.preflightPath, 'PreflightPath'),
            taskId: completionTaskId,
            taskModePath: String(options.taskModePath || ''),
            rulePackPath: String(options.rulePackPath || ''),
            timelinePath: String(options.timelinePath || ''),
            reviewsRoot: String(options.reviewsRoot || ''),
            compileEvidencePath: String(options.compileEvidencePath || ''),
            reviewEvidencePath: String(options.reviewEvidencePath || ''),
            docImpactPath: String(options.docImpactPath || ''),
            noOpArtifactPath: String(options.noOpArtifactPath || ''),
            handshakePath: String(options.handshakePath || ''),
            shellSmokePath: String(options.shellSmokePath || '')
        });

        const resolvedCompletionTaskId = String(completionResult.task_id || '').trim();
        if (resolvedCompletionTaskId) {
            const orchestratorRoot = gateHelpers.joinOrchestratorPath(repoRoot, '');
            if (completionResult.outcome === 'PASS') {
                try {
                    await reconcileSuccessfulCompletionFinalizationAsync({
                        repoRoot,
                        taskId: resolvedCompletionTaskId,
                        preflightPath: String(completionResult.preflight_path || ''),
                        previousStatusHint: 'IN_REVIEW',
                        completionEventDetails: {
                            status: completionResult.status,
                            outcome: completionResult.outcome,
                            preflight_path: completionResult.preflight_path,
                            timeline_path: completionResult.timeline_path,
                            violations: completionResult.violations
                        }
                    });
                } catch (error: unknown) {
                    try {
                        await emitMandatoryCompletionGateEventAsync(orchestratorRoot, resolvedCompletionTaskId, false, {
                            status: completionResult.status,
                            outcome: 'FINALIZATION_FAILED',
                            preflight_path: completionResult.preflight_path,
                            timeline_path: completionResult.timeline_path,
                            violations: completionResult.violations,
                            finalization_error: error instanceof Error ? error.message : String(error)
                        });
                    } catch (eventError: unknown) {
                        throw new Error(
                            `completion-gate finalization failed after validation PASS, and mandatory lifecycle event `
                            + `'COMPLETION_GATE_FAILED' could not be appended. FinalizationError: `
                            + `${error instanceof Error ? error.message : String(error)} EventError: `
                            + `${eventError instanceof Error ? eventError.message : String(eventError)}`
                        );
                    }
                    throw new Error(
                        `completion-gate finalization failed after validation PASS. ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            } else {
                try {
                    await emitMandatoryCompletionGateEventAsync(orchestratorRoot, resolvedCompletionTaskId, false, {
                        status: completionResult.status,
                        outcome: completionResult.outcome,
                        preflight_path: completionResult.preflight_path,
                        timeline_path: completionResult.timeline_path,
                        violations: completionResult.violations
                    });
                } catch (error: unknown) {
                    throw new Error(
                        `completion-gate failed because mandatory lifecycle event 'COMPLETION_GATE_FAILED' could not be appended. ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            }
        }

        return completionResult;
    });

    process.stdout.write(`${formatCompletionGateResult(result)}\n`);
    if (result.outcome !== 'PASS') {
        process.exitCode = EXIT_GATE_FAILURE;
    }
}

export async function handleHumanCommit(gateArgv: string[]): Promise<void> {
    const exitCode = await runHumanCommitCommand(gateArgv, { cwd: process.cwd() });
    if (exitCode !== 0) {
        process.exitCode = exitCode;
    }
}

export async function handleTaskReset(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--confirm': { key: 'confirm', type: 'boolean' },
        '--to-status': { key: 'toStatus', type: 'string' },
        '--reopen': { key: 'reopen', type: 'boolean' },
        '--discard': { key: 'discard', type: 'boolean' },
        '--events-root': { key: 'eventsRoot', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--as-json': { key: 'asJson', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    if (!options.taskId) {
        throw new Error(buildTaskResetMissingTaskIdMessage());
    }
    const result = runTaskResetCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    emitMandatoryCompletionGateEventAsync,
    emitStatusChangedEventAsync
} from '../../gate-runtime/lifecycle-events';
import * as gateHelpers from '../../gates/helpers';
import { formatCompletionGateResult, runCompletionGate } from '../../gates/completion';
import { buildTaskEventsSummary, formatTaskEventsSummaryText } from '../../gates/task-events-summary';
import {
    buildTaskAuditSummary,
    formatTaskAuditSummaryText,
    synchronizeFinalCloseoutArtifacts
} from '../../gates/task-audit-summary';
import { withCompletionGateFinalizationLockAsync } from '../../gates/finalization-lock';
import {
    runEnterTaskModeCommand,
    runHandshakeDiagnosticsCommand,
    runHumanCommitCommand,
    runLoadRulePackCommand,
    runLogTaskEventCommand,
    runRecordNoOpCommand,
    runRestartCoherentCycleCommand,
    runShellSmokePreflightCommand,
    runCommandTimeoutDiagnosticsCommand
} from './gates';
import {
    parseOptions,
    normalizePathValue,
    ensureDirectoryExists,
    parseRequiredText
} from './cli-helpers';
import {
    formatKeyValueOutput,
    type ParsedOptionsRecord,
    requireResolvedPath
} from './shared-command-utils';
import { syncTaskQueueStatus } from './gate-flows/gate-flow-helpers';
import { EXIT_GATE_FAILURE } from '../exit-codes';

export async function handleEnterTaskMode(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--entry-mode': { key: 'entryMode', type: 'string' },
        '--requested-depth': { key: 'requestedDepth', type: 'string' },
        '--effective-depth': { key: 'effectiveDepth', type: 'string' },
        '--task-summary': { key: 'taskSummary', type: 'string' },
        '--planned-changed-file': { key: 'plannedChangedFiles', type: 'string[]' },
        '--planned-changed-files': { key: 'plannedChangedFiles', type: 'string[]' },
        '--orchestrator-work': { key: 'orchestratorWork', type: 'boolean' },
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

export async function handleHandshakeDiagnostics(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--provider': { key: 'provider', type: 'string' },
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
        '--output-path': { key: 'outputPath', type: 'string' },
        '--as-json': { key: 'asJson', type: 'boolean' },
        '--include-details': { key: 'includeDetails', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs);
    const options = rawOptions as ParsedOptionsRecord;
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    ensureDirectoryExists(repoRoot, 'Repo root');
    const eventsRoot = options.eventsRoot
        ? requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(String(options.eventsRoot), repoRoot, { allowMissing: true }),
            'EventsRoot'
        )
        : gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    const summary = buildTaskEventsSummary({
        taskId: parseRequiredText(options.taskId, 'TaskId'),
        eventsRoot,
        repoRoot
    });
    const rendered = options.asJson === true
        ? `${JSON.stringify(summary, null, 2)}\n`
        : `${formatTaskEventsSummaryText(summary, options.includeDetails === true)}\n`;
    if (options.outputPath) {
        const outputPath = requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(String(options.outputPath), repoRoot, { allowMissing: true }),
            'OutputPath'
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, rendered, 'utf8');
    }
    process.stdout.write(rendered);
}

export async function handleTaskAuditSummary(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--events-root': { key: 'eventsRoot', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--output-path': { key: 'outputPath', type: 'string' },
        '--as-json': { key: 'asJson', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs);
    const options = rawOptions as ParsedOptionsRecord;
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    ensureDirectoryExists(repoRoot, 'Repo root');
    const auditSummary = buildTaskAuditSummary({
        taskId: parseRequiredText(options.taskId, 'TaskId'),
        repoRoot,
        eventsRoot: options.eventsRoot ? String(options.eventsRoot) : null,
        reviewsRoot: options.reviewsRoot ? String(options.reviewsRoot) : null
    });
    synchronizeFinalCloseoutArtifacts(auditSummary);
    const rendered = options.asJson === true
        ? `${JSON.stringify(auditSummary, null, 2)}\n`
        : `${formatTaskAuditSummaryText(auditSummary)}\n`;
    if (options.outputPath) {
        const outputPath = requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(String(options.outputPath), repoRoot, { allowMissing: true }),
            'OutputPath'
        );
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, rendered, 'utf8');
    }
    process.stdout.write(rendered);
    if (auditSummary.status !== 'PASS') {
        process.exitCode = EXIT_GATE_FAILURE;
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
            try {
                await emitMandatoryCompletionGateEventAsync(orchestratorRoot, resolvedCompletionTaskId, completionResult.outcome === 'PASS', {
                    status: completionResult.status,
                    outcome: completionResult.outcome,
                    preflight_path: completionResult.preflight_path,
                    timeline_path: completionResult.timeline_path,
                    violations: completionResult.violations
                });
            } catch (error: unknown) {
                throw new Error(
                    `completion-gate failed because mandatory lifecycle event '${completionResult.outcome === 'PASS' ? 'COMPLETION_GATE_PASSED' : 'COMPLETION_GATE_FAILED'}' could not be appended. ${error instanceof Error ? error.message : String(error)}`
                );
            }
            if (completionResult.outcome === 'PASS') {
                await emitStatusChangedEventAsync(orchestratorRoot, resolvedCompletionTaskId, 'IN_REVIEW', 'DONE');
                syncTaskQueueStatus(repoRoot, resolvedCompletionTaskId, 'DONE');
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

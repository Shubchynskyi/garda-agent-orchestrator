import * as fs from 'node:fs';
import * as path from 'node:path';
import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from '../../core/constants';
import {
    emitMandatoryCompletionGateEventAsync,
    emitMandatoryFullSuiteValidationEventAsync
} from '../../gate-runtime/lifecycle-events';
import * as gateHelpers from '../../gates/helpers';
import { formatCompletionGateResult, runCompletionGate } from '../../gates/completion';
import {
    buildSkippedResult,
    buildValidationResult,
    formatFullSuiteValidationResult,
    loadFullSuiteValidationConfig,
    type FullSuiteValidationCycleBinding
} from '../../gates/full-suite-validation';
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
    runRestartReviewCycleCommand,
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
import { executeCommand } from './gates-subprocess';
import { reconcileSuccessfulCompletionFinalizationAsync } from './gate-flows/completion-finalization';
import { EXIT_GATE_FAILURE, EXIT_GENERAL_FAILURE } from '../exit-codes';

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

function readLatestCompileGatePassedTimestamp(repoRoot: string, taskId: string): string | null {
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    if (!fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
        return null;
    }

    let latestTimestamp: string | null = null;
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (String(parsed.event_type || '').trim() !== 'COMPILE_GATE_PASSED') {
                continue;
            }
            const timestamp = String(parsed.timestamp_utc || '').trim();
            if (timestamp) {
                latestTimestamp = timestamp;
            }
        } catch {
            // Best-effort only; timeline integrity is validated elsewhere.
        }
    }

    return latestTimestamp;
}

export async function handleFullSuiteValidation(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs);
    const options = rawOptions as ParsedOptionsRecord;
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    ensureDirectoryExists(repoRoot, 'Repo root');

    const taskId = parseRequiredText(options.taskId, 'TaskId');
    const preflightPath = requireResolvedPath(
        gateHelpers.resolvePathInsideRepo(String(options.preflightPath || ''), repoRoot, { allowMissing: true }),
        'PreflightPath'
    );
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        throw new Error(`Preflight artifact not found: ${gateHelpers.normalizePath(preflightPath)}`);
    }

    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const preflightTaskId = String(preflight.task_id || '').trim();
    if (preflightTaskId && preflightTaskId !== taskId) {
        throw new Error(
            `Preflight task_id '${preflightTaskId}' does not match requested task '${taskId}'.`
        );
    }

    const config = loadFullSuiteValidationConfig(repoRoot);
    const reviewsRoot = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const artifactPath = path.join(reviewsRoot, `${taskId}-full-suite-validation.json`);
    const outputArtifactPath = path.join(reviewsRoot, `${taskId}-full-suite-output.log`);
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const cycleBinding: FullSuiteValidationCycleBinding = {
        task_id: taskId,
        preflight_path: gateHelpers.normalizePath(preflightPath),
        preflight_sha256: gateHelpers.fileSha256(preflightPath) || '',
        compile_gate_timestamp: readLatestCompileGatePassedTimestamp(repoRoot, taskId)
    };

    if (!config.enabled) {
        const skippedResult = buildSkippedResult(config, cycleBinding);
        fs.writeFileSync(artifactPath, `${JSON.stringify(skippedResult, null, 2)}\n`, 'utf8');
        await emitMandatoryFullSuiteValidationEventAsync(repoRoot, taskId, skippedResult.status, {
            status: skippedResult.status,
            enabled: skippedResult.enabled,
            preflight_path: cycleBinding.preflight_path,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            cycle_binding: skippedResult.cycle_binding
        });
        process.stdout.write(`${formatFullSuiteValidationResult(skippedResult)}\n`);
        return;
    }

    if (String(config.command || '').trim() === UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND) {
        const unconfiguredResult = {
            status: 'FAILED' as const,
            enabled: true,
            command: config.command,
            exit_code: null,
            timed_out: false,
            output_artifact_path: null,
            compact_summary: ['Full-suite validation command is not configured.'],
            failure_chunks: [],
            out_of_scope_failure_policy: config.out_of_scope_failure_policy,
            out_of_scope_failure_detected: false,
            out_of_scope_audit_verdict: 'NOT_APPLICABLE' as const,
            violations: [
                'Full-suite validation command is not configured. Run agent-init to seed a project-appropriate default or set workflow-config.full_suite_validation.command explicitly.'
            ],
            warnings: [],
            cycle_binding: cycleBinding
        };
        fs.writeFileSync(artifactPath, `${JSON.stringify(unconfiguredResult, null, 2)}\n`, 'utf8');
        await emitMandatoryFullSuiteValidationEventAsync(repoRoot, taskId, unconfiguredResult.status, {
            status: unconfiguredResult.status,
            enabled: unconfiguredResult.enabled,
            command: unconfiguredResult.command,
            exit_code: unconfiguredResult.exit_code,
            timed_out: unconfiguredResult.timed_out,
            preflight_path: cycleBinding.preflight_path,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            cycle_binding: unconfiguredResult.cycle_binding,
            out_of_scope_audit_verdict: unconfiguredResult.out_of_scope_audit_verdict,
            violations: unconfiguredResult.violations,
            warnings: unconfiguredResult.warnings
        });
        process.stdout.write(`${formatFullSuiteValidationResult(unconfiguredResult)}\n`);
        process.exitCode = EXIT_GATE_FAILURE;
        return;
    }

    let commandExitCode = EXIT_GENERAL_FAILURE;
    let timedOut = false;
    let outputLines: string[] = [];
    try {
        const execution = executeCommand(config.command, {
            cwd: repoRoot,
            timeoutMs: config.timeout_ms
        });
        commandExitCode = execution.exitCode;
        timedOut = execution.timedOut;
        outputLines = execution.outputLines;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        outputLines = [message];
    }

    fs.writeFileSync(
        outputArtifactPath,
        outputLines.length > 0 ? `${outputLines.join('\n')}\n` : '',
        'utf8'
    );
    const result = buildValidationResult(
        config,
        commandExitCode,
        timedOut,
        outputLines,
        outputArtifactPath,
        changedFiles,
        cycleBinding
    );
    fs.writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await emitMandatoryFullSuiteValidationEventAsync(repoRoot, taskId, result.status, {
        status: result.status,
        enabled: result.enabled,
        command: result.command,
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        preflight_path: cycleBinding.preflight_path,
        artifact_path: gateHelpers.normalizePath(artifactPath),
        output_artifact_path: gateHelpers.normalizePath(outputArtifactPath),
        cycle_binding: result.cycle_binding,
        out_of_scope_audit_verdict: result.out_of_scope_audit_verdict,
        violations: result.violations,
        warnings: result.warnings
    });
    process.stdout.write(`${formatFullSuiteValidationResult(result)}\n`);
    if (result.status === 'FAILED') {
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

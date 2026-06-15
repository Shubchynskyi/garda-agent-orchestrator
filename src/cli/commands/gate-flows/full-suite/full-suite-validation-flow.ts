import * as fs from 'node:fs';
import * as path from 'node:path';
import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from '../../../../core/constants';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { redactSecretText } from '../../../../core/redaction';
import {
    buildFullSuiteValidationOutputTelemetry,
    buildFullSuiteTimeoutForecast,
    buildDocsOnlyNotRequiredResult,
    buildSkippedResult,
    buildValidationResult,
    buildZeroDiffNoReviewableNotRequiredResult,
    formatFullSuiteValidationResult,
    isFullSuiteNotRequiredForDocsOnlyScope,
    isFullSuiteNotRequiredForZeroDiffNoReviewableScope,
    loadFullSuiteValidationConfig,
    persistFullSuiteFailureEvidence,
    recordFullSuiteValidationDuration,
    type FullSuiteValidationCycleBinding
} from '../../../../gates/full-suite/full-suite-validation';
import { getTaskModeEvidence } from '../../../../gates/task-mode/task-mode';
import {
    buildRawOutputRetentionEvidence,
    serializeCapturedOutputLines
} from '../../../../gate-runtime/output-log-retention';
import {
    getCurrentWorkflowConfigChanges,
    getWorkflowConfigWorkViolations
} from '../../../../gates/workflow-config/workflow-config-work';
import { executeCommandAsync } from '../../gates/gates-subprocess';
import { EXIT_GATE_FAILURE, EXIT_GENERAL_FAILURE } from '../../../exit-codes';
import {
    normalizePathValue,
    ensureDirectoryExists,
    parseRequiredText
} from '../../cli-helpers';
import { requireResolvedPath } from '../../shared-command-utils';
import {
    type FullSuiteValidationCommandOptions,
    type FullSuiteValidationCommandResult
} from './full-suite-validation-flow-types';
import {
    readFullSuiteScopeBinding,
    readLatestCompileGatePassedTimestamp,
    tryReadRebindableFullSuiteValidationArtifact
} from './full-suite-validation-cycle-binding';
import { writeArtifactThenEmitMandatoryFullSuiteEvent } from './full-suite-validation-lifecycle';
import {
    normalizeSuccessfulFullSuiteOutputRetention,
    shouldOmitSuccessfulFullSuiteOutput
} from './full-suite-validation-output-retention';
import {
    cleanupGeneratedLocksAfterTimedOutFullSuite,
    formatGeneratedLockCleanupObservation
} from './full-suite-validation-lock-cleanup';
import { buildWorkflowConfigWorkBlockedResult } from './full-suite-validation-workflow-config';
import {
    clearFullSuiteValidationRunMarker,
    updateFullSuiteValidationRunMarkerChildProcess,
    writeFullSuiteValidationRunMarker
} from '../../../../gates/full-suite/full-suite-validation-run-marker';

export { shouldOmitSuccessfulFullSuiteOutput } from './full-suite-validation-output-retention';
export type {
    FullSuiteValidationCommandOptions,
    FullSuiteValidationCommandResult
} from './full-suite-validation-flow-types';

function buildFullSuiteValidationCommandEnv(): NodeJS.ProcessEnv {
    return {
        GARDA_BUNDLE_NAME: undefined,
        GARDA_NODE_FOUNDATION_REUSE_PUBLISH_RUNTIME: '1',
        GARDA_NODE_FOUNDATION_TEST_PREBUILT: '1'
    };
}

function resolveEffectiveFullSuiteValidationConfig(
    repoRoot: string,
    config: ReturnType<typeof loadFullSuiteValidationConfig>
): ReturnType<typeof loadFullSuiteValidationConfig> {
    const timeoutForecast = buildFullSuiteTimeoutForecast(repoRoot, config);
    const effectiveTimeoutMs = Math.max(config.timeout_ms, timeoutForecast.recommended_timeout_seconds * 1000);
    return effectiveTimeoutMs === config.timeout_ms
        ? config
        : { ...config, timeout_ms: effectiveTimeoutMs };
}

export async function runFullSuiteValidationCommand(
    options: FullSuiteValidationCommandOptions
): Promise<FullSuiteValidationCommandResult> {
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
    const eventsRoot = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
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
        compile_gate_timestamp: readLatestCompileGatePassedTimestamp(repoRoot, taskId),
        scope_binding: readFullSuiteScopeBinding(repoRoot, taskId, preflight)
    };

    const taskModeEvidence = getTaskModeEvidence(repoRoot, taskId);
    let workflowConfigBaseline = taskModeEvidence.workflow_config_file_hashes;
    const workflowConfigChanges = getCurrentWorkflowConfigChanges(repoRoot, workflowConfigBaseline, {
        allowProtectedManifestFallback: false
    });
    workflowConfigBaseline = workflowConfigChanges.baseline_file_hashes;
    const workflowConfigViolations = getWorkflowConfigWorkViolations({
        changedFiles: workflowConfigChanges.changed_files,
        taskModeEvidence,
        phaseLabel: 'full-suite validation',
        baselineFileHashes: workflowConfigChanges.baseline_file_hashes,
        currentFileHashes: workflowConfigChanges.current_file_hashes
    });
    if (workflowConfigViolations.length > 0) {
        const blockedResult = buildWorkflowConfigWorkBlockedResult(
            config,
            cycleBinding,
            workflowConfigViolations,
            workflowConfigChanges.scan_error
        );
        await writeArtifactThenEmitMandatoryFullSuiteEvent(repoRoot, eventsRoot, taskId, artifactPath, blockedResult.status, blockedResult, {
            status: blockedResult.status,
            enabled: blockedResult.enabled,
            command: blockedResult.command,
            exit_code: blockedResult.exit_code,
            timed_out: blockedResult.timed_out,
            preflight_path: cycleBinding.preflight_path,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            cycle_binding: blockedResult.cycle_binding,
            violations: blockedResult.violations,
            warnings: blockedResult.warnings
        });
        return {
            outputText: `${formatFullSuiteValidationResult(blockedResult)}\n`,
            exitCode: EXIT_GATE_FAILURE
        };
    }

    if (!config.enabled) {
        const skippedResult = buildSkippedResult(config, cycleBinding);
        await writeArtifactThenEmitMandatoryFullSuiteEvent(repoRoot, eventsRoot, taskId, artifactPath, skippedResult.status, skippedResult, {
            status: skippedResult.status,
            enabled: skippedResult.enabled,
            required: skippedResult.required,
            skip_reason: skippedResult.skip_reason,
            preflight_path: cycleBinding.preflight_path,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            cycle_binding: skippedResult.cycle_binding
        });
        return {
            outputText: `${formatFullSuiteValidationResult(skippedResult)}\n`,
            exitCode: 0
        };
    }

    if (isFullSuiteNotRequiredForDocsOnlyScope(preflight)) {
        const skippedResult = buildDocsOnlyNotRequiredResult(config, cycleBinding);
        await writeArtifactThenEmitMandatoryFullSuiteEvent(repoRoot, eventsRoot, taskId, artifactPath, skippedResult.status, skippedResult, {
            status: skippedResult.status,
            enabled: skippedResult.enabled,
            command: skippedResult.command,
            required: skippedResult.required,
            skip_reason: skippedResult.skip_reason,
            preflight_path: cycleBinding.preflight_path,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            cycle_binding: skippedResult.cycle_binding
        });
        return {
            outputText: `${formatFullSuiteValidationResult(skippedResult)}\n`,
            exitCode: 0
        };
    }

    if (isFullSuiteNotRequiredForZeroDiffNoReviewableScope(preflight)) {
        const skippedResult = buildZeroDiffNoReviewableNotRequiredResult(config, cycleBinding);
        await writeArtifactThenEmitMandatoryFullSuiteEvent(repoRoot, eventsRoot, taskId, artifactPath, skippedResult.status, skippedResult, {
            status: skippedResult.status,
            enabled: skippedResult.enabled,
            command: skippedResult.command,
            required: skippedResult.required,
            skip_reason: skippedResult.skip_reason,
            preflight_path: cycleBinding.preflight_path,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            cycle_binding: skippedResult.cycle_binding
        });
        return {
            outputText: `${formatFullSuiteValidationResult(skippedResult)}\n`,
            exitCode: 0
        };
    }

    const reboundResult = tryReadRebindableFullSuiteValidationArtifact({
        artifactPath,
        repoRoot,
        taskId,
        configCommand: config.command,
        cycleBinding
    });
    if (reboundResult) {
        const retainedReboundResult = normalizeSuccessfulFullSuiteOutputRetention(repoRoot, outputArtifactPath, reboundResult);
        await writeArtifactThenEmitMandatoryFullSuiteEvent(repoRoot, eventsRoot, taskId, artifactPath, retainedReboundResult.status, retainedReboundResult, {
            status: retainedReboundResult.status,
            enabled: retainedReboundResult.enabled,
            command: retainedReboundResult.command,
            exit_code: retainedReboundResult.exit_code,
            timed_out: retainedReboundResult.timed_out,
            preflight_path: cycleBinding.preflight_path,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            cycle_binding: retainedReboundResult.cycle_binding,
            out_of_scope_audit_verdict: retainedReboundResult.out_of_scope_audit_verdict,
            violations: retainedReboundResult.violations,
            warnings: retainedReboundResult.warnings,
            output_retention: retainedReboundResult.output_retention,
            reused_existing_evidence: true
        });
        return {
            outputText:
                `${formatFullSuiteValidationResult(retainedReboundResult)}\n`
                + 'Rebound existing full-suite evidence to the current compile/preflight cycle without rerunning the configured command.\n',
            exitCode: 0
        };
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
        await writeArtifactThenEmitMandatoryFullSuiteEvent(repoRoot, eventsRoot, taskId, artifactPath, unconfiguredResult.status, unconfiguredResult, {
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
        return {
            outputText: `${formatFullSuiteValidationResult(unconfiguredResult)}\n`,
            exitCode: EXIT_GATE_FAILURE
        };
    }

    let commandExitCode = EXIT_GENERAL_FAILURE;
    let timedOut = false;
    let outputLines: string[] = [];
    const executionConfig = resolveEffectiveFullSuiteValidationConfig(repoRoot, config);
    const startedAtMs = Date.now();
    writeFullSuiteValidationRunMarker({
        repoRoot,
        taskId,
        command: config.command,
        cwd: repoRoot,
        timeoutMs: executionConfig.timeout_ms,
        cycleBinding
    });
    try {
        const execution = await executeCommandAsync(config.command, {
            cwd: repoRoot,
            env: buildFullSuiteValidationCommandEnv(),
            timeoutMs: executionConfig.timeout_ms,
            onSpawn: (child) => updateFullSuiteValidationRunMarkerChildProcess(repoRoot, taskId, child)
        });
        commandExitCode = execution.exitCode;
        timedOut = execution.timedOut;
        outputLines = execution.outputLines;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        outputLines = [message];
    }
    const durationMs = Math.max(1, Date.now() - startedAtMs);
    const generatedLockCleanup = timedOut
        ? cleanupGeneratedLocksAfterTimedOutFullSuite(repoRoot)
        : [];
    if (generatedLockCleanup.length > 0) {
        outputLines = [
            ...outputLines,
            ...generatedLockCleanup.map(formatGeneratedLockCleanupObservation)
        ];
    }
    outputLines = outputLines.map((line) => redactSecretText(line));
    const rawOutputText = serializeCapturedOutputLines(outputLines);
    const result = buildValidationResult(
        executionConfig,
        commandExitCode,
        timedOut,
        outputLines,
        outputArtifactPath,
        changedFiles,
        cycleBinding
    );
    fs.writeFileSync(outputArtifactPath, rawOutputText, 'utf8');
    result.output_retention = buildRawOutputRetentionEvidence(rawOutputText, true);
    result.failure_evidence = persistFullSuiteFailureEvidence({
        repoRoot,
        reviewsRoot,
        taskId,
        result,
        outputLines
    });
    if (generatedLockCleanup.length > 0) {
        result.warnings.push(...generatedLockCleanup.map(formatGeneratedLockCleanupObservation));
    }
    result.duration_ms = durationMs;
    result.output_telemetry = buildFullSuiteValidationOutputTelemetry(outputLines, result);
    const postWorkflowConfigChanges = getCurrentWorkflowConfigChanges(repoRoot, workflowConfigBaseline, {
        allowProtectedManifestFallback: false
    });
    const postWorkflowConfigViolations = getWorkflowConfigWorkViolations({
        changedFiles: postWorkflowConfigChanges.changed_files,
        taskModeEvidence,
        phaseLabel: 'full-suite validation output validation',
        baselineFileHashes: postWorkflowConfigChanges.baseline_file_hashes,
        currentFileHashes: postWorkflowConfigChanges.current_file_hashes
    });
    if (postWorkflowConfigViolations.length > 0) {
        const blockedResult = buildWorkflowConfigWorkBlockedResult(
            config,
            cycleBinding,
            postWorkflowConfigViolations,
            postWorkflowConfigChanges.scan_error
        );
        blockedResult.output_artifact_path = gateHelpers.normalizePath(outputArtifactPath);
        blockedResult.output_retention = buildRawOutputRetentionEvidence(rawOutputText, true);
        blockedResult.duration_ms = durationMs;
        blockedResult.failure_evidence = persistFullSuiteFailureEvidence({
            repoRoot,
            reviewsRoot,
            taskId,
            result: blockedResult,
            outputLines
        });
        if (blockedResult.status !== 'SKIPPED') {
            recordFullSuiteValidationDuration(repoRoot, config, {
                timestamp_utc: new Date().toISOString(),
                task_id: taskId,
                status: blockedResult.status,
                duration_ms: durationMs,
                timed_out: timedOut,
                exit_code: commandExitCode
            });
        }
        blockedResult.timeout_forecast = buildFullSuiteTimeoutForecast(repoRoot, config);
        blockedResult.output_telemetry = buildFullSuiteValidationOutputTelemetry(outputLines, blockedResult);
        await writeArtifactThenEmitMandatoryFullSuiteEvent(repoRoot, eventsRoot, taskId, artifactPath, blockedResult.status, blockedResult, {
            status: blockedResult.status,
            enabled: blockedResult.enabled,
            command: blockedResult.command,
            exit_code: blockedResult.exit_code,
            timed_out: blockedResult.timed_out,
            preflight_path: cycleBinding.preflight_path,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            output_artifact_path: gateHelpers.normalizePath(outputArtifactPath),
            duration_ms: blockedResult.duration_ms,
            timeout_forecast: blockedResult.timeout_forecast,
            cycle_binding: blockedResult.cycle_binding,
            violations: blockedResult.violations,
            warnings: blockedResult.warnings,
            output_telemetry: blockedResult.output_telemetry,
            output_retention: blockedResult.output_retention,
            failure_evidence: blockedResult.failure_evidence
        });
        clearFullSuiteValidationRunMarker(repoRoot, taskId);
        return {
            outputText: `${formatFullSuiteValidationResult(blockedResult)}\n`,
            exitCode: EXIT_GATE_FAILURE
        };
    }
    if (result.status !== 'SKIPPED') {
        recordFullSuiteValidationDuration(repoRoot, config, {
            timestamp_utc: new Date().toISOString(),
            task_id: taskId,
            status: result.status,
            duration_ms: durationMs,
            timed_out: timedOut,
            exit_code: commandExitCode
        });
    }
    if (shouldOmitSuccessfulFullSuiteOutput(result)) {
        fs.rmSync(outputArtifactPath, { force: true });
        result.output_artifact_path = null;
        result.output_retention = buildRawOutputRetentionEvidence(rawOutputText, false);
    }
    result.timeout_forecast = buildFullSuiteTimeoutForecast(repoRoot, config);
    result.output_telemetry = buildFullSuiteValidationOutputTelemetry(outputLines, result);
    await writeArtifactThenEmitMandatoryFullSuiteEvent(repoRoot, eventsRoot, taskId, artifactPath, result.status, result, {
        status: result.status,
        enabled: result.enabled,
        command: result.command,
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        preflight_path: cycleBinding.preflight_path,
        artifact_path: gateHelpers.normalizePath(artifactPath),
        output_artifact_path: result.output_artifact_path,
        duration_ms: result.duration_ms,
        timeout_forecast: result.timeout_forecast,
        cycle_binding: result.cycle_binding,
        out_of_scope_audit_verdict: result.out_of_scope_audit_verdict,
        violations: result.violations,
        warnings: result.warnings,
        output_telemetry: result.output_telemetry,
        output_retention: result.output_retention,
        failure_evidence: result.failure_evidence
    });
    clearFullSuiteValidationRunMarker(repoRoot, taskId);

    return {
        outputText: `${formatFullSuiteValidationResult(result)}\n`,
        exitCode: result.status === 'FAILED' ? EXIT_GATE_FAILURE : 0
    };
}

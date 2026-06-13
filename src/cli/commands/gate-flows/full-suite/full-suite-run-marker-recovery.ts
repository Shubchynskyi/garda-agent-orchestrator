import * as fs from 'node:fs';
import * as path from 'node:path';

import { getBundleCliCommand, getSourceCliCommand, resolveBundleNameForTarget } from '../../../../core/constants';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { redactSecretText } from '../../../../core/redaction';
import {
    buildFullSuiteTimeoutForecast,
    buildFullSuiteValidationOutputTelemetry,
    formatFullSuiteTimeoutForecast,
    loadFullSuiteValidationConfig,
    persistFullSuiteFailureEvidence,
    type FullSuiteValidationCycleBinding,
    type FullSuiteValidationResult
} from '../../../../gates/full-suite/full-suite-validation';
import {
    buildRawOutputRetentionEvidence,
    serializeCapturedOutputLines
} from '../../../../gate-runtime/output-log-retention';
import {
    clearFullSuiteValidationRunMarker,
    readInterruptedFullSuiteValidationRunMarker,
    resolveFullSuiteValidationRunMarkerPath,
    type FullSuiteValidationRunMarkerInspectionOptions,
    type FullSuiteValidationInterruptedRunSummary
} from '../../../../gates/full-suite/full-suite-validation-run-marker';
import {
    writeArtifactThenEmitMandatoryFullSuiteEvent
} from './full-suite-validation-lifecycle';
import {
    readLatestCompileGatePassedTimestamp
} from './full-suite-validation-cycle-binding';
import {
    normalizePathValue,
    ensureDirectoryExists,
    parseRequiredText
} from '../../cli-helpers';
import { requireResolvedPath } from '../../shared-command-utils';
import { EXIT_GATE_FAILURE } from '../../../exit-codes';

export interface FullSuiteRunMarkerRecoveryCommandOptions {
    taskId?: string;
    preflightPath?: string;
    repoRoot?: string;
    artifactPath?: string;
    clearDeadMarker?: boolean;
    operatorConfirmed?: string;
    inspectionOptions?: FullSuiteValidationRunMarkerInspectionOptions;
}

export interface FullSuiteRunMarkerRecoveryCommandResult {
    outputLines: string[];
    exitCode: number;
}

type RecoveryStatus =
    | 'MISSING'
    | 'LIVE_GATE'
    | 'STALE_DESCENDANTS'
    | 'DEAD_MARKER'
    | 'CLEARED_DEAD_MARKER'
    | 'UNKNOWN_STATE'
    | 'REFUSED_LIVE_CLEAR';

interface CurrentSuccessfulFullSuiteTerminalEvidence {
    status: 'PRESERVED_CURRENT_TERMINAL';
    artifact_path: string;
    full_suite_status: 'PASSED' | 'WARNED';
    cycle_binding: FullSuiteValidationCycleBinding;
}

export async function runFullSuiteRunMarkerRecoveryCommand(
    options: FullSuiteRunMarkerRecoveryCommandOptions
): Promise<FullSuiteRunMarkerRecoveryCommandResult> {
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

    const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
    const preflightSha256 = gateHelpers.fileSha256(preflightPath) || '';
    const compileGateTimestamp = readLatestCompileGatePassedTimestamp(repoRoot, taskId);
    const summary = readInterruptedFullSuiteValidationRunMarker(
        repoRoot,
        taskId,
        preflightPath,
        preflightSha256,
        compileGateTimestamp,
        options.inspectionOptions
    );
    const requestedClear = options.clearDeadMarker === true;
    const operatorConfirmed = String(options.operatorConfirmed || '').trim().toLowerCase() === 'yes';
    const artifactPath = options.artifactPath
        ? requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(String(options.artifactPath), repoRoot, { allowMissing: true }),
            'ArtifactPath'
        )
        : gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-full-suite-run-marker-recovery.json`));
    if (path.resolve(artifactPath) === path.resolve(markerPath)) {
        throw new Error('ArtifactPath must not equal the full-suite run marker path; recovery evidence must survive marker cleanup.');
    }

    let status: RecoveryStatus;
    let action = '';
    let exitCode = 0;

    if (!fs.existsSync(markerPath)) {
        status = 'MISSING';
        action = 'No full-suite run marker exists for this task. Rerun next-step to continue normal routing.';
    } else if (!summary) {
        status = 'UNKNOWN_STATE';
        action = 'A marker exists, but it is stale, invalid, or not bound to the current preflight/compile cycle. Inspect it manually; this command will not clear unknown marker state automatically.';
        exitCode = EXIT_GATE_FAILURE;
    } else if (summary.gateProcessAlive) {
        status = requestedClear ? 'REFUSED_LIVE_CLEAR' : 'LIVE_GATE';
        action = requestedClear
            ? 'Refused to clear the marker because the recorded gate process is still alive.'
            : 'The gate process is still alive. Wait for terminal full-suite evidence or inspect task-owned processes only.';
        exitCode = requestedClear ? EXIT_GATE_FAILURE : 0;
    } else {
        const hasLiveChildTree =
            summary.childProcessAlive === true
            || summary.descendantProcessCandidates.length > 0
            || !!summary.processScanWarning;
        if (hasLiveChildTree) {
            status = requestedClear ? 'REFUSED_LIVE_CLEAR' : 'STALE_DESCENDANTS';
            action = requestedClear
                ? 'Refused to clear the marker while child/descendant process state is live or unknown.'
                : 'Child or descendant process evidence is live or unknown. Terminate only task-owned processes confirmed by marker, command line, or working-directory evidence before clearing the marker.';
            exitCode = requestedClear ? EXIT_GATE_FAILURE : 0;
        } else if (requestedClear) {
            if (!operatorConfirmed) {
                status = 'DEAD_MARKER';
                action = 'Dead marker can be cleared, but --operator-confirmed yes is required.';
                exitCode = EXIT_GATE_FAILURE;
            } else {
                status = 'CLEARED_DEAD_MARKER';
                action = 'Dead full-suite run marker was cleared after writing recovery evidence.';
            }
        } else {
            status = 'DEAD_MARKER';
            action = 'Dead marker has no live child or descendant process evidence. Run the printed cleanup command to clear it after preserving this recovery evidence.';
        }
    }

    const cleanupCommand = [
        `${buildCliPrefix(repoRoot)} gate full-suite-run-marker-recovery`,
        `--task-id "${taskId}"`,
        `--preflight-path "${gateHelpers.normalizePath(path.relative(repoRoot, preflightPath))}"`,
        '--clear-dead-marker',
        '--operator-confirmed yes',
        '--repo-root "."'
    ].join(' ');
    const nextRecoveryCommand = buildNextStepCommand(repoRoot, taskId);
    const config = loadFullSuiteValidationConfig(repoRoot);
    const existingTerminalEvidence = status === 'CLEARED_DEAD_MARKER'
        ? readCurrentSuccessfulFullSuiteTerminalEvidence({
            repoRoot,
            taskId,
            preflightPath,
            preflightSha256,
            compileGateTimestamp,
            configCommand: config.command
        })
        : null;
    const artifactStatus = status === 'CLEARED_DEAD_MARKER' ? 'DEAD_MARKER' : status;
    const artifactAction = status === 'CLEARED_DEAD_MARKER'
        ? 'Dead marker cleanup is in progress; final cleared evidence is written only after terminal evidence and marker cleanup succeed.'
        : action;
    const artifact = buildRecoveryArtifact({
        repoRoot,
        taskId,
        markerPath,
        preflightPath,
        preflightSha256,
        compileGateTimestamp,
        status: artifactStatus,
        action: artifactAction,
        summary,
        cleanupCommand,
        nextRecoveryCommand,
        existingTerminalEvidence: null
    });
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

    if (status === 'CLEARED_DEAD_MARKER' && !existingTerminalEvidence) {
        await materializeInterruptedFullSuiteTimeoutEvidence({
            repoRoot,
            taskId,
            preflightPath,
            preflightSha256,
            compileGateTimestamp,
            recoveryArtifactPath: artifactPath,
            markerPath,
            summary,
            cleanupCommand,
            nextRecoveryCommand
        });
    }
    if (status === 'CLEARED_DEAD_MARKER') {
        clearFullSuiteValidationRunMarker(repoRoot, taskId);
        const finalArtifact = buildRecoveryArtifact({
            repoRoot,
            taskId,
            markerPath,
            preflightPath,
            preflightSha256,
            compileGateTimestamp,
            status,
            action,
            summary,
            cleanupCommand,
            nextRecoveryCommand,
            existingTerminalEvidence
        });
        fs.writeFileSync(artifactPath, `${JSON.stringify(finalArtifact, null, 2)}\n`, 'utf8');
    }

    const outputLines = [
        'FULL_SUITE_RUN_MARKER_RECOVERY',
        `TaskId: ${taskId}`,
        `Status: ${status}`,
        `MarkerPath: ${gateHelpers.normalizePath(markerPath)}`,
        `ArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`,
        `Action: ${action}`
    ];
    if (summary) {
        outputLines.push(...formatSummaryLines(summary));
    }
    if (status === 'DEAD_MARKER' && !requestedClear) {
        outputLines.push(`CleanupCommand: ${cleanupCommand}`);
    }
    return { outputLines, exitCode };
}

function buildCliPrefix(repoRoot: string): string {
    return fs.existsSync(path.join(path.resolve(repoRoot), 'bin', 'garda.js'))
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleNameForTarget(repoRoot));
}

function buildNextStepCommand(repoRoot: string, taskId: string): string {
    return `${buildCliPrefix(repoRoot)} next-step "${taskId}" --repo-root "."`;
}

function buildRecoveryArtifact(options: {
    repoRoot: string;
    taskId: string;
    markerPath: string;
    preflightPath: string;
    preflightSha256: string;
    compileGateTimestamp: string | null;
    status: RecoveryStatus;
    action: string;
    summary: FullSuiteValidationInterruptedRunSummary | null;
    cleanupCommand: string;
    nextRecoveryCommand: string;
    existingTerminalEvidence: CurrentSuccessfulFullSuiteTerminalEvidence | null;
}): Record<string, unknown> {
    return {
        schema_version: 1,
        task_id: options.taskId,
        status: options.status,
        action: options.action,
        created_at_utc: new Date().toISOString(),
        marker_path: gateHelpers.normalizePath(options.markerPath),
        preflight_path: gateHelpers.normalizePath(options.preflightPath),
        preflight_sha256: options.preflightSha256,
        compile_gate_timestamp: options.compileGateTimestamp,
        terminal_full_suite_evidence: options.status === 'CLEARED_DEAD_MARKER'
            ? options.existingTerminalEvidence ?? {
                status: 'MATERIALIZED_TIMEOUT_FAILURE',
                artifact_path: gateHelpers.normalizePath(gateHelpers.joinOrchestratorPath(
                    options.repoRoot,
                    path.join('runtime', 'reviews', `${options.taskId}-full-suite-validation.json`)
                )),
                next_recovery_command: redactSecretText(options.nextRecoveryCommand),
                cleanup_command: redactSecretText(options.cleanupCommand)
            }
            : null,
        cleanup_command: redactSecretText(options.cleanupCommand),
        recovery_summary: options.summary
            ? {
                marker_path: options.summary.markerPath,
                started_at_utc: options.summary.startedAtUtc,
                updated_at_utc: options.summary.updatedAtUtc,
                command: redactSecretText(options.summary.command),
                timeout_ms: options.summary.timeoutMs,
                gate_pid: options.summary.gatePid,
                gate_process_alive: options.summary.gateProcessAlive,
                child_pid: options.summary.childPid,
                child_process_alive: options.summary.childProcessAlive,
                child_command: options.summary.childCommand ? redactSecretText(options.summary.childCommand) : null,
                descendant_process_candidates: options.summary.descendantProcessCandidates.map((candidate) => ({
                    ...candidate,
                    commandLine: redactSecretText(candidate.commandLine)
                })),
                process_scan_warning: options.summary.processScanWarning
                    ? redactSecretText(options.summary.processScanWarning)
                    : null
            }
            : null
    };
}

function readCurrentSuccessfulFullSuiteTerminalEvidence(options: {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    preflightSha256: string;
    compileGateTimestamp: string | null;
    configCommand: string;
}): CurrentSuccessfulFullSuiteTerminalEvidence | null {
    const artifactPath = gateHelpers.joinOrchestratorPath(
        options.repoRoot,
        path.join('runtime', 'reviews', `${options.taskId}-full-suite-validation.json`)
    );
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return null;
    }

    try {
        const raw = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
        const status = String(raw.status || '').trim().toUpperCase();
        if (status !== 'PASSED' && status !== 'WARNED') {
            return null;
        }
        if (raw.enabled !== true || String(raw.command || '').trim() !== options.configCommand) {
            return null;
        }
        const cycleBinding = raw.cycle_binding;
        if (!cycleBinding || typeof cycleBinding !== 'object' || Array.isArray(cycleBinding)) {
            return null;
        }
        const cycle = cycleBinding as Record<string, unknown>;
        const expectedPreflightPath = gateHelpers.normalizePath(options.preflightPath);
        const actualPreflightPath = gateHelpers.normalizePath(String(cycle.preflight_path || ''));
        const actualPreflightSha256 = String(cycle.preflight_sha256 || '').trim().toLowerCase();
        const actualCompileGateTimestamp = String(cycle.compile_gate_timestamp || '').trim() || null;
        if (
            String(cycle.task_id || '').trim() !== options.taskId
            || actualPreflightPath !== expectedPreflightPath
            || actualPreflightSha256 !== options.preflightSha256
            || actualCompileGateTimestamp !== options.compileGateTimestamp
        ) {
            return null;
        }

        return {
            status: 'PRESERVED_CURRENT_TERMINAL',
            artifact_path: gateHelpers.normalizePath(artifactPath),
            full_suite_status: status,
            cycle_binding: cycleBinding as FullSuiteValidationCycleBinding
        };
    } catch {
        return null;
    }
}

async function materializeInterruptedFullSuiteTimeoutEvidence(options: {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    preflightSha256: string;
    compileGateTimestamp: string | null;
    recoveryArtifactPath: string;
    markerPath: string;
    summary: FullSuiteValidationInterruptedRunSummary | null;
    cleanupCommand: string;
    nextRecoveryCommand: string;
}): Promise<void> {
    const reviewsRoot = gateHelpers.joinOrchestratorPath(options.repoRoot, path.join('runtime', 'reviews'));
    const eventsRoot = gateHelpers.joinOrchestratorPath(options.repoRoot, path.join('runtime', 'task-events'));
    const artifactPath = path.join(reviewsRoot, `${options.taskId}-full-suite-validation.json`);
    const outputArtifactPath = path.join(reviewsRoot, `${options.taskId}-full-suite-output.log`);
    const config = loadFullSuiteValidationConfig(options.repoRoot);
    const timeoutForecast = buildFullSuiteTimeoutForecast(options.repoRoot, config);
    const timeoutMs = options.summary?.timeoutMs || config.timeout_ms;
    const startedAtMs = Date.parse(options.summary?.startedAtUtc || '');
    const durationMs = Number.isFinite(startedAtMs)
        ? Math.max(1, Date.now() - startedAtMs)
        : timeoutMs;
    const outputLines = [
        'FULL_SUITE_INTERRUPTED_TIMEOUT_RECOVERY',
        `TaskId: ${options.taskId}`,
        'Status: FAILED',
        'TimedOut: true',
        `Reason: interrupted full-suite run marker was dead before terminal evidence was materialized`,
        `MarkerPath: ${gateHelpers.normalizePath(options.markerPath)}`,
        `RecoveryArtifact: ${gateHelpers.normalizePath(options.recoveryArtifactPath)}`,
        `CleanupCommand: ${redactSecretText(options.cleanupCommand)}`,
        `InterruptedCommand: ${redactSecretText(options.summary?.command || config.command)}`,
        `InterruptedTimeoutMs: ${timeoutMs}`,
        `TimeoutForecast: ${formatFullSuiteTimeoutForecast(timeoutForecast)}`,
        `NextRecoveryCommand: ${redactSecretText(options.nextRecoveryCommand)}`
    ];
    const rawOutputText = serializeCapturedOutputLines(outputLines);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(outputArtifactPath, rawOutputText, 'utf8');

    const result: FullSuiteValidationResult = {
        status: 'FAILED',
        enabled: true,
        command: config.command,
        exit_code: null,
        timed_out: true,
        output_artifact_path: gateHelpers.normalizePath(outputArtifactPath),
        output_retention: buildRawOutputRetentionEvidence(rawOutputText, true),
        compact_summary: outputLines,
        failure_chunks: [outputLines],
        out_of_scope_failure_policy: config.out_of_scope_failure_policy,
        out_of_scope_failure_detected: false,
        out_of_scope_audit_verdict: 'NOT_APPLICABLE',
        violations: [
            `Full-suite validation was interrupted after the forecast-derived timeout window without terminal gate evidence; recovery materialized this FAILED timeout artifact from ${gateHelpers.normalizePath(options.recoveryArtifactPath)}.`
        ],
        warnings: [
            'Dead run marker had no live child or descendant process evidence; no generic Node process cleanup was required.'
        ],
        cycle_binding: {
            task_id: options.taskId,
            preflight_path: gateHelpers.normalizePath(options.preflightPath),
            preflight_sha256: options.preflightSha256,
            compile_gate_timestamp: options.compileGateTimestamp,
            scope_binding: options.summary?.preflightSha256
                ? {
                    changed_files_sha256: null,
                    scope_sha256: null,
                    scope_content_sha256: null
                }
                : null
        },
        duration_ms: durationMs,
        timeout_forecast: timeoutForecast
    };
    result.failure_evidence = persistFullSuiteFailureEvidence({
        repoRoot: options.repoRoot,
        reviewsRoot,
        taskId: options.taskId,
        result,
        outputLines
    });
    result.output_telemetry = buildFullSuiteValidationOutputTelemetry(outputLines, result);
    await writeArtifactThenEmitMandatoryFullSuiteEvent(options.repoRoot, eventsRoot, options.taskId, artifactPath, result.status, result, {
        status: result.status,
        enabled: result.enabled,
        command: result.command,
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        preflight_path: result.cycle_binding?.preflight_path || gateHelpers.normalizePath(options.preflightPath),
        artifact_path: gateHelpers.normalizePath(artifactPath),
        output_artifact_path: result.output_artifact_path,
        duration_ms: result.duration_ms,
        timeout_forecast: result.timeout_forecast,
        cycle_binding: result.cycle_binding,
        violations: result.violations,
        warnings: result.warnings,
        output_telemetry: result.output_telemetry,
        output_retention: result.output_retention,
        failure_evidence: result.failure_evidence,
        recovery_artifact_path: gateHelpers.normalizePath(options.recoveryArtifactPath)
    });
}

function formatSummaryLines(summary: FullSuiteValidationInterruptedRunSummary): string[] {
    const descendants = summary.descendantProcessCandidates.length > 0
        ? summary.descendantProcessCandidates
            .slice(0, 5)
            .map((candidate) => `pid=${candidate.pid},ppid=${candidate.parentPid ?? 'unknown'}`)
            .join('; ')
        : 'none';
    return [
        `GatePid: ${summary.gatePid} alive=${summary.gateProcessAlive}`,
        `ChildPid: ${summary.childPid ?? 'none'} alive=${summary.childProcessAlive == null ? 'unknown' : summary.childProcessAlive}`,
        `DescendantCandidates: ${descendants}`,
        `ProcessScanWarning: ${summary.processScanWarning ? redactSecretText(summary.processScanWarning) : 'none'}`
    ];
}

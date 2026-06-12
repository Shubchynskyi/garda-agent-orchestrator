import * as fs from 'node:fs';
import * as path from 'node:path';

import { getBundleCliCommand, getSourceCliCommand, resolveBundleNameForTarget } from '../../../../core/constants';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { redactSecretText } from '../../../../core/redaction';
import {
    clearFullSuiteValidationRunMarker,
    readInterruptedFullSuiteValidationRunMarker,
    resolveFullSuiteValidationRunMarkerPath,
    type FullSuiteValidationRunMarkerInspectionOptions,
    type FullSuiteValidationInterruptedRunSummary
} from '../../../../gates/full-suite/full-suite-validation-run-marker';
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

export function runFullSuiteRunMarkerRecoveryCommand(
    options: FullSuiteRunMarkerRecoveryCommandOptions
): FullSuiteRunMarkerRecoveryCommandResult {
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

    const artifact = buildRecoveryArtifact({
        repoRoot,
        taskId,
        markerPath,
        preflightPath,
        preflightSha256,
        compileGateTimestamp,
        status,
        action,
        summary
    });
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

    if (status === 'CLEARED_DEAD_MARKER') {
        clearFullSuiteValidationRunMarker(repoRoot, taskId);
    }

    const cleanupCommand = [
        `${buildCliPrefix(repoRoot)} gate full-suite-run-marker-recovery`,
        `--task-id "${taskId}"`,
        `--preflight-path "${gateHelpers.normalizePath(path.relative(repoRoot, preflightPath))}"`,
        '--clear-dead-marker',
        '--operator-confirmed yes',
        '--repo-root "."'
    ].join(' ');
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

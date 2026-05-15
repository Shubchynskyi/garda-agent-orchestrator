import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from '../../../core/constants';
import { LIFECYCLE_EVENT_TYPES } from '../../../gate-runtime/lifecycle-events';
import { appendTaskEventAsync } from '../../../gate-runtime/task-events';
import * as gateHelpers from '../../../gates/helpers';
import {
    buildFullSuiteValidationOutputTelemetry,
    buildDocsOnlyNotRequiredResult,
    buildSkippedResult,
    buildValidationResult,
    formatFullSuiteValidationResult,
    isFullSuiteNotRequiredForDocsOnlyScope,
    loadFullSuiteValidationConfig,
    type FullSuiteValidationCycleBinding,
    type FullSuiteValidationResult
} from '../../../gates/full-suite-validation';
import { getTaskModeEvidence } from '../../../gates/task-mode';
import {
    getCurrentWorkflowConfigChanges,
    getWorkflowConfigWorkViolations
} from '../../../gates/workflow-config-work';
import { executeCommandAsync } from '../gates-subprocess';
import { EXIT_GATE_FAILURE, EXIT_GENERAL_FAILURE } from '../../exit-codes';
import {
    normalizePathValue,
    ensureDirectoryExists,
    parseRequiredText
} from '../cli-helpers';
import { requireResolvedPath } from '../shared-command-utils';

export interface FullSuiteValidationCommandOptions {
    taskId?: unknown;
    preflightPath?: unknown;
    repoRoot?: unknown;
}

export interface FullSuiteValidationCommandResult {
    outputText: string;
    exitCode: number;
}

function resolveFullSuiteValidationEventType(status: 'PASSED' | 'FAILED' | 'WARNED' | 'SKIPPED'): string {
    return {
        PASSED: LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_PASSED,
        FAILED: LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_FAILED,
        WARNED: LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_WARNED,
        SKIPPED: LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_SKIPPED
    }[status];
}

function resolveFullSuiteValidationOutcome(status: 'PASSED' | 'FAILED' | 'WARNED' | 'SKIPPED'): string {
    return status === 'FAILED' ? 'FAIL' : status === 'WARNED' ? 'WARN' : status === 'SKIPPED' ? 'INFO' : 'PASS';
}

const FULL_SUITE_VALIDATION_EVENT_TYPES = new Set<string>([
    LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_PASSED,
    LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_FAILED,
    LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_WARNED,
    LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_SKIPPED
]);

const FULL_SUITE_GENERATED_LOCKS = Object.freeze([
    '.scripts-build.lock',
    '.node-build.lock',
    'dist.lock'
]);

interface GeneratedLockCleanupObservation {
    readonly lock_path: string;
    readonly removed: boolean;
    readonly reason: string;
    readonly owner_pid: number | null;
    readonly owner_alive: boolean | null;
}

function readLatestFullSuiteValidationTransactionId(eventsRoot: string, taskId: string): string | null {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
        return null;
    }

    let transactionId: string | null = null;
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const eventType = String(parsed.event_type || '').trim();
            if (!FULL_SUITE_VALIDATION_EVENT_TYPES.has(eventType)) {
                continue;
            }
            const details = parsed.details && typeof parsed.details === 'object'
                ? parsed.details as Record<string, unknown>
                : null;
            const candidate = details ? String(details.artifact_transaction_id || '').trim() : '';
            transactionId = candidate || null;
        } catch {
            // Best-effort only; timeline integrity is validated elsewhere.
        }
    }

    return transactionId;
}

function cleanupPendingFullSuiteValidationArtifact(pendingArtifactPath: string, pendingMetaPath: string): void {
    fs.rmSync(pendingArtifactPath, { force: true });
    fs.rmSync(pendingMetaPath, { force: true });
}

function promotePendingFullSuiteValidationArtifact(
    pendingArtifactPath: string,
    pendingMetaPath: string,
    artifactPath: string
): void {
    fs.copyFileSync(pendingArtifactPath, artifactPath);
    cleanupPendingFullSuiteValidationArtifact(pendingArtifactPath, pendingMetaPath);
}

function recoverPendingFullSuiteValidationArtifact(
    eventsRoot: string,
    taskId: string,
    artifactPath: string,
    pendingArtifactPath: string,
    pendingMetaPath: string
): void {
    const pendingArtifactExists = fs.existsSync(pendingArtifactPath);
    const pendingMetaExists = fs.existsSync(pendingMetaPath);
    if (!pendingArtifactExists && !pendingMetaExists) {
        return;
    }

    if (!pendingArtifactExists || !pendingMetaExists) {
        cleanupPendingFullSuiteValidationArtifact(pendingArtifactPath, pendingMetaPath);
        return;
    }

    let pendingTransactionId: string | null = null;
    try {
        const pendingMeta = JSON.parse(fs.readFileSync(pendingMetaPath, 'utf8')) as Record<string, unknown>;
        const candidate = String(pendingMeta.transaction_id || '').trim();
        pendingTransactionId = candidate || null;
    } catch {
        cleanupPendingFullSuiteValidationArtifact(pendingArtifactPath, pendingMetaPath);
        return;
    }

    const latestTransactionId = readLatestFullSuiteValidationTransactionId(eventsRoot, taskId);
    if (pendingTransactionId && latestTransactionId === pendingTransactionId) {
        promotePendingFullSuiteValidationArtifact(pendingArtifactPath, pendingMetaPath, artifactPath);
        return;
    }

    cleanupPendingFullSuiteValidationArtifact(pendingArtifactPath, pendingMetaPath);
}

async function appendFullSuiteValidationLifecycleEvent(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    status: 'PASSED' | 'FAILED' | 'WARNED' | 'SKIPPED',
    details: Record<string, unknown>
): Promise<void> {
    const result = await appendTaskEventAsync(
        repoRoot,
        taskId,
        resolveFullSuiteValidationEventType(status),
        resolveFullSuiteValidationOutcome(status),
        `Full-suite validation ${status.toLowerCase()}.`,
        details,
        {
            actor: 'gate',
            passThru: true,
            eventsRoot
        }
    );
    if (!result || !result.integrity) {
        const warningText = result?.warnings.join(' | ') || 'task timeline append failed without diagnostics.';
        throw new Error(`Mandatory lifecycle event '${resolveFullSuiteValidationEventType(status)}' append failed: ${warningText}`);
    }
}

async function writeArtifactThenEmitMandatoryFullSuiteEvent(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    artifactPath: string,
    status: 'PASSED' | 'FAILED' | 'WARNED' | 'SKIPPED',
    artifact: unknown,
    details: Record<string, unknown>
): Promise<void> {
    const pendingArtifactPath = `${artifactPath}.pending`;
    const pendingMetaPath = `${artifactPath}.pending.meta.json`;
    recoverPendingFullSuiteValidationArtifact(eventsRoot, taskId, artifactPath, pendingArtifactPath, pendingMetaPath);
    const transactionId = randomUUID();
    fs.writeFileSync(pendingArtifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    fs.writeFileSync(
        pendingMetaPath,
        `${JSON.stringify({ transaction_id: transactionId }, null, 2)}\n`,
        'utf8'
    );
    try {
        await appendFullSuiteValidationLifecycleEvent(repoRoot, eventsRoot, taskId, status, {
            ...details,
            artifact_transaction_id: transactionId
        });
    } catch (error: unknown) {
        try {
            cleanupPendingFullSuiteValidationArtifact(pendingArtifactPath, pendingMetaPath);
        } catch {
            // Best-effort cleanup only; keep the lifecycle emit failure as the primary error.
        }
        throw error;
    }
    try {
        promotePendingFullSuiteValidationArtifact(pendingArtifactPath, pendingMetaPath, artifactPath);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Mandatory lifecycle event '${resolveFullSuiteValidationEventType(status)}' was recorded, ` +
            `but canonical artifact promotion failed: ${message}. ` +
            `Pending artifact retained at '${gateHelpers.normalizePath(pendingArtifactPath)}' for recovery on the next full-suite-validation run.`
        );
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

function normalizeSha256Text(value: unknown): string | null {
    const text = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

function readFullSuiteScopeBinding(
    repoRoot: string,
    taskId: string,
    preflight: Record<string, unknown>
): NonNullable<FullSuiteValidationCycleBinding['scope_binding']> | null {
    const compileGatePath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-compile-gate.json`)
    );
    const compileGate = fs.existsSync(compileGatePath) && fs.statSync(compileGatePath).isFile()
        ? JSON.parse(fs.readFileSync(compileGatePath, 'utf8')) as Record<string, unknown>
        : null;
    const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
        ? preflight.metrics as Record<string, unknown>
        : {};
    const changedFilesSha256 = normalizeSha256Text(compileGate?.preflight_changed_files_sha256)
        || normalizeSha256Text(compileGate?.scope_changed_files_sha256)
        || normalizeSha256Text(metrics.changed_files_sha256);
    const scopeSha256 = normalizeSha256Text(compileGate?.preflight_scope_sha256)
        || normalizeSha256Text(metrics.scope_sha256);
    const scopeContentSha256 = normalizeSha256Text(compileGate?.preflight_scope_content_sha256)
        || normalizeSha256Text(metrics.scope_content_sha256);
    if (!changedFilesSha256 && !scopeSha256 && !scopeContentSha256) {
        return null;
    }
    return {
        changed_files_sha256: changedFilesSha256,
        scope_sha256: scopeSha256,
        scope_content_sha256: scopeContentSha256
    };
}

function readGeneratedLockOwnerPid(lockPath: string): number | null {
    const ownerPath = path.join(lockPath, 'owner.json');
    try {
        const parsed = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
        return Number.isInteger(parsed.pid) && Number(parsed.pid) > 0
            ? Number(parsed.pid)
            : null;
    } catch {
        return null;
    }
}

function isProcessAlive(pid: number | null): boolean | null {
    if (pid === null || !Number.isInteger(pid) || pid <= 0) {
        return null;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        const code = error != null && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || '')
            : '';
        if (code === 'ESRCH') {
            return false;
        }
        if (code === 'EPERM') {
            return true;
        }
        return null;
    }
}

function cleanupGeneratedLocksAfterTimedOutFullSuite(repoRoot: string): GeneratedLockCleanupObservation[] {
    const observations: GeneratedLockCleanupObservation[] = [];
    const resolvedRoot = path.resolve(repoRoot);

    for (const lockName of FULL_SUITE_GENERATED_LOCKS) {
        const lockPath = path.resolve(resolvedRoot, lockName);
        if (!lockPath.startsWith(`${resolvedRoot}${path.sep}`)) {
            continue;
        }
        if (!fs.existsSync(lockPath) || !fs.statSync(lockPath).isDirectory()) {
            continue;
        }

        const ownerPid = readGeneratedLockOwnerPid(lockPath);
        const ownerAlive = isProcessAlive(ownerPid);
        if (ownerPid !== null && ownerAlive === false) {
            fs.rmSync(lockPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
            observations.push({
                lock_path: gateHelpers.normalizePath(lockPath),
                removed: true,
                reason: 'owner_process_dead_after_full_suite_timeout',
                owner_pid: ownerPid,
                owner_alive: false
            });
            continue;
        }

        observations.push({
            lock_path: gateHelpers.normalizePath(lockPath),
            removed: false,
            reason: ownerPid === null ? 'owner_pid_missing_or_unreadable' : 'owner_process_still_alive_or_unknown',
            owner_pid: ownerPid,
            owner_alive: ownerAlive
        });
    }

    return observations;
}

function formatGeneratedLockCleanupObservation(observation: GeneratedLockCleanupObservation): string {
    const action = observation.removed ? 'removed' : 'retained';
    const ownerPid = observation.owner_pid === null ? 'unknown' : String(observation.owner_pid);
    const ownerAlive = observation.owner_alive === null ? 'unknown' : String(observation.owner_alive);
    return `Full-suite timeout cleanup ${action} generated lock ${observation.lock_path} `
        + `(reason=${observation.reason}; owner_pid=${ownerPid}; owner_alive=${ownerAlive}).`;
}

function buildFullSuiteValidationCommandEnv(): NodeJS.ProcessEnv {
    return {
        GARDA_BUNDLE_NAME: undefined
    };
}

function buildWorkflowConfigWorkBlockedResult(
    config: ReturnType<typeof loadFullSuiteValidationConfig>,
    cycleBinding: FullSuiteValidationCycleBinding,
    violations: string[],
    scanError: string | null
): FullSuiteValidationResult {
    return {
        status: 'FAILED',
        enabled: config.enabled,
        command: config.command,
        exit_code: null,
        timed_out: false,
        output_artifact_path: null,
        compact_summary: ['Workflow config change is not authorized for this task mode.'],
        failure_chunks: [],
        out_of_scope_failure_policy: config.out_of_scope_failure_policy,
        out_of_scope_failure_detected: false,
        out_of_scope_audit_verdict: 'NOT_APPLICABLE',
        violations,
        warnings: scanError ? [`Workflow config workspace scan warning: ${scanError}`] : [],
        cycle_binding: cycleBinding
    };
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
    try {
        const execution = await executeCommandAsync(config.command, {
            cwd: repoRoot,
            env: buildFullSuiteValidationCommandEnv(),
            timeoutMs: config.timeout_ms
        });
        commandExitCode = execution.exitCode;
        timedOut = execution.timedOut;
        outputLines = execution.outputLines;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        outputLines = [message];
    }
    const generatedLockCleanup = timedOut
        ? cleanupGeneratedLocksAfterTimedOutFullSuite(repoRoot)
        : [];
    if (generatedLockCleanup.length > 0) {
        outputLines = [
            ...outputLines,
            ...generatedLockCleanup.map(formatGeneratedLockCleanupObservation)
        ];
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
    if (generatedLockCleanup.length > 0) {
        result.warnings.push(...generatedLockCleanup.map(formatGeneratedLockCleanupObservation));
    }
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
            cycle_binding: blockedResult.cycle_binding,
            violations: blockedResult.violations,
            warnings: blockedResult.warnings,
            output_telemetry: blockedResult.output_telemetry
        });
        return {
            outputText: `${formatFullSuiteValidationResult(blockedResult)}\n`,
            exitCode: EXIT_GATE_FAILURE
        };
    }
    await writeArtifactThenEmitMandatoryFullSuiteEvent(repoRoot, eventsRoot, taskId, artifactPath, result.status, result, {
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
        warnings: result.warnings,
        output_telemetry: result.output_telemetry
    });

    return {
        outputText: `${formatFullSuiteValidationResult(result)}\n`,
        exitCode: result.status === 'FAILED' ? EXIT_GATE_FAILURE : 0
    };
}

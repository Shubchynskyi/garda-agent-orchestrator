import * as fs from 'node:fs';
import * as path from 'node:path';

import { redactPath } from '../core/redaction';
import { assertValidTaskId } from '../gate-runtime/task-events';
import {
    fileSha256,
    isOrchestratorSourceCheckout,
    joinOrchestratorPath,
    normalizePath,
    resolvePathInsideRepo,
    toPosix
} from './helpers';

// ---------------------------------------------------------------------------
// Timeout phase constants
// ---------------------------------------------------------------------------

export type TimeoutPhase =
    | 'pre_launch'
    | 'launch_pending'
    | 'awaiting_first_output'
    | 'output_stalled'
    | 'completed'
    | 'timed_out';

export type SuspectedLayer =
    | 'shell'
    | 'bridge'
    | 'provider_callback'
    | 'gate'
    | 'unknown';

// ---------------------------------------------------------------------------
// Artifact types
// ---------------------------------------------------------------------------

export interface CommandPhaseRecord {
    command_label: string;
    command_text: string;
    start_time_utc: string | null;
    first_output_time_utc: string | null;
    last_output_time_utc: string | null;
    end_time_utc: string | null;
    elapsed_ms: number | null;
    time_to_first_output_ms: number | null;
    output_gap_ms: number | null;
    timeout_phase: TimeoutPhase;
    timed_out: boolean;
    exit_code: number | null;
    suspected_layer: SuspectedLayer;
    diagnosis: string;
}

export interface CommandTimeoutDiagnosticsArtifact {
    schema_version: 1;
    timestamp_utc: string;
    event_source: 'command-timeout-diagnostics';
    task_id: string;
    status: 'PASSED' | 'FAILED';
    outcome: 'PASS' | 'FAIL';

    provider: string | null;
    execution_context: 'source-checkout' | 'materialized-bundle';
    effective_cwd: string;
    workspace_root: string;

    commands: CommandPhaseRecord[];
    violations: string[];
    summary: string;
}

export interface CommandTimeoutEvidenceResult {
    task_id: string | null;
    evidence_path: string | null;
    evidence_hash: string | null;
    evidence_status: string;
    provider: string | null;
    violations: string[];
}

// ---------------------------------------------------------------------------
// Build options
// ---------------------------------------------------------------------------

export interface BuildCommandTimeoutDiagnosticsOptions {
    taskId: string;
    repoRoot: string;
    provider?: string | null;
    effectiveCwd?: string | null;
    commands?: CommandPhaseRecord[];
}

// ---------------------------------------------------------------------------
// Phase tracker — used by callers to build CommandPhaseRecord instances
// ---------------------------------------------------------------------------

export class CommandPhaseTracker {
    private readonly label: string;
    private readonly commandText: string;
    private startTime: number | null = null;
    private startTimeUtc: string | null = null;
    private firstOutputTime: number | null = null;
    private firstOutputTimeUtc: string | null = null;
    private lastOutputTime: number | null = null;
    private lastOutputTimeUtc: string | null = null;
    private endTime: number | null = null;
    private endTimeUtc: string | null = null;
    private exitCode: number | null = null;
    private didTimeout = false;

    constructor(label: string, commandText: string) {
        this.label = label;
        this.commandText = commandText;
    }

    recordStart(): void {
        this.startTime = Date.now();
        this.startTimeUtc = new Date(this.startTime).toISOString();
    }

    recordFirstOutput(): void {
        if (this.firstOutputTime !== null) return;
        this.firstOutputTime = Date.now();
        this.firstOutputTimeUtc = new Date(this.firstOutputTime).toISOString();
        this.lastOutputTime = this.firstOutputTime;
        this.lastOutputTimeUtc = this.firstOutputTimeUtc;
    }

    recordOutput(): void {
        if (this.firstOutputTime === null) {
            this.recordFirstOutput();
        }
        this.lastOutputTime = Date.now();
        this.lastOutputTimeUtc = new Date(this.lastOutputTime).toISOString();
    }

    recordEnd(exitCode: number | null, timedOut: boolean): void {
        this.endTime = Date.now();
        this.endTimeUtc = new Date(this.endTime).toISOString();
        this.exitCode = exitCode;
        this.didTimeout = timedOut;
    }

    toRecord(): CommandPhaseRecord {
        const elapsedMs = (this.startTime !== null && this.endTime !== null)
            ? this.endTime - this.startTime
            : null;

        const timeToFirstOutputMs = (this.startTime !== null && this.firstOutputTime !== null)
            ? this.firstOutputTime - this.startTime
            : null;

        const outputGapMs = (this.lastOutputTime !== null && this.endTime !== null)
            ? this.endTime - this.lastOutputTime
            : null;

        const timeoutPhase = classifyTimeoutPhase(
            this.startTime,
            this.firstOutputTime,
            this.lastOutputTime,
            this.endTime,
            this.didTimeout
        );

        const suspectedLayer = classifySuspectedLayer(
            this.startTime,
            this.firstOutputTime,
            this.lastOutputTime,
            this.endTime,
            this.didTimeout
        );

        const diagnosis = buildDiagnosis(timeoutPhase, suspectedLayer, elapsedMs, timeToFirstOutputMs, outputGapMs);

        return {
            command_label: this.label,
            command_text: this.commandText,
            start_time_utc: this.startTimeUtc,
            first_output_time_utc: this.firstOutputTimeUtc,
            last_output_time_utc: this.lastOutputTimeUtc,
            end_time_utc: this.endTimeUtc,
            elapsed_ms: elapsedMs,
            time_to_first_output_ms: timeToFirstOutputMs,
            output_gap_ms: outputGapMs,
            timeout_phase: timeoutPhase,
            timed_out: this.didTimeout,
            exit_code: this.exitCode,
            suspected_layer: suspectedLayer,
            diagnosis
        };
    }
}

// ---------------------------------------------------------------------------
// Phase and layer classification
// ---------------------------------------------------------------------------

export function classifyTimeoutPhase(
    startTime: number | null,
    firstOutputTime: number | null,
    lastOutputTime: number | null,
    endTime: number | null,
    timedOut: boolean
): TimeoutPhase {
    if (startTime === null) return 'pre_launch';
    if (endTime === null) return 'launch_pending';
    if (!timedOut) return 'completed';
    if (firstOutputTime === null) return 'awaiting_first_output';
    if (lastOutputTime !== null) return 'output_stalled';
    return 'timed_out';
}

export function classifySuspectedLayer(
    startTime: number | null,
    firstOutputTime: number | null,
    _lastOutputTime: number | null,
    _endTime: number | null,
    timedOut: boolean
): SuspectedLayer {
    if (!timedOut) return 'unknown';
    if (startTime === null) return 'shell';
    if (firstOutputTime === null) return 'bridge';
    return 'provider_callback';
}

function buildDiagnosis(
    phase: TimeoutPhase,
    layer: SuspectedLayer,
    elapsedMs: number | null,
    timeToFirstOutputMs: number | null,
    outputGapMs: number | null
): string {
    const elapsed = elapsedMs !== null ? `${elapsedMs}ms` : 'unknown';

    switch (phase) {
        case 'pre_launch':
            return 'Command was never started. Likely a shell launch failure or environment issue.';
        case 'launch_pending':
            return 'Command started but never resolved. The process may still be running or the exit handler was lost.';
        case 'completed':
            return `Command completed normally in ${elapsed}.`;
        case 'awaiting_first_output':
            return `Command timed out after ${elapsed} without producing any output. ` +
                `Suspected layer: ${layer}. This suggests a shell launch failure or bridge callback loss.`;
        case 'output_stalled': {
            const gap = outputGapMs !== null ? `${outputGapMs}ms` : 'unknown';
            const firstOut = timeToFirstOutputMs !== null ? `${timeToFirstOutputMs}ms` : 'unknown';
            return `Command timed out after ${elapsed}. First output arrived after ${firstOut}, ` +
                `then output stalled for ${gap} before timeout. ` +
                `Suspected layer: ${layer}. This suggests the process hung during execution.`;
        }
        case 'timed_out':
            return `Command timed out after ${elapsed}. Suspected layer: ${layer}.`;
    }
}

// ---------------------------------------------------------------------------
// Artifact path resolution
// ---------------------------------------------------------------------------

export function resolveCommandTimeoutArtifactPath(repoRoot: string, taskId: string, artifactPath = ''): string {
    const explicit = String(artifactPath || '').trim();
    if (explicit) {
        const resolved = resolvePathInsideRepo(explicit, repoRoot, { allowMissing: true });
        if (!resolved) {
            throw new Error('CommandTimeoutArtifactPath must not be empty.');
        }
        return resolved;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-command-timeout.json`));
}

// ---------------------------------------------------------------------------
// Build artifact
// ---------------------------------------------------------------------------

export function buildCommandTimeoutDiagnostics(options: BuildCommandTimeoutDiagnosticsOptions): CommandTimeoutDiagnosticsArtifact {
    const taskId = assertValidTaskId(options.taskId);
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const isSourceCheckout = isOrchestratorSourceCheckout(repoRoot);
    const provider = String(options.provider || '').trim() || null;
    const effectiveCwd = options.effectiveCwd
        ? String(options.effectiveCwd).trim()
        : toPosix(repoRoot);

    const commands = options.commands || [];
    const violations: string[] = [];

    for (const cmd of commands) {
        if (cmd.timed_out) {
            violations.push(
                `Command '${cmd.command_label}' timed out in phase '${cmd.timeout_phase}' ` +
                `(suspected layer: ${cmd.suspected_layer}). ${cmd.diagnosis}`
            );
        }
    }

    const hasTimeout = commands.some(c => c.timed_out);
    const hasPreLaunchFailure = commands.some(c => c.timeout_phase === 'pre_launch');
    const hasErrors = hasTimeout || hasPreLaunchFailure;

    if (hasPreLaunchFailure) {
        for (const cmd of commands) {
            if (cmd.timeout_phase === 'pre_launch') {
                violations.push(
                    `Command '${cmd.command_label}' was never launched. ${cmd.diagnosis}`
                );
            }
        }
    }

    const completedCount = commands.filter(c => c.timeout_phase === 'completed').length;
    const timedOutCount = commands.filter(c => c.timed_out).length;
    const preLaunchCount = commands.filter(c => c.timeout_phase === 'pre_launch').length;

    const summary = `${commands.length} commands tracked: ` +
        `${completedCount} completed, ${timedOutCount} timed out, ${preLaunchCount} never launched.`;

    return {
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        event_source: 'command-timeout-diagnostics',
        task_id: taskId,
        status: hasErrors ? 'FAILED' : 'PASSED',
        outcome: hasErrors ? 'FAIL' : 'PASS',
        provider,
        execution_context: isSourceCheckout ? 'source-checkout' : 'materialized-bundle',
        effective_cwd: redactPath(effectiveCwd, repoRoot),
        workspace_root: redactPath(toPosix(repoRoot)),
        commands,
        violations,
        summary
    };
}

// ---------------------------------------------------------------------------
// Evidence verification
// ---------------------------------------------------------------------------

export interface GetCommandTimeoutEvidenceOptions {
    artifactPath?: string;
    timelinePath?: string;
}

export function getCommandTimeoutEvidence(
    repoRoot: string,
    taskId: string | null,
    artifactPathOrOptions: string | GetCommandTimeoutEvidenceOptions = ''
): CommandTimeoutEvidenceResult {
    const opts: GetCommandTimeoutEvidenceOptions = typeof artifactPathOrOptions === 'string'
        ? { artifactPath: artifactPathOrOptions }
        : artifactPathOrOptions;
    const result: CommandTimeoutEvidenceResult = {
        task_id: taskId,
        evidence_path: null,
        evidence_hash: null,
        evidence_status: 'UNKNOWN',
        provider: null,
        violations: []
    };

    if (!taskId) {
        result.evidence_status = 'TASK_ID_MISSING';
        return result;
    }

    const resolvedTaskId = assertValidTaskId(taskId);
    const resolvedPath = resolveCommandTimeoutArtifactPath(repoRoot, resolvedTaskId, opts.artifactPath || '');
    result.evidence_path = normalizePath(resolvedPath);

    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        result.evidence_status = 'EVIDENCE_FILE_MISSING';
        result.violations.push(
            `Command timeout diagnostics evidence missing: file not found at '${result.evidence_path}'. ` +
            'Run command-timeout-diagnostics to persist hang evidence.'
        );
        return result;
    }

    let artifact: Record<string, unknown>;
    try {
        artifact = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as Record<string, unknown>;
    } catch {
        result.evidence_status = 'EVIDENCE_INVALID_JSON';
        result.violations.push(`Command timeout diagnostics evidence is invalid JSON at '${result.evidence_path}'.`);
        return result;
    }

    result.evidence_hash = fileSha256(resolvedPath);
    result.provider = String(artifact.provider || '').trim() || null;

    const evidenceTaskId = String(artifact.task_id || '').trim();
    if (evidenceTaskId !== resolvedTaskId) {
        result.evidence_status = 'EVIDENCE_TASK_MISMATCH';
        result.violations.push(
            `Command timeout diagnostics task mismatch. Expected '${resolvedTaskId}', got '${evidenceTaskId}'.`
        );
        return result;
    }

    const eventSource = String(artifact.event_source || '').trim();
    if (eventSource !== 'command-timeout-diagnostics') {
        result.evidence_status = 'EVIDENCE_SOURCE_INVALID';
        result.violations.push(
            `Command timeout diagnostics evidence source is invalid. Expected 'command-timeout-diagnostics', got '${eventSource}'.`
        );
        return result;
    }

    // Timeline cross-verification
    const timelineViolations = verifyCommandTimeoutTimelineBinding(resolvedTaskId, result.evidence_hash, opts.timelinePath);
    if (timelineViolations.length > 0) {
        result.evidence_status = 'EVIDENCE_TIMELINE_UNBOUND';
        result.violations.push(...timelineViolations);
        return result;
    }

    const status = String(artifact.status || '').trim().toUpperCase();
    const outcome = String(artifact.outcome || '').trim().toUpperCase();
    if (status === 'PASSED' && outcome === 'PASS') {
        result.evidence_status = 'PASS';
        return result;
    }

    result.evidence_status = 'PASS_WITH_VIOLATIONS';
    const artifactViolations = Array.isArray(artifact.violations) ? artifact.violations : [];
    for (const v of artifactViolations) {
        result.violations.push(`Command timeout diagnostic violation: ${String(v)}`);
    }

    return result;
}

function verifyCommandTimeoutTimelineBinding(
    taskId: string,
    artifactHash: string | null,
    timelinePath?: string
): string[] {
    if (!timelinePath) return [];

    const resolvedTimeline = path.resolve(timelinePath);
    if (!fs.existsSync(resolvedTimeline) || !fs.statSync(resolvedTimeline).isFile()) {
        return [];
    }

    const lines = fs.readFileSync(resolvedTimeline, 'utf8').split('\n').filter(line => line.trim().length > 0);
    let foundEvent = false;
    let recordedHash: string | null = null;

    for (const line of lines) {
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const eventType = String(parsed.event_type || '').trim().toUpperCase();
            if (eventType === 'COMMAND_TIMEOUT_DIAGNOSTICS_RECORDED') {
                foundEvent = true;
                const details = parsed.details as Record<string, unknown> | undefined;
                if (details && typeof details.artifact_hash === 'string') {
                    recordedHash = details.artifact_hash;
                }
            }
        } catch {
            // Skip malformed lines
        }
    }

    if (!foundEvent) {
        return [
            `Command timeout diagnostics evidence is not bound to task timeline for '${taskId}'. ` +
            'COMMAND_TIMEOUT_DIAGNOSTICS_RECORDED event is missing from the timeline. ' +
            'Run command-timeout-diagnostics gate to emit proper lifecycle evidence.'
        ];
    }

    if (artifactHash && recordedHash && artifactHash !== recordedHash) {
        return [
            `Command timeout diagnostics artifact hash mismatch: file hash '${artifactHash}' ` +
            `does not match timeline-recorded hash '${recordedHash}'. ` +
            'The artifact may have been modified after the command-timeout-diagnostics gate ran.'
        ];
    }

    return [];
}

// ---------------------------------------------------------------------------
// Violation helpers
// ---------------------------------------------------------------------------

export function getCommandTimeoutEvidenceViolations(result: CommandTimeoutEvidenceResult): string[] {
    switch (result.evidence_status) {
        case 'PASS':
        case 'PASS_WITH_VIOLATIONS':
            return result.violations;
        case 'TASK_ID_MISSING':
            return ['Command timeout diagnostics evidence cannot be verified: task id is missing.'];
        case 'EVIDENCE_FILE_MISSING':
            return result.violations;
        case 'EVIDENCE_INVALID_JSON':
            return result.violations;
        case 'EVIDENCE_TASK_MISMATCH':
            return result.violations;
        case 'EVIDENCE_SOURCE_INVALID':
            return result.violations;
        case 'EVIDENCE_TIMELINE_UNBOUND':
            return result.violations;
        default:
            return ['Command timeout diagnostics evidence is missing or invalid. Run command-timeout-diagnostics gate.'];
    }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatCommandTimeoutDiagnosticsResult(artifact: CommandTimeoutDiagnosticsArtifact): string[] {
    const lines: string[] = [
        artifact.outcome === 'PASS' ? 'COMMAND_TIMEOUT_DIAGNOSTICS_PASSED' : 'COMMAND_TIMEOUT_DIAGNOSTICS_FAILED',
        `TaskId: ${artifact.task_id}`,
        `Provider: ${artifact.provider || 'unknown'}`,
        `ExecutionContext: ${artifact.execution_context}`,
        `EffectiveCwd: ${artifact.effective_cwd}`,
        `WorkspaceRoot: ${artifact.workspace_root}`,
        `Summary: ${artifact.summary}`
    ];

    if (artifact.commands.length > 0) {
        lines.push('Commands:');
        for (const cmd of artifact.commands) {
            const icon = cmd.timed_out ? '-' : cmd.timeout_phase === 'pre_launch' ? '-' : '+';
            const timing = cmd.elapsed_ms != null ? ` (${cmd.elapsed_ms}ms)` : '';
            lines.push(`  [${icon}] ${cmd.command_label}: ${cmd.timeout_phase}${timing}`);
            lines.push(`      Diagnosis: ${cmd.diagnosis}`);
            if (cmd.suspected_layer !== 'unknown') {
                lines.push(`      SuspectedLayer: ${cmd.suspected_layer}`);
            }
        }
    }

    if (artifact.violations.length > 0) {
        lines.push('Violations:');
        for (const v of artifact.violations) {
            lines.push(`  - ${v}`);
        }
    }

    return lines;
}

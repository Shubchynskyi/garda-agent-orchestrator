import { appendTaskEvent, appendTaskEventAsync } from '../task-events';
import type { AutoEmitOptions } from '../lifecycle-event-core';
import { LIFECYCLE_EVENT_TYPES } from '../lifecycle-event-types';

function emitDiagnosticWarning(label: string, error: unknown): null {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`WARNING: ${label} event emit failed: ${msg}\n`);
    return null;
}

export function emitHandshakeDiagnosticsEvent(
    repoRoot: string,
    taskId: string,
    provider: string | null,
    executionContext: string,
    cliPath: string,
    passed: boolean,
    artifactHash: string | null = null,
    options: AutoEmitOptions = {}
): ReturnType<typeof appendTaskEvent> {
    if (!repoRoot || !taskId) return null;
    try {
        return appendTaskEvent(
            repoRoot,
            taskId,
            LIFECYCLE_EVENT_TYPES.HANDSHAKE_DIAGNOSTICS_RECORDED,
            passed ? 'PASS' : 'FAIL',
            `Handshake diagnostics ${passed ? 'passed' : 'failed'}: provider=${provider || 'unknown'}, context=${executionContext}.`,
            {
                provider,
                execution_context: executionContext,
                cli_path: cliPath,
                passed,
                artifact_hash: artifactHash
            },
            {
                actor: options.actor || 'gate',
                passThru: options.passThru ?? true,
                eventsRoot: options.eventsRoot
            }
        );
    } catch (error: unknown) {
        return emitDiagnosticWarning('handshake-diagnostics', error);
    }
}

export async function emitHandshakeDiagnosticsEventAsync(
    repoRoot: string,
    taskId: string,
    provider: string | null,
    executionContext: string,
    cliPath: string,
    passed: boolean,
    artifactHash: string | null = null,
    options: AutoEmitOptions = {}
): Promise<ReturnType<typeof appendTaskEvent>> {
    if (!repoRoot || !taskId) return null;
    try {
        return await appendTaskEventAsync(
            repoRoot,
            taskId,
            LIFECYCLE_EVENT_TYPES.HANDSHAKE_DIAGNOSTICS_RECORDED,
            passed ? 'PASS' : 'FAIL',
            `Handshake diagnostics ${passed ? 'passed' : 'failed'}: provider=${provider || 'unknown'}, context=${executionContext}.`,
            {
                provider,
                execution_context: executionContext,
                cli_path: cliPath,
                passed,
                artifact_hash: artifactHash
            },
            {
                actor: options.actor || 'gate',
                passThru: options.passThru ?? true,
                eventsRoot: options.eventsRoot
            }
        );
    } catch (error: unknown) {
        return emitDiagnosticWarning('handshake-diagnostics', error);
    }
}

export function emitShellSmokePreflightEvent(
    repoRoot: string,
    taskId: string,
    provider: string | null,
    executionContext: string,
    passed: boolean,
    artifactHash: string | null = null,
    options: AutoEmitOptions = {}
): ReturnType<typeof appendTaskEvent> {
    if (!repoRoot || !taskId) return null;
    try {
        return appendTaskEvent(
            repoRoot,
            taskId,
            LIFECYCLE_EVENT_TYPES.SHELL_SMOKE_PREFLIGHT_RECORDED,
            passed ? 'PASS' : 'FAIL',
            `Shell smoke preflight ${passed ? 'passed' : 'failed'}: provider=${provider || 'unknown'}, context=${executionContext}.`,
            {
                provider,
                execution_context: executionContext,
                passed,
                artifact_hash: artifactHash
            },
            {
                actor: options.actor || 'gate',
                passThru: options.passThru ?? true,
                eventsRoot: options.eventsRoot
            }
        );
    } catch (error: unknown) {
        return emitDiagnosticWarning('shell-smoke-preflight', error);
    }
}

export async function emitShellSmokePreflightEventAsync(
    repoRoot: string,
    taskId: string,
    provider: string | null,
    executionContext: string,
    passed: boolean,
    artifactHash: string | null = null,
    options: AutoEmitOptions = {}
): Promise<ReturnType<typeof appendTaskEvent>> {
    if (!repoRoot || !taskId) return null;
    try {
        return await appendTaskEventAsync(
            repoRoot,
            taskId,
            LIFECYCLE_EVENT_TYPES.SHELL_SMOKE_PREFLIGHT_RECORDED,
            passed ? 'PASS' : 'FAIL',
            `Shell smoke preflight ${passed ? 'passed' : 'failed'}: provider=${provider || 'unknown'}, context=${executionContext}.`,
            {
                provider,
                execution_context: executionContext,
                passed,
                artifact_hash: artifactHash
            },
            {
                actor: options.actor || 'gate',
                passThru: options.passThru ?? true,
                eventsRoot: options.eventsRoot
            }
        );
    } catch (error: unknown) {
        return emitDiagnosticWarning('shell-smoke-preflight', error);
    }
}

export function emitCommandTimeoutDiagnosticsEvent(
    repoRoot: string,
    taskId: string,
    provider: string | null,
    executionContext: string,
    passed: boolean,
    commandCount: number,
    timedOutCount: number,
    artifactHash: string | null = null,
    options: AutoEmitOptions = {}
): ReturnType<typeof appendTaskEvent> {
    if (!repoRoot || !taskId) return null;
    try {
        return appendTaskEvent(
            repoRoot,
            taskId,
            LIFECYCLE_EVENT_TYPES.COMMAND_TIMEOUT_DIAGNOSTICS_RECORDED,
            passed ? 'PASS' : 'FAIL',
            `Command timeout diagnostics ${passed ? 'passed' : 'failed'}: provider=${provider || 'unknown'}, context=${executionContext}, commands=${commandCount}, timed_out=${timedOutCount}.`,
            {
                provider,
                execution_context: executionContext,
                passed,
                command_count: commandCount,
                timed_out_count: timedOutCount,
                artifact_hash: artifactHash
            },
            {
                actor: options.actor || 'gate',
                passThru: options.passThru ?? true,
                eventsRoot: options.eventsRoot
            }
        );
    } catch (error: unknown) {
        return emitDiagnosticWarning('command-timeout-diagnostics', error);
    }
}

export async function emitCommandTimeoutDiagnosticsEventAsync(
    repoRoot: string,
    taskId: string,
    provider: string | null,
    executionContext: string,
    passed: boolean,
    commandCount: number,
    timedOutCount: number,
    artifactHash: string | null = null,
    options: AutoEmitOptions = {}
): Promise<ReturnType<typeof appendTaskEvent>> {
    if (!repoRoot || !taskId) return null;
    try {
        return await appendTaskEventAsync(
            repoRoot,
            taskId,
            LIFECYCLE_EVENT_TYPES.COMMAND_TIMEOUT_DIAGNOSTICS_RECORDED,
            passed ? 'PASS' : 'FAIL',
            `Command timeout diagnostics ${passed ? 'passed' : 'failed'}: provider=${provider || 'unknown'}, context=${executionContext}, commands=${commandCount}, timed_out=${timedOutCount}.`,
            {
                provider,
                execution_context: executionContext,
                passed,
                command_count: commandCount,
                timed_out_count: timedOutCount,
                artifact_hash: artifactHash
            },
            {
                actor: options.actor || 'gate',
                passThru: options.passThru ?? true,
                eventsRoot: options.eventsRoot
            }
        );
    } catch (error: unknown) {
        return emitDiagnosticWarning('command-timeout-diagnostics', error);
    }
}

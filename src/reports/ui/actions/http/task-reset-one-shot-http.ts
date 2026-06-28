import type * as http from 'node:http';

import { resolveTaskResetAvailability, type TaskResetAvailability } from '../../../../core/task-reset-availability';
import {
    appendUiActionAudit,
    buildUiActionDefinition,
    normalizeUiActionRunnerResult,
    normalizeUiActionTimeoutMs,
    uiActionExecutionAuditFields,
    uiActionExecutionPayload,
    uiActionHttpStatus
} from '../action-common';
import {
    TASK_RESET_CLOSE_ACTION_ID,
    TASK_RESET_REOPEN_ACTION_ID
} from '../task-actions';
import type { UiActionDefinition, UiActionRunnerResult } from '../types';
import {
    resolveUiActionMode,
    sendJson,
    type LocalUiServerRuntimeOptions,
    type UiActionRequest
} from './action-http-common';

const MAX_STEP_OUTPUT_CHARS = 1200;

export function isTaskResetOneShotActionId(actionId: unknown): boolean {
    return actionId === TASK_RESET_REOPEN_ACTION_ID || actionId === TASK_RESET_CLOSE_ACTION_ID;
}

function taskResetActionLabel(action: UiActionDefinition): string {
    return action.id === TASK_RESET_CLOSE_ACTION_ID ? 'Close without execution' : 'Reset task';
}

function taskResetActionSuccessLine(action: UiActionDefinition): string {
    return action.id === TASK_RESET_CLOSE_ACTION_ID
        ? 'Close without execution completed.'
        : 'Task reset completed.';
}

function buildTaskResetSetAction(repoRoot: string, enabled: boolean, actionId: string): UiActionDefinition {
    return buildUiActionDefinition(
        repoRoot,
        actionId,
        'Task',
        enabled ? 'Prepare audited task reset' : 'Restore task reset setting',
        enabled
            ? 'Enable or repair audited task reset readiness for this one UI action.'
            : 'Restore task_reset.enabled=false after a one-shot task reset action.',
        [
            'workflow',
            'set',
            '--task-reset-enabled',
            enabled ? 'true' : 'false',
            '--target-root',
            repoRoot,
            '--operator-confirmed',
            'yes',
            '--operator-confirmed-at-utc',
            new Date().toISOString()
        ],
        { mutates: true }
    );
}

function buildOneShotCommandDisplay(
    action: UiActionDefinition,
    availability: TaskResetAvailability
): string {
    if (availability.enabled) {
        return action.command.display;
    }
    if (availability.configuredEnabled) {
        return `UI one-shot: repair audited task-reset evidence, then run ${action.command.display}`;
    }
    return `UI one-shot: temporarily enable task_reset.enabled, run ${action.command.display}, then restore task_reset.enabled=false`;
}

function actionSucceeded(result: UiActionRunnerResult): boolean {
    return result.timed_out !== true && result.exit_code === 0;
}

function compactOutput(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length <= MAX_STEP_OUTPUT_CHARS) {
        return trimmed;
    }
    return `${trimmed.slice(0, MAX_STEP_OUTPUT_CHARS)}\n[step output truncated]`;
}

function compactStepFailure(label: string, result: UiActionRunnerResult): string {
    const code = result.timed_out === true
        ? `timed out after ${result.timeout_ms ?? 'unknown'} ms`
        : `exit code ${result.exit_code ?? 'unknown'}`;
    const output = compactOutput([result.stderr, result.stdout].filter(Boolean).join('\n'));
    return output ? `${label} failed with ${code}.\n${output}` : `${label} failed with ${code}.`;
}

async function runStep(
    action: UiActionDefinition,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<UiActionRunnerResult> {
    try {
        return normalizeUiActionRunnerResult(action, await options.actionRunner(action, repoRoot));
    } catch (error: unknown) {
        return {
            exit_code: 1,
            signal: null,
            stdout: '',
            stderr: `Failed to launch command: ${error instanceof Error ? error.message : String(error)}`,
            timed_out: false,
            timeout_ms: normalizeUiActionTimeoutMs(action)
        };
    }
}

function buildFinalResult(options: {
    action: UiActionDefinition;
    availability: TaskResetAvailability;
    prepareResult: UiActionRunnerResult | null;
    taskResult: UiActionRunnerResult | null;
    restoreResult: UiActionRunnerResult | null;
}): UiActionRunnerResult {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const failedResults: UiActionRunnerResult[] = [];

    if (!options.availability.enabled && options.availability.configuredEnabled) {
        if (options.prepareResult && actionSucceeded(options.prepareResult)) {
            stdoutLines.push('Audited task-reset evidence repaired.');
        }
    } else if (!options.availability.enabled) {
        if (options.prepareResult && actionSucceeded(options.prepareResult)) {
            stdoutLines.push('Task reset was enabled temporarily.');
        }
    }

    if (options.prepareResult && !actionSucceeded(options.prepareResult)) {
        stderrLines.push(compactStepFailure('Task-reset preparation', options.prepareResult));
        stdoutLines.push(`${taskResetActionLabel(options.action)} did not run.`);
        failedResults.push(options.prepareResult);
    }

    if (options.taskResult) {
        if (actionSucceeded(options.taskResult)) {
            stdoutLines.push(taskResetActionSuccessLine(options.action));
        } else {
            stderrLines.push(compactStepFailure(taskResetActionLabel(options.action), options.taskResult));
            failedResults.push(options.taskResult);
        }
    }

    if (options.restoreResult) {
        if (actionSucceeded(options.restoreResult)) {
            stdoutLines.push('task_reset.enabled was restored to false.');
        } else {
            stderrLines.push(compactStepFailure('task_reset.enabled restore', options.restoreResult));
            failedResults.push(options.restoreResult);
        }
    }

    const firstFailure = failedResults[0] ?? null;
    const timedOut = failedResults.some((result) => result.timed_out === true);
    return {
        exit_code: firstFailure ? firstFailure.exit_code ?? 1 : 0,
        signal: firstFailure ? firstFailure.signal : null,
        stdout: stdoutLines.join('\n'),
        stderr: stderrLines.join('\n'),
        timed_out: timedOut,
        timeout_ms: options.action.timeout_ms
    };
}

async function runTaskResetOneShotAction(
    action: UiActionDefinition,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<UiActionRunnerResult> {
    const availability = resolveTaskResetAvailability(repoRoot);
    const needsPreparation = !availability.enabled;
    const needsRestore = needsPreparation && !availability.configuredEnabled;
    let prepareResult: UiActionRunnerResult | null = null;
    let taskResult: UiActionRunnerResult | null = null;
    let restoreResult: UiActionRunnerResult | null = null;

    if (needsPreparation) {
        prepareResult = await runStep(buildTaskResetSetAction(repoRoot, true, 'task-reset-one-shot-prepare'), repoRoot, options);
    }
    if (!prepareResult || actionSucceeded(prepareResult)) {
        taskResult = await runStep(action, repoRoot, options);
    }
    if (needsRestore && prepareResult && actionSucceeded(prepareResult)) {
        restoreResult = await runStep(buildTaskResetSetAction(repoRoot, false, 'task-reset-one-shot-restore'), repoRoot, options);
    }

    return buildFinalResult({
        action,
        availability,
        prepareResult,
        taskResult,
        restoreResult
    });
}

export async function processTaskResetOneShotActionRequest(
    response: http.ServerResponse,
    repoRoot: string,
    taskId: string,
    payload: UiActionRequest,
    action: UiActionDefinition,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    const mode = resolveUiActionMode(payload);
    const availability = resolveTaskResetAvailability(repoRoot);
    const command = buildOneShotCommandDisplay(action, availability);
    const auditActionId = `${taskId}:${action.id}`;

    if (mode === 'preview') {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: auditActionId,
            mode,
            status: 'previewed',
            command
        });
        sendJson(response, 200, {
            action_id: action.id,
            mode,
            status: 'previewed',
            command,
            requires_confirmation: action.requires_confirmation,
            confirmation_phrase: action.confirmation_phrase,
            audit_path: auditPath,
            task_id: taskId
        });
        return;
    }

    if (action.requires_confirmation && payload.confirmation !== action.confirmation_phrase) {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: auditActionId,
            mode,
            status: 'confirmation_required',
            command
        });
        sendJson(response, 409, {
            action_id: action.id,
            mode,
            status: 'confirmation_required',
            command,
            requires_confirmation: true,
            confirmation_phrase: action.confirmation_phrase,
            audit_path: auditPath,
            task_id: taskId
        });
        return;
    }

    const result = await runTaskResetOneShotAction(action, repoRoot, options);
    const auditPath = appendUiActionAudit(repoRoot, {
        timestamp_utc: new Date().toISOString(),
        action_id: auditActionId,
        mode,
        status: 'executed',
        command,
        ...uiActionExecutionAuditFields(result)
    });
    sendJson(response, uiActionHttpStatus(result), {
        action_id: action.id,
        mode,
        status: 'executed',
        command,
        ...uiActionExecutionPayload(result),
        audit_path: auditPath,
        task_id: taskId
    });
}

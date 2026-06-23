import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as path from 'node:path';

import { assertCanonicalTaskId } from '../../../core/task-ids';
import { validateManagedConfigByName } from '../../../schemas/config-artifacts';
import {
    readRuntimeRetentionPolicyDocument,
    resolveRuntimeRetentionPolicyConfigPath,
    type RuntimeRetentionPolicyDocument
} from '../../../lifecycle/runtime-retention-policy';
import {
    UI_ACTION_CLEANUP_TIMEOUT_MS,
    appendUiActionAudit,
    buildUiActionCommand,
    normalizeUiActionRunnerResult,
    quoteCommandPart,
    resolveBundleRoot,
    uiActionExecutionAuditFields,
    uiActionExecutionPayload,
    uiActionHttpStatus
} from './action-common';
import type { UiActionDefinition, UiActionMode } from './types';
import {
    isValidActionRequestBoundary,
    readJsonBody,
    resolveUiActionMode,
    sendApiError,
    sendJson,
    type LocalUiServerRuntimeOptions
} from './http/action-http-common';

const CLEANUP_SETTINGS_CONFIRMATION = 'SAVE CLEANUP SETTINGS';
const CLEANUP_APPLY_CONFIRMATION = 'RUN GARDA CLEANUP';
const TASK_PURGE_CONFIRMATION = 'PURGE TASK RUNTIME';

interface CleanupSettingsRequest {
    mode?: unknown;
    settings?: unknown;
    confirmation?: unknown;
}

interface CleanupRunRequest {
    mode?: unknown;
    eligible_older_than_days?: unknown;
    keep_latest_tasks?: unknown;
    include_problematic_tasks?: unknown;
    confirmation?: unknown;
}

interface CleanupTaskPurgeRequest {
    mode?: unknown;
    task_id?: unknown;
    confirmation?: unknown;
}

function parseNonNegativeInteger(value: unknown, label: string): number {
    if (typeof value !== 'string' && typeof value !== 'number') {
        throw new Error(`${label} must be a non-negative integer.`);
    }
    const normalized = String(value).trim();
    if (!/^\d+$/u.test(normalized)) {
        throw new Error(`${label} must be a non-negative integer.`);
    }
    return Number.parseInt(normalized, 10);
}

function parseBoolean(value: unknown, label: string): boolean {
    if (value === true || value === false) {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }
    throw new Error(`${label} must be true or false.`);
}

function readRuntimeRetentionDocument(repoRoot: string): {
    bundleRoot: string;
    configPath: string;
    document: RuntimeRetentionPolicyDocument;
} {
    const bundleRoot = resolveBundleRoot(repoRoot);
    const configPath = resolveRuntimeRetentionPolicyConfigPath(bundleRoot);
    return {
        bundleRoot,
        configPath,
        document: readRuntimeRetentionPolicyDocument(bundleRoot)
    };
}

function writeRuntimeRetentionDocument(configPath: string, document: RuntimeRetentionPolicyDocument): RuntimeRetentionPolicyDocument {
    const normalized = validateManagedConfigByName('runtime-retention', document) as RuntimeRetentionPolicyDocument;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return normalized;
}

function displayPath(repoRoot: string, targetPath: string): string {
    return path.relative(repoRoot, targetPath).replace(/\\/gu, '/') || targetPath;
}

function buildSettingsUpdateCommand(repoRoot: string, configPath: string, changedKeys: string[]): string {
    const pathGroups = new Set<string>();
    for (const key of changedKeys) {
        if (key.startsWith('daily_maintenance_')) {
            pathGroups.add('daily_maintenance.{enabled,max_tasks_per_run,eligible_older_than_days,keep_latest_tasks,dry_run}');
        } else if (key === 'purge_require_confirm') {
            pathGroups.add('purge.require_confirm');
        } else if (key === 'healthy_done_compact_after_days') {
            pathGroups.add('healthy_done.compact_after_days');
        } else if (key === 'problem_tasks_compress_after_days') {
            pathGroups.add('problem_tasks.compress_after_days');
        }
    }
    const paths = [...pathGroups];
    return [
        'update',
        quoteCommandPart(displayPath(repoRoot, configPath)),
        paths.length > 0 ? paths.join(',') : 'runtime-retention'
    ].join(' ');
}

function applyCleanupSettingsPatch(
    document: RuntimeRetentionPolicyDocument,
    rawSettings: Record<string, unknown>
): RuntimeRetentionPolicyDocument {
    const nextDocument = JSON.parse(JSON.stringify(document)) as RuntimeRetentionPolicyDocument;
    if (rawSettings.daily_maintenance_enabled !== undefined) {
        nextDocument.daily_maintenance.enabled = parseBoolean(rawSettings.daily_maintenance_enabled, 'daily_maintenance_enabled');
    }
    if (rawSettings.daily_maintenance_max_tasks_per_run !== undefined) {
        nextDocument.daily_maintenance.max_tasks_per_run = parseNonNegativeInteger(
            rawSettings.daily_maintenance_max_tasks_per_run,
            'daily_maintenance_max_tasks_per_run'
        );
    }
    if (rawSettings.eligible_older_than_days !== undefined) {
        nextDocument.daily_maintenance.eligible_older_than_days = parseNonNegativeInteger(
            rawSettings.eligible_older_than_days,
            'eligible_older_than_days'
        );
    }
    if (rawSettings.keep_latest_tasks !== undefined) {
        nextDocument.daily_maintenance.keep_latest_tasks = parseNonNegativeInteger(
            rawSettings.keep_latest_tasks,
            'keep_latest_tasks'
        );
    }
    if (rawSettings.daily_maintenance_dry_run !== undefined) {
        nextDocument.daily_maintenance.dry_run = parseBoolean(rawSettings.daily_maintenance_dry_run, 'daily_maintenance_dry_run');
    }
    if (rawSettings.purge_require_confirm !== undefined) {
        nextDocument.purge.require_confirm = parseBoolean(rawSettings.purge_require_confirm, 'purge_require_confirm');
    }
    if (rawSettings.healthy_done_compact_after_days !== undefined) {
        nextDocument.healthy_done.compact_after_days = parseNonNegativeInteger(
            rawSettings.healthy_done_compact_after_days,
            'healthy_done_compact_after_days'
        );
    }
    if (rawSettings.problem_tasks_compress_after_days !== undefined) {
        nextDocument.problem_tasks.compress_after_days = parseNonNegativeInteger(
            rawSettings.problem_tasks_compress_after_days,
            'problem_tasks_compress_after_days'
        );
    }
    return validateManagedConfigByName('runtime-retention', nextDocument) as RuntimeRetentionPolicyDocument;
}

function buildCleanupCommand(repoRoot: string, request: CleanupRunRequest, execute: boolean): ReturnType<typeof buildUiActionCommand> {
    const args = ['cleanup', 'batch-task-purge', '--target-root', repoRoot];
    if (!execute) {
        args.push('--dry-run');
    } else {
        args.push('--confirm');
    }
    const olderThanDays = request.eligible_older_than_days;
    const keepLatestTasks = request.keep_latest_tasks;
    if (olderThanDays !== undefined && String(olderThanDays).trim() !== '') {
        args.push('--runtime-retention-older-than-days', String(parseNonNegativeInteger(olderThanDays, 'eligible_older_than_days')));
    }
    if (keepLatestTasks !== undefined && String(keepLatestTasks).trim() !== '') {
        args.push('--runtime-retention-keep-latest-tasks', String(parseNonNegativeInteger(keepLatestTasks, 'keep_latest_tasks')));
    }
    if (request.include_problematic_tasks !== undefined
        && parseBoolean(request.include_problematic_tasks, 'include_problematic_tasks')) {
        args.push('--include-problematic-tasks');
    }
    return buildUiActionCommand(repoRoot, args);
}

function buildTaskPurgeCommand(repoRoot: string, taskId: string, execute: boolean): ReturnType<typeof buildUiActionCommand> {
    const args = ['cleanup', 'task-purge', '--target-root', repoRoot, '--task-id', taskId];
    if (execute) {
        args.push('--confirm');
    }
    return buildUiActionCommand(repoRoot, args);
}

function assertActionBoundary(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    options: LocalUiServerRuntimeOptions
): boolean {
    if (!options.actionsEnabled) {
        sendApiError(response, 403, 'UI cleanup actions are disabled. Restart with --actions to enable guarded cleanup controls.', 'actions_disabled');
        return false;
    }
    if (!isValidActionRequestBoundary(request, options)) {
        sendApiError(response, 403, 'UI cleanup request failed origin, token, or content-type validation.', 'action_boundary_rejected');
        return false;
    }
    return true;
}

export function buildUiCleanupSettingsPayload(repoRoot: string, actionsEnabled: boolean): Record<string, unknown> {
    const { configPath, document } = readRuntimeRetentionDocument(repoRoot);
    return {
        enabled: actionsEnabled,
        confirmation_phrase: CLEANUP_SETTINGS_CONFIRMATION,
        cleanup_confirmation_phrase: CLEANUP_APPLY_CONFIRMATION,
        task_purge_confirmation_phrase: TASK_PURGE_CONFIRMATION,
        config_path: configPath,
        policy: document,
        settings: {
            daily_maintenance_enabled: Boolean(document.daily_maintenance.enabled),
            daily_maintenance_max_tasks_per_run: Number(document.daily_maintenance.max_tasks_per_run),
            eligible_older_than_days: Number(document.daily_maintenance.eligible_older_than_days),
            keep_latest_tasks: Number(document.daily_maintenance.keep_latest_tasks),
            include_problematic_tasks: false,
            daily_maintenance_dry_run: Boolean(document.daily_maintenance.dry_run),
            purge_require_confirm: Boolean(document.purge.require_confirm),
            healthy_done_compact_after_days: Number(document.healthy_done.compact_after_days),
            problem_tasks_compress_after_days: Number(document.problem_tasks.compress_after_days)
        },
        commands: {
            cleanup_preview: buildCleanupCommand(repoRoot, {}, false).display,
            cleanup_apply: buildCleanupCommand(repoRoot, {}, true).display
        }
    };
}

export async function handleUiCleanupSettingsRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    if (!assertActionBoundary(request, response, options)) {
        return;
    }
    const payload = await readJsonBody(request) as CleanupSettingsRequest;
    const mode = resolveUiActionMode(payload);
    const { configPath, document } = readRuntimeRetentionDocument(repoRoot);
    const rawSettings = payload.settings && typeof payload.settings === 'object'
        ? payload.settings as Record<string, unknown>
        : {};
    if (Object.keys(rawSettings).length === 0) {
        sendApiError(response, 400, 'Cleanup settings request must include at least one setting field.', 'cleanup_settings_empty');
        return;
    }
    const normalized = applyCleanupSettingsPatch(document, rawSettings);
    const command = buildSettingsUpdateCommand(repoRoot, configPath, Object.keys(rawSettings));

    if (mode === 'preview') {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: 'cleanup-settings',
            mode,
            status: 'previewed',
            command
        });
        sendJson(response, 200, {
            action_id: 'cleanup-settings',
            mode,
            status: 'previewed',
            command,
            config_path: configPath,
            proposed_settings: {
                daily_maintenance: normalized.daily_maintenance,
                purge: normalized.purge,
                healthy_done: normalized.healthy_done,
                problem_tasks: normalized.problem_tasks
            },
            requires_confirmation: true,
            confirmation_phrase: CLEANUP_SETTINGS_CONFIRMATION,
            audit_path: auditPath
        });
        return;
    }

    if (payload.confirmation !== CLEANUP_SETTINGS_CONFIRMATION) {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: 'cleanup-settings',
            mode,
            status: 'confirmation_required',
            command
        });
        sendJson(response, 409, {
            action_id: 'cleanup-settings',
            mode,
            status: 'confirmation_required',
            command,
            requires_confirmation: true,
            confirmation_phrase: CLEANUP_SETTINGS_CONFIRMATION,
            audit_path: auditPath
        });
        return;
    }

    const savedDocument = writeRuntimeRetentionDocument(configPath, normalized);
    const auditPath = appendUiActionAudit(repoRoot, {
        timestamp_utc: new Date().toISOString(),
        action_id: 'cleanup-settings',
        mode,
        status: 'executed',
        command
    });
    sendJson(response, 200, {
        action_id: 'cleanup-settings',
        mode,
        status: 'executed',
        command,
        config_path: configPath,
        saved_settings: {
            daily_maintenance: savedDocument.daily_maintenance,
            purge: savedDocument.purge,
            healthy_done: savedDocument.healthy_done,
            problem_tasks: savedDocument.problem_tasks
        },
        audit_path: auditPath
    });
}

export async function handleUiCleanupRunRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    if (!assertActionBoundary(request, response, options)) {
        return;
    }
    const payload = await readJsonBody(request) as CleanupRunRequest;
    const mode = resolveUiActionMode(payload);
    const command = buildCleanupCommand(repoRoot, payload, mode === 'execute');
    const action: UiActionDefinition = {
        id: mode === 'execute' ? 'cleanup-apply-custom' : 'cleanup-preview-custom',
        category: 'Maintenance',
        label: mode === 'execute' ? 'Apply Runtime Cleanup' : 'Preview Runtime Cleanup',
        description: 'Purge old task-owned runtime artifacts selected by UI-provided age and keep-latest bounds.',
        mutates: mode === 'execute',
        enabled: true,
        unavailable_reason: null,
        requires_confirmation: mode === 'execute',
        confirmation_phrase: mode === 'execute' ? CLEANUP_APPLY_CONFIRMATION : null,
        timeout_ms: UI_ACTION_CLEANUP_TIMEOUT_MS,
        command
    };

    if (mode === 'preview') {
        const result = normalizeUiActionRunnerResult(action, await options.actionRunner(action, repoRoot));
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: 'cleanup-preview-custom',
            mode,
            status: 'previewed',
            command: command.display,
            ...uiActionExecutionAuditFields(result)
        });
        sendJson(response, uiActionHttpStatus(result), {
            action_id: action.id,
            mode,
            status: 'previewed',
            command: command.display,
            ...uiActionExecutionPayload(result),
            audit_path: auditPath
        });
        return;
    }

    if (payload.confirmation !== CLEANUP_APPLY_CONFIRMATION) {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: 'cleanup-apply-custom',
            mode,
            status: 'confirmation_required',
            command: command.display
        });
        sendJson(response, 409, {
            action_id: action.id,
            mode,
            status: 'confirmation_required',
            command: command.display,
            requires_confirmation: true,
            confirmation_phrase: CLEANUP_APPLY_CONFIRMATION,
            audit_path: auditPath
        });
        return;
    }

    const result = normalizeUiActionRunnerResult(action, await options.actionRunner(action, repoRoot));
    const auditPath = appendUiActionAudit(repoRoot, {
        timestamp_utc: new Date().toISOString(),
        action_id: 'cleanup-apply-custom',
        mode,
        status: 'executed',
        command: command.display,
        ...uiActionExecutionAuditFields(result)
    });
    sendJson(response, uiActionHttpStatus(result), {
        action_id: action.id,
        mode,
        status: 'executed',
        command: command.display,
        ...uiActionExecutionPayload(result),
        audit_path: auditPath
    });
}

export async function handleUiCleanupTaskPurgeRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    if (!assertActionBoundary(request, response, options)) {
        return;
    }
    const payload = await readJsonBody(request) as CleanupTaskPurgeRequest;
    const mode: UiActionMode = resolveUiActionMode(payload);
    const taskId = assertCanonicalTaskId(payload.task_id);
    const command = buildTaskPurgeCommand(repoRoot, taskId, mode === 'execute');

    if (mode === 'preview') {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: 'cleanup-task-purge',
            mode,
            status: 'previewed',
            command: command.display
        });
        sendJson(response, 200, {
            action_id: 'cleanup-task-purge',
            mode,
            status: 'previewed',
            command: command.display,
            audit_path: auditPath
        });
        return;
    }

    if (payload.confirmation !== TASK_PURGE_CONFIRMATION) {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: 'cleanup-task-purge',
            mode,
            status: 'confirmation_required',
            command: command.display
        });
        sendJson(response, 409, {
            action_id: 'cleanup-task-purge',
            mode,
            status: 'confirmation_required',
            command: command.display,
            requires_confirmation: true,
            confirmation_phrase: TASK_PURGE_CONFIRMATION,
            audit_path: auditPath
        });
        return;
    }

    const action: UiActionDefinition = {
        id: 'cleanup-task-purge',
        category: 'Maintenance',
        label: 'Purge Task Runtime',
        description: 'Purge runtime artifacts owned by one task id.',
        mutates: true,
        enabled: true,
        unavailable_reason: null,
        requires_confirmation: true,
        confirmation_phrase: TASK_PURGE_CONFIRMATION,
        timeout_ms: UI_ACTION_CLEANUP_TIMEOUT_MS,
        command
    };
    const result = normalizeUiActionRunnerResult(action, await options.actionRunner(action, repoRoot));
    const auditPath = appendUiActionAudit(repoRoot, {
        timestamp_utc: new Date().toISOString(),
        action_id: 'cleanup-task-purge',
        mode,
        status: 'executed',
        command: command.display,
        ...uiActionExecutionAuditFields(result)
    });
    sendJson(response, uiActionHttpStatus(result), {
        action_id: 'cleanup-task-purge',
        mode,
        status: 'executed',
        command: command.display,
        task_id: taskId,
        ...uiActionExecutionPayload(result),
        audit_path: auditPath
    });
}

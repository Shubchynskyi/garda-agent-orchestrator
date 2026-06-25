import type * as http from 'node:http';
import {
    appendUiActionAudit,
    normalizeUiActionRunnerResult,
    uiActionExecutionAuditFields,
    uiActionExecutionPayload,
    uiActionHttpStatus
} from '../action-common';
import {
    buildUiOptionalCheckRuleAction,
    buildUiSettingAction,
    buildUiSettingDefinitions,
    findSetting,
    parseUiOptionalCheckRuleValue,
    parseUiSettingValue
} from '../workflow-setting-actions';
import type { ParsedUiOptionalCheckRuleValue, ParsedUiSettingValue, UiActionDefinition, UiSettingDefinition } from '../types';
import {
    isValidActionRequestBoundary,
    readJsonBody,
    sendApiError,
    sendJson,
    type LocalUiServerRuntimeOptions
} from './action-http-common';

interface UiSettingRequest {
    setting_id?: unknown;
    value?: unknown;
    mode?: unknown;
    confirmation?: unknown;
    optional_rule_action?: unknown;
    rule_id?: unknown;
    title?: unknown;
    prompt?: unknown;
    enabled?: unknown;
}

function normalizeSettingRequest(payload: unknown): UiSettingRequest {
    return payload && typeof payload === 'object' ? payload as UiSettingRequest : {};
}

function buildSettingResponsePayload(
    setting: UiSettingDefinition,
    value: ParsedUiSettingValue,
    mode: 'preview' | 'execute',
    status: string,
    command: string,
    extras: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        setting_id: setting.id,
        label: setting.label,
        key: setting.key,
        mode,
        status,
        current_value: setting.current_value,
        proposed_value: value.proposed_value,
        changed_keys: [setting.key],
        command,
        ...extras
    };
}

function buildOptionalRuleResponsePayload(
    value: ParsedUiOptionalCheckRuleValue,
    mode: 'preview' | 'execute',
    status: string,
    command: string,
    extras: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        setting_id: 'optional-check-rule-management',
        label: value.action === 'delete' ? 'Remove optional quality-check rule' : 'Save optional quality-check rule',
        key: 'optional_quality_checks.rules',
        mode,
        status,
        current_value: null,
        proposed_value: value.proposed_value,
        changed_keys: ['optional_quality_checks.rules'],
        command,
        ...extras
    };
}

async function handleUiOptionalRuleRequest(
    response: http.ServerResponse,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions,
    payload: UiSettingRequest
): Promise<void> {
    let value: ParsedUiOptionalCheckRuleValue;
    try {
        value = parseUiOptionalCheckRuleValue(payload);
    } catch (error) {
        sendApiError(response, 400, error instanceof Error ? error.message : String(error), 'invalid_setting_value');
        return;
    }
    const mode = payload.mode === 'execute' ? 'execute' : 'preview';
    const timestampUtc = new Date().toISOString();
    const action: UiActionDefinition = buildUiOptionalCheckRuleAction(repoRoot, value, timestampUtc);
    if (mode === 'preview') {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: timestampUtc,
            action_id: action.id,
            mode,
            status: 'previewed',
            command: action.command.display
        });
        sendJson(response, 200, buildOptionalRuleResponsePayload(value, mode, 'previewed', action.command.display, {
            requires_confirmation: true,
            confirmation_phrase: action.confirmation_phrase,
            audit_path: auditPath
        }));
        return;
    }
    if (payload.confirmation !== action.confirmation_phrase) {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: timestampUtc,
            action_id: action.id,
            mode,
            status: 'confirmation_required',
            command: action.command.display
        });
        sendJson(response, 409, buildOptionalRuleResponsePayload(value, mode, 'confirmation_required', action.command.display, {
            requires_confirmation: true,
            confirmation_phrase: action.confirmation_phrase,
            audit_path: auditPath
        }));
        return;
    }
    try {
        const result = normalizeUiActionRunnerResult(action, await options.actionRunner(action, repoRoot));
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: timestampUtc,
            action_id: action.id,
            mode,
            status: 'executed',
            command: action.command.display,
            ...uiActionExecutionAuditFields(result)
        });
        sendJson(response, uiActionHttpStatus(result), buildOptionalRuleResponsePayload(value, mode, 'executed', action.command.display, {
            ...uiActionExecutionPayload(result),
            audit_path: auditPath
        }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: timestampUtc,
            action_id: action.id,
            mode,
            status: 'failed_to_launch',
            command: action.command.display,
            error: message
        });
        sendJson(response, 500, buildOptionalRuleResponsePayload(value, mode, 'failed_to_launch', action.command.display, {
            error: message,
            audit_path: auditPath
        }));
    }
}

export async function handleUiWorkflowSettingRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    if (!options.actionsEnabled) {
        sendApiError(response, 403, 'UI setting edits are disabled. Restart with --actions to enable guarded workflow commands.', 'settings_disabled');
        return;
    }
    if (!isValidActionRequestBoundary(request, options)) {
        sendApiError(response, 403, 'UI setting request failed origin, token, or content-type validation.', 'action_boundary_rejected');
        return;
    }
    const payload = normalizeSettingRequest(await readJsonBody(request));
    if (payload.optional_rule_action === 'upsert' || payload.optional_rule_action === 'delete') {
        await handleUiOptionalRuleRequest(response, repoRoot, options, payload);
        return;
    }
    const settings = buildUiSettingDefinitions(repoRoot);
    const setting = findSetting(settings, payload.setting_id);
    if (!setting) {
        sendApiError(response, 400, 'Unknown editable setting.', 'unknown_setting');
        return;
    }
    let value: ReturnType<typeof parseUiSettingValue>;
    try {
        value = parseUiSettingValue(setting, payload.value);
    } catch (error) {
        sendApiError(response, 400, error instanceof Error ? error.message : String(error), 'invalid_setting_value');
        return;
    }
    const mode = payload.mode === 'execute' ? 'execute' : 'preview';
    const timestampUtc = new Date().toISOString();
    const action = buildUiSettingAction(repoRoot, setting, value.command_value, timestampUtc);
    if (mode === 'preview') {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: timestampUtc,
            action_id: action.id,
            mode,
            status: 'previewed',
            command: action.command.display
        });
        sendJson(response, 200, buildSettingResponsePayload(setting, value, mode, 'previewed', action.command.display, {
            requires_confirmation: true,
            confirmation_phrase: setting.confirmation_phrase,
            audit_path: auditPath
        }));
        return;
    }
    if (payload.confirmation !== setting.confirmation_phrase) {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: timestampUtc,
            action_id: action.id,
            mode,
            status: 'confirmation_required',
            command: action.command.display
        });
        sendJson(response, 409, buildSettingResponsePayload(setting, value, mode, 'confirmation_required', action.command.display, {
            requires_confirmation: true,
            confirmation_phrase: setting.confirmation_phrase,
            audit_path: auditPath
        }));
        return;
    }
    try {
        const result = normalizeUiActionRunnerResult(action, await options.actionRunner(action, repoRoot));
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: timestampUtc,
            action_id: action.id,
            mode,
            status: 'executed',
            command: action.command.display,
            ...uiActionExecutionAuditFields(result)
        });
        sendJson(response, uiActionHttpStatus(result), buildSettingResponsePayload(setting, value, mode, 'executed', action.command.display, {
            ...uiActionExecutionPayload(result),
            audit_path: auditPath
        }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: timestampUtc,
            action_id: action.id,
            mode,
            status: 'failed_to_launch',
            command: action.command.display,
            error: message
        });
        sendJson(response, 500, buildSettingResponsePayload(setting, value, mode, 'failed_to_launch', action.command.display, {
            error: message,
            audit_path: auditPath
        }));
    }
}

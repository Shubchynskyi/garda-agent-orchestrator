import * as http from 'node:http';
import {
    appendUiActionAudit,
    buildUiActionDefinitions,
    buildUiSettingAction,
    buildUiSettingDefinitions,
    findAction,
    findSetting,
    formatPublicAction,
    parseUiSettingValue,
    type UiActionRunner
} from './ui-action-registry';

interface UiActionRequest {
    action_id?: unknown;
    mode?: unknown;
    confirmation?: unknown;
}

interface UiSettingRequest {
    setting_id?: unknown;
    value?: unknown;
    mode?: unknown;
    confirmation?: unknown;
}

export interface LocalUiServerRuntimeOptions {
    actionsEnabled: boolean;
    actionRunner: UiActionRunner;
    actionToken: string;
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
    response.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
    });
    response.end(JSON.stringify(payload, null, 2));
}

export function sendApiError(response: http.ServerResponse, statusCode: number, error: string, code: string): void {
    sendJson(response, statusCode, { error, code });
}

function readJsonBody(request: http.IncomingMessage, maxBytes = 8192): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let raw = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > maxBytes) {
                reject(new Error('Request body is too large.'));
                request.destroy();
            }
        });
        request.on('error', reject);
        request.on('end', () => {
            if (raw.trim() === '') {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new Error('Request body must be valid JSON.'));
            }
        });
    });
}

function isJsonRequest(request: http.IncomingMessage): boolean {
    const contentType = request.headers['content-type'];
    const value = Array.isArray(contentType) ? contentType[0] : contentType;
    return typeof value === 'string' && value.toLowerCase().split(';', 1)[0].trim() === 'application/json';
}

function getRequestOrigin(request: http.IncomingMessage): string | null {
    const origin = request.headers.origin;
    if (Array.isArray(origin)) {
        return origin[0] || null;
    }
    return typeof origin === 'string' && origin ? origin : null;
}

function getExpectedOrigin(request: http.IncomingMessage): string | null {
    const host = request.headers.host;
    if (Array.isArray(host) || typeof host !== 'string' || !host) {
        return null;
    }
    return `http://${host}`;
}

function isValidActionRequestBoundary(request: http.IncomingMessage, actionToken: string): boolean {
    const expectedOrigin = getExpectedOrigin(request);
    const actualOrigin = getRequestOrigin(request);
    const token = request.headers['x-garda-action-token'];
    return expectedOrigin !== null
        && actualOrigin === expectedOrigin
        && token === actionToken
        && isJsonRequest(request);
}

function normalizeActionRequest(payload: unknown): UiActionRequest {
    return payload && typeof payload === 'object' ? payload as UiActionRequest : {};
}

function normalizeSettingRequest(payload: unknown): UiSettingRequest {
    return payload && typeof payload === 'object' ? payload as UiSettingRequest : {};
}

export function buildUiActionsPayload(repoRoot: string, actionsEnabled: boolean): Record<string, unknown> {
    const actions = actionsEnabled
        ? buildUiActionDefinitions(repoRoot).map(formatPublicAction)
        : [];
    return {
        enabled: actionsEnabled,
        actions
    };
}

export function buildUiSettingsPayload(repoRoot: string, actionsEnabled: boolean): Record<string, unknown> {
    return {
        enabled: actionsEnabled,
        settings: buildUiSettingDefinitions(repoRoot)
    };
}

export async function handleUiActionRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    if (!options.actionsEnabled) {
        sendApiError(response, 403, 'UI actions are disabled. Restart with --actions to enable allow-listed commands.', 'actions_disabled');
        return;
    }
    if (!isValidActionRequestBoundary(request, options.actionToken)) {
        sendApiError(response, 403, 'UI action request failed origin, token, or content-type validation.', 'action_boundary_rejected');
        return;
    }
    const payload = normalizeActionRequest(await readJsonBody(request));
    const actions = buildUiActionDefinitions(repoRoot);
    const action = findAction(actions, payload.action_id);
    if (!action) {
        sendApiError(response, 400, 'Unknown UI action.', 'unknown_action');
        return;
    }
    const mode = payload.mode === 'execute' ? 'execute' : 'preview';
    if (mode === 'preview') {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: action.id,
            mode,
            status: 'previewed',
            command: action.command.display
        });
        sendJson(response, 200, {
            action_id: action.id,
            mode,
            status: 'previewed',
            command: action.command.display,
            requires_confirmation: action.requires_confirmation,
            confirmation_phrase: action.confirmation_phrase,
            audit_path: auditPath
        });
        return;
    }
    if (action.requires_confirmation && payload.confirmation !== action.confirmation_phrase) {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: action.id,
            mode,
            status: 'confirmation_required',
            command: action.command.display
        });
        sendJson(response, 409, {
            action_id: action.id,
            mode,
            status: 'confirmation_required',
            command: action.command.display,
            requires_confirmation: true,
            confirmation_phrase: action.confirmation_phrase,
            audit_path: auditPath
        });
        return;
    }
    try {
        const result = await options.actionRunner(action, repoRoot);
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: action.id,
            mode,
            status: 'executed',
            command: action.command.display,
            exit_code: result.exit_code,
            signal: result.signal
        });
        sendJson(response, result.exit_code === 0 ? 200 : 500, {
            action_id: action.id,
            mode,
            status: 'executed',
            command: action.command.display,
            exit_code: result.exit_code,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
            audit_path: auditPath
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: new Date().toISOString(),
            action_id: action.id,
            mode,
            status: 'failed_to_launch',
            command: action.command.display,
            error: message
        });
        sendJson(response, 500, {
            action_id: action.id,
            mode,
            status: 'failed_to_launch',
            command: action.command.display,
            error: message,
            audit_path: auditPath
        });
    }
}

export async function handleUiSettingRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    if (!options.actionsEnabled) {
        sendApiError(response, 403, 'UI setting edits are disabled. Restart with --actions to enable guarded workflow commands.', 'settings_disabled');
        return;
    }
    if (!isValidActionRequestBoundary(request, options.actionToken)) {
        sendApiError(response, 403, 'UI setting request failed origin, token, or content-type validation.', 'action_boundary_rejected');
        return;
    }
    const payload = normalizeSettingRequest(await readJsonBody(request));
    const settings = buildUiSettingDefinitions(repoRoot);
    const setting = findSetting(settings, payload.setting_id);
    if (!setting) {
        sendApiError(response, 400, 'Unknown editable setting.', 'unknown_setting');
        return;
    }
    let value: number;
    try {
        value = parseUiSettingValue(setting, payload.value);
    } catch (error) {
        sendApiError(response, 400, error instanceof Error ? error.message : String(error), 'invalid_setting_value');
        return;
    }
    const mode = payload.mode === 'execute' ? 'execute' : 'preview';
    const timestampUtc = new Date().toISOString();
    const action = buildUiSettingAction(repoRoot, setting, value, timestampUtc);
    if (mode === 'preview') {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: timestampUtc,
            action_id: action.id,
            mode,
            status: 'previewed',
            command: action.command.display
        });
        sendJson(response, 200, {
            setting_id: setting.id,
            key: setting.key,
            mode,
            status: 'previewed',
            current_value: setting.current_value,
            proposed_value: value,
            changed_keys: [setting.key],
            command: action.command.display,
            requires_confirmation: true,
            confirmation_phrase: setting.confirmation_phrase,
            audit_path: auditPath
        });
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
        sendJson(response, 409, {
            setting_id: setting.id,
            key: setting.key,
            mode,
            status: 'confirmation_required',
            current_value: setting.current_value,
            proposed_value: value,
            changed_keys: [setting.key],
            command: action.command.display,
            requires_confirmation: true,
            confirmation_phrase: setting.confirmation_phrase,
            audit_path: auditPath
        });
        return;
    }
    try {
        const result = await options.actionRunner(action, repoRoot);
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: timestampUtc,
            action_id: action.id,
            mode,
            status: 'executed',
            command: action.command.display,
            exit_code: result.exit_code,
            signal: result.signal
        });
        sendJson(response, result.exit_code === 0 ? 200 : 500, {
            setting_id: setting.id,
            key: setting.key,
            mode,
            status: 'executed',
            current_value: setting.current_value,
            proposed_value: value,
            changed_keys: [setting.key],
            command: action.command.display,
            exit_code: result.exit_code,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
            audit_path: auditPath
        });
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
        sendJson(response, 500, {
            setting_id: setting.id,
            key: setting.key,
            mode,
            status: 'failed_to_launch',
            command: action.command.display,
            error: message,
            audit_path: auditPath
        });
    }
}

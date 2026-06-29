import type * as http from 'node:http';
import * as path from 'node:path';
import { buildQualityGateTab, buildWorkflowConfigTab } from '../report-data-contract';
import { joinOrchestratorPath } from '../../gates/shared/helpers';
import {
    buildUiSettingDefinitions,
    buildUiWorkspaceAndBackupActionDefinitions,
    buildUiCleanupSettingsPayload,
    detectUiSwitchModeState,
    formatPublicAction
} from './actions/registry';
import {
    buildUiProfilesPayload,
    handleUiProfileRequest
} from './actions/profile-actions';
import {
    handleUiCleanupRunRequest,
    handleUiCleanupSettingsRequest,
    handleUiCleanupTaskPurgeRequest
} from './actions/cleanup-settings-actions';
import { handleUiTaskActionRequest as executeUiTaskActionRequest } from './actions/http/task-action-http';
import { handleUiWorkspaceActionRequest } from './actions/http/workspace-action-http';
import { handleUiWorkflowSettingRequest } from './actions/http/workflow-setting-action-http';
import type { LocalUiServerRuntimeOptions } from './actions/http/action-http-common';

export type { LocalUiServerRuntimeOptions };

export { sendApiError } from './actions/http/action-http-common';

export function buildUiActionsPayload(repoRoot: string, actionsEnabled: boolean): Record<string, unknown> {
    const actions = actionsEnabled
        ? buildUiWorkspaceAndBackupActionDefinitions(repoRoot).map(formatPublicAction)
        : [];
    return {
        enabled: actionsEnabled,
        switch_state: detectUiSwitchModeState(repoRoot),
        actions
    };
}

export function buildUiSettingsPayload(repoRoot: string, actionsEnabled: boolean): Record<string, unknown> {
    const workflowConfigTab = buildWorkflowConfigTab(repoRoot);
    const qualityGateTab = buildQualityGateTab({
        repoRoot,
        reviewsRoot: joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews')),
        eventsRoot: joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events')),
        workflowConfigTab
    });
    return {
        enabled: actionsEnabled,
        settings: buildUiSettingDefinitions(repoRoot),
        optional_quality_checks: workflowConfigTab.optional_quality_checks,
        optional_skill_selection_policy: workflowConfigTab.optional_skill_selection_policy,
        quality_gate: qualityGateTab
    };
}

export function buildUiCleanupPayload(repoRoot: string, actionsEnabled: boolean): Record<string, unknown> {
    return buildUiCleanupSettingsPayload(repoRoot, actionsEnabled);
}

export function buildUiProfilePayload(repoRoot: string, actionsEnabled: boolean): Record<string, unknown> {
    return buildUiProfilesPayload(repoRoot, actionsEnabled);
}

export async function handleUiActionRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    return handleUiWorkspaceActionRequest(request, response, repoRoot, options);
}

export async function handleUiTaskActionRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    repoRoot: string,
    taskId: string,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    return executeUiTaskActionRequest(request, response, repoRoot, taskId, options);
}

export async function handleUiSettingRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    return handleUiWorkflowSettingRequest(request, response, repoRoot, options);
}

export async function handleUiProfilesPostRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    return handleUiProfileRequest(request, response, repoRoot, options);
}

export async function handleUiCleanupSettingsPostRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    return handleUiCleanupSettingsRequest(request, response, repoRoot, options);
}

export async function handleUiCleanupRunPostRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    return handleUiCleanupRunRequest(request, response, repoRoot, options);
}

export async function handleUiCleanupTaskPurgePostRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    return handleUiCleanupTaskPurgeRequest(request, response, repoRoot, options);
}

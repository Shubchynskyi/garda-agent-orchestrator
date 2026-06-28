import type * as http from 'node:http';
import { findAction } from '../action-common';
import { buildUiTaskActionDefinitions } from '../task-actions';
import {
    isValidActionRequestBoundary,
    normalizeActionRequest,
    processUiActionRequest,
    readJsonBody,
    sendApiError,
    type LocalUiServerRuntimeOptions
} from './action-http-common';
import {
    isTaskResetOneShotActionId,
    processTaskResetOneShotActionRequest
} from './task-reset-one-shot-http';

export async function handleUiTaskActionRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    repoRoot: string,
    taskId: string,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    if (!options.actionsEnabled) {
        sendApiError(response, 403, 'UI actions are disabled. Restart with --actions to enable allow-listed commands.', 'actions_disabled');
        return;
    }
    if (!isValidActionRequestBoundary(request, options)) {
        sendApiError(response, 403, 'UI action request failed origin, token, or content-type validation.', 'action_boundary_rejected');
        return;
    }
    const payload = normalizeActionRequest(await readJsonBody(request));
    const actions = buildUiTaskActionDefinitions(repoRoot, taskId);
    if (isTaskResetOneShotActionId(payload.action_id)) {
        const action = findAction(actions, payload.action_id);
        if (action) {
            await processTaskResetOneShotActionRequest(response, repoRoot, taskId, payload, action, options);
            return;
        }
    }
    await processUiActionRequest(response, repoRoot, payload, actions, options, {
        extraResponseFields: { task_id: taskId }
    });
}

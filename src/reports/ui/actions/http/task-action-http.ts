import type * as http from 'node:http';
import { buildUiTaskActionDefinitions } from '../task-actions';
import {
    isValidActionRequestBoundary,
    normalizeActionRequest,
    processUiActionRequest,
    readJsonBody,
    sendApiError,
    type LocalUiServerRuntimeOptions
} from './action-http-common';

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
    await processUiActionRequest(response, repoRoot, payload, actions, options, {
        extraResponseFields: { task_id: taskId }
    });
}

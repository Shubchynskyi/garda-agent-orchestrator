import { buildDashboardClientPrelude, type DashboardClientPreludeOptions } from './dashboard-client-prelude';
import { UI_DASHBOARD_CLIENT_BOOTSTRAP } from './dashboard-client-bootstrap';
import { UI_DASHBOARD_CLIENT_CORE } from './dashboard-client-core';
import { UI_DASHBOARD_CLIENT_INIT_SETTINGS } from './dashboard-client-init-settings';
import { UI_DASHBOARD_CLIENT_INSTRUCTIONS } from './dashboard-client-instructions';
import { UI_DASHBOARD_CLIENT_PROJECT_MEMORY } from './dashboard-client-project-memory';
import { UI_DASHBOARD_CLIENT_SESSION_ACTIONS } from './dashboard-client-session-actions';
import { UI_DASHBOARD_CLIENT_TASK_DETAIL } from './dashboard-client-task-detail';
import { UI_DASHBOARD_CLIENT_TASKS } from './dashboard-client-tasks';
import { UI_DASHBOARD_CLIENT_WORKFLOW } from './dashboard-client-workflow';

export function buildDashboardClientScript(options: DashboardClientPreludeOptions): string {
    return [
        buildDashboardClientPrelude(options),
        UI_DASHBOARD_CLIENT_CORE,
        UI_DASHBOARD_CLIENT_TASKS,
        UI_DASHBOARD_CLIENT_WORKFLOW,
        UI_DASHBOARD_CLIENT_INIT_SETTINGS,
        UI_DASHBOARD_CLIENT_PROJECT_MEMORY,
        UI_DASHBOARD_CLIENT_INSTRUCTIONS,
        UI_DASHBOARD_CLIENT_SESSION_ACTIONS,
        UI_DASHBOARD_CLIENT_TASK_DETAIL,
        UI_DASHBOARD_CLIENT_BOOTSTRAP
    ].join('\n');
}

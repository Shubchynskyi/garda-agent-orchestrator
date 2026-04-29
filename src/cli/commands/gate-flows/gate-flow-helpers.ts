import * as gateHelpers from '../../../gates/helpers';

// Keep this barrel while older imports migrate to the focused helper modules.
export { readTaskQueueStatus, syncTaskQueueStatus, syncTaskQueueStatusDetailed, type TaskQueueStatusSyncResult } from './task-queue-sync';
export { readRoutingDecision } from './routing-decision';
export { resolveBudgetTokensFromForecast, resolveOutputFiltersPath } from './output-budget-filter';

export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function resolveOrchestratorRoot(repoRoot: string): string {
    return gateHelpers.joinOrchestratorPath(repoRoot, '');
}

export function splitOutputLines(text: unknown): string[] {
    if (!text) {
        return [];
    }
    const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function appendMetricsIfEnabled(
    repoRoot: string,
    metricsPath: string | null,
    eventObject: Record<string, unknown>,
    emitMetrics: boolean
): void {
    if (!metricsPath) {
        return;
    }
    gateHelpers.appendMetricsEvent(metricsPath, eventObject, emitMetrics, repoRoot);
}

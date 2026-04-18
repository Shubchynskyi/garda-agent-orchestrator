import * as fs from 'node:fs';
import * as path from 'node:path';
import * as gateHelpers from '../../../gates/helpers';
import { resolveGateExecutionPath } from '../../../gates/isolation-sandbox';
import { resolveRuntimeReviewerIdentity } from '../../../gates/reviewer-routing';
import { requireResolvedPath } from '../shared-command-utils';

export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function resolveOrchestratorRoot(repoRoot: string): string {
    return gateHelpers.joinOrchestratorPath(repoRoot, '');
}

export function readTaskQueueStatus(repoRoot: string, taskId: string): string | null {
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return null;
    }

    const statusPattern = /\b(TODO|IN_PROGRESS|IN_REVIEW|DONE|BLOCKED)\b/i;
    const lines = fs.readFileSync(taskPath, 'utf8').split('\n');
    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('|')) {
            continue;
        }
        const cells = trimmed.split('|').map((cell) => cell.trim()).filter(Boolean);
        if (cells.length < 2 || cells[0] !== taskId) {
            continue;
        }
        const statusMatch = statusPattern.exec(cells[1]);
        return statusMatch ? statusMatch[1].toUpperCase() : null;
    }

    return null;
}

const TASK_QUEUE_STATUS_MARKERS: Record<string, string> = Object.freeze({
    TODO: '🟦',
    IN_PROGRESS: '🟨',
    IN_REVIEW: '🟧',
    DONE: '🟩',
    BLOCKED: '🟥'
});

function formatTaskQueueStatusCell(existingCell: string, nextStatus: string): string {
    const normalizedStatus = String(nextStatus || '').trim().toUpperCase();
    const leadingWhitespace = existingCell.match(/^\s*/)?.[0] ?? ' ';
    const trailingWhitespace = existingCell.match(/\s*$/)?.[0] ?? ' ';
    const hasMarker = Object.values(TASK_QUEUE_STATUS_MARKERS).some((marker) => existingCell.includes(marker));
    const formattedStatus = hasMarker && TASK_QUEUE_STATUS_MARKERS[normalizedStatus]
        ? `${TASK_QUEUE_STATUS_MARKERS[normalizedStatus]} ${normalizedStatus}`
        : normalizedStatus;
    return `${leadingWhitespace}${formattedStatus}${trailingWhitespace}`;
}

export function syncTaskQueueStatus(repoRoot: string, taskId: string, nextStatus: string): boolean {
    const result = syncTaskQueueStatusDetailed(repoRoot, taskId, nextStatus);
    return result.outcome === 'updated';
}

export interface TaskQueueStatusSyncResult {
    outcome: 'updated' | 'already_synced' | 'task_file_missing' | 'task_not_found' | 'write_failed';
    task_path: string;
    task_id: string;
    previous_status: string | null;
    next_status: string;
    error_message: string | null;
}

export function syncTaskQueueStatusDetailed(repoRoot: string, taskId: string, nextStatus: string): TaskQueueStatusSyncResult {
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return {
            outcome: 'task_file_missing',
            task_path: gateHelpers.normalizePath(taskPath),
            task_id: taskId,
            previous_status: null,
            next_status: String(nextStatus || '').trim().toUpperCase(),
            error_message: null
        };
    }

    const originalContent = fs.readFileSync(taskPath, 'utf8');
    const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
    const lines = originalContent.split(/\r?\n/);
    const normalizedNextStatus = String(nextStatus || '').trim().toUpperCase();
    let changed = false;
    let taskFound = false;
    let previousStatus: string | null = null;

    for (let index = 0; index < lines.length; index += 1) {
        const rawLine = lines[index];
        if (!rawLine.trim().startsWith('|')) {
            continue;
        }

        const cells = rawLine.split('|');
        if (cells.length < 4 || cells[1].trim() !== taskId) {
            continue;
        }

        taskFound = true;
        const statusMatch = /\b(TODO|IN_PROGRESS|IN_REVIEW|DONE|BLOCKED)\b/i.exec(cells[2]);
        previousStatus = statusMatch ? statusMatch[1].toUpperCase() : null;
        const updatedStatusCell = formatTaskQueueStatusCell(cells[2], normalizedNextStatus);
        if (updatedStatusCell !== cells[2]) {
            cells[2] = updatedStatusCell;
            lines[index] = cells.join('|');
            changed = true;
        }
        break;
    }

    if (!taskFound) {
        return {
            outcome: 'task_not_found',
            task_path: gateHelpers.normalizePath(taskPath),
            task_id: taskId,
            previous_status: null,
            next_status: normalizedNextStatus,
            error_message: null
        };
    }

    if (!changed) {
        return {
            outcome: 'already_synced',
            task_path: gateHelpers.normalizePath(taskPath),
            task_id: taskId,
            previous_status: previousStatus,
            next_status: normalizedNextStatus,
            error_message: null
        };
    }

    try {
        fs.writeFileSync(taskPath, lines.join(newline), 'utf8');
    } catch (error: unknown) {
        return {
            outcome: 'write_failed',
            task_path: gateHelpers.normalizePath(taskPath),
            task_id: taskId,
            previous_status: previousStatus,
            next_status: normalizedNextStatus,
            error_message: getErrorMessage(error)
        };
    }

    return {
        outcome: 'updated',
        task_path: gateHelpers.normalizePath(taskPath),
        task_id: taskId,
        previous_status: previousStatus,
        next_status: normalizedNextStatus,
        error_message: null
    };
}

export function readRoutingDecision(
    repoRoot: string,
    providerOverride?: unknown,
    routedToOverride?: unknown,
    taskId?: string | null
): {
    provider: string | null;
    routedTo: string | null;
    canonicalSourceOfTruth: string | null;
    canonicalEntrypoint: string | null;
    executionProviderSource: string | null;
    providerBridge: string | null;
    identityStatus: string;
    violations: string[];
} {
    const identity = resolveRuntimeReviewerIdentity({
        repoRoot,
        taskId,
        executionProvider: providerOverride,
        routedTo: routedToOverride,
        allowLegacyFallback: true
    });
    return {
        provider: identity.execution_provider,
        routedTo: identity.routed_to,
        canonicalSourceOfTruth: identity.canonical_source_of_truth,
        canonicalEntrypoint: identity.canonical_entrypoint,
        executionProviderSource: identity.execution_provider_source,
        providerBridge: identity.provider_bridge,
        identityStatus: identity.identity_status,
        violations: identity.violations
    };
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

export function resolveBudgetTokensFromForecast(forecast: unknown): number | null {
    if (!forecast || typeof forecast !== 'object') {
        return null;
    }
    const record = forecast as Record<string, unknown>;
    const totalForecastTokens = typeof record.total_forecast_tokens === 'number' && Number.isFinite(record.total_forecast_tokens)
        ? record.total_forecast_tokens
        : null;
    const effectiveForecastTokens = typeof record.effective_forecast_tokens === 'number' && Number.isFinite(record.effective_forecast_tokens)
        ? record.effective_forecast_tokens
        : null;
    const tokenEconomyActiveForDepth = record.token_economy_active_for_depth === true;
    if (tokenEconomyActiveForDepth && effectiveForecastTokens != null) {
        return effectiveForecastTokens;
    }
    if (totalForecastTokens != null) {
        return totalForecastTokens;
    }
    return effectiveForecastTokens;
}

export function resolveOutputFiltersPath(repoRoot: string, explicitPath: string): string {
    if (explicitPath) {
        return requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(explicitPath, repoRoot, { allowMissing: true }),
            'OutputFiltersPath'
        );
    }
    return resolveGateExecutionPath(repoRoot, path.join('live', 'config', 'output-filters.json'));
}

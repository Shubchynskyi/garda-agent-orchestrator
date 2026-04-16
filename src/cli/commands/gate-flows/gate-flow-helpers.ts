import * as fs from 'node:fs';
import * as path from 'node:path';
import * as gateHelpers from '../../../gates/helpers';
import { resolveGateExecutionPath } from '../../../gates/isolation-sandbox';
import { getCanonicalEntrypointFile } from '../../../materialization/common';
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
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return false;
    }

    const originalContent = fs.readFileSync(taskPath, 'utf8');
    const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
    const lines = originalContent.split(/\r?\n/);
    let changed = false;

    for (let index = 0; index < lines.length; index += 1) {
        const rawLine = lines[index];
        if (!rawLine.trim().startsWith('|')) {
            continue;
        }

        const cells = rawLine.split('|');
        if (cells.length < 4 || cells[1].trim() !== taskId) {
            continue;
        }

        const updatedStatusCell = formatTaskQueueStatusCell(cells[2], nextStatus);
        if (updatedStatusCell !== cells[2]) {
            cells[2] = updatedStatusCell;
            lines[index] = cells.join('|');
            changed = true;
        }
        break;
    }

    if (!changed) {
        return false;
    }

    fs.writeFileSync(taskPath, lines.join(newline), 'utf8');
    return true;
}

export function readRoutingDecision(repoRoot: string, providerOverride?: unknown, routedToOverride?: unknown): { provider: string | null; routedTo: string | null } {
    const explicitProvider = String(providerOverride || '').trim();
    const explicitRoutedTo = String(routedToOverride || '').trim();
    if (explicitProvider) {
        return {
            provider: explicitProvider,
            routedTo: explicitRoutedTo || getCanonicalEntrypointFile(explicitProvider)
        };
    }

    const initAnswersPath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'init-answers.json'));
    if (!fs.existsSync(initAnswersPath) || !fs.statSync(initAnswersPath).isFile()) {
        return { provider: null, routedTo: null };
    }

    try {
        const payload = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
        const sourceOfTruth = String(payload.SourceOfTruth || '').trim();
        if (!sourceOfTruth) {
            return { provider: null, routedTo: null };
        }
        return {
            provider: sourceOfTruth,
            routedTo: getCanonicalEntrypointFile(sourceOfTruth)
        };
    } catch {
        return { provider: null, routedTo: null };
    }
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

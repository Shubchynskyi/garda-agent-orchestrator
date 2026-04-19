import * as path from 'node:path';
import * as gateHelpers from '../../../gates/helpers';
import { resolveGateExecutionPath } from '../../../gates/isolation-sandbox';
import { requireResolvedPath } from '../shared-command-utils';

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

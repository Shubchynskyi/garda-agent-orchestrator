import { BudgetTierConfig, BudgetTierResolution } from './types';
import { asRecord } from './utils';

const DEFAULT_TIERS: BudgetTierConfig[] = [
    { label: 'tight',    max_tokens: 500,  passthrough_ceiling_max_lines: 20, fail_tail_lines: 15, max_matches: 5,  max_parser_lines: 6,  truncate_line_max_chars: 160 },
    { label: 'moderate', max_tokens: 1500, passthrough_ceiling_max_lines: 40, fail_tail_lines: 30, max_matches: 10, max_parser_lines: 12, truncate_line_max_chars: 200 },
    { label: 'generous', max_tokens: null,  passthrough_ceiling_max_lines: 60, fail_tail_lines: 50, max_matches: 16, max_parser_lines: 18, truncate_line_max_chars: 240 }
];

export function parseBudgetTiers(config: Record<string, unknown> | null): BudgetTierConfig[] {
    if (!config) return DEFAULT_TIERS;
    const budgetCfg = asRecord(config.budget_profiles);
    if (!budgetCfg) return DEFAULT_TIERS;

    const enabled = budgetCfg.enabled;
    if (enabled === false) return DEFAULT_TIERS;

    const rawTiers = budgetCfg.tiers;
    if (!Array.isArray(rawTiers) || rawTiers.length === 0) return DEFAULT_TIERS;

    const tiers: BudgetTierConfig[] = [];
    for (const raw of rawTiers) {
        const t = asRecord(raw);
        if (!t) continue;
        const label = String(t.label || '').trim();
        if (!label) continue;
        tiers.push({
            label,
            max_tokens: (typeof t.max_tokens === 'number' && Number.isInteger(t.max_tokens) && t.max_tokens > 0) ? t.max_tokens : null,
            passthrough_ceiling_max_lines: typeof t.passthrough_ceiling_max_lines === 'number' ? t.passthrough_ceiling_max_lines : 60,
            fail_tail_lines: typeof t.fail_tail_lines === 'number' ? t.fail_tail_lines : 50,
            max_matches: typeof t.max_matches === 'number' ? t.max_matches : 12,
            max_parser_lines: typeof t.max_parser_lines === 'number' ? t.max_parser_lines : 18,
            truncate_line_max_chars: typeof t.truncate_line_max_chars === 'number' ? t.truncate_line_max_chars : 240
        });
    }
    return tiers.length > 0 ? tiers : DEFAULT_TIERS;
}

/**
 * Match budget tokens against tiers. Tiers are evaluated in order;
 * the first tier whose `max_tokens` is >= budgetTokens wins.
 * A tier with `max_tokens: null` is a catch-all that always matches.
 */
export function resolveBudgetTier(
    config: Record<string, unknown> | null,
    budgetTokens: number | null
): BudgetTierResolution {
    const noMatch: BudgetTierResolution = { tier_label: 'none', matched: false, overrides_applied: [] };
    if (budgetTokens == null || budgetTokens < 0) return noMatch;

    const budgetCfg = asRecord(config?.budget_profiles ?? null);
    if (budgetCfg && budgetCfg.enabled === false) return noMatch;

    const tiers = parseBudgetTiers(config);
    for (const tier of tiers) {
        if (tier.max_tokens === null || budgetTokens <= tier.max_tokens) {
            const overrides: string[] = [];
            const defaults = DEFAULT_TIERS.find(d => d.label === 'generous') || DEFAULT_TIERS[DEFAULT_TIERS.length - 1];
            if (tier.passthrough_ceiling_max_lines !== defaults.passthrough_ceiling_max_lines) overrides.push('passthrough_ceiling_max_lines');
            if (tier.fail_tail_lines !== defaults.fail_tail_lines) overrides.push('fail_tail_lines');
            if (tier.max_matches !== defaults.max_matches) overrides.push('max_matches');
            if (tier.max_parser_lines !== defaults.max_parser_lines) overrides.push('max_parser_lines');
            if (tier.truncate_line_max_chars !== defaults.truncate_line_max_chars) overrides.push('truncate_line_max_chars');
            return { tier_label: tier.label, matched: true, overrides_applied: overrides };
        }
    }
    return noMatch;
}

export function getActiveTierConfig(config: Record<string, unknown> | null, tierLabel: string): BudgetTierConfig | null {
    const tiers = parseBudgetTiers(config);
    return tiers.find(t => t.label === tierLabel) || null;
}

/**
 * Inject budget-derived values into the runtime context so that
 * context_key lookups in profile definitions resolve to tier values.
 */
export function applyBudgetContextOverrides(
    context: Record<string, unknown> | null,
    resolution: BudgetTierResolution,
    config: Record<string, unknown> | null
): Record<string, unknown> {
    const tier = getActiveTierConfig(config, resolution.tier_label);
    if (!tier) return context || {};
    return {
        ...(context || {}),
        fail_tail_lines: tier.fail_tail_lines
    };
}

/**
 * Clone a profile record and apply budget overrides to numeric operation
 * parameters and parser parameters.
 */
export function applyBudgetProfileOverrides(
    profile: Record<string, unknown>,
    resolution: BudgetTierResolution,
    config: Record<string, unknown> | null
): Record<string, unknown> {
    const tier = getActiveTierConfig(config, resolution.tier_label);
    if (!tier) return profile;

    const result = { ...profile };

    if (Array.isArray(result.operations)) {
        result.operations = (result.operations as Record<string, unknown>[]).map((op) => {
            const opClone = { ...op };
            const opType = String(opClone.type || '').trim().toLowerCase();
            if (opType === 'truncate_line_length' && typeof opClone.max_chars === 'number') {
                opClone.max_chars = Math.min(opClone.max_chars as number, tier.truncate_line_max_chars);
            }
            return opClone;
        });
    }

    if (result.parser && typeof result.parser === 'object') {
        const parserClone = { ...(result.parser as Record<string, unknown>) };
        if (parserClone.max_matches !== undefined && typeof parserClone.max_matches === 'number') {
            parserClone.max_matches = Math.min(parserClone.max_matches as number, tier.max_matches);
        }
        if (parserClone.max_lines !== undefined && typeof parserClone.max_lines === 'number') {
            parserClone.max_lines = Math.min(parserClone.max_lines as number, tier.max_parser_lines);
        }
        if (parserClone.tail_count !== undefined && typeof parserClone.tail_count === 'number') {
            parserClone.tail_count = Math.min(parserClone.tail_count as number, tier.fail_tail_lines);
        }
        result.parser = parserClone;
    }

    return result;
}

/**
 * Build a config object with budget-overridden passthrough ceiling values.
 */
export function applyBudgetCeilingOverride(
    config: Record<string, unknown> | null,
    resolution: BudgetTierResolution
): Record<string, unknown> {
    const tier = getActiveTierConfig(config, resolution.tier_label);
    if (!tier) return config || {};
    const baseCeiling = asRecord((config || {}).passthrough_ceiling) || {};
    return {
        ...(config || {}),
        passthrough_ceiling: {
            ...baseCeiling,
            max_lines: tier.passthrough_ceiling_max_lines
        }
    };
}

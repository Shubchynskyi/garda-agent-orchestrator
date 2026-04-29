import * as fs from 'node:fs';
import { toStringArray } from './text-utils';
import {
    FilterProfileResult,
    ApplyOutputFilterProfileOptions
} from './output-filters/types';
import { selectHeadLines, selectTailLines, asRecord } from './output-filters/utils';
import { applyOutputFilterOperation } from './output-filters/operations';
import { applyOutputParser } from './output-filters/parsers';
import {
    resolveBudgetTier,
    applyBudgetContextOverrides,
    applyBudgetProfileOverrides,
    applyBudgetCeilingOverride
} from './output-filters/budget';

export {
    BudgetTierConfig,
    BudgetProfilesConfig,
    BudgetTierResolution,
    ResolveFilterStrOptions,
    AddUniqueLinesOptions,
    SelectMatchingLinesOptions,
    CompileStrategyConfig,
    ErrorGroup,
    GroupingResult,
    ParserResult,
    FilterProfileResult,
    ApplyOutputFilterProfileOptions
} from './output-filters/types';

export {
    resolveFilterInt,
    resolveFilterStr,
    selectHeadLines,
    selectTailLines,
    selectMatchingLines
} from './output-filters/utils';

export {
    normalizeErrorSignature,
    groupMatchingLines,
    formatGroupedLines
} from './output-filters/error-grouping';

export {
    getCompileFailureStrategyConfig,
    applyOutputParser
} from './output-filters/parsers';

export {
    applyOutputFilterOperation
} from './output-filters/operations';

export {
    resolveBudgetTier
} from './output-filters/budget';

/**
 * Apply passthrough ceiling, matching Python _apply_passthrough_ceiling.
 */
export function applyPassthroughCeiling(
    lines: string[],
    config: Record<string, unknown> | null,
    fallbackMode: string
): string[] {
    const DEFAULT_MAX = 60;
    let maxLines = DEFAULT_MAX;
    let strategy = 'tail';

    if (config && typeof config === 'object') {
        const ceilingCfg = asRecord(config.passthrough_ceiling);
        if (ceilingCfg) {
            if (typeof ceilingCfg.max_lines === 'number' && ceilingCfg.max_lines > 0) {
                maxLines = ceilingCfg.max_lines;
            }
            if (ceilingCfg.strategy === 'head') {
                strategy = 'head';
            }
        }
    }

    const total = lines.length;
    if (total <= maxLines) {
        return [...lines];
    }

    const capped = strategy === 'head' ? selectHeadLines(lines, maxLines) : selectTailLines(lines, maxLines);
    const header = `[passthrough-ceiling] fallback=${fallbackMode} total=${total} ceiling=${maxLines} strategy=${strategy}`;
    return [header, ...capped];
}

/**
 * Apply a named output filter profile, matching Python apply_output_filter_profile.
 */
export function applyOutputFilterProfile(
    lines: unknown,
    configPath: string,
    profileName: string,
    options: ApplyOutputFilterProfileOptions = {}
): FilterProfileResult {
    const context = options.context || null;
    const budgetTokens = options.budgetTokens ?? null;
    const originalLines = toStringArray(lines);
    const passthrough: FilterProfileResult = {
        lines: originalLines,
        filter_mode: 'passthrough',
        fallback_mode: 'none',
        parser_mode: 'NONE',
        parser_name: null,
        parser_strategy: null,
        budget_tier: null,
        grouping: null
    };

    if (!String(profileName || '').trim()) {
        return passthrough;
    }

    if (!configPath || !fs.existsSync(configPath)) {
        process.stderr.write(`WARNING: output filter config missing for profile '${profileName}': ${configPath}\n`);
        passthrough.fallback_mode = 'missing_config_passthrough';
        passthrough.lines = applyPassthroughCeiling(originalLines, null, 'missing_config_passthrough');
        return passthrough;
    }

    let config: Record<string, unknown> | null = null;
    try {
        const parsedConfig: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config = asRecord(parsedConfig) || {};
    } catch (err) {
        process.stderr.write(`WARNING: output filter config is invalid JSON for profile '${profileName}': ${err}\n`);
        passthrough.fallback_mode = 'invalid_config_passthrough';
        passthrough.lines = applyPassthroughCeiling(originalLines, null, 'invalid_config_passthrough');
        return passthrough;
    }

    const profiles = config ? asRecord(config.profiles) : null;
    if (!profiles) {
        process.stderr.write("WARNING: output filter config must contain object 'profiles'.\n");
        passthrough.fallback_mode = 'invalid_config_passthrough';
        passthrough.lines = applyPassthroughCeiling(originalLines, config, 'invalid_config_passthrough');
        return passthrough;
    }

    const profile = profiles[profileName];
    if (profile == null) {
        process.stderr.write(`WARNING: output filter profile '${profileName}' not found in ${configPath}.\n`);
        passthrough.fallback_mode = 'missing_profile_passthrough';
        passthrough.lines = applyPassthroughCeiling(originalLines, config, 'missing_profile_passthrough');
        return passthrough;
    }
    const profileRecord = asRecord(profile);
    if (!profileRecord) {
        process.stderr.write(`WARNING: output filter profile '${profileName}' must be an object.\n`);
        passthrough.fallback_mode = 'invalid_profile_passthrough';
        passthrough.lines = applyPassthroughCeiling(originalLines, config, 'invalid_profile_passthrough');
        return passthrough;
    }

    const budgetResolution = resolveBudgetTier(config, budgetTokens);
    const effectiveContext = budgetResolution.matched
        ? applyBudgetContextOverrides(context, budgetResolution, config)
        : context;
    const effectiveProfile = budgetResolution.matched
        ? applyBudgetProfileOverrides(profileRecord, budgetResolution, config)
        : profileRecord;

    try {
        let filteredLines = [...originalLines];
        const operations = effectiveProfile.operations || [];
        if (typeof operations === 'string' || !Array.isArray(operations)) {
            throw new Error(`Profile '${profileName}' field 'operations' must be an array.`);
        }
        for (const operation of operations) {
            filteredLines = applyOutputFilterOperation(filteredLines, operation as Record<string, unknown>, effectiveContext);
        }

        const parserResult = applyOutputParser(
            filteredLines,
            effectiveProfile.parser as Record<string, unknown> | null | undefined,
            effectiveContext
        );
        filteredLines = [...parserResult.lines];
        if (parserResult.parser_mode === 'PASSTHROUGH') {
            const ceilingConfig = budgetResolution.matched
                ? applyBudgetCeilingOverride(config, budgetResolution)
                : config;
            filteredLines = applyPassthroughCeiling(filteredLines, ceilingConfig, 'parser_passthrough');
        }
        const emitWhenEmpty = String(effectiveProfile.emit_when_empty || '').trim();
        if (filteredLines.length === 0 && emitWhenEmpty) {
            filteredLines = [emitWhenEmpty];
        }

        return {
            lines: filteredLines,
            filter_mode: `profile:${profileName}`,
            fallback_mode: parserResult.fallback_mode,
            parser_mode: parserResult.parser_mode,
            parser_name: parserResult.parser_name,
            parser_strategy: parserResult.parser_strategy,
            budget_tier: budgetResolution.matched ? budgetResolution.tier_label : null,
            grouping: parserResult.grouping ?? null
        };
    } catch (err) {
        process.stderr.write(`WARNING: output filter profile '${profileName}' is invalid: ${err}\n`);
        passthrough.fallback_mode = 'invalid_profile_passthrough';
        passthrough.lines = applyPassthroughCeiling(originalLines, config, 'invalid_profile_passthrough');
        return passthrough;
    }
}

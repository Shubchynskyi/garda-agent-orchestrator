import { toStringArray } from './text-utils';
import * as fs from 'node:fs';

interface ResolveFilterStrOptions {
    allowEmpty?: boolean;
}

interface AddUniqueLinesOptions {
    limit?: number;
}

interface SelectMatchingLinesOptions {
    limit?: number;
}

interface CompileStrategyConfig {
    display_name: string;
    full_patterns: string[];
    degraded_patterns: string[];
}

interface ErrorGroup {
    signature: string;
    representative: string;
    count: number;
}

interface GroupingResult {
    groups: ErrorGroup[];
    total_matches: number;
    unique_groups: number;
}

interface ParserResult {
    lines: string[];
    parser_mode: string;
    parser_name: string | null;
    parser_strategy: string | null;
    fallback_mode: string;
    grouping?: GroupingResult | null;
}

interface FilterProfileResult {
    lines: string[];
    filter_mode: string;
    fallback_mode: string;
    parser_mode: string;
    parser_name: string | null;
    parser_strategy: string | null;
    budget_tier?: string | null;
    grouping?: GroupingResult | null;
}

interface ApplyOutputFilterProfileOptions {
    context?: Record<string, unknown> | null;
    budgetTokens?: number | null;
}

// ---------------------------------------------------------------------------
// Budget-tier types
// ---------------------------------------------------------------------------

export interface BudgetTierConfig {
    label: string;
    max_tokens: number | null;
    passthrough_ceiling_max_lines: number;
    fail_tail_lines: number;
    max_matches: number;
    max_parser_lines: number;
    truncate_line_max_chars: number;
}

export interface BudgetProfilesConfig {
    enabled: boolean;
    tiers: BudgetTierConfig[];
}

export interface BudgetTierResolution {
    tier_label: string;
    matched: boolean;
    overrides_applied: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

/**
 * Resolve a context-lookup integer value, matching Python _resolve_filter_int.
 */
export function resolveFilterInt(
    value: unknown,
    context: Record<string, unknown> | null | undefined,
    fieldName: string,
    minimum: number = 0
): number {
    let resolvedValue: unknown = value;
    if (
        resolvedValue
        && typeof resolvedValue === 'object'
        && 'context_key' in resolvedValue
        && typeof resolvedValue.context_key === 'string'
        && resolvedValue.context_key.trim()
    ) {
        const contextKey = resolvedValue.context_key.trim();
        if (!context || typeof context !== 'object' || !(contextKey in context)) {
            throw new Error(`${fieldName} references missing context key '${contextKey}'.`);
        }
        resolvedValue = context[contextKey];
    }

    if (typeof resolvedValue === 'boolean') {
        throw new Error(`${fieldName} must resolve to integer >= ${minimum}.`);
    }
    let result: number;
    if (typeof resolvedValue === 'number' && Number.isInteger(resolvedValue)) {
        result = resolvedValue;
    } else if (typeof resolvedValue === 'number' && Number.isFinite(resolvedValue) && resolvedValue === Math.floor(resolvedValue)) {
        result = Math.floor(resolvedValue);
    } else if (typeof resolvedValue === 'string' && /^\s*-?\d+\s*$/.test(resolvedValue.trim())) {
        result = parseInt(resolvedValue.trim(), 10);
    } else {
        throw new Error(`${fieldName} must resolve to integer >= ${minimum}.`);
    }
    if (result < minimum) {
        throw new Error(`${fieldName} must resolve to integer >= ${minimum}.`);
    }
    return result;
}

/**
 * Resolve a context-lookup string value, matching Python _resolve_filter_str.
 */
export function resolveFilterStr(
    value: unknown,
    context: Record<string, unknown> | null | undefined,
    fieldName: string,
    options: ResolveFilterStrOptions = {}
): string {
    const allowEmpty = options.allowEmpty || false;
    let resolvedValue: unknown = value;
    if (
        resolvedValue
        && typeof resolvedValue === 'object'
        && 'context_key' in resolvedValue
        && typeof resolvedValue.context_key === 'string'
        && resolvedValue.context_key.trim()
    ) {
        const contextKey = resolvedValue.context_key.trim();
        if (!context || typeof context !== 'object' || !(contextKey in context)) {
            throw new Error(`${fieldName} references missing context key '${contextKey}'.`);
        }
        resolvedValue = context[contextKey];
    }

    if (resolvedValue == null) {
        if (allowEmpty) {
            return '';
        }
        throw new Error(`${fieldName} must resolve to non-empty string.`);
    }

    const text = String(resolvedValue).trim();
    if (!text && !allowEmpty) {
        throw new Error(`${fieldName} must resolve to non-empty string.`);
    }
    return text;
}

/**
 * Get filter patterns from operation config, matching Python _get_filter_patterns.
 */
function getFilterPatterns(operation: Record<string, unknown>): string[] {
    const patternsValue = operation.patterns || operation.pattern;
    const patterns = toStringArray(patternsValue, { trimValues: true });
    if (patterns.length === 0) {
        throw new Error("Filter operation requires non-empty `pattern` or `patterns`.");
    }
    for (const pattern of patterns) {
        new RegExp(pattern); // validate
    }
    return patterns;
}

export function selectHeadLines(lines: string[], count: number): string[] {
    if (count <= 0) return [];
    return lines.slice(0, count);
}

export function selectTailLines(lines: string[], count: number): string[] {
    if (count <= 0) return [];
    return lines.slice(-count);
}

function addUniqueLines(
    destination: string[],
    seen: Set<string>,
    lines: unknown,
    options: AddUniqueLinesOptions = {}
): void {
    const limit = options.limit || 0;
    for (const lineValue of toStringArray(lines)) {
        const lineText = String(lineValue);
        if (!lineText.trim() || seen.has(lineText)) {
            continue;
        }
        destination.push(lineText);
        seen.add(lineText);
        if (limit > 0 && destination.length >= limit) {
            break;
        }
    }
}

export function selectMatchingLines(
    lines: string[],
    patterns: string[],
    options: SelectMatchingLinesOptions = {}
): string[] {
    const limit = options.limit || 0;
    const compiledPatterns = patterns.map((pattern) => new RegExp(pattern));
    const matches: string[] = [];
    for (const line of lines) {
        if (compiledPatterns.some((pattern) => pattern.test(line))) {
            matches.push(line);
            if (limit > 0 && matches.length >= limit) {
                break;
            }
        }
    }
    return matches;
}

// ---------------------------------------------------------------------------
// Error grouping and deduplication
// ---------------------------------------------------------------------------

// Strip file paths, line/column numbers, and leading whitespace to extract
// the core error signature from a diagnostic line.
// Requires at least one directory separator to avoid matching bare words.
const PATH_PREFIX_RE = /^(?:[A-Za-z]:)?[/\\]?(?:[\w.@-]+[/\\])+[\w.@-]+(?::\d+(?::\d+)?)?[:\s]+/;
const LINE_COL_RE = /\(\d+,\d+\)/g;
const ANON_PATH_RE = /(?:[A-Za-z]:)?(?:[/\\][\w.@-]+){2,}/g;

export function normalizeErrorSignature(line: string): string {
    let sig = line.trim();
    sig = sig.replace(PATH_PREFIX_RE, '');
    sig = sig.replace(LINE_COL_RE, '');
    sig = sig.replace(ANON_PATH_RE, '<path>');
    sig = sig.replace(/\s{2,}/g, ' ').trim();
    return sig || line.trim();
}

export function groupMatchingLines(
    lines: string[],
    patterns: string[],
    maxGroups: number
): GroupingResult {
    const compiledPatterns = patterns.map((p) => new RegExp(p));
    const groupMap = new Map<string, ErrorGroup>();
    const groupOrder: string[] = [];
    let totalMatches = 0;

    for (const line of lines) {
        if (!compiledPatterns.some((p) => p.test(line))) {
            continue;
        }
        totalMatches++;
        const sig = normalizeErrorSignature(line);
        const existing = groupMap.get(sig);
        if (existing) {
            existing.count++;
        } else {
            const group: ErrorGroup = { signature: sig, representative: line, count: 1 };
            groupMap.set(sig, group);
            groupOrder.push(sig);
        }
    }

    const limitedKeys = maxGroups > 0 ? groupOrder.slice(0, maxGroups) : groupOrder;
    const groups: ErrorGroup[] = limitedKeys.map((k) => groupMap.get(k)!);
    return { groups, total_matches: totalMatches, unique_groups: groupOrder.length };
}

export function formatGroupedLines(result: GroupingResult): string[] {
    const output: string[] = [];
    for (const group of result.groups) {
        if (group.count > 1) {
            output.push(`[${group.count}×] ${group.representative}`);
        } else {
            output.push(group.representative);
        }
    }
    if (result.unique_groups > result.groups.length) {
        const omitted = result.unique_groups - result.groups.length;
        output.push(`... and ${omitted} more distinct error(s) (${result.total_matches} total matches)`);
    } else if (result.total_matches > result.groups.reduce((s, g) => s + g.count, 0)) {
        // Should not normally happen, but guard for clarity
        output.push(`(${result.total_matches} total matches)`);
    }
    return output;
}

// --- Compile failure strategy configs ---

const COMPILE_STRATEGY_CONFIGS = {
    maven: {
        display_name: 'maven',
        full_patterns: [
            String.raw`^\[ERROR\]`,
            'BUILD FAILURE',
            'COMPILATION ERROR',
            'Failed to execute goal',
            'There are test failures',
            String.raw`Tests run: .*Failures:`,
            'Re-run Maven'
        ],
        degraded_patterns: [String.raw`^\[ERROR\]`, String.raw`^\[WARNING\]`, 'BUILD FAILURE', 'error']
    },
    gradle: {
        display_name: 'gradle',
        full_patterns: [
            String.raw`^FAILURE: Build failed with an exception\.`,
            '^BUILD FAILED',
            'Execution failed for task',
            String.raw`^\* What went wrong:`,
            '^> .*',
            '^> Task .*FAILED'
        ],
        degraded_patterns: ['^FAILURE:', '^BUILD FAILED', 'FAILED', 'error']
    },
    node: {
        display_name: 'node-build',
        full_patterns: [
            '^npm ERR!',
            '^ERR!',
            'Command failed with exit code',
            'Failed to compile',
            'ERROR in',
            'Type error',
            'Module not found'
        ],
        degraded_patterns: ['^npm ERR!', 'warning', 'error', 'failed']
    },
    cargo: {
        display_name: 'cargo',
        full_patterns: [
            String.raw`^error(\[[A-Z0-9]+\])?:`,
            '^Caused by:',
            'could not compile',
            '^failures:',
            '^test result: FAILED'
        ],
        degraded_patterns: ['^warning:', '^error', 'FAILED']
    },
    dotnet: {
        display_name: 'dotnet',
        full_patterns: [
            String.raw`^Build FAILED\.`,
            String.raw`^\s*error [A-Z]{2,}\d+:`,
            String.raw`^\s*warning [A-Z]{2,}\d+:`,
            String.raw`^Failed!  - Failed:`,
            String.raw`^Test Run Failed\.`
        ],
        degraded_patterns: [String.raw`^\s*error `, String.raw`^\s*warning `, 'FAILED']
    },
    go: {
        display_name: 'go',
        full_patterns: [
            '^# ',
            '^--- FAIL:',
            String.raw`^FAIL(\s|$)`,
            '^panic:',
            'cannot use',
            'undefined:'
        ],
        degraded_patterns: ['^FAIL', '^panic:', 'error']
    }
};

export function getCompileFailureStrategyConfig(strategy: string): CompileStrategyConfig {
    const normalized = (strategy || '').trim().toLowerCase();
    if (normalized in COMPILE_STRATEGY_CONFIGS) {
        return COMPILE_STRATEGY_CONFIGS[normalized as keyof typeof COMPILE_STRATEGY_CONFIGS];
    }
    return {
        display_name: 'generic-compile',
        full_patterns: ['error', 'failed', 'exception', 'cannot ', 'undefined', 'not found'],
        degraded_patterns: ['warning', 'error', 'failed']
    };
}

function invokeCompileFailureParser(
    lines: string[],
    parserConfig: Record<string, unknown>,
    context: Record<string, unknown> | null | undefined
): ParserResult {
    let strategy = resolveFilterStr(parserConfig.strategy, context, 'parser.strategy', { allowEmpty: true });
    if (!strategy) {
        strategy = resolveFilterStr({ context_key: 'command_filter_strategy' }, context, 'parser.strategy_context', { allowEmpty: true });
    }
    if (!strategy) {
        strategy = 'generic';
    }

    const config = getCompileFailureStrategyConfig(strategy);
    const maxMatches = resolveFilterInt(parserConfig.max_matches, context, 'parser.max_matches', 1);
    const tailCount = resolveFilterInt(parserConfig.tail_count, context, 'parser.tail_count', 0);

    const fullGrouping = groupMatchingLines(lines, config.full_patterns, maxMatches);
    if (fullGrouping.total_matches > 0) {
        const summaryLines: string[] = [];
        const seen = new Set<string>();
        addUniqueLines(summaryLines, seen, [
            `CompactSummary: FULL | strategy=${config.display_name} | ${fullGrouping.unique_groups} group(s), ${fullGrouping.total_matches} match(es)`
        ]);
        addUniqueLines(summaryLines, seen, formatGroupedLines(fullGrouping), { limit: maxMatches + 1 });
        if (tailCount > 0) {
            addUniqueLines(summaryLines, seen, selectTailLines(lines, tailCount));
        }
        return {
            lines: summaryLines,
            parser_mode: 'FULL',
            parser_name: 'compile_failure_summary',
            parser_strategy: config.display_name,
            fallback_mode: 'none',
            grouping: fullGrouping
        };
    }

    const degradedGrouping = groupMatchingLines(lines, config.degraded_patterns, Math.max(maxMatches, 8));
    if (degradedGrouping.total_matches > 0) {
        const summaryLines: string[] = [];
        const seen = new Set<string>();
        addUniqueLines(summaryLines, seen, [
            `CompactSummary: DEGRADED | strategy=${config.display_name} | ${degradedGrouping.unique_groups} group(s), ${degradedGrouping.total_matches} match(es)`
        ]);
        addUniqueLines(summaryLines, seen, formatGroupedLines(degradedGrouping), { limit: Math.max(maxMatches, 8) + 1 });
        if (tailCount > 0) {
            addUniqueLines(summaryLines, seen, selectTailLines(lines, tailCount));
        }
        return {
            lines: summaryLines,
            parser_mode: 'DEGRADED',
            parser_name: 'compile_failure_summary',
            parser_strategy: config.display_name,
            fallback_mode: 'none',
            grouping: degradedGrouping
        };
    }

    return {
        lines: [...lines],
        parser_mode: 'PASSTHROUGH',
        parser_name: 'compile_failure_summary',
        parser_strategy: config.display_name,
        fallback_mode: 'parser_passthrough',
        grouping: null
    };
}

function invokeTestFailureParser(
    lines: string[],
    parserConfig: Record<string, unknown>,
    context: Record<string, unknown> | null | undefined
): ParserResult {
    const maxMatches = resolveFilterInt(parserConfig.max_matches, context, 'parser.max_matches', 1);
    const tailCount = resolveFilterInt(parserConfig.tail_count, context, 'parser.tail_count', 0);
    const patterns = [
        '^--- FAIL:',
        String.raw`^FAIL(\s|$)`,
        '^FAILED',
        '^failures?:',
        '^panic:',
        '^AssertionError',
        '^Error:',
        String.raw`[0-9]+\s+failed`,
        'Test Run Failed',
        '[✕×]'
    ];
    const grouping = groupMatchingLines(lines, patterns, maxMatches);
    if (grouping.total_matches > 0) {
        const summaryLines: string[] = [];
        const seen = new Set<string>();
        addUniqueLines(summaryLines, seen, [
            `CompactSummary: FULL | strategy=test | ${grouping.unique_groups} group(s), ${grouping.total_matches} match(es)`
        ]);
        addUniqueLines(summaryLines, seen, formatGroupedLines(grouping), { limit: maxMatches + 1 });
        if (tailCount > 0) {
            addUniqueLines(summaryLines, seen, selectTailLines(lines, tailCount));
        }
        return {
            lines: summaryLines,
            parser_mode: 'FULL',
            parser_name: 'test_failure_summary',
            parser_strategy: 'test',
            fallback_mode: 'none',
            grouping
        };
    }
    return {
        lines: [...lines],
        parser_mode: 'PASSTHROUGH',
        parser_name: 'test_failure_summary',
        parser_strategy: 'test',
        fallback_mode: 'parser_passthrough',
        grouping: null
    };
}

function invokeLintFailureParser(
    lines: string[],
    parserConfig: Record<string, unknown>,
    context: Record<string, unknown> | null | undefined
): ParserResult {
    const maxMatches = resolveFilterInt(parserConfig.max_matches, context, 'parser.max_matches', 1);
    const tailCount = resolveFilterInt(parserConfig.tail_count, context, 'parser.tail_count', 0);
    const patterns = [
        String.raw`^\s*error`,
        String.raw`^\s*warning`,
        String.raw`:[0-9]+(:[0-9]+)?\s+(error|warning)`,
        String.raw`^Found\s+[0-9]+\s+errors?`,
        '[✖×]',
        'problems?'
    ];
    const grouping = groupMatchingLines(lines, patterns, maxMatches);
    if (grouping.total_matches > 0) {
        const summaryLines: string[] = [];
        const seen = new Set<string>();
        addUniqueLines(summaryLines, seen, [
            `CompactSummary: FULL | strategy=lint | ${grouping.unique_groups} group(s), ${grouping.total_matches} match(es)`
        ]);
        addUniqueLines(summaryLines, seen, formatGroupedLines(grouping), { limit: maxMatches + 1 });
        if (tailCount > 0) {
            addUniqueLines(summaryLines, seen, selectTailLines(lines, tailCount));
        }
        return {
            lines: summaryLines,
            parser_mode: 'FULL',
            parser_name: 'lint_failure_summary',
            parser_strategy: 'lint',
            fallback_mode: 'none',
            grouping
        };
    }
    return {
        lines: [...lines],
        parser_mode: 'PASSTHROUGH',
        parser_name: 'lint_failure_summary',
        parser_strategy: 'lint',
        fallback_mode: 'parser_passthrough',
        grouping: null
    };
}

function invokeReviewSummaryParser(
    lines: string[],
    parserConfig: Record<string, unknown>,
    context: Record<string, unknown> | null | undefined
): ParserResult {
    const maxLines = resolveFilterInt(parserConfig.max_lines, context, 'parser.max_lines', 1);
    const summaryLines = selectHeadLines(lines, maxLines);
    if (summaryLines.length === 0) {
        return {
            lines: [...lines],
            parser_mode: 'PASSTHROUGH',
            parser_name: 'review_gate_summary',
            parser_strategy: 'review',
            fallback_mode: 'parser_passthrough',
            grouping: null
        };
    }
    return {
        lines: summaryLines,
        parser_mode: 'FULL',
        parser_name: 'review_gate_summary',
        parser_strategy: 'review',
        fallback_mode: 'none',
        grouping: null
    };
}

export function applyOutputParser(
    lines: string[],
    parserConfig: Record<string, unknown> | null | undefined,
    context: Record<string, unknown> | null | undefined
): ParserResult {
    if (parserConfig == null) {
        return {
            lines: [...lines],
            parser_mode: 'NONE',
            parser_name: null,
            parser_strategy: null,
            fallback_mode: 'none',
            grouping: null
        };
    }
    if (typeof parserConfig !== 'object') {
        throw new Error('Profile parser must be an object.');
    }

    const parserType = resolveFilterStr(parserConfig.type, context, 'parser.type');
    const normalized = parserType.trim().toLowerCase();
    if (normalized === 'compile_failure_summary') {
        return invokeCompileFailureParser(lines, parserConfig, context);
    }
    if (normalized === 'test_failure_summary') {
        return invokeTestFailureParser(lines, parserConfig, context);
    }
    if (normalized === 'lint_failure_summary') {
        return invokeLintFailureParser(lines, parserConfig, context);
    }
    if (normalized === 'review_gate_summary') {
        return invokeReviewSummaryParser(lines, parserConfig, context);
    }
    throw new Error(`Unsupported profile parser type '${parserType}'.`);
}

/**
 * Apply a single output filter operation, matching Python apply_output_filter_operation.
 */
export function applyOutputFilterOperation(
    lines: unknown,
    operation: Record<string, unknown>,
    context: Record<string, unknown> | null | undefined = null
): string[] {
    if (!operation || typeof operation !== 'object') {
        throw new Error('Filter operation must be an object.');
    }

    const operationType = String(operation.type || '').trim().toLowerCase();
    if (!operationType) {
        throw new Error("Filter operation requires non-empty `type`.");
    }

    const currentLines = toStringArray(lines);

    if (operationType === 'strip_ansi') {
        const ansiPattern = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
        return currentLines.map(line => line.replace(ansiPattern, ''));
    }
    if (operationType === 'regex_replace') {
        const pattern = String(operation.pattern || '').trim();
        if (!pattern) {
            throw new Error("regex_replace requires non-empty `pattern`.");
        }
        const compiled = new RegExp(pattern, 'g');
        const replacement = String(operation.replacement || '');
        return currentLines.map(line => line.replace(compiled, replacement));
    }
    if (operationType === 'drop_lines_matching') {
        const patterns = getFilterPatterns(operation);
        const compiledPatterns = patterns.map(p => new RegExp(p));
        return currentLines.filter(line => !compiledPatterns.some(p => p.test(line)));
    }
    if (operationType === 'keep_lines_matching') {
        const patterns = getFilterPatterns(operation);
        const compiledPatterns = patterns.map(p => new RegExp(p));
        return currentLines.filter(line => compiledPatterns.some(p => p.test(line)));
    }
    if (operationType === 'truncate_line_length') {
        const maxChars = resolveFilterInt(operation.max_chars, context, 'truncate_line_length.max_chars', 1);
        const suffix = String(operation.suffix != null ? operation.suffix : '...');
        const result: string[] = [];
        for (const line of currentLines) {
            if (line.length <= maxChars) {
                result.push(line);
            } else if (suffix.length >= maxChars) {
                result.push(suffix.substring(0, maxChars));
            } else {
                result.push(line.substring(0, maxChars - suffix.length) + suffix);
            }
        }
        return result;
    }
    if (operationType === 'head') {
        const count = resolveFilterInt(operation.count, context, 'head.count', 1);
        return selectHeadLines(currentLines, count);
    }
    if (operationType === 'tail') {
        const count = resolveFilterInt(operation.count, context, 'tail.count', 1);
        return selectTailLines(currentLines, count);
    }
    if (operationType === 'max_total_lines') {
        const maxLines = resolveFilterInt(operation.max_lines, context, 'max_total_lines.max_lines', 0);
        const strategy = String(operation.strategy || 'tail').trim().toLowerCase() || 'tail';
        if (maxLines === 0) return [];
        if (strategy === 'head') return selectHeadLines(currentLines, maxLines);
        if (strategy === 'tail') return selectTailLines(currentLines, maxLines);
        throw new Error("max_total_lines.strategy must be 'head' or 'tail'.");
    }

    throw new Error(`Unsupported filter operation type '${operationType}'.`);
}

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

    // Resolve budget tier and apply overrides to context and profile
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

// ---------------------------------------------------------------------------
// Budget-tier resolution and adaptive overrides
// ---------------------------------------------------------------------------

const DEFAULT_TIERS: BudgetTierConfig[] = [
    { label: 'tight',    max_tokens: 500,  passthrough_ceiling_max_lines: 20, fail_tail_lines: 15, max_matches: 5,  max_parser_lines: 6,  truncate_line_max_chars: 160 },
    { label: 'moderate', max_tokens: 1500, passthrough_ceiling_max_lines: 40, fail_tail_lines: 30, max_matches: 10, max_parser_lines: 12, truncate_line_max_chars: 200 },
    { label: 'generous', max_tokens: null,  passthrough_ceiling_max_lines: 60, fail_tail_lines: 50, max_matches: 16, max_parser_lines: 18, truncate_line_max_chars: 240 }
];

function parseBudgetTiers(config: Record<string, unknown> | null): BudgetTierConfig[] {
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

function getActiveTierConfig(config: Record<string, unknown> | null, tierLabel: string): BudgetTierConfig | null {
    const tiers = parseBudgetTiers(config);
    return tiers.find(t => t.label === tierLabel) || null;
}

/**
 * Inject budget-derived values into the runtime context so that
 * context_key lookups in profile definitions resolve to tier values.
 */
function applyBudgetContextOverrides(
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
function applyBudgetProfileOverrides(
    profile: Record<string, unknown>,
    resolution: BudgetTierResolution,
    config: Record<string, unknown> | null
): Record<string, unknown> {
    const tier = getActiveTierConfig(config, resolution.tier_label);
    if (!tier) return profile;

    const result = { ...profile };

    // Override operations
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

    // Override parser parameters
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
function applyBudgetCeilingOverride(
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

export interface ResolveFilterStrOptions {
    allowEmpty?: boolean;
}

export interface AddUniqueLinesOptions {
    limit?: number;
}

export interface SelectMatchingLinesOptions {
    limit?: number;
}

export interface CompileStrategyConfig {
    display_name: string;
    full_patterns: string[];
    degraded_patterns: string[];
}

export interface ErrorGroup {
    signature: string;
    representative: string;
    count: number;
}

export interface GroupingResult {
    groups: ErrorGroup[];
    total_matches: number;
    unique_groups: number;
}

export interface ParserResult {
    lines: string[];
    parser_mode: string;
    parser_name: string | null;
    parser_strategy: string | null;
    fallback_mode: string;
    grouping?: GroupingResult | null;
}

export interface FilterProfileResult {
    lines: string[];
    filter_mode: string;
    fallback_mode: string;
    parser_mode: string;
    parser_name: string | null;
    parser_strategy: string | null;
    budget_tier?: string | null;
    grouping?: GroupingResult | null;
}

export interface ApplyOutputFilterProfileOptions {
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

import type { OutputCompactionContributionLike } from '../../../gate-runtime/output-compaction-reporting';
import type { BudgetComparisonResult, BudgetForecast } from '../../../gate-runtime/budget-preflight';
import type { ReviewAttemptSummary } from '../../../gates/task-audit/task-audit-summary-collectors';

export interface TokenContribution extends OutputCompactionContributionLike {}

export interface TaskStatsResult {
    task_id: string;
    events_count: number;
    first_event_utc: string | null;
    last_event_utc: string | null;
    wall_clock_seconds: number | null;
    gate_pass_count: number;
    gate_fail_count: number;
    path_mode: string | null;
    required_reviews: string[];
    changed_files_count: number;
    changed_lines_total: number;
    requested_depth: number | null;
    effective_depth: number | null;
    depth_escalated: boolean;
    review_attempt_summary?: ReviewAttemptSummary | null;
    budget_forecast: BudgetForecast | null;
    budget_comparison: BudgetComparisonResult | null;
    token_economy: TokenEconomySummary;
}

export interface TokenEconomySummary {
    total_estimated_saved_chars: number;
    total_raw_char_count: number;
    total_output_char_count: number;
    total_estimated_saved_tokens: number;
    total_raw_token_count_estimate: number;
    chars_savings_percent: number | null;
    savings_percent: number | null;
    breakdown: TokenContribution[];
    visible_summary_line: string | null;
}

export interface AggregateStatsResult {
    tasks_analyzed: number;
    total_events: number;
    total_wall_clock_seconds: number;
    total_gate_pass: number;
    total_gate_fail: number;
    total_estimated_saved_chars: number;
    total_raw_char_count: number;
    aggregate_chars_savings_percent: number | null;
    total_estimated_saved_tokens: number;
    total_raw_token_count_estimate: number;
    aggregate_savings_percent: number | null;
    per_task: TaskStatsResult[];
}

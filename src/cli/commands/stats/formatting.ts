import type { ReviewAttemptTypeSummary } from '../../../gates/task-audit/task-audit-summary-collectors';
import { bold, cyan, dim, green, red, yellow } from '../cli-format-output';
import type { AggregateStatsResult, TaskStatsResult } from './types';

function formatWallClock(seconds: number | null): string {
    if (seconds == null || seconds <= 0) return '(unknown)';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainder}s`;
    const hours = Math.floor(minutes / 60);
    const remainMin = minutes % 60;
    return `${hours}h ${remainMin}m ${remainder}s`;
}

function formatGateFailCount(count: number): string {
    return count > 0 ? red(`${count} failed`) : dim(`${count} failed`);
}

function formatPercentNote(percent: number | null): string {
    return percent != null ? yellow(`~${percent}%`) : '';
}

function formatReviewAttemptCount(value: number, colorize: (text: string) => string): string {
    return value > 0 ? colorize(String(value)) : dim(String(value));
}

function formatReviewAttemptTypeSummary(entry: ReviewAttemptTypeSummary): string {
    return [
        `${cyan(entry.review_type)}:`,
        `${formatReviewAttemptCount(entry.pass_count, green)} pass`,
        `${formatReviewAttemptCount(entry.fail_count, red)} fail`,
        `${formatReviewAttemptCount(entry.reused_count, yellow)} reused`,
        `${formatReviewAttemptCount(entry.missing_or_invalid_count, yellow)} missing/invalid`
    ].join(' ');
}

export function formatTaskStatsText(stats: TaskStatsResult): string {
    const lines: string[] = [];
    lines.push(`${bold('Task:')} ${cyan(stats.task_id)}`);
    lines.push(`${bold('Events:')} ${stats.events_count}`);
    if (stats.first_event_utc) lines.push(`${bold('Started:')} ${stats.first_event_utc}`);
    if (stats.last_event_utc) lines.push(`${bold('Ended:')} ${stats.last_event_utc}`);
    lines.push(`${bold('Duration:')} ${formatWallClock(stats.wall_clock_seconds)}`);
    lines.push(`${bold('Gates:')} ${green(`${stats.gate_pass_count} passed`)}, ${formatGateFailCount(stats.gate_fail_count)}`);
    if (stats.path_mode) lines.push(`${bold('PathMode:')} ${cyan(stats.path_mode)}`);
    if (stats.requested_depth != null && stats.effective_depth != null) {
        if (stats.depth_escalated) {
            lines.push(`${bold('Depth:')} ${stats.requested_depth} -> ${yellow(String(stats.effective_depth))} ${yellow('(escalated)')}`);
        } else {
            lines.push(`${bold('Depth:')} ${stats.effective_depth}`);
        }
    }
    if (stats.required_reviews.length > 0) lines.push(`${bold('Reviews:')} ${stats.required_reviews.map((review) => cyan(review)).join(', ')}`);
    lines.push(`${bold('ChangedFiles:')} ${stats.changed_files_count} (${stats.changed_lines_total} lines)`);

    if (stats.review_attempt_summary && stats.review_attempt_summary.review_types.length > 0) {
        lines.push('');
        lines.push(bold('Review Attempts:'));
        lines.push(`  Total: ${stats.review_attempt_summary.total_attempts}`);
        for (const entry of stats.review_attempt_summary.review_types) {
            lines.push(`  - ${formatReviewAttemptTypeSummary(entry)}`);
        }
    }

    if (stats.budget_forecast) {
        lines.push('');
        lines.push(bold('Budget Forecast:'));
        lines.push(`  Total forecast: ~${stats.budget_forecast.total_forecast_tokens} tokens`);
        if (stats.budget_forecast.token_economy_active_for_depth) {
            lines.push(`  ${green(`Effective forecast: ~${stats.budget_forecast.effective_forecast_tokens} tokens`)}`);
        }
    }

    if (stats.budget_comparison && stats.budget_comparison.forecast_total_tokens > 0) {
        lines.push(`  ${stats.budget_comparison.summary_line}`);
    }

    if (stats.token_economy.total_estimated_saved_chars > 0 || stats.token_economy.total_estimated_saved_tokens > 0) {
        lines.push('');
        lines.push(bold('Token Economy:'));
        if (stats.token_economy.visible_summary_line) {
            lines.push(`  ${green(stats.token_economy.visible_summary_line)}`);
        }
        for (const item of stats.token_economy.breakdown) {
            if (item.estimated_saved_chars > 0) {
                const notes = [
                    item.raw_char_count > 0 ? `raw ~${item.raw_char_count} chars` : null,
                    item.estimated_saved_tokens > 0 ? `suppressed output estimate ~${item.estimated_saved_tokens} tokens` : null
                ].filter((entry) => !!entry).join(', ');
                lines.push(`  - ${cyan(item.label)}: ${green(`~${item.estimated_saved_chars} chars suppressed`)}${notes ? ` (${dim(notes)})` : ''}`);
            } else if (item.estimated_saved_tokens > 0) {
                const notes = item.raw_token_count_estimate > 0
                    ? `raw ~${item.raw_token_count_estimate} tokens`
                    : '';
                lines.push(`  - ${cyan(item.label)}: ${green(`suppressed output estimate ~${item.estimated_saved_tokens} tokens`)}${notes ? ` (${dim(notes)})` : ''}`);
            }
        }
    } else {
        lines.push('');
        lines.push(`${bold('Token Economy:')} ${dim('no savings recorded')}`);
    }

    return lines.join('\n');
}

export function formatAggregateStatsText(stats: AggregateStatsResult): string {
    const lines: string[] = [];
    lines.push(bold('GARDA_STATS'));
    lines.push(`${bold('Tasks analyzed:')} ${stats.tasks_analyzed}`);
    lines.push(`${bold('Total events:')} ${stats.total_events}`);
    lines.push(`${bold('Total duration:')} ${formatWallClock(stats.total_wall_clock_seconds)}`);
    lines.push(`${bold('Total gates:')} ${green(`${stats.total_gate_pass} passed`)}, ${formatGateFailCount(stats.total_gate_fail)}`);

    if (stats.total_estimated_saved_chars > 0 || stats.total_estimated_saved_tokens > 0) {
        const partialCharCoverage = stats.total_estimated_saved_chars > 0
            && stats.total_estimated_saved_tokens > 0
            && stats.aggregate_chars_savings_percent == null;
        if (stats.total_estimated_saved_chars > 0) {
            const pctNote = stats.aggregate_chars_savings_percent != null
                ? ` (${formatPercentNote(stats.aggregate_chars_savings_percent)})`
                : '';
            const label = partialCharCoverage
                ? 'Total suppressed output (char-aware subset)'
                : 'Total suppressed output';
            lines.push(`${bold(`${label}:`)} ${green(`~${stats.total_estimated_saved_chars} chars`)}${pctNote}`);
        } else if (stats.total_raw_char_count > 0) {
            lines.push(`${bold('Total suppressed output:')} 0 chars`);
        } else if (stats.total_estimated_saved_tokens > 0) {
            lines.push(`${bold('Total suppressed output:')} ${yellow('unavailable')} ${dim('(legacy token-only artifacts)')}`);
        }
        if (stats.total_estimated_saved_tokens > 0) {
            lines.push(`${bold('Total suppressed output estimate:')} ${green(`~${stats.total_estimated_saved_tokens} tokens`)}`);
        }
        if (stats.total_raw_char_count > 0) {
            lines.push(`${bold('Total raw chars:')} ~${stats.total_raw_char_count}`);
        }
        if (stats.total_raw_token_count_estimate > 0) {
            lines.push(`${bold('Total raw tokens:')} ~${stats.total_raw_token_count_estimate}`);
        }
    } else {
        lines.push(`${bold('Total suppressed output:')} 0 chars`);
    }

    if (stats.per_task.length > 0) {
        lines.push('');
        lines.push(bold('Per-task summary:'));
        for (const task of stats.per_task) {
            const partialCharCoverage = task.token_economy.total_estimated_saved_chars > 0
                && task.token_economy.total_estimated_saved_tokens > 0
                && task.token_economy.chars_savings_percent == null;
            const savedNote = task.token_economy.total_estimated_saved_chars > 0
                ? partialCharCoverage
                    ? `, ~${task.token_economy.total_estimated_saved_chars} chars suppressed (char-aware subset; suppressed output estimate ~${task.token_economy.total_estimated_saved_tokens} tokens)`
                    : `, ~${task.token_economy.total_estimated_saved_chars} chars suppressed`
                : task.token_economy.total_estimated_saved_tokens > 0
                    ? `, suppressed output estimate ~${task.token_economy.total_estimated_saved_tokens} tokens`
                    : '';
            const durationNote = formatWallClock(task.wall_clock_seconds);
            lines.push(`  ${cyan(task.task_id)}: ${task.events_count} events, ${durationNote}${savedNote}`);
        }
    }

    return lines.join('\n');
}

export function formatTaskStatsJson(stats: TaskStatsResult): string {
    return JSON.stringify(stats, null, 2);
}

export function formatAggregateStatsJson(stats: AggregateStatsResult): string {
    const stableAggregateStats = {
        ...stats,
        per_task: stats.per_task.map((taskStats) => {
            const { review_attempt_summary: _reviewAttemptSummary, ...aggregateTaskStats } = taskStats;
            return aggregateTaskStats;
        })
    };
    return JSON.stringify(stableAggregateStats, null, 2);
}

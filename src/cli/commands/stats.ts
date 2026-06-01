import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    getGateOutputCompactionLabel,
    getReviewContextOutputLabel,
    summarizeOutputCompactionBreakdown,
    type OutputCompactionContributionLike
} from '../../gate-runtime/output-compaction-reporting';
import { assertValidTaskId, forEachJsonlLine } from '../../gate-runtime/task-events';
import { parseTaskIdJsonlFileName } from '../../core/task-ids';
import { coerceIntLike } from '../../gate-runtime/token-telemetry';
import { buildBudgetComparison, type BudgetForecast, type BudgetComparisonResult } from '../../gate-runtime/budget-preflight';
import { joinOrchestratorPath, resolvePathInsideRepo, toPosix } from '../../gates/shared/helpers';
import {
    buildReviewAttemptSummary,
    type ReviewAttemptSummary,
    type ReviewAttemptTypeSummary
} from '../../gates/task-audit/task-audit-summary-collectors';
import type { ReviewReuseTelemetryEventLike } from '../../gates/review-reuse/review-reuse-telemetry';
import { bold, cyan, dim, green, red, yellow } from './cli-format-output';
import {
    parseTimestamp,
    getOutputTelemetryFromPayload,
    buildTaskCycleBindingKey,
    getCycleBindingSnapshotFromPayload,
    getCurrentCycleReviewContextPaths,
    resolveTaskCycleBindingSnapshot,
    shouldIncludeTelemetryForCurrentCycle
} from '../../gates/task-events-summary/task-events-summary';

interface TokenContribution extends OutputCompactionContributionLike {}

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

// Gate outcome event types used for pass/fail counting.
const GATE_PASS_EVENTS = new Set([
    'RULE_PACK_LOADED',
    'PREFLIGHT_CLASSIFIED',
    'COMPILE_GATE_PASSED',
    'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE',
    'DOC_IMPACT_ASSESSED',
    'FULL_SUITE_VALIDATION_PASSED',
    'FULL_SUITE_VALIDATION_WARNED',
    'FULL_SUITE_VALIDATION_SKIPPED',
    'COMPLETION_GATE_PASSED'
]);

const GATE_FAIL_EVENTS = new Set([
    'RULE_PACK_LOAD_FAILED',
    'PREFLIGHT_FAILED',
    'COMPILE_GATE_FAILED',
    'REVIEW_GATE_FAILED',
    'DOC_IMPACT_ASSESSMENT_FAILED',
    'FULL_SUITE_VALIDATION_FAILED',
    'COMPLETION_GATE_FAILED'
]);

function safeReadJson(filePath: string): Record<string, unknown> | null {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function getReviewContextSummary(payload: Record<string, unknown> | null | undefined): TokenContribution | null {
    if (!payload || typeof payload !== 'object') return null;
    const ruleContext = payload.rule_context as Record<string, unknown> | null | undefined;
    if (!ruleContext || typeof ruleContext !== 'object') return null;
    const summary = ruleContext.summary as Record<string, unknown> | null | undefined;
    if (!summary || typeof summary !== 'object') return null;
    const savedTokens = coerceIntLike(summary.estimated_saved_tokens);
    const savedChars = coerceIntLike(summary.estimated_saved_chars);
    if ((savedTokens == null || savedTokens <= 0) && (savedChars == null || savedChars <= 0)) return null;
    const rawTokenEstimate = coerceIntLike(summary.original_token_count_estimate);
    const rawCharCount = coerceIntLike(summary.original_char_count);
    const outputCharCount = coerceIntLike(summary.output_char_count);
    const reviewType = String(payload.review_type || '').trim().toLowerCase();
    return {
        label: getReviewContextOutputLabel(reviewType),
        estimated_saved_chars: savedChars != null && savedChars > 0 ? savedChars : 0,
        estimated_saved_tokens: savedTokens != null && savedTokens > 0 ? savedTokens : 0,
        raw_char_count: rawCharCount != null && rawCharCount > 0 ? rawCharCount : 0,
        output_char_count: outputCharCount != null && outputCharCount >= 0 ? outputCharCount : null,
        raw_token_count_estimate: rawTokenEstimate != null && rawTokenEstimate > 0 ? rawTokenEstimate : 0
    };
}

function resolveArtifactPathForRead(pathValue: unknown, repoRoot: string | null): string | null {
    if (pathValue == null) return null;
    const text = String(pathValue).trim();
    if (!text) return null;
    if (repoRoot) {
        try {
            return resolvePathInsideRepo(text, repoRoot, { allowMissing: true });
        } catch {
            return null;
        }
    }
    if (path.isAbsolute(text)) return path.resolve(text);
    return null;
}

function readJsonArtifact(pathValue: unknown, repoRoot: string | null): Record<string, unknown> | null {
    const resolvedPath = resolveArtifactPathForRead(pathValue, repoRoot);
    if (!resolvedPath) return null;
    try {
        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) return null;
        return JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    } catch {
        return null;
    }
}

function getCommandOutputLabel(eventType: string): string {
    return getGateOutputCompactionLabel(eventType);
}

function getCommandOutputSourceKey(
    eventType: string,
    details: Record<string, unknown>,
    index: number,
    repoRoot: string
): string {
    const normalizedEventType = String(eventType || '').trim().toUpperCase();
    if (normalizedEventType.startsWith('FULL_SUITE_VALIDATION_')) {
        const cycleKey = buildTaskCycleBindingKey(getCycleBindingSnapshotFromPayload(details, repoRoot));
        if (cycleKey) {
            return `command-output:full-suite-cycle:${cycleKey}`;
        }
        if (typeof details.artifact_path === 'string' && details.artifact_path.trim()) {
            const resolved = resolveArtifactPathForRead(details.artifact_path, repoRoot);
            const normalizedPath = resolved ? toPosix(resolved) : String(details.artifact_path).trim();
            if (normalizedPath) {
                return `command-output:${normalizedPath}`;
            }
        }
    }
    return `command-output:event:${index}:${eventType}`;
}

export function buildTaskStats(
    taskId: string,
    repoRoot: string,
    eventsRoot?: string | null,
    reviewsRoot?: string | null,
    options: { includeReviewAttemptSummary?: boolean } = {}
): TaskStatsResult {
    const resolvedRepoRoot = path.resolve(repoRoot);
    const safeTaskId = assertValidTaskId(taskId);
    const resolvedEventsRoot = eventsRoot
        ? resolvePathInsideRepo(eventsRoot, resolvedRepoRoot, { allowMissing: true }) || eventsRoot
        : joinOrchestratorPath(resolvedRepoRoot, path.join('runtime', 'task-events'));
    const resolvedReviewsRoot = reviewsRoot
        ? resolvePathInsideRepo(reviewsRoot, resolvedRepoRoot, { allowMissing: true }) || reviewsRoot
        : joinOrchestratorPath(resolvedRepoRoot, path.join('runtime', 'reviews'));

    const taskEventFile = path.join(resolvedEventsRoot, `${safeTaskId}.jsonl`);

    const events: Record<string, unknown>[] = [];
    if (fs.existsSync(taskEventFile) && fs.statSync(taskEventFile).isFile()) {
        forEachJsonlLine(taskEventFile, (line: string) => {
            try {
                const event = JSON.parse(line);
                if (event != null) events.push(event);
            } catch {
                // skip parse errors
            }
        });
    }

    events.sort((a, b) => {
        const ta = parseTimestamp(a.timestamp_utc);
        const tb = parseTimestamp(b.timestamp_utc);
        return ta.getTime() - tb.getTime();
    });

    const firstDate = events.length > 0 ? parseTimestamp(events[0].timestamp_utc) : null;
    const lastDate = events.length > 0 ? parseTimestamp(events[events.length - 1].timestamp_utc) : null;
    const firstUtc = firstDate && firstDate.getTime() > 0 ? firstDate.toISOString() : null;
    const lastUtc = lastDate && lastDate.getTime() > 0 ? lastDate.toISOString() : null;

    let wallClockSeconds: number | null = null;
    if (firstDate && lastDate && firstDate.getTime() > 0 && lastDate.getTime() > 0) {
        wallClockSeconds = Math.round((lastDate.getTime() - firstDate.getTime()) / 1000);
    }

    // Gate pass/fail counts
    let gatePassCount = 0;
    let gateFail = 0;
    for (const event of events) {
        const eventType = String(event.event_type || '');
        if (GATE_PASS_EVENTS.has(eventType)) gatePassCount += 1;
        if (GATE_FAIL_EVENTS.has(eventType)) gateFail += 1;
    }

    let pathMode: string | null = null;
    let requiredReviews: string[] = [];
    let changedFilesCount = 0;
    let changedLinesTotal = 0;

    const preflightPath = path.join(resolvedReviewsRoot, `${safeTaskId}-preflight.json`);
    const preflight = safeReadJson(preflightPath);
    if (preflight) {
        pathMode = typeof preflight.mode === 'string' ? preflight.mode : null;
        if (preflight.required_reviews && typeof preflight.required_reviews === 'object') {
            const rr = preflight.required_reviews as Record<string, unknown>;
            requiredReviews = Object.entries(rr).filter(([, v]) => v === true).map(([k]) => k);
        }
        if (Array.isArray(preflight.changed_files)) {
            changedFilesCount = preflight.changed_files.length;
        }
        const metrics = preflight.metrics as Record<string, unknown> | null | undefined;
        if (metrics && typeof metrics === 'object') {
            changedLinesTotal = Number(metrics.changed_lines_total) || 0;
        }
    }

    let requestedDepth: number | null = null;
    let effectiveDepth: number | null = null;
    let depthEscalated = false;
    let budgetForecast: BudgetForecast | null = null;

    if (preflight) {
        const bf = preflight.budget_forecast as Record<string, unknown> | null | undefined;
        if (bf && typeof bf === 'object') {
            budgetForecast = bf as unknown as BudgetForecast;
            requestedDepth = typeof bf.requested_depth === 'number' ? bf.requested_depth : null;
            effectiveDepth = typeof bf.effective_depth === 'number' ? bf.effective_depth : null;
            depthEscalated = bf.depth_escalated === true;
        }
        const de = preflight.depth_escalation as Record<string, unknown> | null | undefined;
        if (de && typeof de === 'object') {
            if (requestedDepth == null && typeof de.requested_depth === 'number') {
                requestedDepth = de.requested_depth;
            }
            if (effectiveDepth == null && typeof de.effective_depth === 'number') {
                effectiveDepth = de.effective_depth;
            }
            if (!depthEscalated && de.escalated === true) {
                depthEscalated = true;
            }
        }
    }

    const taskModePath = path.join(resolvedReviewsRoot, `${safeTaskId}-task-mode.json`);
    const taskMode = safeReadJson(taskModePath);
    if (taskMode) {
        if (requestedDepth == null && typeof taskMode.requested_depth === 'number') {
            requestedDepth = taskMode.requested_depth;
        }
        if (effectiveDepth == null && typeof taskMode.effective_depth === 'number') {
            effectiveDepth = taskMode.effective_depth;
        }
        if (requestedDepth != null && effectiveDepth != null && effectiveDepth > requestedDepth) {
            depthEscalated = true;
        }
    }

    const tokenEconomy = buildTokenEconomy(events, resolvedRepoRoot, resolvedReviewsRoot, safeTaskId);
    const reviewAttemptSummary = options.includeReviewAttemptSummary === false
        ? null
        : buildReviewAttemptSummary({
            reviewsRoot: resolvedReviewsRoot,
            taskId: safeTaskId,
            timelineEvents: events as ReviewReuseTelemetryEventLike[]
        });

    const budgetComparison = buildBudgetComparison(
        safeTaskId,
        budgetForecast,
        tokenEconomy.total_estimated_saved_tokens,
        tokenEconomy.total_raw_token_count_estimate
    );

    return {
        task_id: safeTaskId,
        events_count: events.length,
        first_event_utc: firstUtc,
        last_event_utc: lastUtc,
        wall_clock_seconds: wallClockSeconds,
        gate_pass_count: gatePassCount,
        gate_fail_count: gateFail,
        path_mode: pathMode,
        required_reviews: requiredReviews,
        changed_files_count: changedFilesCount,
        changed_lines_total: changedLinesTotal,
        requested_depth: requestedDepth,
        effective_depth: effectiveDepth,
        depth_escalated: depthEscalated,
        review_attempt_summary: reviewAttemptSummary,
        budget_forecast: budgetForecast,
        budget_comparison: budgetComparison,
        token_economy: tokenEconomy
    };
}

function buildTokenEconomy(
    events: Record<string, unknown>[],
    repoRoot: string,
    reviewsRoot: string,
    taskId: string
): TokenEconomySummary {
    const breakdown: TokenContribution[] = [];
    const sourceIndexByKey = new Map<string, number>();
    const currentCycle = resolveTaskCycleBindingSnapshot(taskId, events, repoRoot, reviewsRoot);

    function addContribution(key: string, contribution: TokenContribution): void {
        if (contribution.estimated_saved_tokens <= 0 && contribution.estimated_saved_chars <= 0) return;
        const existingIndex = sourceIndexByKey.get(key);
        if (existingIndex != null) {
            breakdown[existingIndex] = contribution;
            return;
        }
        sourceIndexByKey.set(key, breakdown.length);
        breakdown.push(contribution);
    }

    function normalizeArtifactKey(rawPath: string): string {
        const resolved = resolveArtifactPathForRead(rawPath, repoRoot);
        return resolved ? toPosix(resolved) : rawPath;
    }

    for (let i = 0; i < events.length; i += 1) {
        const event = events[i];
        const rawDetails = event && typeof event === 'object' ? event.details : null;
        if (!rawDetails || typeof rawDetails !== 'object') continue;
        const details = rawDetails as Record<string, unknown>;
        const eventType = String(event.event_type || 'UNKNOWN');

        let reviewEvidencePayload: Record<string, unknown> | null = null;

        if (typeof details.review_evidence_path === 'string' && details.review_evidence_path.trim()) {
            const artifact = readJsonArtifact(details.review_evidence_path, repoRoot);
            if (artifact) {
                reviewEvidencePayload = artifact;
                const telemetry = getOutputTelemetryFromPayload(artifact);
                const includeCurrentCycleTelemetry = shouldIncludeTelemetryForCurrentCycle(
                    eventType,
                    event.timestamp_utc,
                    artifact,
                    currentCycle,
                    repoRoot
                );
                if (telemetry && includeCurrentCycleTelemetry) {
                    const normalizedKey = normalizeArtifactKey(String(details.review_evidence_path));
                    addContribution(`command-output:${normalizedKey}`, {
                        label: getCommandOutputLabel(eventType),
                        estimated_saved_chars: telemetry.estimated_saved_chars,
                        estimated_saved_tokens: telemetry.estimated_saved_tokens,
                        raw_char_count: telemetry.raw_char_count,
                        output_char_count: telemetry.output_char_count,
                        raw_token_count_estimate: telemetry.raw_token_count_estimate
                    });
                }
                if (includeCurrentCycleTelemetry) {
                    collectReviewContextFromContainer(artifact, repoRoot, sourceIndexByKey, breakdown, normalizeArtifactKey);
                }
            }
        }

        if (!reviewEvidencePayload) {
            const telemetry = getOutputTelemetryFromPayload(details);
            const includeCurrentCycleTelemetry = shouldIncludeTelemetryForCurrentCycle(
                eventType,
                event.timestamp_utc,
                details,
                currentCycle,
                repoRoot
            );
            if (telemetry && includeCurrentCycleTelemetry) {
                addContribution(getCommandOutputSourceKey(eventType, details, i + 1, repoRoot), {
                    label: getCommandOutputLabel(eventType),
                    estimated_saved_chars: telemetry.estimated_saved_chars,
                    estimated_saved_tokens: telemetry.estimated_saved_tokens,
                    raw_char_count: telemetry.raw_char_count,
                    output_char_count: telemetry.output_char_count,
                    raw_token_count_estimate: telemetry.raw_token_count_estimate
                });
            }
            if (includeCurrentCycleTelemetry) {
                collectReviewContextFromContainer(details, repoRoot, sourceIndexByKey, breakdown, normalizeArtifactKey);
            }
        }
    }

    const currentCycleReviewContextPaths = currentCycle?.compile_gate_timestamp
        ? getCurrentCycleReviewContextPaths(events, currentCycle, repoRoot)
        : new Map<string, string>([
            ['code', path.join(reviewsRoot, `${taskId}-code-review-context.json`)],
            ['db', path.join(reviewsRoot, `${taskId}-db-review-context.json`)],
            ['security', path.join(reviewsRoot, `${taskId}-security-review-context.json`)],
            ['refactor', path.join(reviewsRoot, `${taskId}-refactor-review-context.json`)],
            ['api', path.join(reviewsRoot, `${taskId}-api-review-context.json`)],
            ['test', path.join(reviewsRoot, `${taskId}-test-review-context.json`)],
            ['performance', path.join(reviewsRoot, `${taskId}-performance-review-context.json`)],
            ['infra', path.join(reviewsRoot, `${taskId}-infra-review-context.json`)],
            ['dependency', path.join(reviewsRoot, `${taskId}-dependency-review-context.json`)]
        ]);
    for (const [, contextPath] of currentCycleReviewContextPaths.entries()) {
        const contextKey = `review-context:${toPosix(contextPath)}`;
        if (sourceIndexByKey.has(contextKey)) continue;
        const payload = safeReadJson(contextPath);
        if (!payload) continue;
        const summary = getReviewContextSummary(payload);
        if (summary) {
            addContribution(contextKey, summary);
        }
    }

    const aggregateSummary = summarizeOutputCompactionBreakdown(breakdown);

    return {
        total_estimated_saved_chars: aggregateSummary.total_estimated_saved_chars,
        total_raw_char_count: aggregateSummary.total_raw_char_count,
        total_output_char_count: aggregateSummary.total_output_char_count,
        total_estimated_saved_tokens: aggregateSummary.total_estimated_saved_tokens,
        total_raw_token_count_estimate: aggregateSummary.total_raw_token_count_estimate,
        chars_savings_percent: aggregateSummary.chars_savings_percent,
        savings_percent: aggregateSummary.savings_percent,
        breakdown,
        visible_summary_line: aggregateSummary.visible_summary_line
    };
}

function collectReviewContextFromContainer(
    container: Record<string, unknown>,
    repoRoot: string,
    sourceIndexByKey: Map<string, number>,
    breakdown: TokenContribution[],
    normalizeKey?: (rawPath: string) => string
): void {
    if (!container || typeof container !== 'object') return;
    const artifactEvidence = container.artifact_evidence as Record<string, unknown> | null | undefined;
    const checked = artifactEvidence && Array.isArray((artifactEvidence as Record<string, unknown>).checked)
        ? (artifactEvidence as Record<string, unknown>).checked as Record<string, unknown>[]
        : [];
    for (const entry of checked) {
        if (!entry || typeof entry !== 'object' || !entry.review_context_path) continue;
        const payload = readJsonArtifact(entry.review_context_path, repoRoot);
        if (!payload) continue;
        const summary = getReviewContextSummary(payload);
        if (!summary) continue;
        const rawPathStr = String(entry.review_context_path);
        const normalizedPath = normalizeKey ? normalizeKey(rawPathStr) : rawPathStr;
        const key = `review-context:${normalizedPath}`;
        const existingIndex = sourceIndexByKey.get(key);
        if (existingIndex != null) {
            breakdown[existingIndex] = summary;
            continue;
        }
        sourceIndexByKey.set(key, breakdown.length);
        breakdown.push(summary);
    }
}

export function buildAggregateStats(
    repoRoot: string,
    eventsRoot?: string | null,
    reviewsRoot?: string | null
): AggregateStatsResult {
    const resolvedRepoRoot = path.resolve(repoRoot);
    const resolvedEventsRoot = eventsRoot
        ? resolvePathInsideRepo(eventsRoot, resolvedRepoRoot, { allowMissing: true }) || eventsRoot
        : joinOrchestratorPath(resolvedRepoRoot, path.join('runtime', 'task-events'));

    const taskIds: string[] = [];
    if (fs.existsSync(resolvedEventsRoot) && fs.statSync(resolvedEventsRoot).isDirectory()) {
        for (const entry of fs.readdirSync(resolvedEventsRoot)) {
            const taskId = parseTaskIdJsonlFileName(entry);
            if (taskId) taskIds.push(taskId);
        }
    }
    taskIds.sort();

    const perTask: TaskStatsResult[] = [];
    for (const tid of taskIds) {
        perTask.push(buildTaskStats(tid, resolvedRepoRoot, eventsRoot, reviewsRoot, {
            includeReviewAttemptSummary: false
        }));
    }

    const totalEvents = perTask.reduce((sum, t) => sum + t.events_count, 0);
    const totalWall = perTask.reduce((sum, t) => sum + (t.wall_clock_seconds || 0), 0);
    const totalPass = perTask.reduce((sum, t) => sum + t.gate_pass_count, 0);
    const totalFail = perTask.reduce((sum, t) => sum + t.gate_fail_count, 0);
    const totalSavedChars = perTask.reduce((sum, t) => sum + t.token_economy.total_estimated_saved_chars, 0);
    const totalRawChars = perTask.reduce((sum, t) => sum + t.token_economy.total_raw_char_count, 0);
    const totalSaved = perTask.reduce((sum, t) => sum + t.token_economy.total_estimated_saved_tokens, 0);
    const totalRaw = perTask.reduce((sum, t) => sum + t.token_economy.total_raw_token_count_estimate, 0);
    const aggregateCharCoverageComplete = perTask.every((task) => {
        const tokenEconomy = task.token_economy;
        if (tokenEconomy.total_estimated_saved_chars <= 0 && tokenEconomy.total_estimated_saved_tokens <= 0) {
            return true;
        }
        if (tokenEconomy.total_estimated_saved_chars <= 0) {
            return false;
        }
        return tokenEconomy.chars_savings_percent != null;
    });
    const aggCharsPercent = aggregateCharCoverageComplete && totalRawChars > 0
        ? Math.round((totalSavedChars * 100.0) / totalRawChars)
        : null;
    const aggPercent = totalRaw > 0 ? Math.round((totalSaved * 100.0) / totalRaw) : null;

    return {
        tasks_analyzed: perTask.length,
        total_events: totalEvents,
        total_wall_clock_seconds: totalWall,
        total_gate_pass: totalPass,
        total_gate_fail: totalFail,
        total_estimated_saved_chars: totalSavedChars,
        total_raw_char_count: totalRawChars,
        aggregate_chars_savings_percent: aggCharsPercent,
        total_estimated_saved_tokens: totalSaved,
        total_raw_token_count_estimate: totalRaw,
        aggregate_savings_percent: aggPercent,
        per_task: perTask
    };
}

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

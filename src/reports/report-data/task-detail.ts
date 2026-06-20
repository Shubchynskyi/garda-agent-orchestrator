import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { buildTaskStats, type TaskStatsResult } from '../../cli/commands/stats';
import { joinOrchestratorPath, toPosix } from '../../gates/shared/helpers';
import {
    buildCompactLatestCycleTaskEventsSummary,
    buildTaskEventsSummary,
    type CompactLatestCycleTaskEventsSummary,
    type TaskEventsSummaryResult
} from '../../gates/task-events-summary';
import { buildTaskAuditSummary, type TaskAuditSummaryResult } from '../../gates/task-audit/task-audit-summary';
import {
    buildFullSuiteTimeoutForecast,
    formatFullSuiteTimeoutForecast,
    isFullSuiteNotRequiredForZeroDiffNoReviewableScope,
    loadFullSuiteValidationConfig,
    type FullSuiteValidationResult
} from '../../gates/full-suite/full-suite-validation';
import { getTaskModeEvidence, readOptionalMarkdownWorkingPlan } from '../../gates/task-mode';
import { readCanonicalActiveQueueRows } from './task-queue';
import type {
    BuildReportTaskDetailOptions,
    ReportArtifactLink,
    ReportDataUnavailableEntry,
    ReportFullSuiteFreshness,
    ReportFullSuiteState,
    ReportFullSuiteSummary,
    ReportTaskDetail,
    ReportTaskQueueRow
} from './types';
import { DEFAULT_REPORT_MAX_DETAILED_TASKS } from './types';

const TERMINAL_TASK_STATUS_TOKENS = new Set(['DONE']);

function readLatestCycleEvents(
    taskId: string,
    repoRoot: string,
    eventsRoot: string,
    reviewsRoot: string,
    unavailable: ReportDataUnavailableEntry[]
): CompactLatestCycleTaskEventsSummary | null {
    try {
        const summary = buildTaskEventsSummary({
            taskId,
            eventsRoot,
            repoRoot,
            reviewsRoot
        }) as TaskEventsSummaryResult;
        return buildCompactLatestCycleTaskEventsSummary(summary);
    } catch (error: unknown) {
        unavailable.push({
            scope: `task:${taskId}:events`,
            reason: error instanceof Error ? error.message : String(error)
        });
        return null;
    }
}

function readTaskAuditSummary(
    taskId: string,
    repoRoot: string,
    eventsRoot: string,
    reviewsRoot: string,
    unavailable: ReportDataUnavailableEntry[]
): TaskAuditSummaryResult | null {
    try {
        return buildTaskAuditSummary({
            taskId,
            repoRoot,
            eventsRoot,
            reviewsRoot
        });
    } catch (error: unknown) {
        unavailable.push({
            scope: `task:${taskId}:audit`,
            reason: error instanceof Error ? error.message : String(error)
        });
        return null;
    }
}

function summarizeTaskAudit(audit: TaskAuditSummaryResult): ReportTaskDetail['audit'] {
    return {
        status: audit.status,
        gates: audit.gates,
        blockers: audit.blockers,
        required_reviews: audit.required_reviews,
        changed_files: audit.changed_files,
        review_attempt_summary: audit.review_attempt_summary,
        final_report_contract_status: audit.final_report_contract.status,
        final_closeout_artifact_state: audit.final_closeout.artifact_state
    };
}

function fileSha256(filePath: string): string | null {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return null;
        }
        return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    } catch {
        return null;
    }
}

function safeReadJsonRecord(filePath: string): Record<string, unknown> | null {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return null;
        }
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
}

function normalizeStatus(value: unknown): FullSuiteValidationResult['status'] | null {
    const normalized = String(value || '').trim().toUpperCase();
    if (normalized === 'PASSED' || normalized === 'FAILED' || normalized === 'WARNED' || normalized === 'SKIPPED') {
        return normalized;
    }
    return null;
}

function normalizeDurationMs(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.round(value)
        : null;
}

function formatDurationMs(durationMs: number | null): string | null {
    if (durationMs == null) {
        return null;
    }
    if (durationMs < 1000) {
        return `${durationMs} ms`;
    }
    const secondsText = (seconds: number): string => seconds.toFixed(1).replace(/\.0$/, '');
    const totalSeconds = durationMs / 1000;
    if (totalSeconds < 60) {
        return `${secondsText(totalSeconds)}s`;
    }
    const totalMinutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds - totalMinutes * 60;
    if (totalMinutes < 60) {
        return `${totalMinutes}m ${secondsText(remainingSeconds)}s`;
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m ${secondsText(remainingSeconds)}s`;
}

function readLatestCompileGateTimestamp(eventsRoot: string, taskId: string): string | null {
    const eventFile = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fs.existsSync(eventFile) || !fs.statSync(eventFile).isFile()) {
        return null;
    }
    let latest: string | null = null;
    const lines = fs.readFileSync(eventFile, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.event_type === 'COMPILE_GATE_PASSED') {
                latest = String(event.timestamp_utc || '').trim() || latest;
            }
        } catch {
            // Ignore malformed event lines; the timeline summary reports them separately.
        }
    }
    return latest;
}

function normalizePathText(value: unknown): string | null {
    const text = String(value || '').trim();
    return text ? toPosix(text) : null;
}

function summarizeFullSuiteFreshness(options: {
    required: boolean;
    artifactExists: boolean;
    preflightPath: string;
    preflightSha256: string | null;
    latestCompileGateTimestamp: string | null;
    cycleBinding: Record<string, unknown> | null;
}): { freshness: ReportFullSuiteFreshness; mismatchReason: string | null } {
    if (!options.required) {
        return { freshness: 'not_required', mismatchReason: null };
    }
    if (!options.artifactExists) {
        return { freshness: 'missing', mismatchReason: 'Full-suite validation evidence artifact is missing.' };
    }
    if (!options.cycleBinding) {
        return { freshness: 'stale', mismatchReason: 'Full-suite validation artifact is missing cycle_binding.' };
    }
    const preflightPathMatches = normalizePathText(options.cycleBinding.preflight_path) === toPosix(options.preflightPath);
    const preflightShaMatches = !!options.preflightSha256
        && String(options.cycleBinding.preflight_sha256 || '').trim().toLowerCase() === options.preflightSha256;
    const compileTimestamp = options.cycleBinding.compile_gate_timestamp == null
        ? null
        : String(options.cycleBinding.compile_gate_timestamp || '').trim() || null;
    const compileMatches = !!options.latestCompileGateTimestamp
        && compileTimestamp === options.latestCompileGateTimestamp;
    if (preflightPathMatches && preflightShaMatches && compileMatches) {
        return { freshness: 'current', mismatchReason: null };
    }
    if (preflightPathMatches && preflightShaMatches && options.cycleBinding.scope_binding) {
        return {
            freshness: 'reused_current_scope',
            mismatchReason: 'Full-suite validation artifact is reused for the current preflight scope.'
        };
    }
    const mismatches: string[] = [];
    if (!preflightPathMatches || !preflightShaMatches) {
        mismatches.push('preflight artifact');
    }
    if (!compileMatches) {
        mismatches.push('compile gate cycle');
    }
    return {
        freshness: 'stale',
        mismatchReason: `Full-suite validation cycle binding does not match the current ${mismatches.join(', ')}.`
    };
}

function resolveFullSuiteState(options: {
    required: boolean;
    artifactExists: boolean;
    freshness: ReportFullSuiteFreshness;
    status: FullSuiteValidationResult['status'] | null;
    timedOut: boolean | null;
}): ReportFullSuiteState {
    if (!options.required) {
        return 'not_required';
    }
    if (!options.artifactExists) {
        return 'not_run';
    }
    if (options.freshness === 'stale') {
        return 'stale';
    }
    if (options.timedOut === true) {
        return 'timed_out';
    }
    if (options.status === 'PASSED') {
        return 'passed';
    }
    if (options.status === 'WARNED') {
        return 'warned';
    }
    if (options.status === 'FAILED') {
        return 'failed';
    }
    if (options.status === 'SKIPPED') {
        return 'skipped';
    }
    return 'unavailable';
}

function buildFullSuiteSummary(
    taskId: string,
    repoRoot: string,
    eventsRoot: string,
    reviewsRoot: string
): ReportFullSuiteSummary {
    const config = loadFullSuiteValidationConfig(repoRoot);
    const timeoutForecast = buildFullSuiteTimeoutForecast(repoRoot, config);
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const preflight = safeReadJsonRecord(preflightPath);
    const fullSuiteRequired = config.enabled && !(preflight && isFullSuiteNotRequiredForZeroDiffNoReviewableScope(preflight));
    const artifactPath = path.join(reviewsRoot, `${taskId}-full-suite-validation.json`);
    const artifactExists = fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile();
    const artifact = artifactExists ? safeReadJsonRecord(artifactPath) : null;
    const status = normalizeStatus(artifact?.status);
    const durationMs = normalizeDurationMs(artifact?.duration_ms);
    const timedOut = typeof artifact?.timed_out === 'boolean' ? artifact.timed_out : null;
    const cycleBinding = artifact && artifact.cycle_binding && typeof artifact.cycle_binding === 'object' && !Array.isArray(artifact.cycle_binding)
        ? artifact.cycle_binding as Record<string, unknown>
        : null;
    const freshness = summarizeFullSuiteFreshness({
        required: fullSuiteRequired,
        artifactExists,
        preflightPath,
        preflightSha256: fileSha256(preflightPath),
        latestCompileGateTimestamp: readLatestCompileGateTimestamp(eventsRoot, taskId),
        cycleBinding
    });
    const stat = artifactExists ? fs.statSync(artifactPath) : null;
    return {
        state: resolveFullSuiteState({
            required: fullSuiteRequired,
            artifactExists,
            freshness: freshness.freshness,
            status,
            timedOut
        }),
        freshness: freshness.freshness,
        enabled: config.enabled,
        required: fullSuiteRequired,
        status,
        command: typeof artifact?.command === 'string' && artifact.command.trim() ? artifact.command : config.command,
        placement: config.placement,
        duration_ms: durationMs,
        duration_human: formatDurationMs(durationMs),
        timed_out: timedOut,
        exit_code: typeof artifact?.exit_code === 'number' && Number.isFinite(artifact.exit_code) ? artifact.exit_code : null,
        artifact_path: toPosix(artifactPath),
        artifact_exists: artifactExists,
        artifact_sha256: fileSha256(artifactPath),
        output_artifact_path: normalizePathText(artifact?.output_artifact_path),
        updated_at_utc: stat ? stat.mtime.toISOString() : null,
        compact_summary: toStringArray(artifact?.compact_summary),
        violations: toStringArray(artifact?.violations),
        warnings: toStringArray(artifact?.warnings),
        skip_reason: typeof artifact?.skip_reason === 'string' && artifact.skip_reason.trim() ? artifact.skip_reason : null,
        mismatch_reason: freshness.mismatchReason,
        timeout_forecast: timeoutForecast,
        timeout_forecast_label: formatFullSuiteTimeoutForecast(timeoutForecast)
    };
}

function buildArtifactLinksFromAudit(audit: TaskAuditSummaryResult | null): ReportArtifactLink[] {
    if (!audit) {
        return [];
    }
    return audit.evidence.map((artifact) => ({
        kind: artifact.kind,
        path: toPosix(artifact.path),
        exists: artifact.exists,
        sha256: artifact.sha256
    }));
}

function readPlanMarkdown(repoRoot: string, planPath: string | null): string | null {
    if (!planPath) {
        return null;
    }
    const resolvedPath = path.resolve(repoRoot, planPath);
    if (!resolvedPath.startsWith(path.resolve(repoRoot) + path.sep) && resolvedPath !== path.resolve(repoRoot)) {
        return null;
    }
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        return null;
    }
    return fs.readFileSync(resolvedPath, 'utf8');
}

function buildTaskPlanDetail(repoRoot: string, taskId: string, taskRow: ReportTaskQueueRow | null): ReportTaskDetail['plan'] {
    const evidence = getTaskModeEvidence(repoRoot, taskId);
    const fallbackMarkdownPlan = readOptionalMarkdownWorkingPlan(repoRoot, taskId);
    const markdownPath = evidence.markdown_working_plan?.working_plan_path || fallbackMarkdownPlan?.working_plan_path || null;
    const planPath = evidence.plan?.plan_path || null;
    const markdown = readPlanMarkdown(repoRoot, markdownPath);
    return {
        available: Boolean(markdown || evidence.plan || evidence.markdown_working_plan),
        task_id: taskId,
        task_title: taskRow?.title || evidence.task_summary || null,
        task_status: taskRow?.status_token || taskRow?.status || null,
        summary: evidence.plan?.plan_summary || evidence.task_summary || null,
        plan_path: planPath,
        markdown_path: markdownPath,
        markdown
    };
}

export function buildReportTaskDetail(options: BuildReportTaskDetailOptions): ReportTaskDetail {
    const repoRoot = path.resolve(options.repoRoot);
    const eventsRoot = options.eventsRoot
        ? path.resolve(options.eventsRoot)
        : joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    const reviewsRoot = options.reviewsRoot
        ? path.resolve(options.reviewsRoot)
        : joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const taskId = options.taskId;
    const unavailable: ReportDataUnavailableEntry[] = [];
    const queueRow = readCanonicalActiveQueueRows(repoRoot).rows.find((row) => row.task_id === taskId) || null;
    let stats: TaskStatsResult | null = null;
    try {
        stats = buildTaskStats(taskId, repoRoot, eventsRoot, reviewsRoot, {
            includeReviewAttemptSummary: true
        });
    } catch (error: unknown) {
        unavailable.push({
            scope: `task:${taskId}:stats`,
            reason: error instanceof Error ? error.message : String(error)
        });
    }
    const audit = readTaskAuditSummary(taskId, repoRoot, eventsRoot, reviewsRoot, unavailable);

    return {
        task_id: taskId,
        detail_status: 'loaded',
        stats,
        latest_cycle_events: readLatestCycleEvents(taskId, repoRoot, eventsRoot, reviewsRoot, unavailable),
        full_suite_validation: buildFullSuiteSummary(taskId, repoRoot, eventsRoot, reviewsRoot),
        audit: audit ? summarizeTaskAudit(audit) : null,
        plan: buildTaskPlanDetail(repoRoot, taskId, queueRow),
        artifact_links: buildArtifactLinksFromAudit(audit),
        unavailable
    };
}

export function isLazyReportDetailEntry(entry: ReportDataUnavailableEntry): boolean {
    return /^task:[^:]+:detail$/u.test(entry.scope)
        && (
            entry.reason.includes('Deep task details are lazy')
            || entry.reason.includes('detail collection is limited')
        );
}

export function buildSkippedTaskDetail(taskId: string, maxDetailedTasks: number): ReportTaskDetail {
    const detailLimitReason = maxDetailedTasks === 0
        ? 'Deep task details are lazy for static reports and are not collected by default'
        : `Initial report detail collection is limited to ${maxDetailedTasks} task(s)`;
    return {
        task_id: taskId,
        detail_status: 'skipped',
        stats: null,
        latest_cycle_events: null,
        full_suite_validation: {
            state: 'not_required',
            freshness: 'not_required',
            enabled: false,
            required: false,
            status: null,
            command: '',
            placement: 'after_compile_before_reviews',
            duration_ms: null,
            duration_human: null,
            timed_out: null,
            exit_code: null,
            artifact_path: '',
            artifact_exists: false,
            artifact_sha256: null,
            output_artifact_path: null,
            updated_at_utc: null,
            compact_summary: [],
            violations: [],
            warnings: [],
            skip_reason: null,
            mismatch_reason: null,
            timeout_forecast: {
                history_path: '',
                sample_count: 0,
                excluded_sample_count: 0,
                excluded_sample_reasons: {},
                average_duration_seconds: null,
                high_watermark_duration_seconds: null,
                recommended_timeout_seconds: 0,
                safety_margin_seconds: null,
                recommendation_source: 'config_timeout',
                configured_timeout_seconds: 0,
                warning: null
            },
            timeout_forecast_label: ''
        },
        audit: null,
        plan: {
            available: false,
            task_id: taskId,
            task_title: null,
            task_status: null,
            summary: null,
            plan_path: null,
            markdown_path: null,
            markdown: null
        },
        artifact_links: [],
        unavailable: [{
            scope: `task:${taskId}:detail`,
            reason: `${detailLimitReason} to keep garda html responsive; use --max-detailed-tasks N for a heavier snapshot or garda task "${taskId}" stats/events for focused inspection.`
        }]
    };
}

export function normalizeMaxDetailedTasks(value: number | null | undefined): number {
    if (value === null || value === undefined) {
        return DEFAULT_REPORT_MAX_DETAILED_TASKS;
    }
    if (!Number.isInteger(value) || value < 0) {
        throw new Error('maxDetailedTasks must be a non-negative integer.');
    }
    return value;
}

export function selectDetailedTaskIds(rows: ReportTaskQueueRow[], maxDetailedTasks: number): Set<string> {
    const selected = new Set<string>();
    if (maxDetailedTasks < 1) {
        return selected;
    }
    const addIfRoom = (row: ReportTaskQueueRow): void => {
        if (selected.size < maxDetailedTasks) {
            selected.add(row.task_id);
        }
    };
    for (const row of rows) {
        if (!TERMINAL_TASK_STATUS_TOKENS.has(row.status_token || '')) {
            addIfRoom(row);
        }
    }
    for (const row of rows) {
        addIfRoom(row);
    }
    return selected;
}

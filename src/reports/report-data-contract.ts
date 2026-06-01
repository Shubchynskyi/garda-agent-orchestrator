import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readTaskQueueStatusToken } from '../core/active-task-state';
import { buildDefaultWorkflowConfig, type WorkflowConfigData } from '../core/workflow-config';
import { parseTaskMdTableRow } from '../core/task-md-table';
import { buildTaskStats, type TaskStatsResult } from '../cli/commands/stats';
import { joinOrchestratorPath, toPosix } from '../gates/shared/helpers';
import {
    buildCompactLatestCycleTaskEventsSummary,
    buildTaskEventsSummary,
    type CompactLatestCycleTaskEventsSummary,
    type TaskEventsSummaryResult
} from '../gates/task-events-summary';
import { buildTaskAuditSummary, type TaskAuditSummaryResult } from '../gates/task-audit/task-audit-summary';
import {
    buildFullSuiteTimeoutForecast,
    formatFullSuiteTimeoutForecast,
    isFullSuiteNotRequiredForZeroDiffNoReviewableScope,
    loadFullSuiteValidationConfig,
    type FullSuiteTimeoutForecast,
    type FullSuiteValidationResult
} from '../gates/full-suite/full-suite-validation';
import { getTaskModeEvidence, readOptionalMarkdownWorkingPlan } from '../gates/task-mode';
import { validateWorkflowConfig } from '../schemas/config-artifacts';
import {
    PROJECT_MEMORY_FILE_DEFINITIONS,
    PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH
} from '../core/project-memory';
import {
    WORKFLOW_SETTING_DEFINITIONS,
    getWorkflowSettingDefinition,
    type WorkflowSettingOption,
    type WorkflowSettingValueType
} from './workflow-setting-metadata';

export const REPORT_DATA_CONTRACT_SCHEMA_VERSION = 1;
export const DEFAULT_REPORT_MAX_DETAILED_TASKS = 0;

const ACTIVE_QUEUE_HEADER = ['ID', 'Status', 'Priority', 'Area', 'Title', 'Owner', 'Updated', 'Profile', 'Notes'];
const TERMINAL_TASK_STATUS_TOKENS = new Set(['DONE']);
const KNOWN_REVIEW_TYPES = ['code', 'db', 'security', 'refactor', 'api', 'test', 'performance', 'infra', 'dependency'];
const FALLBACK_PROFILE_IDS = ['balanced', 'fast', 'strict', 'docs-only'];

export interface ReportDataUnavailableEntry {
    scope: string;
    reason: string;
}

export interface ReportTaskQueueRow {
    task_id: string;
    status: string;
    status_token: string | null;
    priority: string;
    area: string;
    title: string;
    owner: string;
    updated: string;
    profile: string;
    notes: string;
}

export interface ReportArtifactLink {
    kind: string;
    path: string;
    exists: boolean;
    sha256: string | null;
}

export type ReportFullSuiteState =
    | 'not_required'
    | 'not_run'
    | 'passed'
    | 'warned'
    | 'failed'
    | 'timed_out'
    | 'skipped'
    | 'stale'
    | 'unavailable';

export type ReportFullSuiteFreshness =
    | 'not_required'
    | 'missing'
    | 'current'
    | 'reused_current_scope'
    | 'stale'
    | 'unavailable';

export interface ReportFullSuiteSummary {
    state: ReportFullSuiteState;
    freshness: ReportFullSuiteFreshness;
    enabled: boolean;
    required: boolean;
    status: FullSuiteValidationResult['status'] | null;
    command: string;
    placement: WorkflowConfigData['full_suite_validation']['placement'];
    duration_ms: number | null;
    duration_human: string | null;
    timed_out: boolean | null;
    exit_code: number | null;
    artifact_path: string;
    artifact_exists: boolean;
    artifact_sha256: string | null;
    output_artifact_path: string | null;
    updated_at_utc: string | null;
    compact_summary: string[];
    violations: string[];
    warnings: string[];
    skip_reason: string | null;
    mismatch_reason: string | null;
    timeout_forecast: FullSuiteTimeoutForecast;
    timeout_forecast_label: string;
}

export interface ReportTaskDetail {
    task_id: string;
    detail_status: 'loaded' | 'skipped';
    stats: TaskStatsResult | null;
    latest_cycle_events: CompactLatestCycleTaskEventsSummary | null;
    full_suite_validation: ReportFullSuiteSummary;
    audit: {
        status: TaskAuditSummaryResult['status'];
        gates: TaskAuditSummaryResult['gates'];
        blockers: TaskAuditSummaryResult['blockers'];
        required_reviews: TaskAuditSummaryResult['required_reviews'];
        changed_files: string[];
        review_attempt_summary: TaskAuditSummaryResult['review_attempt_summary'];
        final_report_contract_status: TaskAuditSummaryResult['final_report_contract']['status'];
        final_closeout_artifact_state: TaskAuditSummaryResult['final_closeout']['artifact_state'];
    } | null;
    plan: {
        available: boolean;
        task_id: string;
        task_title: string | null;
        task_status: string | null;
        summary: string | null;
        plan_path: string | null;
        markdown_path: string | null;
        markdown: string | null;
    };
    artifact_links: ReportArtifactLink[];
    unavailable: ReportDataUnavailableEntry[];
}

export interface ReportTaskRow extends ReportTaskQueueRow {
    detail: ReportTaskDetail;
}

export interface ReportWorkflowSetting {
    id: string;
    key: string;
    label: string;
    value: unknown;
    value_type: WorkflowSettingValueType;
    options: WorkflowSettingOption[];
    command: string;
    description: string;
    editable: boolean;
    min?: number;
    max?: number;
    placeholder?: string;
    readonly: true;
}

export interface ReportWorkflowConfigTab {
    config_path: string;
    config_exists: boolean;
    status: 'present' | 'missing' | 'invalid';
    settings: ReportWorkflowSetting[];
    unavailable: ReportDataUnavailableEntry[];
}

export interface ReportInstructionEntry {
    id: string;
    title: string;
    body: string;
}

export interface ReportValueRow {
    id: string;
    label: string;
    description: string;
    value: unknown;
}

export interface ReportCommandInfo {
    id: string;
    title: string;
    description: string;
    command: string;
}

export interface ReportInitSettingsTab {
    init_answers_path: string;
    init_answers_status: 'present' | 'missing' | 'invalid';
    init_answers: ReportValueRow[];
    agent_init_state_path: string;
    agent_init_state_status: 'present' | 'missing' | 'invalid';
    agent_init_state: ReportValueRow[];
    commands: ReportCommandInfo[];
    unavailable: ReportDataUnavailableEntry[];
}

export interface ReportProjectMemoryFile {
    id: string;
    path: string;
    exists: boolean;
    purpose: string;
    read_role: 'read_first' | 'focused';
    size_bytes: number | null;
    content: string | null;
}

export interface ReportProjectMemoryTab {
    status: ReportValueRow[];
    files: ReportProjectMemoryFile[];
    unavailable: ReportDataUnavailableEntry[];
}

export interface ReportDataContract {
    schema_version: typeof REPORT_DATA_CONTRACT_SCHEMA_VERSION;
    generated_at_utc: string;
    repo_root: string;
    tasks_tab: {
        source_path: string;
        parser: 'canonical_active_queue_9_columns';
        rows: ReportTaskRow[];
    };
    workflow_config_tab: ReportWorkflowConfigTab;
    init_settings_tab: ReportInitSettingsTab;
    project_memory_tab: ReportProjectMemoryTab;
    instructions_tab: {
        entries: ReportInstructionEntry[];
    };
    unavailable: ReportDataUnavailableEntry[];
}

export interface BuildReportDataContractOptions {
    repoRoot: string;
    generatedAtUtc?: string;
    eventsRoot?: string | null;
    reviewsRoot?: string | null;
    maxDetailedTasks?: number | null;
}

export interface BuildReportTaskDetailOptions {
    taskId: string;
    repoRoot: string;
    eventsRoot?: string | null;
    reviewsRoot?: string | null;
}

function normalizeHeaderCells(cells: string[]): string[] {
    return cells.map((cell) => cell.trim());
}

function isSeparatorRow(line: string): boolean {
    const cells = parseTaskMdTableRow(line.trim()).map((cell) => cell.trimmed);
    return cells.length === ACTIVE_QUEUE_HEADER.length
        && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isActiveQueueHeader(line: string): boolean {
    const cells = normalizeHeaderCells(parseTaskMdTableRow(line.trim()).map((cell) => cell.trimmed));
    return cells.length === ACTIVE_QUEUE_HEADER.length
        && cells.every((cell, index) => cell === ACTIVE_QUEUE_HEADER[index]);
}

export function readCanonicalActiveQueueRows(repoRoot: string): {
    source_path: string;
    rows: ReportTaskQueueRow[];
    unavailable: ReportDataUnavailableEntry[];
} {
    const taskPath = path.join(path.resolve(repoRoot), 'TASK.md');
    const unavailable: ReportDataUnavailableEntry[] = [];
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return {
            source_path: toPosix(taskPath),
            rows: [],
            unavailable: [{ scope: 'tasks', reason: 'TASK.md not found.' }]
        };
    }

    const lines = fs.readFileSync(taskPath, 'utf8').split(/\r?\n/);
    const activeQueueIndex = lines.findIndex((line) => line.trim() === '## Active Queue');
    if (activeQueueIndex < 0) {
        return {
            source_path: toPosix(taskPath),
            rows: [],
            unavailable: [{ scope: 'tasks', reason: 'Canonical ## Active Queue section not found.' }]
        };
    }

    const headerIndex = activeQueueIndex + 1;
    const separatorIndex = activeQueueIndex + 2;
    if (!isActiveQueueHeader(lines[headerIndex] || '') || !isSeparatorRow(lines[separatorIndex] || '')) {
        return {
            source_path: toPosix(taskPath),
            rows: [],
            unavailable: [{ scope: 'tasks', reason: 'Canonical Active Queue 9-column table header not found.' }]
        };
    }

    const rows: ReportTaskQueueRow[] = [];
    for (let index = separatorIndex + 1; index < lines.length; index += 1) {
        const rawLine = lines[index];
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('|')) {
            break;
        }
        const cells = parseTaskMdTableRow(trimmed).map((cell) => cell.trimmed);
        if (cells.length !== ACTIVE_QUEUE_HEADER.length) {
            unavailable.push({
                scope: 'tasks',
                reason: `Skipped noncanonical Active Queue row ${index + 1}: expected 9 cells, got ${cells.length}.`
            });
            continue;
        }
        if (cells[0].toLowerCase() === 'id' || cells[0].startsWith('-')) {
            continue;
        }
        rows.push({
            task_id: cells[0],
            status: cells[1],
            status_token: readTaskQueueStatusToken(cells[1]),
            priority: cells[2],
            area: cells[3],
            title: cells[4],
            owner: cells[5],
            updated: cells[6],
            profile: cells[7],
            notes: cells[8]
        });
    }

    return {
        source_path: toPosix(taskPath),
        rows,
        unavailable
    };
}

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

function buildSkippedTaskDetail(taskId: string, maxDetailedTasks: number): ReportTaskDetail {
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

function normalizeMaxDetailedTasks(value: number | null | undefined): number {
    if (value === null || value === undefined) {
        return DEFAULT_REPORT_MAX_DETAILED_TASKS;
    }
    if (!Number.isInteger(value) || value < 0) {
        throw new Error('maxDetailedTasks must be a non-negative integer.');
    }
    return value;
}

function selectDetailedTaskIds(rows: ReportTaskQueueRow[], maxDetailedTasks: number): Set<string> {
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

function getConfigValue(config: WorkflowConfigData, key: string): unknown {
    return key.split('.').reduce<unknown>((current, part) => {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            return undefined;
        }
        return (current as Record<string, unknown>)[part];
    }, config);
}

function getRawConfigValue(rawConfig: unknown, key: string): unknown {
    return key.split('.').reduce<unknown>((current, part) => {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            return undefined;
        }
        return (current as Record<string, unknown>)[part];
    }, rawConfig);
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        const text = typeof entry === 'string' ? entry.trim() : '';
        if (!text) {
            continue;
        }
        const dedupeKey = text.toLowerCase();
        if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            normalized.push(text);
        }
    }
    return normalized;
}

function buildReviewTypeOptions(repoRoot: string, currentValue: unknown): WorkflowSettingOption[] {
    const capabilitiesPath = joinOrchestratorPath(path.resolve(repoRoot), path.join('live', 'config', 'review-capabilities.json'));
    const capabilities = readJsonObject(capabilitiesPath);
    const configuredReviewTypes = capabilities
        ? Object.keys(capabilities).filter((key) => typeof capabilities[key] === 'boolean')
        : [];
    const reviewTypes = [...new Set([...KNOWN_REVIEW_TYPES, ...configuredReviewTypes])].sort((a, b) => {
        const leftIndex = KNOWN_REVIEW_TYPES.indexOf(a);
        const rightIndex = KNOWN_REVIEW_TYPES.indexOf(b);
        if (leftIndex !== -1 || rightIndex !== -1) {
            return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex)
                - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
        }
        return a.localeCompare(b);
    });
    const options: WorkflowSettingOption[] = reviewTypes.map((reviewType) => {
        const capabilityValue = capabilities?.[reviewType];
        const capabilityText = capabilityValue === true
            ? 'enabled'
            : capabilityValue === false
                ? 'disabled'
                : 'not configured';
        return {
            value: reviewType,
            label: reviewType,
            description: `Known review contract key; capability is ${capabilityText}.`
        };
    });
    return appendUnknownCurrentValues(options, currentValue, 'Unknown legacy review type preserved from the current config.');
}

function buildProfileOptions(repoRoot: string, currentValue: unknown): WorkflowSettingOption[] {
    const profilesPath = joinOrchestratorPath(path.resolve(repoRoot), path.join('live', 'config', 'profiles.json'));
    const profiles = readJsonObject(profilesPath);
    const builtInProfiles = profiles?.built_in_profiles && typeof profiles.built_in_profiles === 'object' && !Array.isArray(profiles.built_in_profiles)
        ? Object.keys(profiles.built_in_profiles as Record<string, unknown>)
        : [];
    const userProfiles = profiles?.user_profiles && typeof profiles.user_profiles === 'object' && !Array.isArray(profiles.user_profiles)
        ? Object.keys(profiles.user_profiles as Record<string, unknown>)
        : [];
    const profileIds = [...new Set([...FALLBACK_PROFILE_IDS, ...builtInProfiles, ...userProfiles])].sort((a, b) => {
        const leftIndex = FALLBACK_PROFILE_IDS.indexOf(a);
        const rightIndex = FALLBACK_PROFILE_IDS.indexOf(b);
        if (leftIndex !== -1 || rightIndex !== -1) {
            return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex)
                - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
        }
        return a.localeCompare(b);
    });
    const options: WorkflowSettingOption[] = profileIds.map((profileId) => ({
        value: profileId,
        label: profileId,
        description: builtInProfiles.includes(profileId)
            ? 'Configured built-in profile.'
            : userProfiles.includes(profileId)
                ? 'Configured user profile.'
                : 'Supported built-in profile fallback.'
    }));
    return appendUnknownCurrentValues(options, currentValue, 'Unknown legacy profile preserved from the current config.');
}

function appendUnknownCurrentValues(
    options: WorkflowSettingOption[],
    currentValue: unknown,
    description: string
): WorkflowSettingOption[] {
    const knownValues = new Set(options.map((option) => option.value));
    const knownValuesLower = new Set(options.map((option) => option.value.toLowerCase()));
    const unknownOptions = normalizeStringList(currentValue)
        .filter((value) => !knownValues.has(value) && !knownValuesLower.has(value.toLowerCase()))
        .map((value) => ({
            value,
            label: `${value} (legacy)`,
            description
        }));
    return unknownOptions.length > 0 ? [...options, ...unknownOptions] : options;
}

function buildWorkflowSettingOptions(repoRoot: string, key: string, currentValue: unknown, fallbackOptions: WorkflowSettingOption[]): WorkflowSettingOption[] {
    if (key === 'review_cycle_guard.excluded_review_types') {
        return buildReviewTypeOptions(repoRoot, currentValue);
    }
    if (key === 'scope_budget_guard.profiles') {
        return buildProfileOptions(repoRoot, currentValue);
    }
    return [...fallbackOptions];
}

function buildWorkflowCommand(flag: string, valueType: WorkflowSettingValueType, options: WorkflowSettingOption[]): string {
    const valueHint = flag === '--garda-self-guard'
        ? '<on|off>'
        : options.length > 0
        ? valueType === 'enum_list'
            ? `<comma-separated: ${options.map((option) => option.value).join('|')}>`
            : `<${options.map((option) => option.value).join('|')}>`
        : valueType === 'integer'
            ? '<number>'
            : valueType === 'string_list'
                ? '<comma-separated values>'
                : '<value>';
    return [
        'garda workflow set',
        flag,
        valueHint,
        '--target-root "."',
        '--operator-confirmed yes',
        '--operator-confirmed-at-utc "<ISO-8601 timestamp>"'
    ].join(' ');
}

function resolveWorkflowSettingValue(
    config: WorkflowConfigData,
    rawConfig: unknown,
    definition: { key: string; value_type: WorkflowSettingValueType }
): unknown {
    const value = getConfigValue(config, definition.key);
    const rawValue = getRawConfigValue(rawConfig, definition.key);
    return definition.value_type === 'enum_list' && Array.isArray(rawValue)
        ? rawValue
        : value;
}

function buildWorkflowSetting(repoRoot: string, config: WorkflowConfigData, rawConfig: unknown, key: string): ReportWorkflowSetting {
    const definition = getWorkflowSettingDefinition(key);
    if (!definition) {
        throw new Error(`Missing local UI workflow setting metadata for ${key}.`);
    }
    const value = resolveWorkflowSettingValue(config, rawConfig, definition);
    const options = buildWorkflowSettingOptions(repoRoot, key, value, definition.options);
    return {
        id: definition.id,
        key,
        label: definition.label,
        value,
        value_type: definition.value_type,
        options,
        command: buildWorkflowCommand(definition.flag, definition.value_type, options),
        description: definition.description,
        editable: definition.editable !== false,
        min: definition.min,
        max: definition.max,
        placeholder: definition.placeholder,
        readonly: true
    };
}

function buildWorkflowSettings(repoRoot: string, config: WorkflowConfigData, rawConfig: unknown = config): ReportWorkflowSetting[] {
    return WORKFLOW_SETTING_DEFINITIONS.map((definition) => buildWorkflowSetting(repoRoot, config, rawConfig, definition.key));
}

export function buildWorkflowConfigTab(repoRoot: string): ReportWorkflowConfigTab {
    const configPath = joinOrchestratorPath(path.resolve(repoRoot), path.join('live', 'config', 'workflow-config.json'));
    const unavailable: ReportDataUnavailableEntry[] = [];
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
        const config = buildDefaultWorkflowConfig();
        return {
            config_path: toPosix(configPath),
            config_exists: false,
            status: 'missing',
            settings: buildWorkflowSettings(repoRoot, config),
            unavailable: [{ scope: 'workflow-config', reason: 'Workflow config file missing; default values are shown.' }]
        };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const defaults = buildDefaultWorkflowConfig();
        const validated = validateWorkflowConfig(parsed) as Partial<WorkflowConfigData>;
        const config = {
            ...defaults,
            ...validated,
            compile_gate: validated.compile_gate ?? defaults.compile_gate
        } as WorkflowConfigData;
        return {
            config_path: toPosix(configPath),
            config_exists: true,
            status: 'present',
            settings: buildWorkflowSettings(repoRoot, config, parsed),
            unavailable
        };
    } catch (error: unknown) {
        const config = buildDefaultWorkflowConfig();
        return {
            config_path: toPosix(configPath),
            config_exists: true,
            status: 'invalid',
            settings: buildWorkflowSettings(repoRoot, config),
            unavailable: [{
                scope: 'workflow-config',
                reason: error instanceof Error ? error.message : String(error)
            }]
        };
    }
}

function toRepoRelativePath(repoRoot: string, filePath: string): string {
    const root = path.resolve(repoRoot);
    const resolved = path.resolve(filePath);
    const relative = path.relative(root, resolved);
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        return toPosix(relative || '.');
    }
    return toPosix(resolved);
}

function readJsonObjectForReport(
    repoRoot: string,
    filePath: string,
    scope: string,
    unavailable: ReportDataUnavailableEntry[]
): { status: 'present' | 'missing' | 'invalid'; value: Record<string, unknown> } {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        unavailable.push({ scope, reason: `${toRepoRelativePath(repoRoot, filePath)} not found.` });
        return { status: 'missing', value: {} };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('JSON root is not an object.');
        }
        return { status: 'present', value: parsed as Record<string, unknown> };
    } catch (error: unknown) {
        unavailable.push({
            scope,
            reason: error instanceof Error ? error.message : String(error)
        });
        return { status: 'invalid', value: {} };
    }
}

function valueRow(id: string, label: string, description: string, value: unknown): ReportValueRow {
    return { id, label, description, value: value ?? null };
}

function pickRows(source: Record<string, unknown>, rows: Array<[string, string, string]>): ReportValueRow[] {
    return rows.map(([id, label, description]) => valueRow(id, label, description, source[id]));
}

function buildInitCommand(initAnswersPath: string): string {
    return [
        'garda reinit',
        '--target-root "."',
        `--init-answers-path "${initAnswersPath}"`
    ].join(' ');
}

function buildAgentInitCommand(initAnswersPath: string, activeAgentFiles: unknown): string {
    const activeFiles = String(activeAgentFiles || '<active-agent-files>');
    return [
        'garda agent-init',
        '--target-root "."',
        `--init-answers-path "${initAnswersPath}"`,
        `--active-agent-files "${activeFiles}"`,
        '--project-rules-updated yes',
        '--skills-prompted yes'
    ].join(' ');
}

export function buildInitSettingsTab(repoRoot: string): ReportInitSettingsTab {
    const root = path.resolve(repoRoot);
    const initAnswersPath = joinOrchestratorPath(root, path.join('runtime', 'init-answers.json'));
    const agentInitStatePath = joinOrchestratorPath(root, path.join('runtime', 'agent-init-state.json'));
    const unavailable: ReportDataUnavailableEntry[] = [];
    const initAnswers = readJsonObjectForReport(root, initAnswersPath, 'init-settings:init-answers', unavailable);
    const agentState = readJsonObjectForReport(root, agentInitStatePath, 'init-settings:agent-init-state', unavailable);
    const initAnswersRelative = toRepoRelativePath(root, initAnswersPath);
    const activeAgentFiles = agentState.value.ActiveAgentFiles || initAnswers.value.ActiveAgentFiles;

    return {
        init_answers_path: initAnswersRelative,
        init_answers_status: initAnswers.status,
        init_answers: pickRows(initAnswers.value, [
            ['AssistantLanguage', 'Assistant language', 'Language the assistant should use with the operator.'],
            ['AssistantBrevity', 'Assistant verbosity', 'How detailed normal assistant answers should be.'],
            ['SourceOfTruth', 'Instruction owner', 'Canonical provider file that owns generated agent instructions.'],
            ['EnforceNoAutoCommit', 'No automatic commits', 'Prevents agents from committing without explicit operator approval.'],
            ['ClaudeOrchestratorFullAccess', 'Claude full access mode', 'Whether Claude-oriented instructions assume full orchestrator access.'],
            ['TokenEconomyEnabled', 'Token economy', 'Keeps generated instructions compact and avoids unnecessary context.'],
            ['ProviderMinimalism', 'Provider minimalism', 'Keeps non-canonical provider entrypoints as redirects when possible.'],
            ['CollectedVia', 'Collected via', 'How the init answers were collected.'],
            ['ActiveAgentFiles', 'Active agent files', 'Root/provider instruction files selected during initialization.']
        ]),
        agent_init_state_path: toRepoRelativePath(root, agentInitStatePath),
        agent_init_state_status: agentState.status,
        agent_init_state: pickRows(agentState.value, [
            ['UpdatedAt', 'Last updated', 'When the hard agent-init state was last written.'],
            ['OrchestratorVersion', 'Orchestrator version', 'Garda version that wrote the state.'],
            ['AssistantLanguageConfirmed', 'Language confirmed', 'Whether the assistant language checkpoint passed.'],
            ['ActiveAgentFilesConfirmed', 'Agent files confirmed', 'Whether selected active agent files were explicitly confirmed.'],
            ['ProjectRulesUpdated', 'Project rules updated', 'Whether project rules were reviewed or accepted during agent init.'],
            ['SkillsPromptCompleted', 'Skills prompted', 'Whether the skills prompt checkpoint completed.'],
            ['OrdinaryDocPathsConfirmed', 'Ordinary docs confirmed', 'Whether ordinary documentation paths were confirmed.'],
            ['OrdinaryDocPaths', 'Ordinary docs', 'User-owned documentation paths Garda may mention without treating them as generated rules.'],
            ['VerificationPassed', 'Verification passed', 'Whether post-init verification passed.'],
            ['ManifestValidationPassed', 'Manifest valid', 'Whether protected control-plane manifest validation passed.'],
            ['ActiveAgentFiles', 'Active agent files', 'Canonical files active after agent init.'],
            ['LastSeededFullSuiteCommand', 'Seeded full-suite command', 'Test command seeded into workflow config during initialization.'],
            ['ProjectMemoryInitialized', 'Project memory initialized', 'Whether agent-init recorded project-memory initialization.'],
            ['ProjectMemoryValidated', 'Project memory validated', 'Whether agent-init recorded successful project-memory validation.'],
            ['ProjectMemoryMode', 'Project memory mode', 'Project-memory bootstrap mode recorded by agent init.'],
            ['ProjectMemoryDir', 'Project memory directory', 'Directory that contains durable project memory.'],
            ['ProjectMemoryReadFirst', 'Project memory read-first files', 'Files agents should read before focused memory files.'],
            ['ProjectMemorySummaryRule', 'Project memory summary rule', 'Generated rule file that summarizes project memory.'],
            ['ProjectMemoryBootstrapReport', 'Project memory bootstrap report', 'Runtime report from project-memory bootstrap.'],
            ['ProjectMemoryWarnings', 'Project memory warnings', 'Warnings recorded during project-memory bootstrap or validation.']
        ]),
        commands: [
            {
                id: 'reinit',
                title: 'Re-initialize workspace',
                description: 'Re-materializes Garda generated files from the current init answers. Use it after changing initialization choices.',
                command: buildInitCommand(initAnswersRelative)
            },
            {
                id: 'agent-init',
                title: 'Complete agent initialization',
                description: 'Records the hard onboarding checkpoints, active agent files, project-rule confirmation, skills prompt, and project-memory readiness.',
                command: buildAgentInitCommand(initAnswersRelative, activeAgentFiles)
            }
        ],
        unavailable
    };
}

function buildProjectMemoryStatusRows(workflowTab: ReportWorkflowConfigTab, initTab: ReportInitSettingsTab): ReportValueRow[] {
    const settingValue = (key: string): unknown => workflowTab.settings.find((setting) => setting.key === key)?.value;
    const stateValue = (id: string): unknown => initTab.agent_init_state.find((row) => row.id === id)?.value;
    return [
        valueRow('memory-enabled', 'Memory maintenance enabled', 'Whether workflow closeout checks durable project memory.', settingValue('project_memory_maintenance.enabled')),
        valueRow('memory-mode', 'Memory maintenance mode', 'Current workflow mode: off, check, update, or strict.', settingValue('project_memory_maintenance.mode')),
        valueRow('memory-run-before-closeout', 'Runs before final closeout', 'Whether the project-memory gate runs before completion.', settingValue('project_memory_maintenance.run_before_final_closeout')),
        valueRow('memory-require-approval', 'Requires approval for writes', 'Whether writes to project-memory files require user approval.', settingValue('project_memory_maintenance.require_user_approval_for_writes')),
        valueRow('memory-read-strategy', 'Read strategy', 'How agents should read project memory at task start.', settingValue('project_memory_maintenance.read_strategy')),
        valueRow('memory-initialized', 'Initialized by agent init', 'Whether agent-init recorded project-memory initialization.', stateValue('ProjectMemoryInitialized')),
        valueRow('memory-validated', 'Validated by agent init', 'Whether agent-init recorded successful project-memory validation.', stateValue('ProjectMemoryValidated')),
        valueRow('memory-dir', 'Memory directory', 'Directory that contains the user-owned durable memory files.', stateValue('ProjectMemoryDir') || PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH),
        valueRow('memory-read-first', 'Read first files', 'Files agents should read before focused memory files.', stateValue('ProjectMemoryReadFirst')),
        valueRow('memory-summary-rule', 'Generated summary rule', 'Generated rule file that summarizes project memory for agent startup.', stateValue('ProjectMemorySummaryRule')),
        valueRow('memory-bootstrap-report', 'Bootstrap report', 'Runtime report from project-memory bootstrap or validation.', stateValue('ProjectMemoryBootstrapReport'))
    ];
}

export function buildProjectMemoryTab(
    repoRoot: string,
    workflowTab: ReportWorkflowConfigTab,
    initTab: ReportInitSettingsTab
): ReportProjectMemoryTab {
    const root = path.resolve(repoRoot);
    const memoryDir = joinOrchestratorPath(root, PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH);
    const unavailable: ReportDataUnavailableEntry[] = [];
    const files = PROJECT_MEMORY_FILE_DEFINITIONS.map((definition): ReportProjectMemoryFile => {
        const filePath = path.join(memoryDir, definition.fileName);
        const exists = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
        if (!exists) {
            unavailable.push({
                scope: `project-memory:${definition.fileName}`,
                reason: `${toRepoRelativePath(root, filePath)} not found.`
            });
        }
        return {
            id: definition.fileName.replace(/[^a-zA-Z0-9_-]+/g, '-'),
            path: toRepoRelativePath(root, filePath),
            exists,
            purpose: definition.purpose,
            read_role: definition.readRole,
            size_bytes: exists ? fs.statSync(filePath).size : null,
            content: exists ? fs.readFileSync(filePath, 'utf8') : null
        };
    });
    return {
        status: buildProjectMemoryStatusRows(workflowTab, initTab),
        files,
        unavailable
    };
}

function buildInstructionEntries(): ReportInstructionEntry[] {
    return [
        {
            id: 'task-execution',
            title: 'Task execution',
            body: 'Start and resume task work with `garda next-step "<task-id>" --repo-root "."`. Treat the printed command as the current router result, then return to next-step after each gate.'
        },
        {
            id: 'task-inspection',
            title: 'Task inspection',
            body: 'Use the Tasks tab for per-task details. Compact rows come from TASK.md only; loading details reads task events, blockers, reviews, and artifact links for that one task.'
        },
        {
            id: 'review-execution-modes',
            title: 'Review execution modes',
            body: '`parallel_all` launches lanes independently. `test_after_code` makes test wait for code. `code_first_optional` makes selected specialist reviews wait for code and keeps test downstream. `strict_sequential` runs required review lanes one by one.'
        },
        {
            id: 'workflow-guards',
            title: 'Workflow guards',
            body: 'Scope budget guards catch oversized tasks. Review-cycle guards catch repeated failed review loops. Project-memory maintenance checks whether durable memory needs a focused update before closeout.'
        },
        {
            id: 'workflow-configuration',
            title: 'Workflow configuration',
            body: 'The Workflow Config tab shows a human label first and the real parameter in parentheses. Saves run audited `garda workflow set` commands when the UI was started with `--actions`.'
        },
        {
            id: 'init-settings',
            title: 'Init settings',
            body: 'The Init settings tab shows the current initialization answers, the hard agent-init checkpoints, and the two commands normally used to re-materialize generated files or complete agent onboarding.'
        },
        {
            id: 'project-memory',
            title: 'Project memory',
            body: 'The Project memory tab shows the current maintenance mode, agent-init memory state, read-first files, and the contents of the durable project-memory files.'
        },
        {
            id: 'workspace-actions',
            title: 'Workspace actions',
            body: 'The Actions tab is for fixed workspace commands such as status, doctor, HTML report generation, and runtime cleanup. Task-specific commands are shown in the selected task details.'
        }
    ];
}

export function buildReportDataContract(options: BuildReportDataContractOptions): ReportDataContract {
    const repoRoot = path.resolve(options.repoRoot);
    const eventsRoot = options.eventsRoot
        ? path.resolve(options.eventsRoot)
        : joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    const reviewsRoot = options.reviewsRoot
        ? path.resolve(options.reviewsRoot)
        : joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const queue = readCanonicalActiveQueueRows(repoRoot);
    const maxDetailedTasks = normalizeMaxDetailedTasks(options.maxDetailedTasks);
    const detailedTaskIds = selectDetailedTaskIds(queue.rows, maxDetailedTasks);
    const tasks = queue.rows.map((row) => ({
        ...row,
        detail: detailedTaskIds.has(row.task_id)
            ? buildReportTaskDetail({ taskId: row.task_id, repoRoot, eventsRoot, reviewsRoot })
            : buildSkippedTaskDetail(row.task_id, maxDetailedTasks)
    }));
    const workflowConfigTab = buildWorkflowConfigTab(repoRoot);
    const initSettingsTab = buildInitSettingsTab(repoRoot);
    const projectMemoryTab = buildProjectMemoryTab(repoRoot, workflowConfigTab, initSettingsTab);
    const unavailable = [
        ...queue.unavailable,
        ...workflowConfigTab.unavailable,
        ...initSettingsTab.unavailable,
        ...projectMemoryTab.unavailable,
        ...tasks.flatMap((task) => task.detail.unavailable).filter((entry) => !isLazyReportDetailEntry(entry))
    ];

    return {
        schema_version: REPORT_DATA_CONTRACT_SCHEMA_VERSION,
        generated_at_utc: options.generatedAtUtc || new Date().toISOString(),
        repo_root: toPosix(repoRoot),
        tasks_tab: {
            source_path: queue.source_path,
            parser: 'canonical_active_queue_9_columns',
            rows: tasks
        },
        workflow_config_tab: workflowConfigTab,
        init_settings_tab: initSettingsTab,
        project_memory_tab: projectMemoryTab,
        instructions_tab: {
            entries: buildInstructionEntries()
        },
        unavailable
    };
}

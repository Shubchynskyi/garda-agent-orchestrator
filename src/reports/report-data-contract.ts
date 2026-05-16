import * as fs from 'node:fs';
import * as path from 'node:path';
import { readTaskQueueStatusToken } from '../core/active-task-state';
import { buildDefaultWorkflowConfig, type WorkflowConfigData } from '../core/workflow-config';
import { parseTaskMdTableRow } from '../core/task-md-table';
import { buildTaskStats, type TaskStatsResult } from '../cli/commands/stats';
import { joinOrchestratorPath, toPosix } from '../gates/helpers';
import {
    buildCompactLatestCycleTaskEventsSummary,
    buildTaskEventsSummary,
    type CompactLatestCycleTaskEventsSummary,
    type TaskEventsSummaryResult
} from '../gates/task-events-summary';
import { buildTaskAuditSummary, type TaskAuditSummaryResult } from '../gates/task-audit-summary';
import { validateWorkflowConfig } from '../schemas/config-artifacts';

export const REPORT_DATA_CONTRACT_SCHEMA_VERSION = 1;

const ACTIVE_QUEUE_HEADER = ['ID', 'Status', 'Priority', 'Area', 'Title', 'Owner', 'Updated', 'Profile', 'Notes'];

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

export interface ReportTaskDetail {
    task_id: string;
    stats: TaskStatsResult | null;
    latest_cycle_events: CompactLatestCycleTaskEventsSummary | null;
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
    artifact_links: ReportArtifactLink[];
    unavailable: ReportDataUnavailableEntry[];
}

export interface ReportTaskRow extends ReportTaskQueueRow {
    detail: ReportTaskDetail;
}

export interface ReportWorkflowSetting {
    key: string;
    value: unknown;
    command: string;
    description: string;
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
    title: string;
    body: string;
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

function readTaskAudit(
    taskId: string,
    repoRoot: string,
    eventsRoot: string,
    reviewsRoot: string,
    unavailable: ReportDataUnavailableEntry[]
): ReportTaskDetail['audit'] {
    try {
        const audit = buildTaskAuditSummary({
            taskId,
            repoRoot,
            eventsRoot,
            reviewsRoot
        });
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
    } catch (error: unknown) {
        unavailable.push({
            scope: `task:${taskId}:audit`,
            reason: error instanceof Error ? error.message : String(error)
        });
        return null;
    }
}

function readArtifactLinks(
    taskId: string,
    repoRoot: string,
    eventsRoot: string,
    reviewsRoot: string,
    unavailable: ReportDataUnavailableEntry[]
): ReportArtifactLink[] {
    try {
        const audit = buildTaskAuditSummary({
            taskId,
            repoRoot,
            eventsRoot,
            reviewsRoot
        });
        return audit.evidence.map((artifact) => ({
            kind: artifact.kind,
            path: toPosix(artifact.path),
            exists: artifact.exists,
            sha256: artifact.sha256
        }));
    } catch (error: unknown) {
        unavailable.push({
            scope: `task:${taskId}:artifacts`,
            reason: error instanceof Error ? error.message : String(error)
        });
        return [];
    }
}

function buildTaskDetail(taskId: string, repoRoot: string, eventsRoot: string, reviewsRoot: string): ReportTaskDetail {
    const unavailable: ReportDataUnavailableEntry[] = [];
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

    return {
        task_id: taskId,
        stats,
        latest_cycle_events: readLatestCycleEvents(taskId, repoRoot, eventsRoot, reviewsRoot, unavailable),
        audit: readTaskAudit(taskId, repoRoot, eventsRoot, reviewsRoot, unavailable),
        artifact_links: readArtifactLinks(taskId, repoRoot, eventsRoot, reviewsRoot, unavailable),
        unavailable
    };
}

function getConfigValue(config: WorkflowConfigData, key: string): unknown {
    return key.split('.').reduce<unknown>((current, part) => {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            return undefined;
        }
        return (current as Record<string, unknown>)[part];
    }, config);
}

function buildWorkflowSetting(config: WorkflowConfigData, key: string, command: string, description: string): ReportWorkflowSetting {
    return {
        key,
        value: getConfigValue(config, key),
        command,
        description,
        readonly: true
    };
}

function buildWorkflowSettings(config: WorkflowConfigData): ReportWorkflowSetting[] {
    return [
        buildWorkflowSetting(
            config,
            'full_suite_validation.enabled',
            'garda workflow set --full-suite on|off --target-root "." --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"',
            'Controls whether the configured full-suite command participates in lifecycle closeout.'
        ),
        buildWorkflowSetting(
            config,
            'full_suite_validation.command',
            'garda workflow set --full-suite-command "<command>" --target-root "." --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"',
            'Command executed by full-suite validation when the suite is required.'
        ),
        buildWorkflowSetting(
            config,
            'review_execution_policy.mode',
            'garda workflow set --review-execution-policy <mode> --target-root "." --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"',
            'Determines reviewer launch ordering and dependency behavior.'
        ),
        buildWorkflowSetting(
            config,
            'scope_budget_guard.enabled',
            'garda workflow set --scope-budget on|off --target-root "." --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"',
            'Controls whether large scopes are blocked or warned before expensive gates.'
        ),
        buildWorkflowSetting(
            config,
            'review_cycle_guard.auto_split_enabled',
            'garda workflow set --review-cycle-auto-split on|off --target-root "." --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"',
            'Controls whether review-cycle guard pressure can create split follow-up tasks automatically.'
        ),
        buildWorkflowSetting(
            config,
            'project_memory_maintenance.mode',
            'garda workflow set --project-memory-mode <off|check|update|strict> --target-root "." --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"',
            'Controls project-memory impact checking before final closeout.'
        ),
        buildWorkflowSetting(
            config,
            'task_reset.enabled',
            'garda workflow set --task-reset on|off --target-root "." --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"',
            'Controls whether confirmed task reset/discard mutations are allowed.'
        ),
        buildWorkflowSetting(
            config,
            'orchestrator_work_policy.mode',
            'garda workflow set --garda-self-guard on|off --target-root "." --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"',
            'Controls whether application agents may enter protected Garda control-plane task work.'
        )
    ];
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
            settings: buildWorkflowSettings(config),
            unavailable: [{ scope: 'workflow-config', reason: 'Workflow config file missing; default values are shown.' }]
        };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const config = validateWorkflowConfig(parsed) as WorkflowConfigData;
        return {
            config_path: toPosix(configPath),
            config_exists: true,
            status: 'present',
            settings: buildWorkflowSettings(config),
            unavailable
        };
    } catch (error: unknown) {
        const config = buildDefaultWorkflowConfig();
        return {
            config_path: toPosix(configPath),
            config_exists: true,
            status: 'invalid',
            settings: buildWorkflowSettings(config),
            unavailable: [{
                scope: 'workflow-config',
                reason: error instanceof Error ? error.message : String(error)
            }]
        };
    }
}

function buildInstructionEntries(): ReportInstructionEntry[] {
    return [
        {
            title: 'Task execution',
            body: 'Start and resume task work with `garda next-step "<task-id>" --repo-root "."`; follow the single command it prints before moving to the next lifecycle stage.'
        },
        {
            title: 'Read-only inspection',
            body: 'Use `garda task "<task-id>" stats` and `garda task "<task-id>" events` for per-task inspection; these surfaces do not replace lifecycle routing.'
        },
        {
            title: 'Workflow configuration',
            body: 'Use `garda workflow show` and `garda workflow explain` for read-only configuration inspection. Configuration changes stay in audited CLI commands, not the static HTML report.'
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
    const tasks = queue.rows.map((row) => ({
        ...row,
        detail: buildTaskDetail(row.task_id, repoRoot, eventsRoot, reviewsRoot)
    }));
    const workflowConfigTab = buildWorkflowConfigTab(repoRoot);
    const unavailable = [
        ...queue.unavailable,
        ...workflowConfigTab.unavailable,
        ...tasks.flatMap((task) => task.detail.unavailable)
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
        instructions_tab: {
            entries: buildInstructionEntries()
        },
        unavailable
    };
}

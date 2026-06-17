import type { WorkflowConfigData } from '../../core/workflow-config';
import type { TaskStatsResult } from '../../cli/commands/stats';
import type { CompactLatestCycleTaskEventsSummary } from '../../gates/task-events-summary';
import type { TaskAuditSummaryResult } from '../../gates/task-audit/task-audit-summary';
import type {
    FullSuiteTimeoutForecast,
    FullSuiteValidationResult
} from '../../gates/full-suite/full-suite-validation';
import type {
    BackupHealthStatus,
    BackupReason
} from '../../lifecycle/backups';
import type {
    WorkflowSettingOption,
    WorkflowSettingValueType
} from '../workflow-setting-metadata';

export const REPORT_DATA_CONTRACT_SCHEMA_VERSION = 1;
export const DEFAULT_REPORT_MAX_DETAILED_TASKS = 0;

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
    flag: string;
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
    file_path?: string | null;
}

export interface ReportCommandInfo {
    id: string;
    title: string;
    description: string;
    command: string;
}

export interface ReportOrdinaryDocsInfo {
    config_path: string;
    status: 'present' | 'missing' | 'invalid';
    paths: string[];
    unavailable: ReportDataUnavailableEntry[];
}

export interface ReportInitSettingsTab {
    init_answers_path: string;
    init_answers_status: 'present' | 'missing' | 'invalid';
    init_answers: ReportValueRow[];
    agent_init_state_path: string;
    agent_init_state_status: 'present' | 'missing' | 'invalid';
    agent_init_state: ReportValueRow[];
    ordinary_docs: ReportOrdinaryDocsInfo;
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
}

export interface ReportProjectMemoryTab {
    settings_config_path: string;
    memory_directory_path: string;
    status: ReportValueRow[];
    settings: ReportWorkflowSetting[];
    files: ReportProjectMemoryFile[];
    unavailable: ReportDataUnavailableEntry[];
}

export interface ReportBackupRow {
    id: string;
    reason: BackupReason;
    created_at: string;
    size_bytes: number;
    size_human: string;
    health: BackupHealthStatus;
    health_message: string | null;
    record_count: number;
    relative_snapshot_path: string;
    restorable: boolean;
}

export interface ReportBackupsTab {
    workflow_config_path: string;
    snapshots_root: string;
    snapshots_root_exists: boolean;
    auto_backup: {
        enabled: boolean;
        interval_days: number;
        keep_latest: number;
    };
    rows: ReportBackupRow[];
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
    backups_tab: ReportBackupsTab;
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

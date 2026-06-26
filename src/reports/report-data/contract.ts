import * as path from 'node:path';
import { joinOrchestratorPath, toPosix } from '../../gates/shared/helpers';
import { buildBackupsTab } from './backups-tab';
import { buildInitSettingsTab } from './init-settings-tab';
import { buildInstructionEntries } from './instructions-tab';
import { buildProjectMemoryTab } from './project-memory-tab';
import { buildQualityGateTab } from './quality-gate-tab';
import { readCanonicalActiveQueueRows } from './task-queue';
import { buildSystemStateReport } from './system-state';
import {
    buildReportTaskDetail,
    buildSkippedTaskDetail,
    isLazyReportDetailEntry,
    normalizeMaxDetailedTasks,
    selectDetailedTaskIds
} from './task-detail';
import type { BuildReportDataContractOptions, ReportDataContract } from './types';
import { REPORT_DATA_CONTRACT_SCHEMA_VERSION } from './types';
import { buildWorkflowConfigTab } from './workflow-config-tab';

export function buildReportDataContract(options: BuildReportDataContractOptions): ReportDataContract {
    const repoRoot = path.resolve(options.repoRoot);
    const eventsRoot = options.eventsRoot
        ? path.resolve(options.eventsRoot)
        : joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    const reviewsRoot = options.reviewsRoot
        ? path.resolve(options.reviewsRoot)
        : joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const generatedAtUtc = options.generatedAtUtc || new Date().toISOString();
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
    const qualityGateTab = buildQualityGateTab(workflowConfigTab);
    const initSettingsTab = buildInitSettingsTab(repoRoot);
    const projectMemoryTab = buildProjectMemoryTab(repoRoot, workflowConfigTab);
    const backupsTab = buildBackupsTab(repoRoot);
    const unavailable = [
        ...queue.unavailable,
        ...workflowConfigTab.unavailable,
        ...initSettingsTab.unavailable,
        ...projectMemoryTab.unavailable,
        ...backupsTab.unavailable,
        ...tasks.flatMap((task) => task.detail.unavailable).filter((entry) => !isLazyReportDetailEntry(entry))
    ];

    return {
        schema_version: REPORT_DATA_CONTRACT_SCHEMA_VERSION,
        generated_at_utc: generatedAtUtc,
        repo_root: toPosix(repoRoot),
        system_state: buildSystemStateReport({
            repoRoot,
            generatedAtUtc,
            tasks,
            workflowTab: workflowConfigTab,
            initTab: initSettingsTab,
            projectMemoryTab
        }),
        tasks_tab: {
            source_path: queue.source_path,
            parser: 'canonical_active_queue_9_columns',
            rows: tasks
        },
        workflow_config_tab: workflowConfigTab,
        quality_gate_tab: qualityGateTab,
        init_settings_tab: initSettingsTab,
        project_memory_tab: projectMemoryTab,
        backups_tab: backupsTab,
        instructions_tab: {
            entries: buildInstructionEntries()
        },
        unavailable
    };
}

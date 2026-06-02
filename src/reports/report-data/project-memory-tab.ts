import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    PROJECT_MEMORY_FILE_DEFINITIONS,
    PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH
} from '../../core/project-memory';
import { joinOrchestratorPath } from '../../gates/shared/helpers';
import { toRepoRelativePath, valueRow } from './shared';
import type {
    ReportDataUnavailableEntry,
    ReportInitSettingsTab,
    ReportProjectMemoryFile,
    ReportProjectMemoryTab,
    ReportValueRow,
    ReportWorkflowConfigTab
} from './types';

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

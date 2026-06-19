import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveTaskResetAvailability } from '../../core/task-reset-availability';
import {
    buildFullSuiteTimeoutForecast,
    formatFullSuiteTimeoutForecast,
    loadFullSuiteValidationConfig
} from '../../gates/full-suite/full-suite-validation';
import { evaluateProtectedControlPlaneManifest } from '../../gates/protected-control-plane/protected-control-plane';
import { joinOrchestratorPath } from '../../gates/shared/helpers';
import { scanTaskEventLocks } from '../../gate-runtime/task-events-locking-health';
import { collectTimelineSummaryForStatus } from '../../gate-runtime/timeline-summary';
import { assessProtectedManifest } from '../../validators/protected-manifest-assessment';
import { detectUiSwitchModeState } from '../ui/actions/action-common';
import type {
    ReportInitSettingsTab,
    ReportProjectMemoryTab,
    ReportSystemState,
    ReportSystemStateConfigFile,
    ReportSystemStateHealth,
    ReportSystemStateSignal,
    ReportTaskRow,
    ReportWorkflowConfigTab
} from './types';

const MAX_RUNTIME_SIGNAL_SCAN_ENTRIES = 512;

function settingValue(workflowTab: ReportWorkflowConfigTab, key: string): unknown {
    return workflowTab.settings.find((setting) => setting.key === key)?.value;
}

function valueRowValue(rows: Array<{ id: string; value: unknown }>, id: string): unknown {
    return rows.find((row) => row.id === id)?.value;
}

function booleanValue(value: unknown): boolean {
    return value === true || String(value).trim().toLowerCase() === 'true';
}

function signal(
    id: string,
    label: string,
    status: ReportSystemStateHealth,
    summary: string,
    remediation: string | null,
    value: unknown,
    sourcePath: string | null
): ReportSystemStateSignal {
    return {
        id,
        label,
        status,
        summary,
        remediation,
        value,
        source_path: sourcePath
    };
}

function worstStatus(signals: ReportSystemStateSignal[]): ReportSystemStateHealth {
    if (signals.some((entry) => entry.status === 'error')) {
        return 'error';
    }
    if (signals.some((entry) => entry.status === 'attention')) {
        return 'attention';
    }
    if (signals.every((entry) => entry.status === 'unknown')) {
        return 'unknown';
    }
    return 'ok';
}

function isPrimaryHealthSignal(entry: ReportSystemStateSignal): boolean {
    return entry.id !== 'ui-actions' && !entry.id.startsWith('config-file-');
}

function buildConfigFiles(
    initTab: ReportInitSettingsTab,
    workflowTab: ReportWorkflowConfigTab
): ReportSystemStateConfigFile[] {
    const entries: ReportSystemStateConfigFile[] = [
        {
            id: 'init-answers',
            label: 'Init answers',
            path: initTab.init_answers_path,
            status: initTab.init_answers_status,
            role: 'secondary'
        },
        {
            id: 'agent-init-state',
            label: 'Agent-init state',
            path: initTab.agent_init_state_path,
            status: initTab.agent_init_state_status,
            role: 'secondary'
        },
        {
            id: 'ordinary-doc-paths',
            label: 'Ordinary docs config',
            path: initTab.ordinary_docs.config_path,
            status: initTab.ordinary_docs.status,
            role: 'secondary'
        },
        {
            id: 'workflow-config',
            label: 'Workflow config',
            path: workflowTab.config_path,
            status: workflowTab.status,
            role: 'secondary'
        }
    ];
    return entries.filter((entry) => Boolean(entry.path));
}

function buildGardaSignal(repoRoot: string): ReportSystemStateSignal {
    const state = detectUiSwitchModeState(repoRoot);
    if (state === 'on') {
        return signal('garda-switch', 'Garda enabled', 'ok', 'Managed Garda instruction surfaces are active.', null, state, 'AGENTS.md');
    }
    if (state === 'off') {
        return signal('garda-switch', 'Garda disabled', 'attention', 'Managed Garda instruction surfaces are switched off.', 'Use the Garda switch action after confirming the workspace should be controlled by Garda.', state, null);
    }
    return signal('garda-switch', 'Garda state unknown', 'unknown', 'The report could not determine whether root Garda instruction surfaces are active.', 'Run status or doctor diagnostics from the local UI.', state, null);
}

function buildUiActionsSignal(): ReportSystemStateSignal {
    return signal(
        'ui-actions',
        'UI actions mode',
        'unknown',
        'Action mode is provided by the local UI session payload; static reports remain read-only.',
        'Start `garda ui --actions` when you want guarded allowlisted actions from the browser.',
        null,
        null
    );
}

function normalizeStatusToken(value: string | null): string {
    return String(value || '').trim().toUpperCase();
}

function buildTaskQueueSignal(rows: ReportTaskRow[]): ReportSystemState['task_queue'] {
    const counts = {
        total: rows.length,
        active: rows.filter((row) => ['IN_PROGRESS', 'IN_REVIEW'].includes(normalizeStatusToken(row.status_token))).length,
        todo: rows.filter((row) => normalizeStatusToken(row.status_token) === 'TODO').length,
        blocked: rows.filter((row) => normalizeStatusToken(row.status_token) === 'BLOCKED').length,
        done: rows.filter((row) => normalizeStatusToken(row.status_token) === 'DONE').length,
        decomposed: rows.filter((row) => normalizeStatusToken(row.status_token) === 'DECOMPOSED').length
    };
    const nextTask = rows.find((row) => ['IN_PROGRESS', 'IN_REVIEW', 'TODO'].includes(normalizeStatusToken(row.status_token)));
    const status: ReportSystemStateHealth = counts.blocked > 0
        ? 'attention'
        : rows.length === 0
            ? 'unknown'
            : 'ok';
    return {
        ...signal(
            'task-queue',
            'Task queue readiness',
            status,
            counts.blocked > 0
                ? `${counts.blocked} task(s) are blocked; inspect the queue before starting more work.`
                : nextTask
                    ? `Next executable task is ${nextTask.task_id}.`
                    : 'No executable TODO or active task is visible in the queue.',
            counts.blocked > 0 ? 'Open the blocked task detail and run why-blocked or next-step diagnostics.' : null,
            counts,
            'TASK.md'
        ),
        counts,
        next_task_id: nextTask?.task_id ?? null
    };
}

function buildWorkflowSignal(repoRoot: string, workflowTab: ReportWorkflowConfigTab): ReportSystemState['workflow'] {
    const compileCommand = String(settingValue(workflowTab, 'compile_gate.command') || '').trim() || null;
    const fullSuiteEnabled = booleanValue(settingValue(workflowTab, 'full_suite_validation.enabled'));
    const fullSuiteCommand = String(settingValue(workflowTab, 'full_suite_validation.command') || '').trim() || null;
    const taskReset = resolveTaskResetAvailability(repoRoot);
    let timeoutForecastLabel: string | null = null;
    try {
        const config = loadFullSuiteValidationConfig(repoRoot);
        timeoutForecastLabel = formatFullSuiteTimeoutForecast(buildFullSuiteTimeoutForecast(repoRoot, config));
    } catch {
        timeoutForecastLabel = null;
    }
    const missingCompile = !compileCommand || compileCommand === '__COMPILE_GATE_COMMAND_UNCONFIGURED__';
    const status: ReportSystemStateHealth = workflowTab.status === 'invalid' || missingCompile
        ? 'error'
        : workflowTab.status === 'missing' || (taskReset.configuredEnabled && !taskReset.enabled)
            ? 'attention'
            : 'ok';
    return {
        ...signal(
            'workflow-readiness',
            'Workflow readiness',
            status,
            missingCompile
                ? 'Compile-gate command is not configured.'
                : taskReset.configuredEnabled && !taskReset.enabled
                    ? 'Task reset is enabled in config but audited readiness is missing.'
                    : 'Workflow config is readable and core lifecycle settings are available.',
            missingCompile
                ? 'Run agent-init or workflow set to record a project-specific compile/build/type-check command.'
                : taskReset.configuredEnabled && !taskReset.enabled
                    ? taskReset.remediationCommand
                    : null,
            {
                compile_command: compileCommand,
                full_suite_enabled: fullSuiteEnabled,
                full_suite_command: fullSuiteCommand,
                task_reset_ready: taskReset.enabled
            },
            workflowTab.config_path
        ),
        compile_command: compileCommand,
        full_suite_enabled: fullSuiteEnabled,
        full_suite_command: fullSuiteCommand,
        full_suite_timeout_forecast_label: timeoutForecastLabel,
        task_reset_ready: taskReset.enabled
    };
}

function buildProjectMemorySignal(tab: ReportProjectMemoryTab): ReportSystemStateSignal {
    const initialized = booleanValue(valueRowValue(tab.status, 'memory-initialized'));
    const validated = booleanValue(valueRowValue(tab.status, 'memory-validated'));
    const missingFiles = tab.files.filter((file) => !file.exists);
    const status: ReportSystemStateHealth = missingFiles.length > 0
        ? 'error'
        : initialized && validated
            ? 'ok'
            : 'attention';
    return signal(
        'project-memory',
        'Project memory',
        status,
        missingFiles.length > 0
            ? `${missingFiles.length} project-memory file(s) are missing.`
            : initialized && validated
                ? 'Project memory is initialized and validated.'
                : 'Project memory is not fully initialized or validated.',
        missingFiles.length > 0
            ? 'Restore the missing memory files or rerun agent-init/project-memory bootstrap.'
            : initialized && validated
                ? null
                : 'Run agent-init to refresh project-memory checkpoints.',
        {
            initialized,
            validated,
            missing_files: missingFiles.map((file) => file.path)
        },
        tab.memory_directory_path
    );
}

function buildProtectedManifestSignal(repoRoot: string): ReportSystemState['protected_manifest'] {
    const evidence = evaluateProtectedControlPlaneManifest(repoRoot, null, true);
    const assessment = assessProtectedManifest({
        evidence,
        parityResult: { isSourceCheckout: evidence.manifest?.is_source_checkout === true },
        allowSourceCheckoutInfo: true
    });
    const status: ReportSystemStateHealth = assessment?.severity === 'fail'
        ? 'error'
        : assessment?.severity === 'warn'
            ? 'attention'
            : 'ok';
    return {
        ...signal(
            'protected-manifest',
            'Protected manifest',
            status,
            evidence.status === 'DRIFT'
                ? `Protected manifest drift detected for ${evidence.changed_files.length} file(s).`
                : `Protected manifest status is ${evidence.status}.`,
            assessment?.requires_refresh
                ? 'If the drift is operator-approved, run repair protected-manifest with confirmation.'
                : null,
            evidence.status,
            evidence.manifest_path
        ),
        assessment_code: assessment?.code ?? null,
        changed_files: evidence.changed_files
    };
}

function countRuntimeArtifactFiles(repoRoot: string, fileNamePattern: RegExp): { count: number; truncated: boolean } {
    const runtimeRoot = joinOrchestratorPath(path.resolve(repoRoot), 'runtime');
    const searchRoots = [
        path.join(runtimeRoot, 'task-events'),
        path.join(runtimeRoot, 'full-suite'),
        path.join(runtimeRoot, 'locks')
    ];
    let count = 0;
    let visited = 0;
    let truncated = false;
    for (const root of searchRoots) {
        if (!fs.existsSync(root)) {
            continue;
        }
        const stack = [root];
        while (stack.length > 0 && visited < MAX_RUNTIME_SIGNAL_SCAN_ENTRIES) {
            const current = stack.pop() as string;
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                visited += 1;
                if (visited > MAX_RUNTIME_SIGNAL_SCAN_ENTRIES) {
                    truncated = true;
                    break;
                }
                const entryPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    stack.push(entryPath);
                } else if (fileNamePattern.test(entry.name)) {
                    count += 1;
                }
            }
        }
        if (stack.length > 0 || visited >= MAX_RUNTIME_SIGNAL_SCAN_ENTRIES) {
            truncated = true;
            break;
        }
    }
    return { count, truncated };
}

function buildRuntimeSignals(repoRoot: string, rows: ReportTaskRow[]): ReportSystemState['runtime'] {
    const bundleRoot = joinOrchestratorPath(path.resolve(repoRoot), '.');
    const lockHealth = scanTaskEventLocks(bundleRoot);
    const runtimeArtifactScan = countRuntimeArtifactFiles(repoRoot, /\.lock(?:\.json)?$/iu);
    const taskStatuses = new Map(rows.map((row) => [row.task_id, normalizeStatusToken(row.status_token)]));
    const timelineSummary = collectTimelineSummaryForStatus(bundleRoot, { taskStatuses });
    const timelineStatus: ReportSystemStateHealth = timelineSummary.warnings.length === 0
        ? 'ok'
        : timelineSummary.warnings.some((warning) => /INVALID|INTEGRITY_FAILED|LEGACY/u.test(warning))
            ? 'error'
            : 'attention';
    const staleLocks = signal(
        'runtime-locks',
        'Task-event lock health',
        lockHealth.stale_count > 0 || runtimeArtifactScan.truncated ? 'attention' : 'ok',
        lockHealth.stale_count > 0
            ? `${lockHealth.stale_count} stale task-event lock(s) detected.`
            : lockHealth.active_count > 0
                ? `${lockHealth.active_count} active task-event lock(s) detected; none are classified as stale.`
                : 'No task-event locks are classified as stale.',
        lockHealth.stale_count > 0
            ? lockHealth.locks.find((lock) => lock.status === 'STALE')?.remediation ?? 'Run doctor stale-lock cleanup diagnostics before removing locks.'
            : runtimeArtifactScan.truncated
                ? 'Run doctor for a complete runtime lock classification; the broad artifact scan was truncated.'
                : null,
        {
            active_count: lockHealth.active_count,
            stale_count: lockHealth.stale_count,
            lock_root: lockHealth.lock_root,
            stale_locks: lockHealth.locks.filter((lock) => lock.status === 'STALE').map((lock) => ({
                lock_name: lock.lock_name,
                task_id: lock.task_id,
                stale_reason: lock.stale_reason,
                remediation: lock.remediation
            })),
            artifact_scan: {
                lock_count: runtimeArtifactScan.count,
                scan_truncated: runtimeArtifactScan.truncated,
                scan_limit: MAX_RUNTIME_SIGNAL_SCAN_ENTRIES
            }
        },
        lockHealth.lock_root
    );
    const incompleteTimeline = signal(
        'active-task-timelines',
        'Task timeline health',
        timelineStatus,
        timelineSummary.warnings.length > 0
            ? `${timelineSummary.warnings.length} task timeline warning(s) detected.`
            : `${timelineSummary.healthy}/${timelineSummary.taskCount} task timeline(s) are complete.`,
        timelineSummary.warnings.length > 0
            ? timelineSummary.warnings[0]
            : null,
        {
            task_count: timelineSummary.taskCount,
            healthy: timelineSummary.healthy,
            warnings: timelineSummary.warnings.slice(0, 10),
            warnings_truncated: timelineSummary.warnings.length > 10
        },
        joinOrchestratorPath(path.resolve(repoRoot), 'runtime/task-events')
    );
    const artifactScan = signal(
        'runtime-artifact-scan',
        'Runtime artifact scan',
        runtimeArtifactScan.truncated ? 'attention' : 'ok',
        runtimeArtifactScan.truncated
            ? `Runtime artifact scan reached the ${MAX_RUNTIME_SIGNAL_SCAN_ENTRIES} entry limit.`
            : `${runtimeArtifactScan.count} broad runtime lock artifact(s) were found in the bounded scan.`,
        runtimeArtifactScan.truncated ? 'Run doctor for complete runtime diagnostics when this bounded UI summary is truncated.' : null,
        {
            lock_count: runtimeArtifactScan.count,
            scan_truncated: runtimeArtifactScan.truncated,
            scan_limit: MAX_RUNTIME_SIGNAL_SCAN_ENTRIES
        },
        joinOrchestratorPath(path.resolve(repoRoot), 'runtime')
    );
    return {
        stale_locks: staleLocks,
        incomplete_timeline: incompleteTimeline,
        artifact_scan: artifactScan,
        artifact_signals: [staleLocks, incompleteTimeline, artifactScan]
    };
}

export function buildSystemStateReport(options: {
    repoRoot: string;
    generatedAtUtc: string;
    tasks: ReportTaskRow[];
    workflowTab: ReportWorkflowConfigTab;
    initTab: ReportInitSettingsTab;
    projectMemoryTab: ReportProjectMemoryTab;
}): ReportSystemState {
    const garda = buildGardaSignal(options.repoRoot);
    const uiActions = buildUiActionsSignal();
    const taskQueue = buildTaskQueueSignal(options.tasks);
    const workflow = buildWorkflowSignal(options.repoRoot, options.workflowTab);
    const projectMemory = buildProjectMemorySignal(options.projectMemoryTab);
    const protectedManifest = buildProtectedManifestSignal(options.repoRoot);
    const runtime = buildRuntimeSignals(options.repoRoot, options.tasks);
    const configurationFiles = buildConfigFiles(options.initTab, options.workflowTab);
    const configSignals = configurationFiles
        .filter((entry) => entry.status !== 'present')
        .map((entry) => signal(
            `config-file-${entry.id}`,
            entry.label,
            entry.status === 'invalid' ? 'error' : 'attention',
            `${entry.path} is ${entry.status}.`,
            'Open the owning tab or run doctor to inspect the file.',
            entry.status,
            entry.path
        ));
    const signals = [
        garda,
        uiActions,
        taskQueue,
        workflow,
        projectMemory,
        protectedManifest,
        ...runtime.artifact_signals,
        ...configSignals
    ];
    const overallStatus = worstStatus(signals.filter(isPrimaryHealthSignal));
    return {
        overall: {
            status: overallStatus,
            label: overallStatus === 'ok'
                ? 'OK'
                : overallStatus === 'error'
                    ? 'Error'
                    : overallStatus === 'attention'
                        ? 'Needs attention'
                        : 'Unknown',
            summary: overallStatus === 'ok'
                ? 'Core System State signals look healthy.'
                : 'One or more System State signals need attention.',
            generated_at_utc: options.generatedAtUtc
        },
        garda,
        ui_actions: uiActions,
        task_queue: taskQueue,
        workflow,
        project_memory: projectMemory,
        protected_manifest: protectedManifest,
        runtime,
        configuration_files: configurationFiles,
        signals
    };
}

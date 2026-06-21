import type { StatusSnapshot } from '../../validators/status';
import type { EffectiveReviewExecutionPolicyMode } from '../../core/review-execution-policy';
import { buildReviewExecutionPolicySummaryLine } from '../../core/review-execution-policy';
import {
    buildTaskQueueStatusContract
} from '../../core/task-queue-status-contract';
import type { TaskCycleBindingSnapshot } from '../task-events-summary/task-events-summary';
import { buildDomainScopeFingerprints } from '../scope/domain-scope-fingerprints';
import { getWorkspaceSnapshotCached } from '../workspace/workspace-snapshot-cache';
import { toPosix } from '../shared/helpers';
import type { ProjectMemoryImpactLifecycleEvidence } from '../project-memory-impact';
import type {
    FinalCloseoutArtifact,
    FinalCloseoutFullSuiteTimeoutSummary,
    FinalCloseoutProjectMemorySummary,
    FinalCloseoutReviewTimingAuditSummary
} from './task-audit-summary';
import type {
    FinalCloseoutChangeMetrics,
    FinalCloseoutDocsSummary,
    FinalCloseoutOptionalSkillsSummary,
    FinalCloseoutReviewIntegrityAttestation,
    FinalCloseoutReviewTrustSummary,
    FinalReportContract,
    ReviewAttemptSummary
} from './task-audit-summary-collectors';
import { parseOptionalNumber } from './task-audit-summary-collectors';
import { buildFinalCloseoutProjectMemorySummary } from './task-audit-summary-project-memory';
import {
    collectKnownNonBlockingSignals
} from '../shared/known-nonblocking-signals';

export interface BuildFinalCloseoutArtifactInput {
    repoRoot: string;
    taskId: string;
    auditStatus: 'PASS' | 'BLOCKED' | 'INCOMPLETE';
    finalReportContract: FinalReportContract;
    finalCloseoutJsonPath: string;
    finalCloseoutMarkdownPath: string;
    finalUserReportPath: string;
    currentCycle: TaskCycleBindingSnapshot | null;
    taskMode: Record<string, unknown> | null;
    pathMode: string | null;
    reviewVerdicts: Record<string, string>;
    docsSummary: FinalCloseoutDocsSummary;
    changedFiles: string[];
    changedFilesCount: number;
    changedLinesTotal: number;
    changeMetrics: FinalCloseoutChangeMetrics;
    scopeCategory: string | null;
    reviewTrustSummary: FinalCloseoutReviewTrustSummary | null;
    reviewTimingAudit: FinalCloseoutReviewTimingAuditSummary | null;
    reviewIntegrityAttestation: FinalCloseoutReviewIntegrityAttestation;
    reviewAttemptSummary: ReviewAttemptSummary | null;
    optionalSkillsSummary: FinalCloseoutOptionalSkillsSummary | null;
    fullSuiteValidation: Record<string, unknown> | null;
    fullSuiteValidationRequiredForLifecycle: boolean;
    reviewExecutionPolicyMode: EffectiveReviewExecutionPolicyMode;
    projectMemoryImpactEvidence: ProjectMemoryImpactLifecycleEvidence;
    tokenEconomy: FinalCloseoutArtifact['token_economy'];
    workspaceStatusSnapshot: StatusSnapshot;
    commitCommandTemplate: string;
    commitCommandSuggestion: string;
}

function readTaskModePlannedChangedFiles(taskMode: Record<string, unknown> | null): string[] {
    const plannedChangedFiles = Array.isArray(taskMode?.planned_changed_files)
        ? taskMode.planned_changed_files
        : [];
    return [...new Set(plannedChangedFiles
        .map((entry) => toPosix(String(entry || '').trim()))
        .filter(Boolean))]
        .sort((left, right) => left.localeCompare(right));
}

function readTaskModeDirtyWorkspaceBaselineChangedFiles(taskMode: Record<string, unknown> | null): string[] {
    const dirtyWorkspaceBaseline = taskMode?.dirty_workspace_baseline;
    if (!dirtyWorkspaceBaseline || typeof dirtyWorkspaceBaseline !== 'object' || Array.isArray(dirtyWorkspaceBaseline)) {
        return [];
    }
    const changedFiles = (dirtyWorkspaceBaseline as Record<string, unknown>).changed_files;
    if (!Array.isArray(changedFiles)) {
        return [];
    }
    return [...new Set(changedFiles
        .map((entry) => toPosix(String(entry || '').trim()))
        .filter(Boolean))]
        .sort((left, right) => left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function normalizeOptionalNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);
}

function normalizeForecastExcludedReasons(value: unknown): Record<string, number> {
    if (!isRecord(value)) {
        return {};
    }
    const entries: [string, number][] = [];
    for (const [reason, count] of Object.entries(value)) {
        const normalizedCount = normalizeOptionalNumber(count);
        if (normalizedCount != null && normalizedCount > 0) {
            entries.push([reason, normalizedCount]);
        }
    }
    return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeRepairTaskProposal(value: unknown): FinalCloseoutFullSuiteTimeoutSummary['repair_task_proposal'] {
    if (!isRecord(value)) {
        return null;
    }
    const suggestedTaskId = String(value.suggested_task_id || '').trim();
    const title = String(value.title || '').trim();
    const area = String(value.area || '').trim();
    const rationale = String(value.rationale || '').trim();
    if (!suggestedTaskId || !title || !area || !rationale) {
        return null;
    }
    return {
        suggested_task_id: suggestedTaskId,
        title,
        area,
        rationale
    };
}

function formatForecastExcludedReasons(reasons: Record<string, number>): string {
    const parts = Object.entries(reasons)
        .map(([reason, count]) => `${reason}=${count}`);
    return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function buildFullSuiteTimeoutSummary(
    artifact: Record<string, unknown> | null
): FinalCloseoutFullSuiteTimeoutSummary | null {
    if (!artifact) {
        return null;
    }
    const timeoutPolicy = isRecord(artifact.timeout_policy) ? artifact.timeout_policy : {};
    const timeoutForecast = isRecord(artifact.timeout_forecast) ? artifact.timeout_forecast : {};
    const attempts = Array.isArray(timeoutPolicy.attempts) ? timeoutPolicy.attempts : [];
    const forecastExcludedSampleReasons = normalizeForecastExcludedReasons(timeoutForecast.excluded_sample_reasons);
    const forecastExcludedSampleCount = normalizeOptionalNumber(timeoutForecast.excluded_sample_count);
    const summary: FinalCloseoutFullSuiteTimeoutSummary = {
        artifact_present: true,
        status: typeof artifact.status === 'string' && artifact.status.trim() ? artifact.status.trim() : null,
        timed_out: normalizeOptionalBoolean(artifact.timed_out),
        timeout_blocker: normalizeOptionalBoolean(timeoutPolicy.timeout_blocker),
        timeout_retry_count: normalizeOptionalNumber(timeoutPolicy.timeout_retry_count),
        max_attempts: normalizeOptionalNumber(timeoutPolicy.max_attempts),
        attempts_count: attempts.length,
        attempts_exhausted: normalizeOptionalBoolean(timeoutPolicy.attempts_exhausted),
        warning_only_continuation: normalizeOptionalBoolean(timeoutPolicy.warning_only_continuation),
        repair_task_proposal: normalizeRepairTaskProposal(timeoutPolicy.repair_task_proposal),
        warnings: normalizeStringArray(artifact.warnings),
        forecast_warning: typeof timeoutForecast.warning === 'string' && timeoutForecast.warning.trim()
            ? timeoutForecast.warning.trim()
            : null,
        forecast_excluded_sample_count: forecastExcludedSampleCount,
        forecast_excluded_sample_reasons: forecastExcludedSampleReasons,
        visible_summary_line: ''
    };
    const attemptsText = summary.max_attempts != null
        ? `${summary.attempts_count}/${summary.max_attempts}`
        : String(summary.attempts_count);
    const warningsCount = summary.warnings.length + (summary.forecast_warning ? 1 : 0);
    summary.visible_summary_line =
        `Full-suite timeout: status=${summary.status || 'unknown'}; timed_out=${summary.timed_out ?? 'unknown'}; ` +
        `blocker=${summary.timeout_blocker ?? 'unknown'}; retry_count=${summary.timeout_retry_count ?? 'unknown'}; ` +
        `attempts=${attemptsText}; exhausted=${summary.attempts_exhausted ?? 'unknown'}; ` +
        `warning_only=${summary.warning_only_continuation ?? 'unknown'}; ` +
        `forecast_excluded=${summary.forecast_excluded_sample_count ?? 0}${formatForecastExcludedReasons(summary.forecast_excluded_sample_reasons)}; ` +
        `warnings=${warningsCount}`;
    return summary;
}

export function buildFinalCloseoutArtifact(input: BuildFinalCloseoutArtifactInput): FinalCloseoutArtifact {
    let closeoutScopeSnapshot: ReturnType<typeof getWorkspaceSnapshotCached> | null = null;
    if (input.changedFiles.length > 0) {
        try {
            closeoutScopeSnapshot = getWorkspaceSnapshotCached(input.repoRoot, 'explicit_changed_files', true, input.changedFiles, {
                noCache: true,
                readOnly: true
            });
        } catch {
            closeoutScopeSnapshot = null;
        }
    }
    const plannedChangedFiles = readTaskModePlannedChangedFiles(input.taskMode);
    const dirtyWorkspaceBaselineChangedFiles = readTaskModeDirtyWorkspaceBaselineChangedFiles(input.taskMode);

    const projectMemory = buildFinalCloseoutProjectMemorySummary(input.projectMemoryImpactEvidence) as FinalCloseoutProjectMemorySummary;
    const knownNonBlockingSignals = collectKnownNonBlockingSignals({
        projectMemory
    });
    const fullSuiteTimeoutSummary = buildFullSuiteTimeoutSummary(input.fullSuiteValidation);

    return {
        schema_version: 1,
        event_source: 'task-audit-summary',
        task_id: input.taskId,
        generated_utc: new Date().toISOString(),
        audit_status: input.auditStatus,
        status: input.finalReportContract.status,
        blocker: input.finalReportContract.blocker,
        artifact_state: input.finalReportContract.status === 'READY' ? 'PENDING' : 'NOT_READY',
        cycle_binding: input.currentCycle
            ? {
                preflight_path: input.currentCycle.preflight_path,
                preflight_sha256: input.currentCycle.preflight_sha256,
                compile_gate_timestamp: input.currentCycle.compile_gate_timestamp
            }
            : null,
        artifact_paths: {
            json: toPosix(input.finalCloseoutJsonPath),
            markdown: toPosix(input.finalCloseoutMarkdownPath),
            final_user_report: toPosix(input.finalUserReportPath)
        },
        implementation_summary: {
            requested_depth: parseOptionalNumber(input.taskMode?.requested_depth),
            effective_depth: parseOptionalNumber(input.taskMode?.effective_depth),
            path_mode: input.pathMode,
            orchestrator_work: input.taskMode?.orchestrator_work === true,
            workflow_config_work: input.taskMode?.workflow_config_work === true,
            planned_changed_files: plannedChangedFiles,
            task_mode_scope_snapshot: {
                orchestrator_work: input.taskMode?.orchestrator_work === true,
                workflow_config_work: input.taskMode?.workflow_config_work === true,
                planned_changed_files: plannedChangedFiles,
                dirty_workspace_baseline_changed_files: dirtyWorkspaceBaselineChangedFiles,
                authorized_changed_files: [...new Set([
                    ...plannedChangedFiles,
                    ...dirtyWorkspaceBaselineChangedFiles
                ])].sort((left, right) => left.localeCompare(right))
            },
            review_verdicts: input.reviewVerdicts,
            docs_updated: input.docsSummary.decision === 'DOCS_UPDATED',
            changed_files: input.changedFiles,
            changed_files_sha256: closeoutScopeSnapshot?.changed_files_sha256 ?? null,
            scope_content_sha256: closeoutScopeSnapshot?.scope_content_sha256 ?? null,
            scope_sha256: closeoutScopeSnapshot?.scope_sha256 ?? null,
            domain_scope_fingerprints: closeoutScopeSnapshot
                ? buildDomainScopeFingerprints({
                    repoRoot: input.repoRoot,
                    detectionSource: closeoutScopeSnapshot.detection_source,
                    includeUntracked: !!closeoutScopeSnapshot.include_untracked,
                    changedFiles: closeoutScopeSnapshot.changed_files
                })
                : null,
            change_metrics: input.changeMetrics,
            changed_files_count: input.changedFilesCount,
            changed_lines_total: input.changedLinesTotal,
            scope_category: input.scopeCategory,
            active_profile: typeof input.taskMode?.active_profile === 'string' && input.taskMode.active_profile.trim()
                ? input.taskMode.active_profile.trim()
                : null
        },
        review_trust: input.reviewTrustSummary,
        review_timing_audit: input.reviewTimingAudit,
        review_integrity_attestation: input.reviewIntegrityAttestation,
        review_attempt_summary: input.reviewAttemptSummary,
        optional_skills: input.optionalSkillsSummary,
        workflow: {
            mandatory_full_suite_enabled: input.fullSuiteValidationRequiredForLifecycle,
            visible_summary_line: `Mandatory full-suite: ${input.fullSuiteValidationRequiredForLifecycle ? 'true' : 'false'}`,
            review_execution_policy_mode: input.reviewExecutionPolicyMode,
            review_execution_policy_summary_line: buildReviewExecutionPolicySummaryLine(input.reviewExecutionPolicyMode),
            full_suite_timeout: fullSuiteTimeoutSummary
        },
        docs: input.docsSummary,
        project_memory: projectMemory,
        known_non_blocking_signals: knownNonBlockingSignals,
        token_economy: input.tokenEconomy,
        task_queue_status_contract: buildTaskQueueStatusContract(input.taskId),
        agent_report: {
            assistant_language: input.workspaceStatusSnapshot.assistantLanguage,
            assistant_language_confirmed: input.workspaceStatusSnapshot.assistantLanguageConfirmed,
            next_task_command: input.workspaceStatusSnapshot.readyForTasks
                ? input.workspaceStatusSnapshot.recommendedNextCommand
                : null,
            latest_update_notice: input.workspaceStatusSnapshot.latestUpdateNotice
        },
        commit_command_template: input.commitCommandTemplate,
        commit_command_suggestion: input.commitCommandSuggestion,
        commit_question: input.finalReportContract.commit_question
    };
}

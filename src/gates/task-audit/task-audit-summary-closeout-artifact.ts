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
            review_execution_policy_summary_line: buildReviewExecutionPolicySummaryLine(input.reviewExecutionPolicyMode)
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

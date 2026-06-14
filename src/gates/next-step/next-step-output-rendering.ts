import type {
    NextStepArtifactState,
    NextStepCommand,
    NextStepFinalReportSummary,
    NextStepFullSuiteSummary,
    NextStepInvalidationImpactSummary,
    NextStepOptionalSkillSelectionSummary,
    NextStepProfileSummary,
    NextStepProjectMemorySummary,
    NextStepResult,
    NextStepReviewCycleBlock,
    NextStepReviewSummary,
    NextStepStatus
} from './next-step';
import type {
    KnownNonBlockingSignal
} from '../shared/known-nonblocking-signals';
import type {
    TaskModeMarkdownWorkingPlanMetadata
} from '../task-mode/task-mode';
import type {
    TaskAuditSummaryResult
} from '../task-audit/task-audit-summary';
import type {
    TaskQueueStatusContract
} from '../../core/task-queue-status-contract';

export interface RenderNextStepOutputParams {
    taskId: string;
    navigatorCommand: string;
    status: NextStepStatus;
    nextGate: string | null;
    title: string;
    reason: string;
    commands: NextStepCommand[];
    missingArtifacts: NextStepArtifactState[];
    presentArtifacts: NextStepArtifactState[];
    fullSuite: NextStepFullSuiteSummary;
    projectMemory?: NextStepProjectMemorySummary | null;
    review: NextStepReviewSummary;
    auditStatus: TaskAuditSummaryResult['status'];
    profile: NextStepProfileSummary | null;
    markdownWorkingPlan?: TaskModeMarkdownWorkingPlanMetadata | null;
    optionalSkillSelection?: NextStepOptionalSkillSelectionSummary | null;
    warnings?: string[];
    invalidationImpact: NextStepInvalidationImpactSummary | null;
    knownNonBlockingSignals: KnownNonBlockingSignal[];
    reviewCycleBlock?: NextStepReviewCycleBlock | null;
    finalReport?: NextStepFinalReportSummary | null;
    taskQueueStatusContract: TaskQueueStatusContract;
}

export function renderNextStepOutput(params: RenderNextStepOutputParams): NextStepResult {
    return {
        schema_version: 1,
        task_id: params.taskId,
        generated_utc: new Date().toISOString(),
        navigator_command: params.navigatorCommand,
        status: params.status,
        next_gate: params.nextGate,
        title: params.title,
        reason: params.reason,
        commands: params.commands,
        missing_artifacts: params.status === 'DONE' ? [] : params.missingArtifacts,
        present_artifacts: params.presentArtifacts,
        full_suite_validation: params.fullSuite,
        project_memory: params.projectMemory || null,
        review: params.review,
        task_queue_status_contract: params.taskQueueStatusContract,
        audit_status: params.auditStatus,
        profile: params.profile,
        markdown_working_plan: params.markdownWorkingPlan || null,
        optional_skill_selection: params.optionalSkillSelection || null,
        warnings: params.warnings || [],
        invalidation_impact: params.invalidationImpact,
        known_non_blocking_signals: params.knownNonBlockingSignals,
        review_cycle_block: params.reviewCycleBlock || null,
        final_report: params.finalReport || null
    };
}

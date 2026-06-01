import * as gateHelpers from '../../../../gates/shared/helpers';

interface PreparedReviewContextSummary {
    reviewType: string;
    outputPath: string;
    ruleContextArtifactPath: string;
}

export function formatReviewTypeList(reviewTypes: readonly string[]): string {
    return reviewTypes.length > 0 ? reviewTypes.join(', ') : 'none';
}

export function buildCoherentCycleRestartedOutput(input: {
    taskId: string;
    taskModePath: string;
    preflightPath: string;
    detectionSource: string;
    plannedChangedFilesCount: number;
    changedFilesCount: unknown;
    preflightSummary: string;
}): string[] {
    return [
        'COHERENT_CYCLE_RESTARTED',
        `TaskId: ${input.taskId}`,
        `TaskModePath: ${gateHelpers.normalizePath(input.taskModePath)}`,
        `PreflightPath: ${gateHelpers.normalizePath(input.preflightPath)}`,
        `DetectionSource: ${input.detectionSource}`,
        `PlannedChangedFilesCount: ${input.plannedChangedFilesCount}`,
        `ChangedFilesCount: ${input.changedFilesCount}`,
        'NextStep: materialize review artifacts for the new compile cycle, then rerun required-reviews-check, doc-impact-gate, and completion-gate.',
        `PreflightSummary: ${input.preflightSummary.trim().replace(/\s+/g, ' ')}`
    ];
}

export function buildReviewCycleRestartedOutput(input: {
    taskId: string;
    preflightPath: string;
    remediationArtifactPath: string;
    detectionSource: string;
    impactAnalysisSource: string;
    affectedFilesCount: number;
    remediationCategory: string;
    invalidatedReviewTypes: readonly string[];
    preservedReviewTypes: readonly string[];
    scopeBoundaryStatus: string;
    previousFilesCount: number;
    currentFilesCount: number;
    expandedNonTestFiles: readonly string[];
    reviewContextsRefreshStatus: string;
    effectiveDepth: number;
    reviewExecutionPolicyMode: string;
    preparedResults: readonly PreparedReviewContextSummary[];
    launchRequiredReviewTypes: readonly string[];
    reusedReviewTypes: readonly string[];
    pendingReviewTypes: readonly string[];
    pendingReason: string | null;
    nextStep: string;
    preflightSummary: string;
}): string[] {
    return [
        'REVIEW_CYCLE_RESTARTED',
        `TaskId: ${input.taskId}`,
        `PreflightPath: ${gateHelpers.normalizePath(input.preflightPath)}`,
        `ReviewRemediationCycleArtifact: ${gateHelpers.normalizePath(input.remediationArtifactPath)}`,
        `DetectionSource: ${input.detectionSource}`,
        `ImpactAnalysis: recorded; affected_files=${input.affectedFilesCount}; source=${input.impactAnalysisSource}`,
        `RemediationFixClassification: ${input.remediationCategory}; invalidated_review_types=${formatReviewTypeList(input.invalidatedReviewTypes)}; preserved_review_types=${formatReviewTypeList(input.preservedReviewTypes)}`,
        `ScopeBoundary: ${input.scopeBoundaryStatus}; previous=${input.previousFilesCount}; current=${input.currentFilesCount}; expanded_non_test=${formatReviewTypeList(input.expandedNonTestFiles)}`,
        `RefreshPoints: preflight=refreshed; post_preflight_rule_pack=reloaded; compile=rerun; review_contexts=${input.reviewContextsRefreshStatus}`,
        `ReuseBoundaries: non_test_changes_must_stay_within_previous_preflight_scope; test_only_expansion_allowed; expanded_non_test_files_block_reuse`,
        `EffectiveDepth: ${input.effectiveDepth}`,
        `ReviewExecutionPolicy: ${input.reviewExecutionPolicyMode}`,
        `PreparedReviewTypes: ${formatReviewTypeList(input.preparedResults.map((result) => result.reviewType))}`,
        `LaunchRequiredReviewTypes: ${formatReviewTypeList(input.launchRequiredReviewTypes)}`,
        `ReusedReviewTypes: ${formatReviewTypeList(input.reusedReviewTypes)}`,
        ...input.preparedResults.flatMap((result) => ([
            `PreparedReviewContext[${result.reviewType}]: ${gateHelpers.normalizePath(result.outputPath)}`,
            `RuleContextArtifact[${result.reviewType}]: ${gateHelpers.normalizePath(result.ruleContextArtifactPath)}`
        ])),
        ...(input.pendingReviewTypes.length > 0
            ? [
                `PendingReviewTypes: ${formatReviewTypeList(input.pendingReviewTypes)}`,
                `PendingReason: ${input.pendingReason}`
            ]
            : []),
        `NextStep: ${input.nextStep}`,
        `PreflightSummary: ${input.preflightSummary.trim().replace(/\s+/g, ' ')}`
    ];
}

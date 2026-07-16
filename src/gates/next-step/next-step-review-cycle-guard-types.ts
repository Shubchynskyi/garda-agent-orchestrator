import {
    type ReviewCycleGuardEvaluation as CoreReviewCycleGuardEvaluation
} from '../../core/review-cycle-guard';

export interface ReviewCycleAttemptCountSummary {
    total: number;
    failed: number;
    passed: number;
    pending: number;
}

export interface ReviewCycleFreshReuseSummary {
    fresh: number;
    reused: number;
}

export interface ReviewCycleScopeHashSummary extends ReviewCycleAttemptCountSummary, ReviewCycleFreshReuseSummary {
    scope_hash: string;
    current_scope: boolean;
}

export interface ReviewCycleAttemptDiagnostics {
    cumulative_total_attempt_count: number;
    cumulative_total_non_test_review_count: number;
    cumulative_failed_non_test_review_count: number;
    current_scope_total_attempt_count: number;
    current_scope_total_non_test_review_count: number;
    current_scope_failed_non_test_review_count: number;
    fresh_non_test_review_count: number;
    reused_non_test_review_count: number;
    current_scope_counts_by_review_type: Record<string, ReviewCycleAttemptCountSummary>;
    fresh_reused_by_review_type: Record<string, ReviewCycleFreshReuseSummary>;
    scope_hash_count_by_review_type: Record<string, number>;
    top_scope_hashes_by_review_type: Record<string, ReviewCycleScopeHashSummary[]>;
}

export interface ReviewCycleGuardEvaluation extends CoreReviewCycleGuardEvaluation {
    current_scope_total_non_test_review_count: number;
    current_scope_failed_non_test_review_count: number;
    current_scope_counts_by_review_type: Record<string, ReviewCycleAttemptCountSummary>;
    attempt_diagnostics: ReviewCycleAttemptDiagnostics;
}

export interface NextStepReviewCycleLatestFailedReview {
    review_type: string;
    event_type: string;
    outcome: string | null;
    verdict_token: string | null;
    reviewer_identity: string | null;
    review_artifact_path: string | null;
    summary: string | null;
    sequence: number;
    timestamp_utc: string | null;
}

export interface NextStepReviewCycleBlock {
    kind: 'review_cycle_guard';
    operator_decision_required: boolean;
    wait_for_operator: boolean;
    auto_split_enabled: boolean;
    reason: string;
    max_failed_non_test_reviews: number;
    max_total_non_test_reviews: number;
    total_non_test_review_count: number;
    failed_non_test_review_count: number;
    counts_by_review_type: Record<string, { total: number; failed: number; passed: number; pending: number }>;
    cumulative_total_non_test_review_count: number;
    cumulative_failed_non_test_review_count: number;
    current_scope_total_non_test_review_count: number;
    current_scope_failed_non_test_review_count: number;
    current_scope_counts_by_review_type: Record<string, ReviewCycleAttemptCountSummary>;
    fresh_non_test_review_count: number;
    reused_non_test_review_count: number;
    fresh_reused_by_review_type: Record<string, ReviewCycleFreshReuseSummary>;
    scope_hash_count_by_review_type: Record<string, number>;
    top_scope_hashes_by_review_type: Record<string, ReviewCycleScopeHashSummary[]>;
    excluded_review_types: string[];
    latest_failed_review: NextStepReviewCycleLatestFailedReview | null;
    choices: string[];
    operator_choice_guidance: string[];
    auto_split_prompt: NextStepReviewCycleAutoSplitPrompt | null;
}

export interface NextStepReviewCycleAutoSplitPrompt {
    kind: 'review_cycle_auto_split_prompt';
    artifact_path: string;
    artifact_sha256: string;
    current_state: 'no_diff' | 'suspended_manifest' | 'checkpoint';
    latch_artifact_path: string;
    latch_artifact_sha256: string;
    wip_capture_status: 'CAPTURED' | 'ALREADY_CAPTURED' | 'BLOCKED' | 'NOT_CAPTURED';
    wip_manifest_path: string | null;
    work_package_contract_path: string;
    next_action: string;
    state_next_action: 'run_validation_lane' | 'preview_restore' | 'inspect_checkpoint_scope';
    next_action_command: string;
    instructions: string[];
    constraints: string[];
}

export interface ReviewCycleGuardReadEvaluationResult {
    evaluation: ReviewCycleGuardEvaluation;
    latestFailedReview: NextStepReviewCycleLatestFailedReview | null;
}

export interface ReviewCycleGuardReadAttempt {
    reviewType: string;
    failed: boolean;
    passed: boolean;
    latestEventFailed: boolean;
    reused: boolean;
    scopeHash: string | null;
    currentScope: boolean;
    lastSequence: number;
}

export interface ReviewCycleGuardReadResult {
    attempts: ReviewCycleGuardReadAttempt[];
    timelineValid: boolean;
    latestFailedReview: NextStepReviewCycleLatestFailedReview | null;
}

export interface ReviewCycleArtifactVerdictResult {
    failed: boolean | null;
    invalidSnapshot: boolean;
}

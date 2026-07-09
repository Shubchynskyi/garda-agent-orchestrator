import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    resolveBundleNameForTarget
} from '../../core/constants';
import {
    allocateParentDerivedTaskIds
} from '../../core/task-id-allocation';
import {
    normalizePath
} from '../shared/helpers';
import {
    formatNextStepInlineList,
    formatNextStepInlineValue,
    quoteCommandValue,
    toRepoDisplayPath
} from './next-step-command-formatters';
import {
    sanitizeReviewCycleAutoSplitSummary
} from './next-step-split-required-latch';
import {
    parseTaskQueueEntriesFromContent
} from './next-step-task-queue';
import {
    type NextStepReviewCycleAutoSplitPrompt,
    type NextStepReviewCycleBlock,
    type NextStepReviewCycleLatestFailedReview,
    type ReviewCycleGuardEvaluation
} from './next-step-review-cycle-guard-types';

const REVIEW_CYCLE_OPERATOR_CHOICES = Object.freeze([
    'split_task',
    'mark_blocked',
    'raise_limits',
    'allow_one_more_cycle',
    'create_follow_up_tasks'
]);

const REVIEW_CYCLE_OPERATOR_CHOICE_GUIDANCE = Object.freeze([
    'allow_one_more_cycle: task-scoped one-shot runtime approval; writes runtime evidence only and does not edit workflow-config.json',
    'raise_limits: permanent repo-local workflow-config change through workflow set; requires separate operator approval and changes future runs',
    'split_task/create_follow_up_tasks: decompose work into child or follow-up tasks instead of increasing limits',
    'mark_blocked: stop the current task attempt and preserve the blocker'
]);

const REVIEW_CYCLE_AUTO_SPLIT_TEMPLATE_PATH = 'template/docs/prompts/review-cycle-auto-split.md';

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function resolveBundleRootForReviewCycleGuard(repoRoot: string): string {
    const sourceCheckoutBundleRoot = path.resolve(repoRoot);
    return fs.existsSync(path.join(sourceCheckoutBundleRoot, 'bin', 'garda.js'))
        ? sourceCheckoutBundleRoot
        : path.join(sourceCheckoutBundleRoot, resolveBundleNameForTarget(repoRoot));
}

function readTaskQueueEntries(repoRoot: string) {
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (!fileExists(taskPath)) {
        return new Map<string, never>();
    }
    return parseTaskQueueEntriesFromContent(fs.readFileSync(taskPath, 'utf8'));
}

export function buildReviewCycleContinuationCommand(
    cliPrefix: string,
    taskId: string,
    evaluation: ReviewCycleGuardEvaluation
): string {
    return [
        `${cliPrefix} gate record-review-cycle-continuation`,
        `--task-id "${taskId}"`,
        '--decision "allow_one_more_cycle"',
        `--baseline-total-non-test-reviews "${evaluation.total_non_test_review_count}"`,
        `--baseline-failed-non-test-reviews "${evaluation.failed_non_test_review_count}"`,
        `--max-total-non-test-reviews "${evaluation.max_total_non_test_reviews}"`,
        `--max-failed-non-test-reviews "${evaluation.max_failed_non_test_reviews}"`,
        `--excluded-review-types ${quoteCommandValue(evaluation.excluded_review_types.join(','))}`,
        `--reason ${quoteCommandValue('Operator approved exactly one additional review-cycle continuation without changing workflow-config.json.')}`,
        '--operator-confirmed yes',
        `--operator-confirmed-at-utc ${quoteCommandValue('<ISO-8601 timestamp>')}`,
        '--repo-root "."'
    ].join(' ');
}

export function buildReviewCycleSplitDecisionCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    evaluation: ReviewCycleGuardEvaluation,
    preflightPath: string
): string {
    return [
        `${cliPrefix} gate record-review-cycle-split-decision`,
        `--task-id "${taskId}"`,
        '--decision "split_task"',
        `--preflight-path ${quoteCommandValue(toRepoDisplayPath(repoRoot, preflightPath))}`,
        `--baseline-total-non-test-reviews "${evaluation.total_non_test_review_count}"`,
        `--baseline-failed-non-test-reviews "${evaluation.failed_non_test_review_count}"`,
        `--max-total-non-test-reviews "${evaluation.max_total_non_test_reviews}"`,
        `--max-failed-non-test-reviews "${evaluation.max_failed_non_test_reviews}"`,
        `--excluded-review-types ${quoteCommandValue(evaluation.excluded_review_types.join(','))}`,
        `--reason ${quoteCommandValue('Operator chose to split the task after the review-cycle guard blocked continuation.')}`,
        '--operator-confirmed yes',
        `--operator-confirmed-at-utc ${quoteCommandValue('<ISO-8601 timestamp>')}`,
        '--repo-root "."'
    ].join(' ');
}

function formatLatestFailedReviewForTemplate(latestFailedReview: NextStepReviewCycleLatestFailedReview | null): string {
    if (!latestFailedReview) {
        return 'none';
    }
    const parts = [
        `review_type=${formatNextStepInlineValue(latestFailedReview.review_type)}`,
        `event=${formatNextStepInlineValue(latestFailedReview.event_type)}`,
        `outcome=${formatNextStepInlineValue(latestFailedReview.outcome || 'unknown')}`,
        `sequence=${latestFailedReview.sequence}`
    ];
    if (latestFailedReview.review_artifact_path) {
        parts.push(`artifact=${formatNextStepInlineValue(latestFailedReview.review_artifact_path)}`);
    }
    if (latestFailedReview.summary) {
        parts.push(`summary=${formatNextStepInlineValue(latestFailedReview.summary)}`);
    }
    return parts.join('; ');
}

function readReviewCycleAutoSplitTemplate(repoRoot: string): string {
    const templatePath = path.join(resolveBundleRootForReviewCycleGuard(repoRoot), REVIEW_CYCLE_AUTO_SPLIT_TEMPLATE_PATH);
    try {
        return fs.readFileSync(templatePath, 'utf8');
    } catch (error: unknown) {
        throw new Error(
            `Review-cycle auto-split prompt template is required but unreadable: ${normalizePath(templatePath)}. ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function buildReviewCycleAutoSplitPromptContent(
    repoRoot: string,
    taskId: string,
    evaluation: ReviewCycleGuardEvaluation,
    latestFailedReview: NextStepReviewCycleLatestFailedReview | null
): string {
    const taskEntries = readTaskQueueEntries(repoRoot);
    const suggestedChildTaskIds = allocateParentDerivedTaskIds({
        parentTaskId: taskId,
        existingTaskIds: taskEntries.keys(),
        kind: 'child',
        count: 3
    });
    const suggestedFollowupTaskId = allocateParentDerivedTaskIds({
        parentTaskId: taskId,
        existingTaskIds: [...taskEntries.keys(), ...suggestedChildTaskIds],
        kind: 'followup',
        count: 1
    })[0];
    const replacements: Record<string, string> = {
        TASK_ID: taskId,
        GUARD_REASON: formatNextStepInlineValue(sanitizeReviewCycleAutoSplitSummary(evaluation)),
        TOTAL_NON_TEST_REVIEWS: String(evaluation.total_non_test_review_count),
        FAILED_NON_TEST_REVIEWS: String(evaluation.failed_non_test_review_count),
        EXCLUDED_REVIEW_TYPES: formatNextStepInlineList(evaluation.excluded_review_types),
        LATEST_FAILED_REVIEW: formatLatestFailedReviewForTemplate(latestFailedReview),
        SUGGESTED_CHILD_TASK_IDS: suggestedChildTaskIds.map((childTaskId) => `\`${childTaskId}\``).join(', '),
        SUGGESTED_FOLLOWUP_TASK_ID: `\`${suggestedFollowupTaskId}\``
    };
    const template = readReviewCycleAutoSplitTemplate(repoRoot);
    return `${template.replace(/\{\{([A-Z0-9_]+)}}/g, (match, key: string) => replacements[key] ?? match).trimEnd()}\n`;
}

function materializeReviewCycleAutoSplitPrompt(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    evaluation: ReviewCycleGuardEvaluation,
    latestFailedReview: NextStepReviewCycleLatestFailedReview | null
): NextStepReviewCycleAutoSplitPrompt {
    const artifactPath = path.join(reviewsRoot, `${taskId}-review-cycle-auto-split-prompt.md`);
    const content = buildReviewCycleAutoSplitPromptContent(repoRoot, taskId, evaluation, latestFailedReview);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    if (!fs.existsSync(artifactPath) || fs.readFileSync(artifactPath, 'utf8') !== content) {
        fs.writeFileSync(artifactPath, content, 'utf8');
    }
    return {
        kind: 'review_cycle_auto_split_prompt',
        artifact_path: normalizePath(path.relative(repoRoot, artifactPath)),
        artifact_sha256: createHash('sha256').update(content).digest('hex'),
        next_action: 'follow_auto_split_prompt',
        instructions: [
            'move_parent_to_decomposed_state',
            'commit_only_completed_reviewed_work_if_required',
            'create_maximally_small_parent_derived_child_tasks',
            'execute_child_tasks_sequentially'
        ],
        constraints: [
            'do_not_auto_commit_unfinished_or_unreviewed_work',
            'do_not_mark_parent_done_because_split_exists',
            'preserve_review_cycle_block_reason',
            'stop_if_split_cannot_proceed_cleanly'
        ]
    };
}

export function buildReviewCycleOperatorBlock(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    evaluation: ReviewCycleGuardEvaluation,
    latestFailedReview: NextStepReviewCycleLatestFailedReview | null
): NextStepReviewCycleBlock {
    const countsByReviewType = Object.fromEntries(
        Object.entries(evaluation.counts_by_review_type)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([reviewType, counts]) => [
                reviewType,
                {
                    total: counts.total,
                    failed: counts.failed,
                    passed: counts.passed,
                    pending: counts.pending
                }
            ])
    );
    const hasReviewCyclePressureViolation = evaluation.violations.some((violation) =>
        violation.metric === 'failed_non_test_review_count'
        || violation.metric === 'total_non_test_review_count'
    );
    const autoSplitEnabled = evaluation.action === 'BLOCK_FOR_OPERATOR_DECISION'
        && evaluation.violations.length > 0
        && evaluation.active
        && hasReviewCyclePressureViolation
        && evaluation.auto_split_enabled;
    const autoSplitPrompt = autoSplitEnabled
        ? materializeReviewCycleAutoSplitPrompt(repoRoot, reviewsRoot, taskId, evaluation, latestFailedReview)
        : null;
    const reason = autoSplitEnabled
        ? sanitizeReviewCycleAutoSplitSummary(evaluation)
        : evaluation.summary_line;

    return {
        kind: 'review_cycle_guard',
        operator_decision_required: !autoSplitEnabled,
        wait_for_operator: !autoSplitEnabled,
        auto_split_enabled: autoSplitEnabled,
        reason,
        max_failed_non_test_reviews: evaluation.max_failed_non_test_reviews,
        max_total_non_test_reviews: evaluation.max_total_non_test_reviews,
        total_non_test_review_count: evaluation.total_non_test_review_count,
        failed_non_test_review_count: evaluation.failed_non_test_review_count,
        counts_by_review_type: countsByReviewType,
        cumulative_total_non_test_review_count: evaluation.attempt_diagnostics.cumulative_total_non_test_review_count,
        cumulative_failed_non_test_review_count: evaluation.attempt_diagnostics.cumulative_failed_non_test_review_count,
        current_scope_total_non_test_review_count: evaluation.current_scope_total_non_test_review_count,
        current_scope_failed_non_test_review_count: evaluation.current_scope_failed_non_test_review_count,
        current_scope_counts_by_review_type: evaluation.current_scope_counts_by_review_type,
        fresh_non_test_review_count: evaluation.attempt_diagnostics.fresh_non_test_review_count,
        reused_non_test_review_count: evaluation.attempt_diagnostics.reused_non_test_review_count,
        fresh_reused_by_review_type: evaluation.attempt_diagnostics.fresh_reused_by_review_type,
        scope_hash_count_by_review_type: evaluation.attempt_diagnostics.scope_hash_count_by_review_type,
        top_scope_hashes_by_review_type: evaluation.attempt_diagnostics.top_scope_hashes_by_review_type,
        excluded_review_types: evaluation.excluded_review_types,
        latest_failed_review: latestFailedReview,
        choices: [...REVIEW_CYCLE_OPERATOR_CHOICES],
        operator_choice_guidance: [...REVIEW_CYCLE_OPERATOR_CHOICE_GUIDANCE],
        auto_split_prompt: autoSplitPrompt
    };
}

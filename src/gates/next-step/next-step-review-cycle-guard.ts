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
    evaluateReviewCycleGuard,
    normalizeReviewCycleGuardConfig,
    type ReviewCycleGuardEvaluation
} from '../../core/review-cycle-guard';
import {
    buildDefaultWorkflowConfig
} from '../../core/workflow-config';
import {
    validateWorkflowConfig
} from '../../schemas/config-artifacts';
import {
    extractReviewVerdictToken
} from '../../gate-runtime/review-context';
import {
    REVIEW_CONTRACTS
} from '../required-reviews/required-reviews-check';
import {
    resolveWorkflowConfigPath
} from '../full-suite/full-suite-validation';
import {
    type TimelineEventEntry
} from '../completion/completion-evidence';
import {
    normalizePath
} from '../shared/helpers';
import {
    parseTaskQueueEntriesFromContent
} from './next-step-task-queue';
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
    readCurrentReviewCyclePreflightFingerprints,
    reviewCycleAttemptMatchesCurrentScope,
    type DomainScopeFingerprints
} from './next-step-review-cycle-scope';

export type {
    ReviewCycleGuardEvaluation
};

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
    next_action: string;
    instructions: string[];
    constraints: string[];
}

export interface ReviewCycleGuardReadEvaluationResult {
    evaluation: ReviewCycleGuardEvaluation;
    latestFailedReview: NextStepReviewCycleLatestFailedReview | null;
}

interface ReviewCycleGuardReadResult {
    attempts: { reviewType: string; failed: boolean; passed: boolean }[];
    timelineValid: boolean;
    latestFailedReview: NextStepReviewCycleLatestFailedReview | null;
}

const REVIEW_VERDICT_PASS_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(REVIEW_CONTRACTS));
const REVIEW_VERDICT_FAIL_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(
    REVIEW_CONTRACTS.map(([reviewType, passToken]) => [reviewType, passToken.replace(/\bPASSED\b/g, 'FAILED')])
));

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

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

function readWorkflowConfigRecordForReviewCycleGuard(repoRoot: string): Record<string, unknown> | null {
    const workflowConfigPath = resolveWorkflowConfigPath(repoRoot);
    if (!fileExists(workflowConfigPath)) {
        return null;
    }

    let workflowConfig: unknown;
    try {
        workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
    } catch (error: unknown) {
        throw new Error(
            `Workflow config at '${toRepoDisplayPath(repoRoot, workflowConfigPath)}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    if (!isPlainRecord(workflowConfig)) {
        throw new Error(
            `Workflow config at '${toRepoDisplayPath(repoRoot, workflowConfigPath)}' must be a JSON object.`
        );
    }
    return workflowConfig;
}

function getTimelineDetailText(details: Record<string, unknown> | null, fieldNames: string[]): string | null {
    for (const fieldName of fieldNames) {
        const value = details?.[fieldName];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return null;
}

function getTimelineReviewType(details: Record<string, unknown> | null): string {
    return String(details?.review_type || details?.reviewType || '').trim().toLowerCase();
}

function getTimelineReviewerIdentity(details: Record<string, unknown> | null): string {
    return String(details?.reviewer_identity || details?.reviewerIdentity || '').trim();
}

function getTimelineReviewContextSha256(details: Record<string, unknown> | null): string {
    return String(details?.review_context_sha256 || details?.reviewContextSha256 || '').trim().toLowerCase();
}

function getTimelineReviewFailure(eventType: string, details: Record<string, unknown> | null, outcome: string | null): boolean | null {
    const verdictToken = String(details?.verdict_token || details?.verdictToken || '').trim().toUpperCase();
    if (verdictToken.endsWith('FAILED')) {
        return true;
    }
    if (verdictToken.endsWith('PASSED')) {
        return false;
    }
    if (
        eventType === 'REVIEW_RECORDED'
        && String(details?.review_artifact_path || details?.reviewArtifactPath || '').trim()
    ) {
        return null;
    }
    const normalizedOutcome = String(outcome || '').trim().toUpperCase();
    if (normalizedOutcome === 'FAIL') {
        return true;
    }
    if (normalizedOutcome === 'PASS') {
        return false;
    }
    return null;
}

function reviewRecordedArtifactHasFailToken(
    repoRoot: string,
    reviewType: string,
    details: Record<string, unknown> | null,
    verdictCache: Map<string, boolean>
): boolean {
    const failToken = REVIEW_VERDICT_FAIL_TOKENS[reviewType] || '';
    const artifactPathText = String(details?.review_artifact_path || details?.reviewArtifactPath || '').trim();
    if (!failToken || !artifactPathText) {
        return false;
    }
    const resolvedArtifactPath = path.isAbsolute(artifactPathText)
        ? path.resolve(artifactPathText)
        : path.resolve(repoRoot, artifactPathText);
    const resolvedRepoRoot = path.resolve(repoRoot);
    const relativeToRepo = path.relative(resolvedRepoRoot, resolvedArtifactPath);
    if (relativeToRepo.startsWith('..') || path.isAbsolute(relativeToRepo)) {
        return false;
    }
    if (!fs.existsSync(resolvedArtifactPath) || !fs.statSync(resolvedArtifactPath).isFile()) {
        return false;
    }
    const cacheKey = `${reviewType}|${resolvedArtifactPath}`;
    const cached = verdictCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }
    const file = fs.openSync(resolvedArtifactPath, 'r');
    let content = '';
    try {
        const buffer = Buffer.alloc(128 * 1024);
        const bytesRead = fs.readSync(file, buffer, 0, buffer.length, 0);
        content = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        fs.closeSync(file);
    }
    if (!content.includes(failToken)) {
        verdictCache.set(cacheKey, false);
        return false;
    }
    const failed = extractReviewVerdictToken(content, REVIEW_VERDICT_PASS_TOKENS[reviewType] || null, failToken, reviewType) === failToken;
    verdictCache.set(cacheKey, failed);
    return failed;
}

function parseReviewCycleTimelineLine(line: string, sequence: number): TimelineEventEntry | null {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const eventType = String(parsed.event_type || '').trim().toUpperCase();
    if (!eventType) {
        return null;
    }
    const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
        ? parsed.details as Record<string, unknown>
        : null;
    return {
        event_type: eventType,
        outcome: String(parsed.outcome || '').trim().toUpperCase() || undefined,
        timestamp_utc: String(parsed.timestamp_utc || '').trim(),
        sequence,
        details
    };
}

function buildLatestFailedReviewSummary(
    event: TimelineEventEntry,
    reviewType: string,
    details: Record<string, unknown> | null
): NextStepReviewCycleLatestFailedReview {
    return {
        review_type: reviewType,
        event_type: event.event_type,
        outcome: event.outcome || null,
        verdict_token: getTimelineDetailText(details, ['verdict_token', 'verdictToken']),
        reviewer_identity: getTimelineReviewerIdentity(details) || null,
        review_artifact_path: getTimelineDetailText(details, ['review_artifact_path', 'reviewArtifactPath']),
        summary: getTimelineDetailText(details, ['summary', 'finding_summary', 'findingSummary', 'reason', 'message']),
        sequence: event.sequence,
        timestamp_utc: event.timestamp_utc || null
    };
}

function readReviewCycleGuardAttempts(
    repoRoot: string,
    timelinePath: string,
    reviewCycleGuardConfig: ReturnType<typeof normalizeReviewCycleGuardConfig>,
    currentPreflightFingerprints: DomainScopeFingerprints | null
): ReviewCycleGuardReadResult {
    const resolvedPath = path.resolve(String(timelinePath || ''));
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        return {
            attempts: [],
            timelineValid: false,
            latestFailedReview: null
        };
    }

    const attemptsByKey = new Map<string, { reviewType: string; failed: boolean; passed: boolean }>();
    const verdictCache = new Map<string, boolean>();
    const excludedReviewTypes = new Set(reviewCycleGuardConfig.excluded_review_types.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
    let malformedReviewCycleEvent = false;
    let guardLimitExceeded = false;
    let totalNonTestReviewCount = 0;
    let failedNonTestReviewCount = 0;
    let latestFailedReview: NextStepReviewCycleLatestFailedReview | null = null;
    let sequence = 0;
    let pending = '';
    const file = fs.openSync(resolvedPath, 'r');
    const buffer = Buffer.alloc(64 * 1024);

    const handleLine = (rawLine: string): boolean => {
        const line = rawLine.trim();
        if (!line) {
            return false;
        }
        let event: TimelineEventEntry | null = null;
        try {
            event = parseReviewCycleTimelineLine(line, sequence);
        } catch {
            if (!guardLimitExceeded) {
                malformedReviewCycleEvent = true;
            }
            return reviewCycleGuardConfig.action === 'BLOCK_FOR_OPERATOR_DECISION' && !guardLimitExceeded;
        } finally {
            sequence += 1;
        }
        if (!event || event.event_type !== 'REVIEW_RECORDED') {
            return false;
        }
        const reviewType = getTimelineReviewType(event.details);
        if (!reviewType) {
            if (!guardLimitExceeded) {
                malformedReviewCycleEvent = true;
            }
            return reviewCycleGuardConfig.action === 'BLOCK_FOR_OPERATOR_DECISION' && !guardLimitExceeded;
        }
        if (!reviewCycleAttemptMatchesCurrentScope(reviewType, event.details, currentPreflightFingerprints)) {
            return false;
        }
        const reviewerIdentity = getTimelineReviewerIdentity(event.details);
        const reviewContextSha256 = getTimelineReviewContextSha256(event.details);
        const key = reviewerIdentity && reviewContextSha256
            ? `${reviewType}|${reviewerIdentity}|${reviewContextSha256}`
            : `${event.event_type}:${event.sequence}`;
        const timelineFailure = getTimelineReviewFailure(event.event_type, event.details, event.outcome || null);
        const artifactFailed = timelineFailure == null && event.event_type === 'REVIEW_RECORDED'
            ? reviewRecordedArtifactHasFailToken(repoRoot, reviewType, event.details, verdictCache)
            : false;
        const failed = timelineFailure ?? artifactFailed;
        const hasReviewArtifactPath = Boolean(getTimelineDetailText(event.details, ['review_artifact_path', 'reviewArtifactPath']));
        const passed = !failed && (
            timelineFailure === false
            || (event.outcome === 'PASS' && !hasReviewArtifactPath)
        );
        const existing = attemptsByKey.get(key);
        const existingFailed = Boolean(existing?.failed);
        const existingPassed = Boolean(existing?.passed);
        const nextFailed = Boolean(existingFailed || failed);
        const nextPassed = Boolean(!nextFailed && (existingPassed || passed));
        attemptsByKey.set(key, {
            reviewType,
            failed: nextFailed,
            passed: nextPassed
        });
        const countedReviewType = reviewType.trim().toLowerCase();
        const countsTowardGuard = countedReviewType && !excludedReviewTypes.has(countedReviewType);
        if (!existing && countsTowardGuard) {
            totalNonTestReviewCount += 1;
        }
        if (!existingFailed && nextFailed && countsTowardGuard) {
            failedNonTestReviewCount += 1;
            latestFailedReview = buildLatestFailedReviewSummary(event, countedReviewType, event.details);
        }
        guardLimitExceeded = guardLimitExceeded || (
            failedNonTestReviewCount > reviewCycleGuardConfig.max_failed_non_test_reviews
            || totalNonTestReviewCount > reviewCycleGuardConfig.max_total_non_test_reviews
        );
        return false;
    };

    try {
        let bytesRead = 0;
        do {
            bytesRead = fs.readSync(file, buffer, 0, buffer.length, null);
            if (bytesRead <= 0) {
                break;
            }
            pending += buffer.subarray(0, bytesRead).toString('utf8');
            let newlineIndex = pending.indexOf('\n');
            while (newlineIndex >= 0) {
                const line = pending.slice(0, newlineIndex).replace(/\r$/, '');
                pending = pending.slice(newlineIndex + 1);
                if (handleLine(line)) {
                    return {
                        attempts: [...attemptsByKey.values()],
                        timelineValid: !malformedReviewCycleEvent,
                        latestFailedReview
                    };
                }
                newlineIndex = pending.indexOf('\n');
            }
        } while (bytesRead > 0);
        if (pending.trim() && handleLine(pending.replace(/\r$/, ''))) {
            return {
                attempts: [...attemptsByKey.values()],
                timelineValid: !malformedReviewCycleEvent,
                latestFailedReview
            };
        }
    } finally {
        fs.closeSync(file);
    }

    return {
        attempts: [...attemptsByKey.values()],
        timelineValid: !malformedReviewCycleEvent,
        latestFailedReview
    };
}

export function readReviewCycleGuardEvaluation(
    repoRoot: string,
    eventsRoot: string,
    taskId: string
): ReviewCycleGuardReadEvaluationResult {
    const defaultWorkflowConfig = buildDefaultWorkflowConfig();
    let rawReviewCycleGuard: unknown = defaultWorkflowConfig.review_cycle_guard;
    const workflowConfig = readWorkflowConfigRecordForReviewCycleGuard(repoRoot);
    if (workflowConfig?.review_cycle_guard !== undefined) {
        const validatedWorkflowConfig = validateWorkflowConfig({
            full_suite_validation: defaultWorkflowConfig.full_suite_validation,
            review_execution_policy: defaultWorkflowConfig.review_execution_policy,
            scope_budget_guard: defaultWorkflowConfig.scope_budget_guard,
            review_cycle_guard: workflowConfig.review_cycle_guard
        });
        rawReviewCycleGuard = isPlainRecord(validatedWorkflowConfig.review_cycle_guard)
            ? validatedWorkflowConfig.review_cycle_guard
            : defaultWorkflowConfig.review_cycle_guard;
    }
    const reviewCycleGuardConfig = normalizeReviewCycleGuardConfig(rawReviewCycleGuard);
    if (!reviewCycleGuardConfig.enabled) {
        return {
            evaluation: evaluateReviewCycleGuard(reviewCycleGuardConfig, {
                attempts: [],
                timelineValid: true
            }),
            latestFailedReview: null
        };
    }

    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const reviewCycleAttempts = readReviewCycleGuardAttempts(
        repoRoot,
        timelinePath,
        reviewCycleGuardConfig,
        readCurrentReviewCyclePreflightFingerprints(eventsRoot, taskId)
    );

    return {
        evaluation: evaluateReviewCycleGuard(
            reviewCycleGuardConfig,
            {
                attempts: reviewCycleAttempts.attempts,
                timelineValid: reviewCycleAttempts.timelineValid
            }
        ),
        latestFailedReview: reviewCycleAttempts.latestFailedReview
    };
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
        excluded_review_types: evaluation.excluded_review_types,
        latest_failed_review: latestFailedReview,
        choices: [...REVIEW_CYCLE_OPERATOR_CHOICES],
        operator_choice_guidance: [...REVIEW_CYCLE_OPERATOR_CHOICE_GUIDANCE],
        auto_split_prompt: autoSplitPrompt
    };
}

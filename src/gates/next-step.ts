import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    LEGACY_REVIEW_EXECUTION_POLICY_MODE,
    computeReviewLaunchPlan,
    getReviewExecutionDependencies,
    resolveReviewExecutionPolicyModeFromPreflight,
    type EffectiveReviewExecutionPolicyMode,
    type ReviewLaunchPlan
} from '../core/review-execution-policy';
import {
    appendMandatoryTaskEvent,
    assertValidTaskId
} from '../gate-runtime/task-events';
import {
    REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION,
    REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION,
    REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION,
    REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION,
    REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION
} from '../gate-runtime/reviewer-session-contract';
import {
    buildReviewVerdictTokenSet,
    extractReviewVerdictToken,
    formatAcceptedReviewVerdictTokens,
    formatReviewVerdictTokenList,
    normalizeReviewReceiptReviewerProvenance
} from '../gate-runtime/review-context';
import {
    buildTaskAuditSummary,
    formatFinalCloseoutMarkdown,
    type TaskAuditSummaryResult
} from './task-audit-summary';
import {
    type GateOutcome,
    resolveEventsRoot,
    resolveReviewsRoot,
    safeReadJson
} from './task-audit-summary-collectors';
import {
    buildFullSuiteTimeoutForecast,
    formatFullSuiteTimeoutForecast,
    isFullSuiteNotRequiredForDocsOnlyScope,
    loadFullSuiteValidationConfig,
    resolveWorkflowConfigPath
} from './full-suite-validation';
import {
    buildReviewTrustSummary,
    type ReviewTrustSummary
} from './review-trust-summary';
import {
    getCycleBindingSnapshotFromPayload
} from './task-events-summary';
import {
    fileSha256,
    normalizePath,
    resolvePathInsideRepo
} from './helpers';
import {
    resolveBundleNameForTarget
} from '../core/constants';
import {
    buildGardaSelfGuardPolicyChangeCommand,
    buildDefaultWorkflowConfig,
    formatGardaSelfGuardProtectedControlPlaneGuidance,
    isGardaSelfGuardDenyAgentEntryForBundle,
    type FullSuiteValidationPlacement
} from '../core/workflow-config';
import {
    isOrchestratorSourceCheckout
} from './protected-control-plane';
import {
    getProjectMemoryImpactLifecycleEvidence,
    type ProjectMemoryImpactEvidenceStatus,
    type ProjectMemoryImpactStatus
} from './project-memory-impact';
import {
    REVIEW_CONTRACTS
} from './required-reviews-check';
import {
    getNoOpEvidence
} from './no-op';
import {
    getWorkspaceSnapshotCached,
    type WorkspaceSnapshot
} from './workspace-snapshot-cache';
import {
    selectRulePackFiles
} from './build-review-context';
import {
    readOptionalMarkdownWorkingPlan,
    type TaskModeMarkdownWorkingPlanMetadata
} from './task-mode';
import {
    buildReviewContextPreflightDiffExpectations,
    getReviewContextContractViolations
} from './review-context-contract';
import {
    validateStrictReusedReviewEvidence,
    type ReviewReuseTelemetryEventLike
} from './review-reuse-telemetry';
import {
    evaluateHiddenReviewTimingTrust
} from './review-timing-trust';
import {
    getClassificationConfig,
    isDocumentationLikePath,
    isRuntimeCodeLikePath,
    isSafeOrdinaryDocumentationPath,
    type ResolvedClassificationConfig
} from './classify-change';
import {
    getPostPreflightRulePackRebindDecision,
    getPostPreflightSequenceEvidence,
    getRulePackEvidence,
    getRulePackEvidenceViolations,
    type PostPreflightRulePackRebindDecision
} from './rule-pack';
import {
    collectOrderedTimelineEvents,
    type TimelineEventEntry
} from './completion-evidence';
import {
    buildCoherentCycleRestartCommand
} from './completion-reporting';
import {
    normalizeProviderId
} from '../core/provider-registry';
import {
    evaluateScopeBudgetGuard,
    normalizeScopeBudgetGuardConfig,
    type ScopeBudgetGuardEvaluation
} from '../core/scope-budget-guard';
import {
    evaluateReviewCycleGuard,
    normalizeReviewCycleGuardConfig,
    type ReviewCycleGuardEvaluation
} from '../core/review-cycle-guard';
import { resolveTaskProfileSelection } from '../policy/task-profile-selection';
import { validateWorkflowConfig } from '../schemas/config-artifacts';
import {
    detectSourceCheckoutRuntimeStaleness,
    type SourceCheckoutRuntimeStalenessResult
} from '../validators';
import {
    buildDefaultReviewScratchCommandPath,
    resolveDefaultReviewScratchPath,
    resolveReviewScratchRoot
} from './review-scratch-paths';
import {
    formatTaskQueueStatusCell,
    isTaskQueueBlockedStatus,
    isTaskQueueDecomposedStatus,
    isTaskQueueDoneStatus,
    isTaskQueueSplitRequiredStatus,
    readTaskQueueStatusToken
} from '../core/active-task-state';
import {
    parseTaskMdTableRow,
    replaceTaskMdTableCell
} from '../core/task-md-table';
import {
    TASK_ID_ALLOWED_PATTERN,
    buildExactTaskIdReferencePattern,
    isCanonicalTaskId,
    isTaskIdReferenceBoundary
} from '../core/task-ids';
import {
    allocateParentDerivedTaskIds
} from '../core/task-id-allocation';
import {
    buildGateChainLaunchDecision,
    formatGateChainLaunchDecision
} from '../core/dependent-validation-chains';
import {
    buildTaskQueueStatusContract,
    type TaskQueueStatusContract
} from '../core/task-queue-status-contract';
import {
    syncTaskQueueStatusDetailed,
    withTaskQueueStatusSyncLock,
    type TaskQueueStatusSyncResult
} from '../cli/commands/gate-flows/task-queue-sync';

const REVIEW_PREPARATION_ORDER = Object.freeze([
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'performance',
    'infra',
    'dependency',
    'test'
]);

const REVIEW_VERDICT_PASS_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(REVIEW_CONTRACTS));
const REVIEW_VERDICT_FAIL_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(
    REVIEW_CONTRACTS.map(([reviewType, passToken]) => [reviewType, passToken.replace(/\bPASSED\b/g, 'FAILED')])
));
const PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE = 'delegated_reviewer_launch_preparation';
const COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE = 'delegated_reviewer_launch';

export type NextStepStatus = 'BLOCKED' | 'READY' | 'DONE' | 'DECOMPOSED' | 'SPLIT_REQUIRED';

export interface NextStepCommand {
    label: string;
    command: string;
}

export interface NextStepArtifactState {
    key: string;
    path: string;
    exists: boolean;
}

export interface NextStepFullSuiteSummary {
    enabled: boolean;
    command: string;
    placement: FullSuiteValidationPlacement;
    config_path: string;
    config_source: 'effective_workflow_config';
    note: string;
    recommended_timeout_seconds?: number | null;
    timeout_forecast_note?: string | null;
}

export interface NextStepProjectMemorySummary {
    enabled: boolean;
    required: boolean;
    mode: string;
    evidence_status: ProjectMemoryImpactEvidenceStatus;
    status: ProjectMemoryImpactStatus | null;
    update_needed: boolean | null;
    affected_memory_files: string[];
    updated_memory_files: string[];
    compact_status: string | null;
    compact_refreshed: boolean | null;
    artifact_path: string;
    update_artifact_path: string;
    visible_summary_line: string;
}

export interface NextStepReviewSummary {
    required_reviews: string[];
    review_execution_policy_mode: EffectiveReviewExecutionPolicyMode;
    review_execution_policy_source: 'preflight' | 'workflow_config_fallback';
    launchable_review_types: string[];
    blocked_review_lanes: NextStepBlockedReviewLane[];
    failed_review_type: string | null;
    next_review_type: string | null;
    blocked_review_dependencies: string[];
    ordinary_doc_review_skips: { path: string; pattern: string }[];
    trust: ReviewTrustSummary | null;
    trust_note: string | null;
}

export interface NextStepBlockedReviewLane {
    review_type: string;
    blocked_by: string[];
    reason: string;
}

export interface NextStepFinalReportSummary {
    closeout_json_path: string;
    closeout_markdown_path: string;
    required_order: string[];
    commit_command_suggestion: string;
    commit_question: string;
}

export interface NextStepProfileSummary {
    task_selected_profile: string | null;
    profile_selection_source: string | null;
    effective_profile: string | null;
    effective_profile_source: string | null;
    runtime_active_profile: string | null;
    runtime_active_profile_source: string | null;
    requested_depth: number | null;
    effective_depth: number | null;
    depth_escalation_reason: string | null;
    total_forecast_tokens: number | null;
    effective_forecast_tokens: number | null;
    token_economy_active_for_depth: boolean | null;
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
    excluded_review_types: string[];
    latest_failed_review: NextStepReviewCycleLatestFailedReview | null;
    choices: string[];
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

export interface NextStepResult {
    schema_version: 1;
    task_id: string;
    generated_utc: string;
    navigator_command: string;
    status: NextStepStatus;
    next_gate: string | null;
    title: string;
    reason: string;
    commands: NextStepCommand[];
    missing_artifacts: NextStepArtifactState[];
    present_artifacts: NextStepArtifactState[];
    full_suite_validation: NextStepFullSuiteSummary;
    project_memory: NextStepProjectMemorySummary | null;
    review: NextStepReviewSummary;
    task_queue_status_contract: TaskQueueStatusContract;
    audit_status: TaskAuditSummaryResult['status'];
    profile: NextStepProfileSummary | null;
    markdown_working_plan: TaskModeMarkdownWorkingPlanMetadata | null;
    warnings: string[];
    review_cycle_block: NextStepReviewCycleBlock | null;
    final_report: NextStepFinalReportSummary | null;
}

interface TaskQueueEntry {
    taskId: string;
    status: string | null;
    title: string | null;
    profile: string | null;
    notes: string | null;
}

interface DecomposedChildRoute {
    taskId: string;
    status: string | null;
    chain: string[];
}

interface DecomposedParentCompletionState {
    hasLinkedChildren: boolean;
    complete: boolean;
    unfinishedRoute: DecomposedChildRoute | null;
    completedDecomposedTaskIds: string[];
    missingChildTaskIds: string[];
}

interface DecomposedParentBatchStatusSyncResult {
    outcome: TaskQueueStatusSyncResult['outcome'];
    task_path: string;
    root_task_id: string;
    task_ids: string[];
    updated_task_ids: string[];
    previous_statuses: Record<string, string | null>;
    next_status: 'DONE';
    error_message: string | null;
    status_contracts: Record<string, TaskQueueStatusContract>;
}

interface ChildTaskIdMention {
    taskId: string;
    index: number;
}

const TASK_QUEUE_LEGACY_SPLIT_NOTE_PATTERN = /\b(?:paused\s+for\s+split|split\s+into|continue\s+via\s+child\s+tasks)\b/i;
const TASK_QUEUE_CHILD_LINK_MARKER_PATTERN =
    /\b(?:split\s+into|continue\s+via|execute|created?|linked)\b[^.;\n|]*\b(?:child(?:ren)?|leaf)\s+tasks?\b|\b(?:child(?:ren)?|leaf)\s+tasks?\s*:/igu;
const TASK_QUEUE_TASK_ID_PATTERN = TASK_ID_ALLOWED_PATTERN;
const SPLIT_REQUIRED_STATUS = 'SPLIT_REQUIRED';

function isLegacySplitParentTask(entry: TaskQueueEntry | null): boolean {
    if (!entry) {
        return false;
    }
    if (!isTaskQueueBlockedStatus(entry.status)) {
        return false;
    }
    return TASK_QUEUE_LEGACY_SPLIT_NOTE_PATTERN.test(String(entry.notes || ''));
}

function isDecomposedParentTask(entry: TaskQueueEntry | null): boolean {
    return Boolean(entry && (isTaskQueueDecomposedStatus(entry.status) || isLegacySplitParentTask(entry)));
}

function appendTaskMentionIfMissing(taskMentions: ChildTaskIdMention[], taskId: string, index: number): void {
    if (!taskMentions.some((mention) => mention.taskId === taskId)) {
        taskMentions.push({ taskId, index });
    }
}

function isExplicitChildListMentionPosition(text: string, index: number): boolean {
    const introPattern = /\b(?:child(?:ren)?|leaf)\s+tasks?\b\s*:*/igu;
    let introMatch: RegExpExecArray | null;
    let introEnd: number | null = null;
    while ((introMatch = introPattern.exec(text)) !== null) {
        if (introMatch.index > index) {
            break;
        }
        introEnd = introMatch.index + introMatch[0].length;
    }
    if (introEnd == null) {
        return false;
    }
    const listPrefix = text.slice(introEnd, index)
        .replace(/`[A-Za-z0-9._-]+`/gu, ' ')
        .replace(/(^|[^A-Za-z0-9._-])([Tt]-\d+)(?=$|[^A-Za-z0-9._-])/gu, '$1 ');
    return /^[\s,:()[\]\-–—]*(?:(?:and|or|through|to)[\s,:()[\]\-–—]*)*$/iu.test(listPrefix);
}

function extractChildTaskMentions(notes: string | null, knownTaskIds: Iterable<string>): ChildTaskIdMention[] {
    const text = String(notes || '');
    const taskMentions: ChildTaskIdMention[] = [];
    const rangePattern = /\b([Tt]-)(\d+)\b[\s`*_]*(?:through|to|-|–|—)[\s`*_]*\b([Tt]-)(\d+)\b/gu;
    let rangeMatch: RegExpExecArray | null;
    while ((rangeMatch = rangePattern.exec(text)) !== null) {
        const startPrefix = rangeMatch[1];
        const startRaw = rangeMatch[2];
        const endPrefix = rangeMatch[3];
        const endRaw = rangeMatch[4];
        if (startPrefix !== endPrefix) {
            continue;
        }
        const start = Number(startRaw);
        const end = Number(endRaw);
        if (!Number.isInteger(start) || !Number.isInteger(end) || Math.abs(end - start) > 100) {
            continue;
        }
        const step = start <= end ? 1 : -1;
        const width = startRaw.length === endRaw.length ? startRaw.length : 0;
        let offset = 0;
        for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
            const valueText = width > 0 ? String(Math.abs(value)).padStart(width, '0') : String(Math.abs(value));
            const signedValueText = value < 0 ? `-${valueText}` : valueText;
            appendTaskMentionIfMissing(taskMentions, `${startPrefix}${signedValueText}`, rangeMatch.index + offset);
            offset += 1;
        }
    }

    const backtickedTaskIdPattern = /`([^`]+)`/gu;
    let backtickedTaskIdMatch: RegExpExecArray | null;
    while ((backtickedTaskIdMatch = backtickedTaskIdPattern.exec(text)) !== null) {
        const taskId = String(backtickedTaskIdMatch[1] || '').trim();
        if (isCanonicalTaskId(taskId)
            && isExplicitChildListMentionPosition(text, backtickedTaskIdMatch.index)) {
            appendTaskMentionIfMissing(taskMentions, taskId, backtickedTaskIdMatch.index + 1);
        }
    }

    const conventionalTaskIdPattern = /(^|[^A-Za-z0-9._-])([Tt]-\d+)(?=$|[^A-Za-z0-9._-])/gu;
    let conventionalTaskIdMatch: RegExpExecArray | null;
    while ((conventionalTaskIdMatch = conventionalTaskIdPattern.exec(text)) !== null) {
        const taskId = conventionalTaskIdMatch[2];
        const mentionIndex = conventionalTaskIdMatch.index + conventionalTaskIdMatch[1].length;
        appendTaskMentionIfMissing(taskMentions, taskId, mentionIndex);
    }

    for (const taskId of knownTaskIds) {
        const taskIdPattern = buildExactTaskIdReferencePattern(taskId);
        const taskIdMatch = taskIdPattern.exec(text);
        if (taskIdMatch) {
            const mentionIndex = taskIdMatch.index + taskIdMatch[1].length;
            const isConventionalTaskId = /^[Tt]-\d+$/u.test(taskId);
            if (!isConventionalTaskId && !isExplicitChildListMentionPosition(text, mentionIndex)) {
                continue;
            }
            appendTaskMentionIfMissing(taskMentions, taskId, taskIdMatch.index + taskIdMatch[1].length);
        }
    }
    return taskMentions
        .sort((left, right) => left.index - right.index);
}

function isTaskIdCharacter(value: string): boolean {
    return !isTaskIdReferenceBoundary(value);
}

function isExplicitChildContinuationBoundary(text: string, index: number): boolean {
    return /^(?:,\s*)?then\s+continue\b/iu.test(text.slice(index));
}

function findExplicitChildSegmentEnd(text: string, startIndex: number): number {
    for (let index = startIndex; index < text.length; index += 1) {
        if (isExplicitChildContinuationBoundary(text, index)) {
            return index;
        }
        const current = text[index];
        if (current === ';' || current === '\n' || current === '|') {
            return index;
        }
        if (current === '.') {
            const previous = text[index - 1] || '';
            const next = text[index + 1] || '';
            if (!(isTaskIdCharacter(previous) && isTaskIdCharacter(next))) {
                return index;
            }
        }
    }
    return text.length;
}

function extractExplicitLinkedChildTaskIds(notes: string | null, knownTaskIds: Iterable<string>): string[] {
    const text = String(notes || '');
    const childTaskIds: ChildTaskIdMention[] = [];
    const knownTaskIdList = [...knownTaskIds];
    let markerMatch: RegExpExecArray | null;
    TASK_QUEUE_CHILD_LINK_MARKER_PATTERN.lastIndex = 0;
    while ((markerMatch = TASK_QUEUE_CHILD_LINK_MARKER_PATTERN.exec(text)) !== null) {
        const absoluteSegmentEnd = findExplicitChildSegmentEnd(text, markerMatch.index);
        const segment = text.slice(markerMatch.index, absoluteSegmentEnd);
        for (const childMention of extractChildTaskMentions(segment, knownTaskIdList)) {
            appendTaskMentionIfMissing(childTaskIds, childMention.taskId, markerMatch.index + childMention.index);
        }
    }
    return childTaskIds
        .sort((left, right) => left.index - right.index)
        .map((mention) => mention.taskId);
}

function resolveNextUnfinishedChildRoute(
    taskEntries: Map<string, TaskQueueEntry>,
    parentTaskId: string,
    visited = new Set<string>(),
    childTaskIdExtractor: (notes: string | null, knownTaskIds: Iterable<string>) => string[] = extractExplicitLinkedChildTaskIds
): DecomposedChildRoute | null {
    if (visited.has(parentTaskId)) {
        return null;
    }
    visited.add(parentTaskId);
    const parentEntry = taskEntries.get(parentTaskId);
    const childTaskIds = childTaskIdExtractor(parentEntry?.notes || null, taskEntries.keys())
        .filter((childTaskId) => childTaskId !== parentTaskId);

    for (const childTaskId of childTaskIds) {
        const childEntry = taskEntries.get(childTaskId);
        if (!childEntry) {
            continue;
        }
        if (isTaskQueueDoneStatus(childEntry.status)) {
            continue;
        }
        if (isDecomposedParentTask(childEntry)) {
            const nestedRoute = resolveNextUnfinishedChildRoute(taskEntries, childTaskId, visited, childTaskIdExtractor);
            if (nestedRoute) {
                return {
                    ...nestedRoute,
                    chain: [childTaskId, ...nestedRoute.chain]
                };
            }
            continue;
        }
        return {
            taskId: childTaskId,
            status: childEntry.status,
            chain: [childTaskId]
        };
    }
    return null;
}

function resolveDecomposedParentCompletionState(
    taskEntries: Map<string, TaskQueueEntry>,
    parentTaskId: string,
    visited = new Set<string>(),
    childTaskIdExtractor: (notes: string | null, knownTaskIds: Iterable<string>) => string[] = extractExplicitLinkedChildTaskIds
): DecomposedParentCompletionState {
    if (visited.has(parentTaskId)) {
        return {
            hasLinkedChildren: false,
            complete: false,
            unfinishedRoute: null,
            completedDecomposedTaskIds: [],
            missingChildTaskIds: []
        };
    }
    visited.add(parentTaskId);
    const parentEntry = taskEntries.get(parentTaskId);
    const childTaskIds = childTaskIdExtractor(parentEntry?.notes || null, taskEntries.keys())
        .filter((childTaskId) => childTaskId !== parentTaskId);

    if (childTaskIds.length === 0) {
        return {
            hasLinkedChildren: false,
            complete: false,
            unfinishedRoute: null,
            completedDecomposedTaskIds: [],
            missingChildTaskIds: []
        };
    }

    const completedDecomposedTaskIds: string[] = [];
    const missingChildTaskIds: string[] = [];
    for (const childTaskId of childTaskIds) {
        const childEntry = taskEntries.get(childTaskId);
        if (!childEntry) {
            missingChildTaskIds.push(childTaskId);
            continue;
        }
        const childLinkedTaskIds = childTaskIdExtractor(childEntry.notes || null, taskEntries.keys())
            .filter((nestedChildTaskId) => nestedChildTaskId !== childTaskId);
        if (childLinkedTaskIds.length > 0 && (
            isTaskQueueDoneStatus(childEntry.status)
            || isTaskQueueDecomposedStatus(childEntry.status)
        )) {
            const nestedState = resolveDecomposedParentCompletionState(
                taskEntries,
                childTaskId,
                visited,
                childTaskIdExtractor
            );
            if (nestedState.unfinishedRoute) {
                return {
                    hasLinkedChildren: true,
                    complete: false,
                    unfinishedRoute: {
                        ...nestedState.unfinishedRoute,
                        chain: [childTaskId, ...nestedState.unfinishedRoute.chain]
                    },
                    completedDecomposedTaskIds,
                    missingChildTaskIds
                };
            }
            if (nestedState.missingChildTaskIds.length > 0) {
                return {
                    hasLinkedChildren: true,
                    complete: false,
                    unfinishedRoute: null,
                    completedDecomposedTaskIds,
                    missingChildTaskIds: [...missingChildTaskIds, ...nestedState.missingChildTaskIds]
                };
            }
            if (nestedState.complete) {
                completedDecomposedTaskIds.push(...nestedState.completedDecomposedTaskIds, childTaskId);
                continue;
            }
            return {
                hasLinkedChildren: true,
                complete: false,
                unfinishedRoute: null,
                completedDecomposedTaskIds,
                missingChildTaskIds
            };
        }
        if (isTaskQueueDoneStatus(childEntry.status)) {
            continue;
        }
        if (isTaskQueueDecomposedStatus(childEntry.status)) {
            const nestedState = resolveDecomposedParentCompletionState(
                taskEntries,
                childTaskId,
                visited,
                childTaskIdExtractor
            );
            if (nestedState.unfinishedRoute) {
                return {
                    hasLinkedChildren: true,
                    complete: false,
                    unfinishedRoute: {
                        ...nestedState.unfinishedRoute,
                        chain: [childTaskId, ...nestedState.unfinishedRoute.chain]
                    },
                    completedDecomposedTaskIds,
                    missingChildTaskIds
                };
            }
            if (nestedState.missingChildTaskIds.length > 0) {
                return {
                    hasLinkedChildren: true,
                    complete: false,
                    unfinishedRoute: null,
                    completedDecomposedTaskIds,
                    missingChildTaskIds: [...missingChildTaskIds, ...nestedState.missingChildTaskIds]
                };
            }
            if (nestedState.complete) {
                completedDecomposedTaskIds.push(...nestedState.completedDecomposedTaskIds, childTaskId);
                continue;
            }
            return {
                hasLinkedChildren: true,
                complete: false,
                unfinishedRoute: null,
                completedDecomposedTaskIds,
                missingChildTaskIds
            };
        }
        if (isLegacySplitParentTask(childEntry)) {
            const nestedState = resolveDecomposedParentCompletionState(
                taskEntries,
                childTaskId,
                visited,
                childTaskIdExtractor
            );
            if (nestedState.unfinishedRoute) {
                return {
                    hasLinkedChildren: true,
                    complete: false,
                    unfinishedRoute: {
                        ...nestedState.unfinishedRoute,
                        chain: [childTaskId, ...nestedState.unfinishedRoute.chain]
                    },
                    completedDecomposedTaskIds,
                    missingChildTaskIds
                };
            }
            if (nestedState.missingChildTaskIds.length > 0) {
                return {
                    hasLinkedChildren: true,
                    complete: false,
                    unfinishedRoute: null,
                    completedDecomposedTaskIds,
                    missingChildTaskIds: [...missingChildTaskIds, ...nestedState.missingChildTaskIds]
                };
            }
            return {
                hasLinkedChildren: true,
                complete: false,
                unfinishedRoute: null,
                completedDecomposedTaskIds,
                missingChildTaskIds
            };
        }
        return {
            hasLinkedChildren: true,
            complete: false,
            unfinishedRoute: {
                taskId: childTaskId,
                status: childEntry.status,
                chain: [childTaskId]
            },
            completedDecomposedTaskIds,
            missingChildTaskIds
        };
    }

    if (missingChildTaskIds.length > 0) {
        return {
            hasLinkedChildren: true,
            complete: false,
            unfinishedRoute: null,
            completedDecomposedTaskIds,
            missingChildTaskIds
        };
    }

    return {
        hasLinkedChildren: true,
        complete: true,
        unfinishedRoute: null,
        completedDecomposedTaskIds,
        missingChildTaskIds: []
    };
}

function hasLinkedChildTasks(taskEntries: Map<string, TaskQueueEntry>, parentTaskId: string): boolean {
    const parentEntry = taskEntries.get(parentTaskId);
    return extractExplicitLinkedChildTaskIds(parentEntry?.notes || null, taskEntries.keys())
        .some((childTaskId) => childTaskId !== parentTaskId && taskEntries.has(childTaskId));
}

type SplitRequiredGuardKind = 'scope_budget' | 'review_cycle';

interface SplitRequiredLatchResult {
    artifact_path: string;
    artifact_sha256: string;
    status_sync: TaskQueueStatusSyncResult;
    status_event_recorded: boolean;
    latch_event_recorded: boolean;
}

interface SplitRequiredLatchEvidence {
    valid: boolean;
    reason: string;
    artifact_path: string;
    artifact_sha256: string | null;
    guard_kind: string | null;
}

function getOrchestratorRootFromEventsRoot(eventsRoot: string): string {
    return path.resolve(eventsRoot, '..', '..');
}

function getSplitRequiredArtifactPath(reviewsRoot: string, taskId: string): string {
    return path.join(reviewsRoot, `${taskId}-split-required.json`);
}

function isSuccessfulSplitRequiredStatusSync(result: TaskQueueStatusSyncResult): boolean {
    return result.outcome === 'updated' || result.outcome === 'already_synced';
}

function writeStableJsonIfChanged(filePath: string, payload: Record<string, unknown>): string {
    const content = `${JSON.stringify(payload, null, 2)}\n`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf8') !== content) {
        fs.writeFileSync(filePath, content, 'utf8');
    }
    return createHash('sha256').update(content).digest('hex');
}

function buildSplitRequiredArtifact(params: {
    taskId: string;
    timestampUtc: string;
    guardKind: SplitRequiredGuardKind;
    guardReason: string;
    rawGuardSummary: string;
    preflightPath: string;
    preflightSha256: string;
    materializationPhase: 'pending_status_sync' | 'complete' | 'status_sync_failed';
    statusSync: Record<string, unknown>;
    guardDetails: Record<string, unknown>;
}): Record<string, unknown> {
    return {
        schema_version: 1,
        timestamp_utc: params.timestampUtc,
        task_id: params.taskId,
        status: SPLIT_REQUIRED_STATUS,
        guard_kind: params.guardKind,
        guard_reason: params.guardReason,
        raw_guard_summary: params.rawGuardSummary,
        preflight_path: normalizePath(params.preflightPath),
        preflight_sha256: params.preflightSha256,
        materialization_phase: params.materializationPhase,
        status_sync: params.statusSync,
        next_actions: [
            'create_and_link_child_tasks',
            'rerun_next_step_on_parent_to_transition_to_decomposed',
            'or_use_explicit_operator_task_reset_or_discard'
        ],
        guard_details: params.guardDetails
    };
}

function readSplitRequiredLatchEvidence(params: {
    reviewsRoot: string;
    eventsRoot: string;
    taskId: string;
}): SplitRequiredLatchEvidence {
    const artifactPath = getSplitRequiredArtifactPath(params.reviewsRoot, params.taskId);
    if (!fileExists(artifactPath)) {
        return {
            valid: false,
            reason: `split-required latch artifact is missing at ${normalizePath(artifactPath)}`,
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: null,
            guard_kind: null
        };
    }

    const artifact = safeReadJson(artifactPath);
    if (!isPlainRecord(artifact)) {
        return {
            valid: false,
            reason: `split-required latch artifact is not a JSON object at ${normalizePath(artifactPath)}`,
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: fileSha256(artifactPath),
            guard_kind: null
        };
    }

    const artifactSha256 = fileSha256(artifactPath);
    const guardKind = typeof artifact.guard_kind === 'string' ? artifact.guard_kind.trim() : '';
    const statusSync = isPlainRecord(artifact.status_sync) ? artifact.status_sync : null;
    const statusSyncOutcome = String(statusSync?.outcome || '').trim();
    const materializationPhase = String(artifact.materialization_phase || '').trim();
    if (artifact.task_id !== params.taskId) {
        return {
            valid: false,
            reason: 'split-required latch artifact task_id does not match the requested task',
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: artifactSha256,
            guard_kind: guardKind || null
        };
    }
    if (artifact.status !== SPLIT_REQUIRED_STATUS) {
        return {
            valid: false,
            reason: 'split-required latch artifact status is not SPLIT_REQUIRED',
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: artifactSha256,
            guard_kind: guardKind || null
        };
    }
    if (guardKind !== 'scope_budget' && guardKind !== 'review_cycle') {
        return {
            valid: false,
            reason: 'split-required latch artifact guard_kind is not recognized',
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: artifactSha256,
            guard_kind: guardKind || null
        };
    }
    if (materializationPhase && materializationPhase !== 'complete') {
        return {
            valid: false,
            reason: `split-required latch artifact is not complete (phase=${materializationPhase})`,
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: artifactSha256,
            guard_kind: guardKind
        };
    }
    if (String(statusSync?.next_status || '') !== SPLIT_REQUIRED_STATUS) {
        return {
            valid: false,
            reason: 'split-required latch artifact status_sync.next_status is not SPLIT_REQUIRED',
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: artifactSha256,
            guard_kind: guardKind
        };
    }
    if (statusSyncOutcome !== 'updated' && statusSyncOutcome !== 'already_synced') {
        return {
            valid: false,
            reason: `split-required latch artifact status sync is not successful (outcome=${statusSyncOutcome || 'missing'})`,
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: artifactSha256,
            guard_kind: guardKind
        };
    }

    const timelineErrors: string[] = [];
    const timeline = collectOrderedTimelineEvents(path.join(params.eventsRoot, `${params.taskId}.jsonl`), timelineErrors);
    const normalizedArtifactPath = normalizePath(artifactPath);
    const hasLatchEvent = timeline.some((event) => {
        const details = event.details || {};
        return event.event_type === 'SPLIT_REQUIRED_LATCHED'
            && String(details.status || '') === SPLIT_REQUIRED_STATUS
            && String(details.guard_kind || '') === guardKind
            && String(details.artifact_sha256 || '').toLowerCase() === artifactSha256
            && normalizePath(String(details.artifact_path || '')) === normalizedArtifactPath;
    });
    if (!hasLatchEvent) {
        return {
            valid: false,
            reason: timelineErrors.length > 0
                ? `split-required latch event is missing or unreadable (${timelineErrors.join('; ')})`
                : 'split-required latch event is missing for the artifact',
            artifact_path: normalizedArtifactPath,
            artifact_sha256: artifactSha256,
            guard_kind: guardKind
        };
    }

    return {
        valid: true,
        reason: 'split-required latch artifact and event are valid',
        artifact_path: normalizedArtifactPath,
        artifact_sha256: artifactSha256,
        guard_kind: guardKind
    };
}

function hasSplitRequiredClearedEvidence(params: {
    eventsRoot: string;
    taskId: string;
    latchEvidence: SplitRequiredLatchEvidence;
}): boolean {
    if (!params.latchEvidence.valid || !params.latchEvidence.artifact_sha256) {
        return false;
    }

    const timelineErrors: string[] = [];
    const timeline = collectOrderedTimelineEvents(path.join(params.eventsRoot, `${params.taskId}.jsonl`), timelineErrors);
    const normalizedArtifactPath = normalizePath(params.latchEvidence.artifact_path);
    const latchEvent = [...timeline].reverse().find((event) => {
        const details = event.details || {};
        return event.event_type === 'SPLIT_REQUIRED_LATCHED'
            && String(details.status || '') === SPLIT_REQUIRED_STATUS
            && String(details.guard_kind || '') === String(params.latchEvidence.guard_kind || '')
            && String(details.artifact_sha256 || '').toLowerCase() === params.latchEvidence.artifact_sha256
            && normalizePath(String(details.artifact_path || '')) === normalizedArtifactPath;
    });
    if (!latchEvent) {
        return false;
    }

    return timeline.some((event) => {
        const details = event.details || {};
        return event.sequence > latchEvent.sequence
            && event.event_type === 'SPLIT_REQUIRED_CLEARED'
            && String(details.previous_status || '') === SPLIT_REQUIRED_STATUS
            && String(details.new_status || '') === 'DECOMPOSED'
            && String(details.reason || '') === 'child_tasks_linked';
    });
}

function hasCompletedDecomposedParentAfterSplitRequiredClear(params: {
    eventsRoot: string;
    taskId: string;
    latchEvidence: SplitRequiredLatchEvidence;
}): boolean {
    if (!params.latchEvidence.valid || !params.latchEvidence.artifact_sha256) {
        return false;
    }

    const timelineErrors: string[] = [];
    const timeline = collectOrderedTimelineEvents(path.join(params.eventsRoot, `${params.taskId}.jsonl`), timelineErrors);
    const normalizedArtifactPath = normalizePath(params.latchEvidence.artifact_path);
    const latchEvent = [...timeline].reverse().find((event) => {
        const details = event.details || {};
        return event.event_type === 'SPLIT_REQUIRED_LATCHED'
            && String(details.status || '') === SPLIT_REQUIRED_STATUS
            && String(details.guard_kind || '') === String(params.latchEvidence.guard_kind || '')
            && String(details.artifact_sha256 || '').toLowerCase() === params.latchEvidence.artifact_sha256
            && normalizePath(String(details.artifact_path || '')) === normalizedArtifactPath;
    });
    if (!latchEvent) {
        return false;
    }

    const clearEvent = timeline.find((event) => {
        const details = event.details || {};
        return event.sequence > latchEvent.sequence
            && event.event_type === 'SPLIT_REQUIRED_CLEARED'
            && String(details.previous_status || '') === SPLIT_REQUIRED_STATUS
            && String(details.new_status || '') === 'DECOMPOSED'
            && String(details.reason || '') === 'child_tasks_linked';
    });
    if (!clearEvent) {
        return false;
    }

    return timeline.some((event) => {
        const details = event.details || {};
        return event.sequence > clearEvent.sequence
            && event.event_type === 'DECOMPOSED_PARENT_COMPLETED'
            && String(details.previous_status || '') === 'DECOMPOSED'
            && String(details.new_status || '') === 'DONE'
            && String(details.reason || '') === 'explicit_children_done';
    });
}

function sanitizeScopeBudgetGuardSummary(evaluation: ScopeBudgetGuardEvaluation): string {
    if (evaluation.violations.length === 0) {
        return evaluation.summary_line;
    }
    const metrics = evaluation.violations.map((violation) => violation.metric).join(', ');
    return `Scope budget guard: ${evaluation.action} (configured budget exceeded: ${metrics})`;
}

function sanitizeReviewCycleAutoSplitSummary(evaluation: ReviewCycleGuardEvaluation): string {
    if (evaluation.violations.length === 0) {
        return evaluation.summary_line;
    }
    const metrics = evaluation.violations.map((violation) => violation.metric).join(', ');
    return `Review cycle guard: ${evaluation.action} (configured review-cycle limit exceeded: ${metrics})`;
}

function materializeSplitRequiredLatch(params: {
    repoRoot: string;
    eventsRoot: string;
    reviewsRoot: string;
    taskId: string;
    guardKind: SplitRequiredGuardKind;
    guardReason: string;
    rawGuardSummary: string;
    preflightPath: string;
    guardDetails: Record<string, unknown>;
}): SplitRequiredLatchResult {
    const artifactPath = getSplitRequiredArtifactPath(params.reviewsRoot, params.taskId);
    const existing = safeReadJson(artifactPath);
    const preflightSha256 = fileSha256(params.preflightPath) || '';
    const orchestratorRoot = getOrchestratorRootFromEventsRoot(params.eventsRoot);
    const existingCurrent =
        existing?.task_id === params.taskId
        && existing?.status === SPLIT_REQUIRED_STATUS
        && existing?.guard_kind === params.guardKind
        && existing?.preflight_sha256 === preflightSha256;
    const timestampUtc = existingCurrent && typeof existing?.timestamp_utc === 'string'
        ? existing.timestamp_utc
        : new Date().toISOString();
    if (!existingCurrent) {
        writeStableJsonIfChanged(artifactPath, buildSplitRequiredArtifact({
            taskId: params.taskId,
            timestampUtc,
            guardKind: params.guardKind,
            guardReason: params.guardReason,
            rawGuardSummary: params.rawGuardSummary,
            preflightPath: params.preflightPath,
            preflightSha256,
            materializationPhase: 'pending_status_sync',
            statusSync: {
                outcome: 'pending',
                previous_status: null,
                next_status: SPLIT_REQUIRED_STATUS,
                error_message: null
            },
            guardDetails: params.guardDetails
        }));
    }
    const statusSync = syncTaskQueueStatusDetailed(params.repoRoot, params.taskId, SPLIT_REQUIRED_STATUS);
    let statusEventRecorded = false;
    let latchEventRecorded = false;
    if (!isSuccessfulSplitRequiredStatusSync(statusSync)) {
        const failedArtifactSha256 = writeStableJsonIfChanged(artifactPath, buildSplitRequiredArtifact({
            taskId: params.taskId,
            timestampUtc,
            guardKind: params.guardKind,
            guardReason: params.guardReason,
            rawGuardSummary: params.rawGuardSummary,
            preflightPath: params.preflightPath,
            preflightSha256,
            materializationPhase: 'status_sync_failed',
            statusSync: {
                outcome: statusSync.outcome,
                previous_status: statusSync.previous_status,
                next_status: statusSync.next_status,
                error_message: statusSync.error_message
            },
            guardDetails: params.guardDetails
        }));
        return {
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: failedArtifactSha256,
            status_sync: statusSync,
            status_event_recorded: false,
            latch_event_recorded: false
        };
    }

    let artifactSha256 = '';
    try {
        const artifact = buildSplitRequiredArtifact({
            taskId: params.taskId,
            timestampUtc,
            guardKind: params.guardKind,
            guardReason: params.guardReason,
            rawGuardSummary: params.rawGuardSummary,
            preflightPath: params.preflightPath,
            preflightSha256,
            materializationPhase: 'complete',
            statusSync: {
                outcome: statusSync.outcome,
                previous_status: statusSync.previous_status,
                next_status: statusSync.next_status,
                error_message: statusSync.error_message
            },
            guardDetails: params.guardDetails
        });
        artifactSha256 = writeStableJsonIfChanged(artifactPath, artifact);
        const latchEvidenceAfterArtifact = readSplitRequiredLatchEvidence({
            reviewsRoot: params.reviewsRoot,
            eventsRoot: params.eventsRoot,
            taskId: params.taskId
        });
        if (!latchEvidenceAfterArtifact.valid) {
            appendMandatoryTaskEvent(
                orchestratorRoot,
                params.taskId,
                'SPLIT_REQUIRED_LATCHED',
                'BLOCKED',
                'Auto-split guard latched the parent task.',
                {
                    status: SPLIT_REQUIRED_STATUS,
                    guard_kind: params.guardKind,
                    guard_reason: params.guardReason,
                    artifact_path: normalizePath(artifactPath),
                    artifact_sha256: artifactSha256,
                    preflight_path: normalizePath(params.preflightPath),
                    preflight_sha256: preflightSha256,
                    status_sync_outcome: statusSync.outcome
                },
                { actor: 'orchestrator' }
            );
            latchEventRecorded = true;
        }

        if (statusSync.outcome === 'updated') {
            appendMandatoryTaskEvent(
                orchestratorRoot,
                params.taskId,
                'STATUS_CHANGED',
                'INFO',
                `Task status changed: ${statusSync.previous_status || 'UNKNOWN'} -> ${SPLIT_REQUIRED_STATUS}.`,
                {
                    previous_status: statusSync.previous_status || 'UNKNOWN',
                    new_status: SPLIT_REQUIRED_STATUS,
                    reason: 'auto_split_guard_latched',
                    guard_kind: params.guardKind,
                    artifact_path: normalizePath(artifactPath),
                    artifact_sha256: artifactSha256
                },
                { actor: 'orchestrator' }
            );
            statusEventRecorded = true;
        }
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        let rollbackMessage: string | null = null;
        if (statusSync.outcome === 'updated' && statusSync.previous_status) {
            const rollback = syncTaskQueueStatusDetailed(params.repoRoot, params.taskId, statusSync.previous_status);
            rollbackMessage = `rollback=${rollback.outcome}${rollback.error_message ? ` (${rollback.error_message})` : ''}`;
        }
        const failureStatusSync: TaskQueueStatusSyncResult = {
            ...statusSync,
            outcome: 'write_failed',
            error_message: rollbackMessage ? `${errorMessage}; ${rollbackMessage}` : errorMessage
        };
        try {
            artifactSha256 = writeStableJsonIfChanged(artifactPath, buildSplitRequiredArtifact({
                taskId: params.taskId,
                timestampUtc,
                guardKind: params.guardKind,
                guardReason: params.guardReason,
                rawGuardSummary: params.rawGuardSummary,
                preflightPath: params.preflightPath,
                preflightSha256,
                materializationPhase: 'status_sync_failed',
                statusSync: {
                    outcome: failureStatusSync.outcome,
                    previous_status: failureStatusSync.previous_status,
                    next_status: failureStatusSync.next_status,
                    error_message: failureStatusSync.error_message
                },
                guardDetails: params.guardDetails
            }));
        } catch {
            artifactSha256 = artifactSha256 || '';
        }
        return {
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: artifactSha256,
            status_sync: failureStatusSync,
            status_event_recorded: statusEventRecorded,
            latch_event_recorded: latchEventRecorded
        };
    }

    return {
        artifact_path: normalizePath(artifactPath),
        artifact_sha256: artifactSha256,
        status_sync: statusSync,
        status_event_recorded: statusEventRecorded,
        latch_event_recorded: latchEventRecorded
    };
}

function transitionSplitRequiredParentToDecomposed(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
}): TaskQueueStatusSyncResult {
    const syncResult = syncTaskQueueStatusFromSplitRequiredToDecomposed(params.repoRoot, params.taskId);
    if (syncResult.outcome === 'updated') {
        appendMandatoryTaskEvent(
            getOrchestratorRootFromEventsRoot(params.eventsRoot),
            params.taskId,
            'STATUS_CHANGED',
            'INFO',
            `Task status changed: ${syncResult.previous_status || SPLIT_REQUIRED_STATUS} -> DECOMPOSED.`,
            {
                previous_status: syncResult.previous_status || SPLIT_REQUIRED_STATUS,
                new_status: 'DECOMPOSED',
                reason: 'split_required_children_linked'
            },
            { actor: 'orchestrator' }
        );
        appendMandatoryTaskEvent(
            getOrchestratorRootFromEventsRoot(params.eventsRoot),
            params.taskId,
            'SPLIT_REQUIRED_CLEARED',
            'INFO',
            'Split-required latch cleared because child tasks are linked.',
            {
                previous_status: syncResult.previous_status || SPLIT_REQUIRED_STATUS,
                new_status: 'DECOMPOSED',
                reason: 'child_tasks_linked'
            },
            { actor: 'orchestrator' }
        );
    }
    return syncResult;
}

function restoreSplitRequiredParentFromPermanentLatch(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    latchEvidence: SplitRequiredLatchEvidence;
}): TaskQueueStatusSyncResult {
    const syncResult = syncTaskQueueStatusDetailed(params.repoRoot, params.taskId, SPLIT_REQUIRED_STATUS);
    if (syncResult.outcome === 'updated') {
        appendMandatoryTaskEvent(
            getOrchestratorRootFromEventsRoot(params.eventsRoot),
            params.taskId,
            'STATUS_CHANGED',
            'INFO',
            `Task status changed: ${syncResult.previous_status || 'UNKNOWN'} -> ${SPLIT_REQUIRED_STATUS}.`,
            {
                previous_status: syncResult.previous_status || 'UNKNOWN',
                new_status: SPLIT_REQUIRED_STATUS,
                reason: 'split_required_permanent_latch_restored',
                guard_kind: params.latchEvidence.guard_kind,
                artifact_path: params.latchEvidence.artifact_path,
                artifact_sha256: params.latchEvidence.artifact_sha256
            },
            { actor: 'orchestrator' }
        );
        appendMandatoryTaskEvent(
            getOrchestratorRootFromEventsRoot(params.eventsRoot),
            params.taskId,
            'SPLIT_REQUIRED_RESTORED',
            'BLOCKED',
            'Permanent split-required latch restored the parent task status.',
            {
                previous_status: syncResult.previous_status || 'UNKNOWN',
                new_status: SPLIT_REQUIRED_STATUS,
                guard_kind: params.latchEvidence.guard_kind,
                artifact_path: params.latchEvidence.artifact_path,
                artifact_sha256: params.latchEvidence.artifact_sha256
            },
            { actor: 'orchestrator' }
        );
    }
    return syncResult;
}

function transitionDecomposedParentsToDone(params: {
    repoRoot: string;
    eventsRoot: string;
    rootTaskId: string;
    taskIds: string[];
}): DecomposedParentBatchStatusSyncResult {
    const syncResult = syncDecomposedParentsToDone(params.repoRoot, params.rootTaskId, params.taskIds);
    if (syncResult.outcome === 'updated') {
        const statusEventCommittedTaskIds = new Set<string>();
        try {
            const orchestratorRoot = getOrchestratorRootFromEventsRoot(params.eventsRoot);
            for (const taskId of syncResult.updated_task_ids) {
                const previousStatus = syncResult.previous_statuses[taskId] || 'DECOMPOSED';
                appendMandatoryTaskEvent(
                    orchestratorRoot,
                    taskId,
                    'STATUS_CHANGED',
                    'INFO',
                    `Task status changed: ${previousStatus} -> DONE.`,
                    {
                        previous_status: previousStatus,
                        new_status: 'DONE',
                        reason: 'decomposed_explicit_children_done'
                    },
                    { actor: 'orchestrator' }
                );
                statusEventCommittedTaskIds.add(taskId);
                appendMandatoryTaskEvent(
                    orchestratorRoot,
                    taskId,
                    'DECOMPOSED_PARENT_COMPLETED',
                    'INFO',
                    'Decomposed parent completed because every explicit child task is DONE.',
                    {
                        previous_status: previousStatus,
                        new_status: 'DONE',
                        reason: 'explicit_children_done'
                    },
                    { actor: 'orchestrator' }
                );
            }
        } catch (error: unknown) {
            const orchestratorRoot = getOrchestratorRootFromEventsRoot(params.eventsRoot);
            const compensation = compensateDecomposedParentStatusEvents({
                orchestratorRoot,
                taskIds: syncResult.updated_task_ids,
                previousStatuses: syncResult.previous_statuses,
                committedTaskIds: statusEventCommittedTaskIds
            });
            const uncompensatedCommittedTaskIds = syncResult.updated_task_ids.filter(
                (taskId) => statusEventCommittedTaskIds.has(taskId) && !compensation.compensatedTaskIds.has(taskId)
            );
            const rollbackTaskIds = syncResult.updated_task_ids.filter(
                (taskId) => !uncompensatedCommittedTaskIds.includes(taskId)
            );
            const rollbackError = rollbackDecomposedParentStatusSync(
                params.repoRoot,
                rollbackTaskIds,
                syncResult.previous_statuses
            );
            const remainingUpdatedTaskIds = rollbackError ? syncResult.updated_task_ids : uncompensatedCommittedTaskIds;
            const compensationMessage = compensation.errorMessages.length > 0
                ? ` Compensation event append failed: ${compensation.errorMessages.join('; ')}.`
                : (statusEventCommittedTaskIds.size > 0
                    ? ` Compensating STATUS_CHANGED event(s) recorded for: ${[...compensation.compensatedTaskIds].join(', ')}.`
                    : '');
            const rollbackMessage = rollbackError
                ? `Rollback failed for eligible TASK.md status changes: ${rollbackError}`
                : (rollbackTaskIds.length > 0
                    ? `Rolled back TASK.md status changes for: ${rollbackTaskIds.join(', ')}.`
                    : 'Skipped TASK.md rollback because every updated task already has an uncompensated committed status event.');
            const skippedRollbackMessage = uncompensatedCommittedTaskIds.length > 0
                ? ` Skipped rollback for task(s) with committed status events that could not be compensated: ${uncompensatedCommittedTaskIds.join(', ')}.`
                : '';
            return {
                ...syncResult,
                outcome: 'write_failed',
                updated_task_ids: remainingUpdatedTaskIds,
                error_message:
                    `Mandatory lifecycle event append failed after TASK.md status sync: ${error instanceof Error ? error.message : String(error)}. ` +
                    `${compensationMessage} ${rollbackMessage}${skippedRollbackMessage}`
            };
        }
    }
    return syncResult;
}

function compensateDecomposedParentStatusEvents(params: {
    orchestratorRoot: string;
    taskIds: string[];
    previousStatuses: Record<string, string | null>;
    committedTaskIds: Set<string>;
}): {
    compensatedTaskIds: Set<string>;
    errorMessages: string[];
} {
    const compensatedTaskIds = new Set<string>();
    const errorMessages: string[] = [];
    for (const taskId of params.taskIds) {
        if (!params.committedTaskIds.has(taskId)) {
            continue;
        }
        const previousStatus = params.previousStatuses[taskId] || 'DECOMPOSED';
        try {
            appendMandatoryTaskEvent(
                params.orchestratorRoot,
                taskId,
                'STATUS_CHANGED',
                'INFO',
                `Task status changed: DONE -> ${previousStatus} after failed decomposed parent completion audit.`,
                {
                    previous_status: 'DONE',
                    new_status: previousStatus,
                    reason: 'decomposed_parent_completion_event_failed_rollback'
                },
                { actor: 'orchestrator' }
            );
            compensatedTaskIds.add(taskId);
        } catch (error: unknown) {
            errorMessages.push(`${taskId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { compensatedTaskIds, errorMessages };
}

function syncTaskQueueStatusFromSplitRequiredToDecomposed(repoRoot: string, taskId: string): TaskQueueStatusSyncResult {
    const taskPath = path.join(repoRoot, 'TASK.md');
    const statusContract = buildTaskQueueStatusContract(taskId);
    if (!fileExists(taskPath)) {
        return {
            outcome: 'task_file_missing',
            task_path: normalizePath(taskPath),
            task_id: taskId,
            previous_status: null,
            next_status: 'DECOMPOSED',
            error_message: null,
            status_contract: statusContract
        };
    }

    return withTaskQueueStatusSyncLock(
        taskPath,
        (message) => ({
            outcome: 'write_failed',
            task_path: normalizePath(taskPath),
            task_id: taskId,
            previous_status: null,
            next_status: 'DECOMPOSED',
            error_message: message,
            status_contract: statusContract
        }),
        () => {
            const originalContent = fs.readFileSync(taskPath, 'utf8');
            const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
            const lines = originalContent.split(/\r?\n/);
            let previousStatus: string | null = null;
            let taskFound = false;
            let changed = false;

            for (let index = 0; index < lines.length; index += 1) {
                const rawLine = lines[index];
                if (!rawLine.trim().startsWith('|')) {
                    continue;
                }
                const cells = parseTaskMdTableRow(rawLine);
                if (cells.length < 4 || cells[0].trimmed !== taskId) {
                    continue;
                }
                taskFound = true;
                previousStatus = readTaskQueueStatusToken(cells[1].trimmed);
                if (previousStatus !== SPLIT_REQUIRED_STATUS) {
                    return {
                        outcome: 'write_failed',
                        task_path: normalizePath(taskPath),
                        task_id: taskId,
                        previous_status: previousStatus,
                        next_status: 'DECOMPOSED',
                        error_message: `Expected previous status ${SPLIT_REQUIRED_STATUS}; found ${previousStatus || 'unknown'}.`,
                        status_contract: statusContract
                    };
                }
                const updatedStatusCell = formatTaskQueueStatusCell(cells[1].raw, 'DECOMPOSED');
                if (updatedStatusCell !== cells[1].raw) {
                    const updatedLine = replaceTaskMdTableCell(rawLine, 1, updatedStatusCell);
                    if (!updatedLine) {
                        return {
                            outcome: 'write_failed',
                            task_path: normalizePath(taskPath),
                            task_id: taskId,
                            previous_status: previousStatus,
                            next_status: 'DECOMPOSED',
                            error_message: 'Failed to replace TASK.md status cell.',
                            status_contract: statusContract
                        };
                    }
                    lines[index] = updatedLine;
                    changed = true;
                }
                break;
            }

            if (!taskFound) {
                return {
                    outcome: 'task_not_found',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: null,
                    next_status: 'DECOMPOSED',
                    error_message: null,
                    status_contract: statusContract
                };
            }

            if (!changed) {
                return {
                    outcome: 'already_synced',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: 'DECOMPOSED',
                    error_message: null,
                    status_contract: statusContract
                };
            }

            try {
                fs.writeFileSync(taskPath, lines.join(newline), 'utf8');
                return {
                    outcome: 'updated',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: 'DECOMPOSED',
                    error_message: null,
                    status_contract: statusContract
                };
            } catch (error: unknown) {
                return {
                    outcome: 'write_failed',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: 'DECOMPOSED',
                    error_message: error instanceof Error ? error.message : String(error),
                    status_contract: statusContract
                };
            }
        }
    );
}

function buildDecomposedParentBatchStatusSyncResult(params: {
    taskPath: string;
    rootTaskId: string;
    taskIds: string[];
    updatedTaskIds?: string[];
    previousStatuses?: Record<string, string | null>;
    outcome: TaskQueueStatusSyncResult['outcome'];
    errorMessage?: string | null;
}): DecomposedParentBatchStatusSyncResult {
    const taskIds = [...new Set(params.taskIds)];
    return {
        outcome: params.outcome,
        task_path: normalizePath(params.taskPath),
        root_task_id: params.rootTaskId,
        task_ids: taskIds,
        updated_task_ids: params.updatedTaskIds || [],
        previous_statuses: params.previousStatuses || {},
        next_status: 'DONE',
        error_message: params.errorMessage || null,
        status_contracts: Object.fromEntries(
            taskIds.map((taskId) => [taskId, buildTaskQueueStatusContract(taskId)])
        )
    };
}

function rollbackDecomposedParentStatusSync(
    repoRoot: string,
    taskIds: string[],
    previousStatuses: Record<string, string | null>
): string | null {
    if (taskIds.length === 0) {
        return null;
    }
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (!fileExists(taskPath)) {
        return 'TASK.md is missing.';
    }
    return withTaskQueueStatusSyncLock(
        taskPath,
        (message) => message,
        () => {
            const originalContent = fs.readFileSync(taskPath, 'utf8');
            const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
            const lines = originalContent.split(/\r?\n/);
            const pendingTaskIds = new Set(taskIds);
            for (let index = 0; index < lines.length && pendingTaskIds.size > 0; index += 1) {
                const rawLine = lines[index];
                if (!rawLine.trim().startsWith('|')) {
                    continue;
                }
                const cells = parseTaskMdTableRow(rawLine);
                const taskId = cells[0]?.trimmed;
                if (!taskId || !pendingTaskIds.has(taskId)) {
                    continue;
                }
                const previousStatus = previousStatuses[taskId];
                if (!previousStatus) {
                    return `Missing previous status for ${taskId}.`;
                }
                const updatedStatusCell = formatTaskQueueStatusCell(cells[1].raw, previousStatus);
                const updatedLine = replaceTaskMdTableCell(rawLine, 1, updatedStatusCell);
                if (!updatedLine) {
                    return `Failed to replace TASK.md status cell for ${taskId}.`;
                }
                lines[index] = updatedLine;
                pendingTaskIds.delete(taskId);
            }
            if (pendingTaskIds.size > 0) {
                return `Could not find TASK.md row(s): ${[...pendingTaskIds].join(', ')}.`;
            }
            try {
                fs.writeFileSync(taskPath, lines.join(newline), 'utf8');
                return null;
            } catch (error: unknown) {
                return error instanceof Error ? error.message : String(error);
            }
        }
    );
}

function syncDecomposedParentsToDone(
    repoRoot: string,
    rootTaskId: string,
    requestedTaskIds: string[]
): DecomposedParentBatchStatusSyncResult {
    const taskPath = path.join(repoRoot, 'TASK.md');
    const uniqueRequestedTaskIds = [...new Set(requestedTaskIds)];
    if (!fileExists(taskPath)) {
        return buildDecomposedParentBatchStatusSyncResult({
            taskPath,
            rootTaskId,
            taskIds: uniqueRequestedTaskIds,
            outcome: 'task_file_missing',
            errorMessage: null
        });
    }

    return withTaskQueueStatusSyncLock(
        taskPath,
        (message) => buildDecomposedParentBatchStatusSyncResult({
            taskPath,
            rootTaskId,
            taskIds: uniqueRequestedTaskIds,
            outcome: 'write_failed',
            errorMessage: message
        }),
        () => {
        const originalContent = fs.readFileSync(taskPath, 'utf8');
        const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
        const lines = originalContent.split(/\r?\n/);
        const taskEntries = parseTaskQueueEntriesFromContent(originalContent);
        const rootEntry = taskEntries.get(rootTaskId);
        if (!rootEntry) {
            return buildDecomposedParentBatchStatusSyncResult({
                taskPath,
                rootTaskId,
                taskIds: uniqueRequestedTaskIds,
                outcome: 'task_not_found',
                errorMessage: null
            });
        }

        const completionState = resolveDecomposedParentCompletionState(
            taskEntries,
            rootTaskId,
            new Set<string>(),
            extractExplicitLinkedChildTaskIds
        );
        const previousStatuses: Record<string, string | null> = {};
        const failClosed = (message: string): DecomposedParentBatchStatusSyncResult => (
            buildDecomposedParentBatchStatusSyncResult({
                taskPath,
                rootTaskId,
                taskIds: uniqueRequestedTaskIds,
                previousStatuses,
                outcome: 'write_failed',
                errorMessage: message
            })
        );

        if (!completionState.hasLinkedChildren) {
            return failClosed(`Root task ${rootTaskId} no longer has explicit child task links.`);
        }
        if (completionState.missingChildTaskIds.length > 0) {
            return failClosed(
                `Explicit child task link(s) missing at write time: ${completionState.missingChildTaskIds.join(', ')}.`
            );
        }
        if (!completionState.complete) {
            const unfinished = completionState.unfinishedRoute
                ? `${completionState.unfinishedRoute.taskId} (${completionState.unfinishedRoute.status || 'unknown'})`
                : 'unknown child';
            return failClosed(`Explicit child completion invariant is no longer satisfied at write time: ${unfinished}.`);
        }

        const freshTaskIds = [...new Set([...completionState.completedDecomposedTaskIds, rootTaskId])];
        const freshTaskIdSet = new Set(freshTaskIds);
        for (const requestedTaskId of uniqueRequestedTaskIds) {
            const requestedEntry = taskEntries.get(requestedTaskId);
            previousStatuses[requestedTaskId] = requestedEntry
                ? readTaskQueueStatusToken(requestedEntry.status || '')
                : null;
            if (!freshTaskIdSet.has(requestedTaskId)) {
                return failClosed(
                    `Completion graph changed at write time; requested parent ${requestedTaskId} is no longer in the completed explicit child graph.`
                );
            }
        }

        const rowByTaskId = new Map<string, { index: number; rawLine: string; cells: ReturnType<typeof parseTaskMdTableRow> }>();
        for (let index = 0; index < lines.length; index += 1) {
            const rawLine = lines[index];
            if (!rawLine.trim().startsWith('|')) {
                continue;
            }
            const cells = parseTaskMdTableRow(rawLine);
            const rowTaskId = cells[0]?.trimmed;
            if (rowTaskId && TASK_QUEUE_TASK_ID_PATTERN.test(rowTaskId)) {
                rowByTaskId.set(rowTaskId, { index, rawLine, cells });
            }
        }

        const updatedTaskIds: string[] = [];
        for (const completedTaskId of freshTaskIds) {
            const completedEntry = taskEntries.get(completedTaskId);
            if (!completedEntry) {
                return buildDecomposedParentBatchStatusSyncResult({
                    taskPath,
                    rootTaskId,
                    taskIds: freshTaskIds,
                    previousStatuses,
                    outcome: 'task_not_found',
                    errorMessage: null
                });
            }
            const previousStatus = readTaskQueueStatusToken(completedEntry.status || '');
            previousStatuses[completedTaskId] = previousStatus;
            if (isTaskQueueDoneStatus(completedEntry.status)) {
                continue;
            }
            if (previousStatus !== 'DECOMPOSED') {
                return buildDecomposedParentBatchStatusSyncResult({
                    taskPath,
                    rootTaskId,
                    taskIds: freshTaskIds,
                    previousStatuses,
                    outcome: 'write_failed',
                    errorMessage: `Expected previous status DECOMPOSED for ${completedTaskId}; found ${previousStatus || 'unknown'}.`
                });
            }
            const row = rowByTaskId.get(completedTaskId);
            if (!row) {
                return buildDecomposedParentBatchStatusSyncResult({
                    taskPath,
                    rootTaskId,
                    taskIds: freshTaskIds,
                    previousStatuses,
                    outcome: 'task_not_found',
                    errorMessage: null
                });
            }
            const updatedStatusCell = formatTaskQueueStatusCell(row.cells[1].raw, 'DONE');
            if (updatedStatusCell === row.cells[1].raw) {
                continue;
            }
            const updatedLine = replaceTaskMdTableCell(row.rawLine, 1, updatedStatusCell);
            if (!updatedLine) {
                return buildDecomposedParentBatchStatusSyncResult({
                    taskPath,
                    rootTaskId,
                    taskIds: freshTaskIds,
                    previousStatuses,
                    outcome: 'write_failed',
                    errorMessage: `Failed to replace TASK.md status cell for ${completedTaskId}.`
                });
            }
            lines[row.index] = updatedLine;
            updatedTaskIds.push(completedTaskId);
        }

        if (updatedTaskIds.length === 0) {
            return buildDecomposedParentBatchStatusSyncResult({
                taskPath,
                rootTaskId,
                taskIds: freshTaskIds,
                previousStatuses,
                outcome: 'already_synced',
                errorMessage: null
            });
        }

        try {
            const currentContent = fs.readFileSync(taskPath, 'utf8');
            if (currentContent !== originalContent) {
                return buildDecomposedParentBatchStatusSyncResult({
                    taskPath,
                    rootTaskId,
                    taskIds: freshTaskIds,
                    previousStatuses,
                    outcome: 'write_failed',
                    errorMessage:
                        'TASK.md changed during decomposed parent status sync; rerun next-step so write-time revalidation can use the latest task queue snapshot.'
                });
            }
            fs.writeFileSync(taskPath, lines.join(newline), 'utf8');
            return buildDecomposedParentBatchStatusSyncResult({
                taskPath,
                rootTaskId,
                taskIds: freshTaskIds,
                updatedTaskIds,
                previousStatuses,
                outcome: 'updated',
                errorMessage: null
            });
        } catch (error: unknown) {
            return buildDecomposedParentBatchStatusSyncResult({
                taskPath,
                rootTaskId,
                taskIds: freshTaskIds,
                previousStatuses,
                outcome: 'write_failed',
                errorMessage: error instanceof Error ? error.message : String(error)
            });
        }
        }
    );
}

interface NextStepOptions {
    taskId: string;
    repoRoot: string;
    eventsRoot?: string | null;
    reviewsRoot?: string | null;
}

interface ArtifactSpec {
    key: string;
    path: string;
}

interface ReviewArtifactState {
    reviewType: string;
    contextPath: string;
    artifactPath: string;
    receiptPath: string;
    contextExists: boolean;
    contextCurrent: boolean;
    artifactExists: boolean;
    receiptExists: boolean;
    passToken: string;
    failToken: string;
    verdictToken: string | null;
    failed: boolean;
    failureKind: 'launch-package' | null;
    failureReason: string | null;
    ready: boolean;
    violations: string[];
    reviewerIdentity: string | null;
    contextReviewerIdentity: string | null;
    reusedExistingReview: boolean;
    reusedFromReceiptPath: string | null;
    reusedFromReceiptSha256: string | null;
    reusedFromReviewContextSha256: string | null;
    reusedFromReviewContextReuseSha256: string | null;
    reusedFromReviewTreeStateSha256: string | null;
    reusedFromReviewScopeSha256: string | null;
    reusedFromCodeScopeSha256: string | null;
    receiptReviewContextSha256: string | null;
    receiptReviewContextReuseSha256: string | null;
    receiptReviewScopeSha256: string | null;
    receiptCodeScopeSha256: string | null;
    contextReviewTreeStateSha256: string | null;
    receiptReviewTreeStateSha256: string | null;
    reviewerProvenance: {
        attestation_type: string;
        controller_event_type: string;
        task_sequence: number | null;
        prev_event_sha256: string | null;
        event_sha256: string | null;
        task_id?: string;
        review_type?: string;
        reviewer_execution_mode?: string;
        reviewer_identity?: string;
        review_context_sha256?: string;
        review_tree_state_sha256?: string | null;
        routing_event_sha256?: string;
        launch_prepared_at_utc?: string | null;
        launched_at_utc?: string | null;
        launch_completed_at_utc?: string | null;
        invocation_attested_at_utc?: string | null;
    } | null;
    reviewResultRecordedAtUtc: string | null;
    recordedAtUtc: string | null;
    reviewOutputSourceMtimeUtc: string | null;
}

const REVIEW_LAUNCH_PACKAGE_FAILURE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\breviewer_prompt_sha256\b[\s\S]{0,160}\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b/i, reason: 'reviewer_prompt_sha256 mismatch' },
    { pattern: /\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b[\s\S]{0,160}\breviewer_prompt_sha256\b/i, reason: 'reviewer_prompt_sha256 mismatch' },
    { pattern: /\breview_context_sha256\b[\s\S]{0,160}\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b/i, reason: 'review_context_sha256 mismatch' },
    { pattern: /\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b[\s\S]{0,160}\breview_context_sha256\b/i, reason: 'review_context_sha256 mismatch' },
    { pattern: /\breview_tree_state_sha256\b[\s\S]{0,160}\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b/i, reason: 'review_tree_state_sha256 mismatch' },
    { pattern: /\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b[\s\S]{0,160}\breview_tree_state_sha256\b/i, reason: 'review_tree_state_sha256 mismatch' },
    { pattern: /\b(?:launch_binding_sha256|prepared_launch_event_sha256|reviewer_launch_artifact_sha256)\b[\s\S]{0,160}\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b/i, reason: 'reviewer launch binding mismatch' },
    { pattern: /\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b[\s\S]{0,160}\b(?:launch_binding_sha256|prepared_launch_event_sha256|reviewer_launch_artifact_sha256)\b/i, reason: 'reviewer launch binding mismatch' },
    { pattern: /\b(?:launch package|launch artifact|prepared launch|reviewer launch|invocation attestation|launch binding)\b[\s\S]{0,160}\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b/i, reason: 'reviewer launch package mismatch' },
    { pattern: /\b(?:wrong|stale|invalid)\s+(?:prompt|context|tree-state|tree state)\s+hash\b/i, reason: 'reviewer launch hash mismatch' }
];
const REVIEW_LAUNCH_PACKAGE_FAILURE_MARKER_PATTERN =
    /\b(?:reviewer\s+failed\s+before\s+\w+\s+review|reviewer\s+launch\s+artifact\s+is\s+not\s+eligible\s+for\s+invocation\s+attestation|reviewer\s+launch\s+package\s+failure|launch\s+package\s+failure|launch\s+metadata\s+failure|invocation\s+attestation\s+failed)\b/i;

function detectReviewLaunchPackageFailureReason(content: string): string | null {
    if (!REVIEW_LAUNCH_PACKAGE_FAILURE_MARKER_PATTERN.test(content)) {
        return null;
    }
    const match = REVIEW_LAUNCH_PACKAGE_FAILURE_PATTERNS.find(({ pattern }) => pattern.test(content));
    return match?.reason || null;
}

interface CompileReadiness {
    ready: boolean;
    reason: string;
}

interface PreflightWorkspaceReadiness {
    ready: boolean;
    reason: string;
    currentChangedFiles?: string[];
    acceptedDocsOnlyDeltaFiles?: string[];
}

interface PreflightWorkspaceReadinessOptions {
    failedReviewType?: string | null;
    failedReviewVerdict?: string | null;
    docImpactPath?: string | null;
    allowDocsOnlyDelta?: boolean;
}

interface PreflightCycleReadiness {
    ready: boolean;
    reason: string;
}

interface PreflightCycleReadinessOptions {
    allowStaleCompletionFailureForDocCloseout?: boolean;
    staleCompletionFailureDocCloseoutReason?: string;
}

interface FailedGateRecovery {
    nextGate: string;
    title: string;
    reason: string;
    label: string;
    command: string;
}

interface RulePackReadiness {
    ready: boolean;
    reason: string;
    rebind: PostPreflightRulePackRebindDecision | null;
}

interface StartupCycleReadiness {
    ready: boolean;
    nextGate: 'load-rule-pack' | 'handshake-diagnostics' | 'shell-smoke-preflight' | null;
    title: string;
    reason: string;
}

interface CoherentCycleReadiness {
    ready: boolean;
    reason: string;
    command: string | null;
}

const COHERENT_CYCLE_BOUNDARY_EVENTS = new Set([
    'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE',
    'COMPLETION_GATE_FAILED',
    'COMPLETION_GATE_PASSED'
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function toRepoDisplayPath(repoRoot: string, filePath: string): string {
    const relative = path.relative(path.resolve(repoRoot), path.resolve(filePath));
    return normalizePath(relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? relative
        : filePath);
}

function buildCliPrefix(repoRoot: string): string {
    return fs.existsSync(path.join(path.resolve(repoRoot), 'bin', 'garda.js'))
        ? 'node bin/garda.js'
        : `node ${resolveBundleNameForTarget(repoRoot)}/bin/garda.js`;
}

function buildBundleRelativePath(repoRoot: string, relativePath: string): string {
    return normalizePath(path.join(resolveBundleNameForTarget(repoRoot), relativePath));
}

function resolveBundleRootForNextStep(repoRoot: string): string {
    const sourceCheckoutBundleRoot = path.resolve(repoRoot);
    return fs.existsSync(path.join(sourceCheckoutBundleRoot, 'bin', 'garda.js'))
        ? sourceCheckoutBundleRoot
        : path.join(sourceCheckoutBundleRoot, resolveBundleNameForTarget(repoRoot));
}

function artifactState(repoRoot: string, specs: ArtifactSpec[]): {
    present: NextStepArtifactState[];
    missing: NextStepArtifactState[];
} {
    const states = specs.map((spec) => ({
        key: spec.key,
        path: toRepoDisplayPath(repoRoot, spec.path),
        exists: fileExists(spec.path)
    }));
    return {
        present: states.filter((state) => state.exists),
        missing: states.filter((state) => !state.exists)
    };
}

function getGateStatus(summary: TaskAuditSummaryResult, gateName: string): GateOutcome['status'] | null {
    return summary.gates.find((gate) => gate.gate === gateName)?.status || null;
}

function isGatePassed(summary: TaskAuditSummaryResult, gateName: string): boolean {
    return getGateStatus(summary, gateName) === 'PASS';
}

function hasAcceptedDocsOnlyFullSuiteSkipArtifact(
    reviewsRoot: string,
    taskId: string,
    expectedCommand: string,
    preflightPath: string,
    preflightSha256: string | null,
    summary: TaskAuditSummaryResult
): boolean {
    const artifactPath = path.join(reviewsRoot, `${taskId}-full-suite-validation.json`);
    const artifact = safeReadJson(artifactPath) as Record<string, unknown> | null;
    if (!artifact) {
        return false;
    }
    return String(artifact.status || '').trim().toUpperCase() === 'SKIPPED'
        && artifact.enabled === true
        && artifact.required === false
        && String(artifact.skip_reason || '').trim() === 'DOCS_ONLY_SCOPE_NOT_REQUIRED'
        && String(artifact.command || '').trim() === expectedCommand
        && fullSuiteArtifactMatchesCurrentCycle(artifact, taskId, preflightPath, preflightSha256, summary);
}

function fullSuiteArtifactMatchesCurrentCycle(
    artifact: Record<string, unknown>,
    taskId: string,
    preflightPath: string,
    preflightSha256: string | null,
    summary: TaskAuditSummaryResult
): boolean {
    const rawCycleBinding = artifact.cycle_binding;
    if (!rawCycleBinding || typeof rawCycleBinding !== 'object' || Array.isArray(rawCycleBinding)) {
        return false;
    }
    const cycleBinding = rawCycleBinding as Record<string, unknown>;
    const expectedPreflightPath = normalizePath(preflightPath);
    const expectedPreflightSha256 = String(preflightSha256 || '').trim().toLowerCase();
    if (String(cycleBinding.task_id || '').trim() !== taskId) {
        return false;
    }
    if (normalizePath(cycleBinding.preflight_path || '') !== expectedPreflightPath) {
        return false;
    }
    if (expectedPreflightSha256 && String(cycleBinding.preflight_sha256 || '').trim().toLowerCase() !== expectedPreflightSha256) {
        return false;
    }
    const expectedCompileTimestamp = String(
        summary.gates.find((gate) => gate.gate === 'compile-gate')?.timestamp_utc || ''
    ).trim();
    const artifactCompileTimestamp = cycleBinding.compile_gate_timestamp == null
        ? ''
        : String(cycleBinding.compile_gate_timestamp || '').trim();
    return !!expectedCompileTimestamp && artifactCompileTimestamp === expectedCompileTimestamp;
}

function getRequiredReviewTypes(requiredReviews: Record<string, boolean>): string[] {
    return REVIEW_PREPARATION_ORDER.filter((reviewType) => requiredReviews[reviewType]);
}

function hasZeroDiffNoReviewableScopeSuppression(
    preflight: Record<string, unknown> | null,
    requiredReviewTypes: string[]
): boolean {
    if (!preflight || requiredReviewTypes.length > 0) {
        return false;
    }
    const zeroDiffGuard = isPlainRecord(preflight.zero_diff_guard)
        ? preflight.zero_diff_guard
        : null;
    const profileGuardrails = isPlainRecord(preflight.profile_guardrails)
        ? preflight.profile_guardrails
        : null;
    return zeroDiffGuard?.zero_diff_detected === true
        && zeroDiffGuard.status === 'BASELINE_ONLY'
        && profileGuardrails?.zero_diff_no_reviewable_scope === true;
}

function preflightRequiresAuditedNoOp(preflight: Record<string, unknown> | null): boolean {
    if (!preflight || !isPlainRecord(preflight.zero_diff_guard)) {
        return false;
    }
    const zeroDiffGuard = preflight.zero_diff_guard;
    return zeroDiffGuard.zero_diff_detected === true
        && zeroDiffGuard.completion_requires_audited_no_op === true;
}

function resolveReviewPolicy(preflight: Record<string, unknown> | null): {
    mode: EffectiveReviewExecutionPolicyMode;
    source: 'preflight' | 'workflow_config_fallback';
} {
    if (preflight && isPlainRecord(preflight.review_execution_policy)) {
        return {
            mode: resolveReviewExecutionPolicyModeFromPreflight(preflight),
            source: 'preflight'
        };
    }
    return {
        mode: resolveReviewExecutionPolicyModeFromPreflight(null),
        source: 'workflow_config_fallback'
    };
}

function readReviewArtifactState(
    reviewsRoot: string,
    taskId: string,
    reviewType: string,
    preflightPath: string,
    preflightSha256: string | null,
    preflightPayload: Record<string, unknown> | null
): ReviewArtifactState {
    const contextPath = path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    const passToken = REVIEW_VERDICT_PASS_TOKENS[reviewType] || '';
    const failToken = REVIEW_VERDICT_FAIL_TOKENS[reviewType] || '';
    const violations: string[] = [];
    const contextExists = fileExists(contextPath);
    let contextCurrent = false;
    const artifactExists = fileExists(artifactPath);
    const receiptExists = fileExists(receiptPath);
    let context: Record<string, unknown> | null = null;
    let receipt: Record<string, unknown> | null = null;
    let reviewerIdentity: string | null = null;
    let contextReviewerIdentity: string | null = null;
    let contextReviewTreeStateSha256: string | null = null;
    let receiptReviewTreeStateSha256: string | null = null;
    let reusedExistingReview = false;
    let reusedFromReceiptPath: string | null = null;
    let reusedFromReceiptSha256: string | null = null;
    let reusedFromReviewContextSha256: string | null = null;
    let reusedFromReviewContextReuseSha256: string | null = null;
    let reusedFromReviewTreeStateSha256: string | null = null;
    let reusedFromReviewScopeSha256: string | null = null;
    let reusedFromCodeScopeSha256: string | null = null;
    let receiptReviewContextSha256: string | null = null;
    let receiptReviewContextReuseSha256: string | null = null;
    let receiptReviewScopeSha256: string | null = null;
    let receiptCodeScopeSha256: string | null = null;
    let reviewerProvenance: ReviewArtifactState['reviewerProvenance'] = null;
    let verdictToken: string | null = null;
    let failed = false;
    let failureKind: ReviewArtifactState['failureKind'] = null;
    let failureReason: string | null = null;
    let reviewResultRecordedAtUtc: string | null = null;
    let recordedAtUtc: string | null = null;
    let reviewOutputSourceMtimeUtc: string | null = null;

    if (!contextExists) {
        violations.push('review context artifact is missing');
    } else {
        context = safeReadJson(contextPath);
        if (!context) {
            violations.push('review context artifact is invalid JSON');
        } else {
            const reviewerRouting = isPlainRecord(context.reviewer_routing)
                ? context.reviewer_routing
                : null;
            const contextTreeState = isPlainRecord(context.tree_state)
                ? context.tree_state
                : null;
            contextReviewTreeStateSha256 = typeof contextTreeState?.tree_state_sha256 === 'string'
                ? contextTreeState.tree_state_sha256.trim().toLowerCase() || null
                : null;
            if (!contextReviewTreeStateSha256) {
                violations.push('review context is missing tree_state.tree_state_sha256');
            }
            const contextReviewerSessionId = typeof reviewerRouting?.reviewer_session_id === 'string'
                ? reviewerRouting.reviewer_session_id.trim()
                : '';
            contextReviewerIdentity = contextReviewerSessionId || null;
            const contextPreflightPath = typeof context.preflight_path === 'string'
                ? normalizePath(context.preflight_path)
                : '';
            const contextPreflightHash = typeof context.preflight_sha256 === 'string'
                ? context.preflight_sha256.trim().toLowerCase()
                : '';
            const expectedPreflightPath = normalizePath(preflightPath);
            const expectedPreflightHash = String(preflightSha256 || '').trim().toLowerCase();
            if (
                contextPreflightPath
                && contextPreflightHash
                && contextPreflightPath.toLowerCase() === expectedPreflightPath.toLowerCase()
                && contextPreflightHash === expectedPreflightHash
            ) {
                const contractViolations = getReviewContextContractViolations({
                    contextPath,
                    reviewContext: context,
                    expectedTaskId: taskId,
                    expectedReviewType: reviewType,
                    expectedPreflightPath: preflightPath,
                    expectedPreflightSha256: preflightSha256,
                    requireReviewType: true,
                    requireTaskId: true,
                    requirePreflightPath: true,
                    requirePreflightSha256: true,
                    ...buildReviewContextPreflightDiffExpectations(preflightPayload, reviewType)
                });
                if (contractViolations.length === 0) {
                    contextCurrent = true;
                } else {
                    violations.push(...contractViolations);
                }
            } else {
                violations.push(
                    'review context preflight binding is stale or missing ' +
                    `(context preflight_path='${contextPreflightPath || 'missing'}', preflight_sha256=${contextPreflightHash || 'missing'}; ` +
                    `expected preflight_path='${expectedPreflightPath || 'missing'}', preflight_sha256=${expectedPreflightHash || 'missing'})`
                );
            }
        }
    }

    if (!artifactExists) {
        violations.push('review artifact is missing');
    } else {
        const content = fs.readFileSync(artifactPath, 'utf8');
        const parsedVerdictToken = extractReviewVerdictToken(content, passToken || null, failToken || null, reviewType);
        const acceptedTokens = buildReviewVerdictTokenSet(reviewType, passToken || null, failToken || null);
        if (failToken && parsedVerdictToken === failToken) {
            verdictToken = failToken;
            failed = true;
            failureReason = detectReviewLaunchPackageFailureReason(content);
            if (failureReason) {
                failureKind = 'launch-package';
                violations.push(
                    `review artifact contains fail token '${failToken}' for reviewer launch package failure (${failureReason}); preserve the failed artifact and restart the review cycle without implementation changes`
                );
            } else {
                violations.push(
                    `review artifact contains fail token '${failToken}'; fix implementation and rerun compile plus '${reviewType}' review before launching dependent reviews`
                );
            }
        } else if (passToken && parsedVerdictToken === passToken) {
            verdictToken = passToken;
        } else {
            violations.push(
                `review artifact does not contain an accepted pass token ` +
                `(${formatReviewVerdictTokenList(acceptedTokens.passTokens)})`
            );
        }
    }

    if (!receiptExists) {
        violations.push('review receipt is missing');
    } else {
        receipt = safeReadJson(receiptPath);
        if (!receipt) {
            violations.push('review receipt is invalid JSON');
        }
    }

    if (context && receipt && artifactExists) {
        const artifactHash = fileSha256(artifactPath);
        const contextHash = fileSha256(contextPath);
        const receiptArtifactHash = typeof receipt.review_artifact_sha256 === 'string'
            ? receipt.review_artifact_sha256.trim().toLowerCase()
            : '';
        const receiptContextHash = typeof receipt.review_context_sha256 === 'string'
            ? receipt.review_context_sha256.trim().toLowerCase()
            : '';
        const reviewerRouting = isPlainRecord(context.reviewer_routing)
            ? context.reviewer_routing
            : null;
        const contextExecutionMode = typeof reviewerRouting?.actual_execution_mode === 'string'
            ? reviewerRouting.actual_execution_mode.trim()
            : '';
        const contextReviewerSessionId = typeof reviewerRouting?.reviewer_session_id === 'string'
            ? reviewerRouting.reviewer_session_id.trim()
            : '';
        const receiptExecutionMode = typeof receipt.reviewer_execution_mode === 'string'
            ? receipt.reviewer_execution_mode.trim()
            : '';
        const receiptReviewerIdentity = typeof receipt.reviewer_identity === 'string'
            ? receipt.reviewer_identity.trim()
            : '';
        reviewerIdentity = receiptReviewerIdentity || null;
        reusedExistingReview = receipt.reused_existing_review === true;
        reusedFromReceiptPath = typeof receipt.reused_from_receipt_path === 'string'
            ? receipt.reused_from_receipt_path.trim() || null
            : null;
        reusedFromReceiptSha256 = typeof receipt.reused_from_receipt_sha256 === 'string'
            ? receipt.reused_from_receipt_sha256.trim().toLowerCase() || null
            : null;
        reusedFromReviewContextSha256 = typeof receipt.reused_from_review_context_sha256 === 'string'
            ? receipt.reused_from_review_context_sha256.trim().toLowerCase() || null
            : null;
        reusedFromReviewContextReuseSha256 = typeof receipt.reused_from_review_context_reuse_sha256 === 'string'
            ? receipt.reused_from_review_context_reuse_sha256.trim().toLowerCase() || null
            : null;
        reusedFromReviewTreeStateSha256 = typeof receipt.reused_from_review_tree_state_sha256 === 'string'
            ? receipt.reused_from_review_tree_state_sha256.trim().toLowerCase() || null
            : null;
        reusedFromReviewScopeSha256 = typeof receipt.reused_from_review_scope_sha256 === 'string'
            ? receipt.reused_from_review_scope_sha256.trim().toLowerCase() || null
            : null;
        reusedFromCodeScopeSha256 = typeof receipt.reused_from_code_scope_sha256 === 'string'
            ? receipt.reused_from_code_scope_sha256.trim().toLowerCase() || null
            : null;
        receiptReviewContextSha256 = receiptContextHash || null;
        receiptReviewContextReuseSha256 = typeof receipt.review_context_reuse_sha256 === 'string'
            ? receipt.review_context_reuse_sha256.trim().toLowerCase() || null
            : null;
        receiptReviewScopeSha256 = typeof receipt.review_scope_sha256 === 'string'
            ? receipt.review_scope_sha256.trim().toLowerCase() || null
            : null;
        receiptCodeScopeSha256 = typeof receipt.code_scope_sha256 === 'string'
            ? receipt.code_scope_sha256.trim().toLowerCase() || null
            : null;
        receiptReviewTreeStateSha256 = typeof receipt.review_tree_state_sha256 === 'string'
            ? receipt.review_tree_state_sha256.trim().toLowerCase() || null
            : null;
        reviewResultRecordedAtUtc = typeof receipt.review_result_recorded_at_utc === 'string'
            ? receipt.review_result_recorded_at_utc.trim() || null
            : null;
        recordedAtUtc = typeof receipt.recorded_at_utc === 'string'
            ? receipt.recorded_at_utc.trim() || null
            : null;
        reviewOutputSourceMtimeUtc = typeof receipt.review_output_source_mtime_utc === 'string'
            ? receipt.review_output_source_mtime_utc.trim() || null
            : null;
        const normalizedProvenance = receipt.reviewer_provenance == null
            ? null
            : normalizeReviewReceiptReviewerProvenance(receipt.reviewer_provenance);
        reviewerProvenance = normalizedProvenance
            ? {
                attestation_type: normalizedProvenance.attestation_type,
                controller_event_type: normalizedProvenance.controller_event_type,
                task_sequence: normalizedProvenance.task_sequence,
                prev_event_sha256: normalizedProvenance.prev_event_sha256 == null
                    ? null
                    : String(normalizedProvenance.prev_event_sha256 || '').trim().toLowerCase() || null,
                event_sha256: String(normalizedProvenance.event_sha256 || '').trim().toLowerCase() || null,
                task_id: 'task_id' in normalizedProvenance ? normalizedProvenance.task_id : undefined,
                review_type: 'review_type' in normalizedProvenance ? normalizedProvenance.review_type : undefined,
                reviewer_execution_mode: 'reviewer_execution_mode' in normalizedProvenance ? normalizedProvenance.reviewer_execution_mode : undefined,
                reviewer_identity: 'reviewer_identity' in normalizedProvenance ? normalizedProvenance.reviewer_identity : undefined,
                review_context_sha256: 'review_context_sha256' in normalizedProvenance ? normalizedProvenance.review_context_sha256 : undefined,
                review_tree_state_sha256: 'review_tree_state_sha256' in normalizedProvenance ? normalizedProvenance.review_tree_state_sha256 : undefined,
                routing_event_sha256: 'routing_event_sha256' in normalizedProvenance ? normalizedProvenance.routing_event_sha256 : undefined,
                launch_prepared_at_utc: 'launch_prepared_at_utc' in normalizedProvenance ? normalizedProvenance.launch_prepared_at_utc : undefined,
                launched_at_utc: 'launched_at_utc' in normalizedProvenance ? normalizedProvenance.launched_at_utc : undefined,
                launch_completed_at_utc: 'launch_completed_at_utc' in normalizedProvenance ? normalizedProvenance.launch_completed_at_utc : undefined,
                invocation_attested_at_utc: 'invocation_attested_at_utc' in normalizedProvenance ? normalizedProvenance.invocation_attested_at_utc : undefined
            }
            : null;
        if (receipt.task_id !== taskId) {
            violations.push(`review receipt belongs to task '${String(receipt.task_id || '')}'`);
        }
        if (receipt.review_type !== reviewType) {
            violations.push(`review receipt has review_type '${String(receipt.review_type || '')}'`);
        }
        if (!artifactHash || receiptArtifactHash !== artifactHash) {
            violations.push('review artifact hash does not match the receipt');
        }
        if (!contextHash || receiptContextHash !== contextHash) {
            violations.push('review context hash does not match the receipt');
        }
        if (contextReviewTreeStateSha256 && !receiptReviewTreeStateSha256) {
            violations.push('review receipt is missing review_tree_state_sha256');
        } else if (
            contextReviewTreeStateSha256
            && receiptReviewTreeStateSha256
            && receiptReviewTreeStateSha256 !== contextReviewTreeStateSha256
        ) {
            violations.push('review receipt review_tree_state_sha256 does not match the review context tree_state');
        }
        if (receiptExecutionMode !== 'delegated_subagent') {
            violations.push("review receipt does not use reviewer_execution_mode 'delegated_subagent'");
        }
        if (String(receipt.trust_level || '').trim() !== 'INDEPENDENT_AUDITED') {
            violations.push("review receipt trust_level must be 'INDEPENDENT_AUDITED'");
        }
        if (!receiptReviewerIdentity.startsWith('agent:')) {
            violations.push("review receipt reviewer_identity must use 'agent:' scope");
        }
        if (!reusedExistingReview && contextExecutionMode !== 'delegated_subagent') {
            violations.push("review context is missing delegated_subagent routing metadata");
        }
        if (!reusedExistingReview && contextReviewerSessionId !== receiptReviewerIdentity) {
            violations.push('review context reviewer identity does not match the receipt');
        }
        if (receipt.reviewer_provenance == null) {
            violations.push('review receipt is missing reviewer_provenance');
        } else if (!normalizedProvenance) {
            violations.push('review receipt reviewer_provenance is invalid');
        } else if (
            !reviewerProvenance?.task_sequence
            || !reviewerProvenance.event_sha256
            || !/^[0-9a-f]{64}$/.test(reviewerProvenance.event_sha256)
        ) {
            violations.push('review receipt reviewer_provenance is incomplete');
        } else if (reviewerProvenance.controller_event_type !== 'REVIEWER_INVOCATION_ATTESTED') {
            violations.push('review receipt reviewer_provenance must reference REVIEWER_INVOCATION_ATTESTED telemetry');
        } else if (
            !reusedExistingReview
            && receiptReviewTreeStateSha256
            && !reviewerProvenance.review_tree_state_sha256
        ) {
            violations.push('review receipt reviewer_provenance is missing review_tree_state_sha256');
        } else if (
            !reusedExistingReview
            && receiptReviewTreeStateSha256
            && reviewerProvenance.review_tree_state_sha256 !== receiptReviewTreeStateSha256
        ) {
            violations.push('review receipt reviewer_provenance review_tree_state_sha256 does not match the receipt');
        } else if (
            reusedExistingReview
            && !reusedFromReviewTreeStateSha256
        ) {
            violations.push('reused review receipt is missing reused_from_review_tree_state_sha256');
        } else if (
            reusedExistingReview
            && reusedFromReviewTreeStateSha256
            && reviewerProvenance.review_tree_state_sha256 !== reusedFromReviewTreeStateSha256
        ) {
            violations.push('reused review receipt reviewer_provenance review_tree_state_sha256 does not match reused_from_review_tree_state_sha256');
        }
    }

    return {
        reviewType,
        contextPath,
        artifactPath,
        receiptPath,
        contextExists,
        contextCurrent,
        artifactExists,
        receiptExists,
        passToken,
        failToken,
        verdictToken,
        failed,
        failureKind,
        failureReason,
        ready: violations.length === 0,
        violations,
        reviewerIdentity,
        contextReviewerIdentity,
        reusedExistingReview,
        reusedFromReceiptPath,
        reusedFromReceiptSha256,
        reusedFromReviewContextSha256,
        reusedFromReviewContextReuseSha256,
        reusedFromReviewTreeStateSha256,
        reusedFromReviewScopeSha256,
        reusedFromCodeScopeSha256,
        receiptReviewContextSha256,
        receiptReviewContextReuseSha256,
        receiptReviewScopeSha256,
        receiptCodeScopeSha256,
        contextReviewTreeStateSha256,
        receiptReviewTreeStateSha256,
        reviewerProvenance,
        reviewResultRecordedAtUtc,
        recordedAtUtc,
        reviewOutputSourceMtimeUtc
    };
}

function scopedDiffExpectedForReview(options: {
    preflight: Record<string, unknown> | null;
    reviewType: string;
}): boolean {
    return buildReviewContextPreflightDiffExpectations(options.preflight, options.reviewType).expectedScopedDiff;
}

function getScopedDiffMetadataReadiness(options: {
    metadataPath: string;
    preflight: Record<string, unknown> | null;
    preflightPath: string;
    preflightSha256: string | null;
    reviewType: string;
}): { ready: boolean; reason: string } {
    const metadataPath = options.metadataPath;
    if (!fileExists(metadataPath)) {
        return {
            ready: false,
            reason: `Scoped diff metadata is missing: ${normalizePath(metadataPath)}.`
        };
    }
    const metadata = safeReadJson(metadataPath);
    if (!isPlainRecord(metadata)) {
        return {
            ready: false,
            reason: `Scoped diff metadata is invalid JSON: ${normalizePath(metadataPath)}.`
        };
    }
    if (typeof metadata.parse_error === 'string' && metadata.parse_error.trim()) {
        return {
            ready: false,
            reason: `Scoped diff metadata contains parse_error: ${metadata.parse_error.trim()}.`
        };
    }
    const outputDiffLineCount = typeof metadata.output_diff_line_count === 'number'
        ? metadata.output_diff_line_count
        : Number(metadata.output_diff_line_count);
    if (!Number.isFinite(outputDiffLineCount) || outputDiffLineCount <= 0) {
        return {
            ready: false,
            reason: `Scoped diff metadata has no output diff lines: ${normalizePath(metadataPath)}.`
        };
    }

    const contractViolations = getReviewContextContractViolations({
        contextPath: metadataPath,
        reviewContext: {
            scoped_diff: {
                expected: true,
                metadata_path: normalizePath(metadataPath),
                metadata
            }
        },
        expectedReviewType: options.reviewType,
        expectedPreflightPath: options.preflightPath,
        expectedPreflightSha256: options.preflightSha256,
        requireReviewType: false,
        requireTaskId: false,
        requirePreflightPath: false,
        requirePreflightSha256: false,
        requireDiffMaterialForRequiredReview: false,
        ...buildReviewContextPreflightDiffExpectations(options.preflight, options.reviewType),
        expectedScopedDiff: true
    });
    if (contractViolations.length > 0) {
        return {
            ready: false,
            reason: `Scoped diff metadata is stale or mismatched: ${contractViolations.join(' ')}`
        };
    }
    return { ready: true, reason: 'Scoped diff metadata is ready.' };
}

function getLatestTaskSequenceForEventTypes(eventsRoot: string, taskId: string, eventTypes: string[]): number | null {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return null;
    }
    const wanted = new Set(eventTypes);
    let latestSequence: number | null = null;
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (!wanted.has(String(event.event_type || '').trim())) {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const sequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            if (Number.isInteger(sequence) && sequence > 0) {
                latestSequence = latestSequence == null ? sequence : Math.max(latestSequence, sequence);
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return latestSequence;
}

function readTaskTimelineEventLikes(eventsRoot: string, taskId: string): ReviewReuseTelemetryEventLike[] {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return [];
    }
    const events: ReviewReuseTelemetryEventLike[] = [];
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            events.push(JSON.parse(line) as ReviewReuseTelemetryEventLike);
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return events;
}

function timelineHasDelegatedReviewInvocationAttestation(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    if (state.reusedExistingReview) {
        return false;
    }
    if (!state.reviewerIdentity || !state.reviewerProvenance?.task_sequence || !state.reviewerProvenance.event_sha256) {
        return false;
    }
    if (
        state.reviewerProvenance.attestation_type !== 'reviewer_invocation_attestation'
        || state.reviewerProvenance.controller_event_type !== 'REVIEWER_INVOCATION_ATTESTED'
    ) {
        return false;
    }
    const expectedReviewTreeStateSha256 = state.contextReviewTreeStateSha256;
    if (
        !expectedReviewTreeStateSha256
        || state.receiptReviewTreeStateSha256 !== expectedReviewTreeStateSha256
        || state.reviewerProvenance.review_tree_state_sha256 !== expectedReviewTreeStateSha256
    ) {
        return false;
    }
    const reviewerLaunchArtifactEvidence = getCurrentReviewerLaunchArtifactEvidenceForInvocation(
        repoRoot,
        eventsRoot,
        taskId,
        state
    );
    if (reviewerLaunchArtifactEvidence.state !== 'launched' || !reviewerLaunchArtifactEvidence.sha256) {
        return false;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return false;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null || state.reviewerProvenance.task_sequence <= latestCompileSequence) {
        return false;
    }
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(lines[index]) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEWER_INVOCATION_ATTESTED') {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            if (String(details.task_id || '').trim() !== taskId) {
                continue;
            }
            if (String(details.review_type || '').trim() !== state.reviewType) {
                continue;
            }
            if (String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent') {
                continue;
            }
            const eventReviewerIdentity = String(details.reviewer_identity || details.reviewer_session_id || '').trim();
            if (eventReviewerIdentity !== state.reviewerIdentity) {
                continue;
            }
            const reviewContextSha256 = String(details.review_context_sha256 || '').trim().toLowerCase();
            const reviewTreeStateSha256 = String(details.review_tree_state_sha256 || '').trim().toLowerCase();
            const routingEventSha256 = String(details.routing_event_sha256 || '').trim().toLowerCase();
            const launchArtifactSha256 = String(details.reviewer_launch_artifact_sha256 || '').trim().toLowerCase();
            if (
                reviewContextSha256 !== String(state.reviewerProvenance.review_context_sha256 || '').trim().toLowerCase()
                || reviewTreeStateSha256 !== expectedReviewTreeStateSha256
                || routingEventSha256 !== String(state.reviewerProvenance.routing_event_sha256 || '').trim().toLowerCase()
                || launchArtifactSha256 !== reviewerLaunchArtifactEvidence.sha256
            ) {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const taskSequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            const eventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
            const prevEventSha256 = integrity?.prev_event_sha256 == null
                ? null
                : String(integrity.prev_event_sha256 || '').trim().toLowerCase() || null;
            if (
                taskSequence !== state.reviewerProvenance.task_sequence
                || eventSha256 !== state.reviewerProvenance.event_sha256
                || prevEventSha256 !== state.reviewerProvenance.prev_event_sha256
            ) {
                continue;
            }
            return true;
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return false;
}

function timelineHasReviewReuseRecordedAfterCompile(eventsRoot: string, taskId: string, state: ReviewArtifactState): boolean {
    if (!state.reusedExistingReview || !state.receiptExists || !state.contextExists || !state.contextCurrent || !state.artifactExists) {
        return false;
    }
    const reviewContextSha256 = fileSha256(state.contextPath);
    const reviewArtifactSha256 = fileSha256(state.artifactPath);
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (!reviewContextSha256 || !reviewArtifactSha256 || latestCompileSequence == null) {
        return false;
    }
    const repoRoot = path.resolve(eventsRoot, '..', '..', '..');
    const validation = validateStrictReusedReviewEvidence({
        repoRoot,
        taskId,
        reviewType: state.reviewType,
        events: readTaskTimelineEventLikes(eventsRoot, taskId),
        receiptPath: state.receiptPath,
        reviewContextSha256,
        reviewContextReuseSha256: state.receiptReviewContextReuseSha256,
        reviewTreeStateSha256: state.receiptReviewTreeStateSha256,
        reviewScopeSha256: state.receiptReviewScopeSha256,
        codeScopeSha256: state.receiptCodeScopeSha256,
        reviewArtifactSha256,
        reusedFromReceiptPath: state.reusedFromReceiptPath,
        reusedFromReceiptSha256: state.reusedFromReceiptSha256,
        reusedFromReviewContextSha256: state.reusedFromReviewContextSha256,
        reusedFromReviewContextReuseSha256: state.reusedFromReviewContextReuseSha256,
        reusedFromReviewTreeStateSha256: state.reusedFromReviewTreeStateSha256,
        reusedFromReviewScopeSha256: state.reusedFromReviewScopeSha256,
        reusedFromCodeScopeSha256: state.reusedFromCodeScopeSha256,
        reviewerExecutionMode: state.reviewerProvenance?.reviewer_execution_mode || null,
        reviewerIdentity: state.reviewerIdentity,
        reviewerProvenance: state.reviewerProvenance as unknown as Record<string, unknown> | null,
        latestCompileTaskSequence: latestCompileSequence
    });
    return validation.valid;
}

function timelineHasDelegatedReviewInvocationForCurrentContext(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    const reviewerIdentity = state.contextReviewerIdentity;
    if (!reviewerIdentity?.startsWith('agent:') || !state.contextExists || !state.contextCurrent) {
        return false;
    }
    const reviewContextSha256 = fileSha256(state.contextPath);
    const reviewTreeStateSha256 = state.contextReviewTreeStateSha256;
    if (!reviewContextSha256 || !reviewTreeStateSha256) {
        return false;
    }
    const reviewerLaunchArtifactEvidence = getCurrentReviewerLaunchArtifactEvidenceForInvocation(
        repoRoot,
        eventsRoot,
        taskId,
        state
    );
    if (reviewerLaunchArtifactEvidence.state !== 'launched' || !reviewerLaunchArtifactEvidence.sha256) {
        return false;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return false;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null) {
        return false;
    }
    const events = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
            try {
                return [JSON.parse(line) as Record<string, unknown>];
            } catch {
                return [];
            }
        });
    let routingEventSha256: string | null = null;
    let routingSequence: number | null = null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim() !== 'REVIEWER_DELEGATION_ROUTED') {
            continue;
        }
        const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
        const taskSequence = typeof integrity?.task_sequence === 'number'
            ? integrity.task_sequence
            : Number(integrity?.task_sequence);
        if (!Number.isInteger(taskSequence) || taskSequence <= latestCompileSequence) {
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        if (
            String(details.review_type || '').trim() !== state.reviewType
            || String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent'
            || String(details.reviewer_session_id || '').trim() !== reviewerIdentity
        ) {
            continue;
        }
        routingEventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
        routingSequence = taskSequence;
        break;
    }
    if (!routingEventSha256 || !routingSequence) {
        return false;
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim() !== 'REVIEWER_INVOCATION_ATTESTED') {
            continue;
        }
        const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
        const taskSequence = typeof integrity?.task_sequence === 'number'
            ? integrity.task_sequence
            : Number(integrity?.task_sequence);
        if (!Number.isInteger(taskSequence) || taskSequence <= routingSequence) {
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const eventReviewerIdentity = String(details.reviewer_identity || details.reviewer_session_id || '').trim();
        if (
            String(details.task_id || '').trim() !== taskId
            || String(details.review_type || '').trim() !== state.reviewType
            || String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent'
            || eventReviewerIdentity !== reviewerIdentity
            || String(details.review_context_sha256 || '').trim().toLowerCase() !== reviewContextSha256
            || String(details.review_tree_state_sha256 || '').trim().toLowerCase() !== reviewTreeStateSha256
            || String(details.routing_event_sha256 || '').trim().toLowerCase() !== routingEventSha256
            || String(details.reviewer_launch_artifact_sha256 || '').trim().toLowerCase() !== reviewerLaunchArtifactEvidence.sha256
        ) {
            continue;
        }
        return true;
    }
    return false;
}

function timelineHasDelegatedReviewRoutingAfterCompile(
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string
): boolean {
    if (!reviewerIdentity.startsWith('agent:')) {
        return false;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return false;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null) {
        return false;
    }
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEWER_DELEGATION_ROUTED') {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const taskSequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            if (!Number.isInteger(taskSequence) || taskSequence <= latestCompileSequence) {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            if (
                String(details.review_type || '').trim() === reviewType
                && String(details.reviewer_execution_mode || '').trim() === 'delegated_subagent'
                && String(details.reviewer_session_id || '').trim() === reviewerIdentity
            ) {
                return true;
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return false;
}

function getDelegatedReviewRoutingShaAfterCompile(
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string
): string | null {
    if (!reviewerIdentity.startsWith('agent:')) {
        return null;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return null;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null) {
        return null;
    }
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(lines[index]) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEWER_DELEGATION_ROUTED') {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const taskSequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            if (!Number.isInteger(taskSequence) || taskSequence <= latestCompileSequence) {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            if (
                String(details.review_type || '').trim() === reviewType
                && String(details.reviewer_execution_mode || '').trim() === 'delegated_subagent'
                && String(details.reviewer_session_id || '').trim() === reviewerIdentity
            ) {
                const eventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
                return /^[0-9a-f]{64}$/.test(eventSha256) ? eventSha256 : null;
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return null;
}

function getArtifactStringField(artifact: Record<string, unknown>, ...fieldNames: string[]): string {
    for (const fieldName of fieldNames) {
        const rawValue = artifact[fieldName];
        if (typeof rawValue === 'string' && rawValue.trim()) {
            return rawValue.trim();
        }
    }
    return '';
}

function hasCompletedReviewerLaunchEvidence(launchArtifact: Record<string, unknown>): boolean {
    const providerInvocationId = getArtifactStringField(
        launchArtifact,
        'provider_invocation_id',
        'providerInvocationId',
        'controller_invocation_id',
        'controllerInvocationId'
    );
    const freshContext = launchArtifact.fresh_context === true
        || launchArtifact.freshContext === true
        || launchArtifact.isolated_context === true
        || launchArtifact.isolatedContext === true
        || launchArtifact.fork_context === false
        || launchArtifact.forkContext === false;
    return Boolean(
        getArtifactStringField(launchArtifact, 'launch_tool', 'launchTool')
        && providerInvocationId
        && getArtifactStringField(launchArtifact, 'launched_at_utc', 'launchedAtUtc')
        && freshContext
    );
}

type CurrentReviewerLaunchArtifactState = 'missing_or_invalid' | 'prepared' | 'launched';

interface CurrentReviewerLaunchArtifactEvidence {
    state: CurrentReviewerLaunchArtifactState;
    path: string | null;
    sha256: string | null;
}

function resolveReviewerLaunchArtifactPathFromTelemetry(repoRoot: string, rawPath: unknown): string | null {
    const pathValue = String(rawPath || '').trim();
    if (!pathValue) {
        return null;
    }
    try {
        const resolvedPath = resolvePathInsideRepo(pathValue, repoRoot, { allowMissing: true });
        if (!resolvedPath) {
            return null;
        }
        const reviewScratchRoot = normalizePath(path.resolve(resolveReviewScratchRoot(repoRoot))).toLowerCase();
        const normalizedPath = normalizePath(path.resolve(resolvedPath)).toLowerCase();
        return normalizedPath === reviewScratchRoot || normalizedPath.startsWith(`${reviewScratchRoot}/`)
            ? resolvedPath
            : null;
    } catch {
        return null;
    }
}

function getCurrentReviewerLaunchArtifactEvidenceForInvocation(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): CurrentReviewerLaunchArtifactEvidence {
    const missing: CurrentReviewerLaunchArtifactEvidence = {
        state: 'missing_or_invalid',
        path: null,
        sha256: null
    };
    const reviewerIdentity = state.contextReviewerIdentity || '';
    if (!reviewerIdentity.startsWith('agent:') || !state.contextExists || !state.contextCurrent) {
        return missing;
    }
    const reviewContextSha256 = fileSha256(state.contextPath);
    const routingEventSha256 = getDelegatedReviewRoutingShaAfterCompile(
        eventsRoot,
        taskId,
        state.reviewType,
        reviewerIdentity
    );
    if (!reviewContextSha256 || !routingEventSha256) {
        return missing;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return missing;
    }
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(lines[index]) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEWER_LAUNCH_PREPARED') {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const details = isPlainRecord(event.details) ? event.details : {};
            const preparedLaunchEventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
            const launchArtifactPath = resolveReviewerLaunchArtifactPathFromTelemetry(
                repoRoot,
                details.reviewer_launch_artifact_path
            ) || resolveDefaultReviewScratchPath(repoRoot, taskId, state.reviewType, 'reviewer-launch.json');
            const launchArtifact = safeReadJson(launchArtifactPath);
            if (!launchArtifact) {
                continue;
            }
            const launchBindingSha256 = getArtifactStringField(
                launchArtifact,
                'launch_binding_sha256',
                'launchBindingSha256'
            ).toLowerCase();
            if (
                !/^[0-9a-f]{64}$/.test(preparedLaunchEventSha256)
                || !/^[0-9a-f]{64}$/.test(launchBindingSha256)
                || getArtifactStringField(launchArtifact, 'prepared_launch_event_sha256', 'preparedLaunchEventSha256').toLowerCase() !== preparedLaunchEventSha256
                || getArtifactStringField(launchArtifact, 'task_id', 'taskId') !== taskId
                || getArtifactStringField(launchArtifact, 'review_type', 'reviewType') !== state.reviewType
                || getArtifactStringField(launchArtifact, 'reviewer_execution_mode', 'reviewerExecutionMode') !== 'delegated_subagent'
                || getArtifactStringField(
                    launchArtifact,
                    'reviewer_identity',
                    'reviewerIdentity',
                    'reviewer_session_id',
                    'reviewerSessionId'
                ) !== reviewerIdentity
                || getArtifactStringField(launchArtifact, 'review_context_sha256', 'reviewContextSha256').toLowerCase() !== reviewContextSha256
                || getArtifactStringField(launchArtifact, 'routing_event_sha256', 'routingEventSha256').toLowerCase() !== routingEventSha256
                || String(details.review_type || '').trim() !== state.reviewType
                || String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent'
                || String(details.reviewer_session_id || details.reviewer_identity || '').trim() !== reviewerIdentity
                || String(details.review_context_sha256 || '').trim().toLowerCase() !== reviewContextSha256
                || String(details.routing_event_sha256 || '').trim().toLowerCase() !== routingEventSha256
                || String(details.launch_binding_sha256 || '').trim().toLowerCase() !== launchBindingSha256
            ) {
                continue;
            }
            const evidenceType = getArtifactStringField(launchArtifact, 'evidence_type', 'artifact_type');
            const attestationState = getArtifactStringField(launchArtifact, 'attestation_state', 'attestationState');
            let artifactState: CurrentReviewerLaunchArtifactState = 'missing_or_invalid';
            if (evidenceType === PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE && attestationState === 'prepared') {
                artifactState = 'prepared';
            } else if (
                evidenceType === COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE
                && attestationState === 'launched'
                && hasCompletedReviewerLaunchEvidence(launchArtifact)
            ) {
                artifactState = 'launched';
            }
            if (artifactState === 'missing_or_invalid') {
                continue;
            }
            const launchArtifactSha256 = fileSha256(launchArtifactPath);
            return {
                state: artifactState,
                path: launchArtifactPath,
                sha256: launchArtifactSha256 || null
            };
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return missing;
}

function getCurrentReviewerLaunchArtifactStateForInvocation(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): CurrentReviewerLaunchArtifactState {
    return getCurrentReviewerLaunchArtifactEvidenceForInvocation(repoRoot, eventsRoot, taskId, state).state;
}

function buildReviewerReadinessChainSummary(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    state: ReviewArtifactState | undefined
): string {
    const contextStatus = !state || !state.contextExists
        ? 'missing'
        : state.contextCurrent
            ? 'current'
            : 'stale';
    const reviewerIdentity = state?.contextReviewerIdentity || '';
    const routingCurrent = Boolean(
        state
        && contextStatus === 'current'
        && reviewerIdentity.startsWith('agent:')
        && timelineHasDelegatedReviewRoutingAfterCompile(eventsRoot, taskId, reviewType, reviewerIdentity)
    );
    const routingStatus = routingCurrent
        ? 'current'
        : contextStatus !== 'current'
            ? 'blocked until current context'
            : reviewerIdentity
                ? 'missing current-cycle telemetry'
                : 'missing reviewer identity';
    const launchArtifactState = routingCurrent && state
        ? getCurrentReviewerLaunchArtifactStateForInvocation(repoRoot, eventsRoot, taskId, state)
        : 'missing_or_invalid';
    const launchStatus = !routingCurrent
        ? 'blocked until routing'
        : launchArtifactState === 'prepared'
            ? 'prepared'
            : launchArtifactState === 'launched'
                ? 'launched'
                : 'missing or stale';
    const invocationCurrent = Boolean(
        state
        && timelineHasDelegatedReviewInvocationForCurrentContext(repoRoot, eventsRoot, taskId, state)
    );
    const invocationStatus = invocationCurrent
        ? 'attested'
        : launchArtifactState === 'launched'
            ? 'missing current-cycle attestation'
            : launchArtifactState === 'prepared'
                ? 'blocked until launch completion'
                : 'blocked until launch artifact';
    let resultStatus = 'blocked until invocation';
    if (invocationCurrent && state) {
        if (!state.artifactExists && !state.receiptExists) {
            resultStatus = 'review output and receipt missing';
        } else if (!state.artifactExists) {
            resultStatus = 'review output missing';
        } else if (!state.receiptExists) {
            resultStatus = 'receipt missing';
        } else if (!state.ready) {
            resultStatus = 'receipt invalid or stale';
        } else if (!reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, state)) {
            resultStatus = 'receipt missing current-cycle provenance';
        } else {
            resultStatus = 'ready';
        }
    }
    return `Reviewer readiness chain: ${[
        'preflight scope=current',
        `review context=${contextStatus}`,
        `routing=${routingStatus}`,
        `launch artifact=${launchStatus}`,
        `invocation=${invocationStatus}`,
        `review output/receipt=${resultStatus}.`
    ].join(' -> ')}`;
}

function buildReviewGateChainStatusSummary(options: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    reviewType: string;
    edgeId: string;
    status?: 'pass' | 'block';
    reason: string;
    preflightPath: string;
    reviewContextPath?: string;
    depth?: number | string;
}): string {
    const timelinePath = path.join(options.eventsRoot, `${options.taskId}.jsonl`);
    const decision = buildGateChainLaunchDecision({
        edgeId: options.edgeId,
        status: options.status || 'pass',
        reason: options.reason,
        context: {
            taskId: options.taskId,
            reviewType: options.reviewType,
            preflightPath: options.preflightPath,
            reviewContextPath: options.reviewContextPath,
            depth: options.depth,
            repoRoot: '.'
        },
        evidencePaths: [
            toRepoDisplayPath(options.repoRoot, timelinePath)
        ]
    });
    return (
        `${formatGateChainLaunchDecision(decision)} ` +
        'LaneScope=review_type; independent review lanes remain eligible when their own prerequisites are current.'
    );
}

function timelineHasReviewContextPreparedAfterCompile(
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    contextPath: string
): boolean {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return false;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null) {
        return false;
    }
    const expectedContextPath = normalizePath(contextPath).toLowerCase();
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEW_PHASE_STARTED') {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const taskSequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            if (!Number.isInteger(taskSequence) || taskSequence <= latestCompileSequence) {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            const eventReviewType = String(details.review_type || details.reviewType || '').trim();
            const outputPath = normalizePath(details.output_path || details.outputPath || '').toLowerCase();
            if (eventReviewType === reviewType && outputPath === expectedContextPath) {
                return true;
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return false;
}

function readReviewTrust(
    reviewsRoot: string,
    taskId: string,
    requiredReviewTypes: string[],
    scopeCategory: string | null
): ReviewTrustSummary | null {
    const entries = requiredReviewTypes.flatMap((reviewType) => {
        const receipt = safeReadJson(path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`));
        if (!receipt) {
            return [];
        }
        return [{
            review_type: reviewType,
            trust_level: typeof receipt.trust_level === 'string' ? receipt.trust_level : null,
            reviewer_execution_mode: typeof receipt.reviewer_execution_mode === 'string'
                ? receipt.reviewer_execution_mode
                : null,
            reviewer_identity: typeof receipt.reviewer_identity === 'string'
                ? receipt.reviewer_identity
                : null,
            reviewer_fallback_reason: typeof receipt.reviewer_fallback_reason === 'string'
                ? receipt.reviewer_fallback_reason
                : null,
            reviewer_provenance: receipt.reviewer_provenance ?? null,
            reused_existing_review: receipt.reused_existing_review === true
        }];
    });
    return buildReviewTrustSummary(entries, scopeCategory, requiredReviewTypes.length);
}

function getReviewLaunchPlan(
    repoRoot: string,
    requiredReviewTypes: string[],
    policyMode: EffectiveReviewExecutionPolicyMode,
    requiredReviews: Record<string, boolean>,
    reviewStates: ReviewArtifactState[],
    eventsRoot: string,
    taskId: string
): ReviewLaunchPlan {
    const passedReviews = new Set(
        reviewStates
            .filter((state) => reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, state))
            .map((state) => state.reviewType)
    );
    const launchPlan = computeReviewLaunchPlan({
        requiredReviewTypes,
        requiredReviews,
        policyMode,
        reviewStates: reviewStates.map((state) => ({
            review_type: state.reviewType,
            satisfied: passedReviews.has(state.reviewType),
            failed_current: state.failed
                && reviewStateHasCurrentRecordedEvidence(repoRoot, eventsRoot, taskId, state)
        }))
    });
    return launchPlan;
}

function applyFullSuiteReadinessToReviewLaunchPlan(
    launchPlan: ReviewLaunchPlan,
    fullSuiteEnabled: boolean,
    fullSuitePlacement: FullSuiteValidationPlacement,
    fullSuiteNotRequiredForDocsOnly: boolean,
    fullSuiteGateStatus: GateOutcome['status'] | null
): ReviewLaunchPlan {
    if (
        !fullSuiteEnabled
        || fullSuitePlacement !== 'before_test_review'
        || fullSuiteNotRequiredForDocsOnly
        || fullSuiteGateStatus === 'PASS'
        || launchPlan.failed_review_type
        || !launchPlan.launchable_review_types.includes('test')
    ) {
        return launchPlan;
    }

    const launchableReviewTypes = launchPlan.launchable_review_types.filter((reviewType) => reviewType !== 'test');
    const blockedReviewLanes = [
        ...launchPlan.blocked_review_lanes.filter((lane) => lane.review_type !== 'test'),
        { review_type: 'test', blocked_by: ['full-suite-validation'] }
    ];
    const [nextLaunchableReviewType] = launchableReviewTypes;

    return {
        ...launchPlan,
        launchable_review_types: launchableReviewTypes,
        blocked_review_lanes: blockedReviewLanes,
        next_review_type: nextLaunchableReviewType || 'test',
        blocked_review_dependencies: nextLaunchableReviewType
            ? []
            : ['full-suite-validation']
    };
}

function shouldRunFullSuiteAfterCompileBeforeReviews(
    enabled: boolean,
    placement: FullSuiteValidationPlacement,
    fullSuiteNotRequiredForCurrentScope: boolean
): boolean {
    return enabled
        && placement === 'after_compile_before_reviews'
        && !fullSuiteNotRequiredForCurrentScope;
}

function shouldRunFullSuiteBeforeTestReview(
    enabled: boolean,
    placement: FullSuiteValidationPlacement,
    fullSuiteNotRequiredForCurrentScope: boolean
): boolean {
    return enabled
        && placement === 'before_test_review'
        && !fullSuiteNotRequiredForCurrentScope;
}

function toNextStepBlockedReviewLanes(launchPlan: ReviewLaunchPlan): NextStepBlockedReviewLane[] {
    return launchPlan.blocked_review_lanes.map((lane) => ({
        review_type: lane.review_type,
        blocked_by: lane.blocked_by,
        reason: lane.blocked_by.includes('full-suite-validation')
            ? 'Waiting for current full-suite validation evidence before launching test review.'
            : lane.blocked_by.length > 0
            ? `Waiting for current-cycle ${lane.blocked_by.join(', ')} review artifacts and receipts to pass.`
            : 'Waiting for review launch dependencies to clear.'
    }));
}

function reviewStateHasSatisfiedEvidence(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    if (!state.ready) {
        return false;
    }
    if (getHiddenReviewTimingTrustRemediation(eventsRoot, taskId, state)) {
        return false;
    }
    if (state.reusedExistingReview) {
        return timelineHasReviewReuseRecordedAfterCompile(eventsRoot, taskId, state);
    }
    return timelineHasDelegatedReviewInvocationAttestation(repoRoot, eventsRoot, taskId, state);
}

function getHiddenReviewTimingTrustRemediation(
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): string | null {
    const timelineEvents = readTaskTimelineEventLikes(eventsRoot, taskId);
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    const timingTrust = evaluateHiddenReviewTimingTrust({
        reviewType: state.reviewType,
        reusedExistingReview: state.reusedExistingReview,
        reviewerProvenance: state.reviewerProvenance,
        reviewResultRecordedAtUtc: state.reviewResultRecordedAtUtc,
        recordedAtUtc: state.recordedAtUtc,
        reviewOutputSourceMtimeUtc: state.reviewOutputSourceMtimeUtc,
        timelineEvents,
        latestCompileSequence
    });
    return timingTrust.trusted ? null : timingTrust.message;
}

function isReviewFailTokenViolation(state: ReviewArtifactState, violation: string): boolean {
    return Boolean(
        state.failed
        && state.failToken
        && violation.includes(`review artifact contains fail token '${state.failToken}'`)
    );
}

function reviewStateHasCurrentRecordedEvidence(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    if (!state.contextExists || !state.artifactExists || !state.receiptExists) {
        return false;
    }
    const nonVerdictViolations = state.violations.filter(
        (violation) => !isReviewFailTokenViolation(state, violation)
    );
    if (nonVerdictViolations.length > 0) {
        return false;
    }
    if (getHiddenReviewTimingTrustRemediation(eventsRoot, taskId, state)) {
        return false;
    }
    if (state.reusedExistingReview) {
        return timelineHasReviewReuseRecordedAfterCompile(eventsRoot, taskId, state);
    }
    return timelineHasDelegatedReviewInvocationAttestation(repoRoot, eventsRoot, taskId, state);
}

function getDownstreamReviewTypesFor(
    failedReviewType: string,
    requiredReviewTypes: string[],
    requiredReviews: Record<string, boolean>,
    policyMode: EffectiveReviewExecutionPolicyMode
): string[] {
    return requiredReviewTypes.filter((reviewType) => (
        reviewType !== failedReviewType
        && getReviewExecutionDependencies(reviewType, requiredReviews, policyMode).includes(failedReviewType)
    ));
}

function describeBlockedReviewDependencies(
    dependencies: readonly string[],
    reviewStates: readonly ReviewArtifactState[]
): string {
    const stateByType = new Map(reviewStates.map((state) => [state.reviewType, state]));
    return dependencies
        .map((dependency) => {
            const dependencyState = stateByType.get(dependency);
            if (dependencyState?.failed) {
                return `${dependency} failed with '${dependencyState.verdictToken || dependencyState.failToken || 'FAILED'}'`;
            }
            if (dependencyState?.artifactExists && !dependencyState.ready) {
                return `${dependency} is not PASS-ready (${dependencyState.violations.join('; ')})`;
            }
            return `${dependency} has no current PASS artifact and receipt`;
        })
        .join('; ');
}

function readCompileReadiness(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    preflightPath: string
): CompileReadiness {
    const compilePath = path.join(reviewsRoot, `${taskId}-compile-gate.json`);
    if (!fileExists(compilePath)) {
        return {
            ready: false,
            reason: `Compile gate evidence missing: ${normalizePath(compilePath)}.`
        };
    }
    const evidence = safeReadJson(compilePath);
    if (!evidence) {
        return {
            ready: false,
            reason: 'Compile gate evidence is invalid JSON; rerun compile-gate.'
        };
    }
    const expectedPreflightHash = fileSha256(preflightPath);
    const evidenceStatus = String(evidence.status || '').trim().toUpperCase();
    const evidenceOutcome = String(evidence.outcome || '').trim().toUpperCase();
    if (evidence.task_id !== taskId) {
        return {
            ready: false,
            reason: `Compile gate evidence belongs to task '${String(evidence.task_id || '')}'.`
        };
    }
    if (String(evidence.event_source || '').trim() !== 'compile-gate') {
        return {
            ready: false,
            reason: 'Compile gate evidence source is invalid; rerun compile-gate.'
        };
    }
    if (evidenceStatus !== 'PASSED' || evidenceOutcome !== 'PASS') {
        return {
            ready: false,
            reason: `Compile gate did not pass. Evidence status='${evidenceStatus || 'UNKNOWN'}', outcome='${evidenceOutcome || 'UNKNOWN'}'.`
        };
    }
    const evidencePreflightHash = String(evidence.preflight_hash_sha256 || '').trim().toLowerCase();
    if (!expectedPreflightHash || evidencePreflightHash !== expectedPreflightHash) {
        return {
            ready: false,
            reason: 'Compile gate evidence preflight hash does not match the current preflight; rerun compile-gate.'
        };
    }
    const detectionSource = String(evidence.scope_detection_source || '').trim();
    const changedFiles = Array.isArray(evidence.scope_changed_files)
        ? evidence.scope_changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const scopeSha256 = String(evidence.scope_sha256 || '').trim();
    const scopeContentSha256 = String(evidence.scope_content_sha256 || '').trim().toLowerCase();
    const changedFilesSha256 = String(evidence.scope_changed_files_sha256 || '').trim();
    const changedLinesTotal = Number.parseInt(String(evidence.scope_changed_lines_total || 0), 10) || 0;
    if (!detectionSource || !scopeSha256 || !changedFilesSha256) {
        return {
            ready: false,
            reason: 'Compile gate evidence is missing scope snapshot fields; rerun compile-gate.'
        };
    }
    const currentScope = getWorkspaceSnapshotCached(
        repoRoot,
        detectionSource,
        evidence.scope_include_untracked == null ? true : !!evidence.scope_include_untracked,
        changedFiles,
        { noCache: true, readOnly: true }
    );
    if (
        currentScope.scope_sha256 !== scopeSha256
        || currentScope.changed_files_sha256 !== changedFilesSha256
        || currentScope.changed_lines_total !== changedLinesTotal
    ) {
        const includeUntracked = evidence.scope_include_untracked == null ? true : !!evidence.scope_include_untracked;
        const currentGitSnapshot = readCurrentGitWorkspaceSnapshot(repoRoot, includeUntracked);
        const docsOnlyDeltaReadiness = currentGitSnapshot
            ? buildDocsOnlyDeltaReadiness(
                repoRoot,
                currentGitSnapshot.changed_files,
                changedFiles,
                changedLinesTotal,
                includeUntracked,
                detectionSource,
                changedFilesSha256,
                scopeContentSha256,
                getDocImpactDeclaredDocsUpdated(path.join(reviewsRoot, `${taskId}-doc-impact.json`))
            )
            : null;
        if (docsOnlyDeltaReadiness) {
            return {
                ready: true,
                reason: `Compile gate evidence is current after accepting ordinary docs-only updates for doc-impact. ${docsOnlyDeltaReadiness.reason}`
            };
        }
        return {
            ready: false,
            reason: 'Workspace changed after compile gate; rerun compile-gate before review preparation.'
        };
    }
    return {
        ready: true,
        reason: 'Compile gate evidence is current.'
    };
}

function stringSha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function describePathList(paths: readonly string[], limit = 8): string {
    const normalized = [...new Set(paths.map((entry) => normalizePath(entry)).filter(Boolean))].sort();
    if (normalized.length === 0) {
        return '[]';
    }
    const visible = normalized.slice(0, limit);
    const suffix = normalized.length > visible.length ? `, ... +${normalized.length - visible.length} more` : '';
    return `[${visible.join(', ')}${suffix}]`;
}

function readCurrentGitWorkspaceSnapshot(
    repoRoot: string,
    includeUntracked: boolean
): (WorkspaceSnapshot & { cache_hit: boolean }) | null {
    try {
        return getWorkspaceSnapshotCached(repoRoot, 'git_auto', includeUntracked, [], {
            noCache: true,
            readOnly: true
        });
    } catch {
        return null;
    }
}

function getUnchangedProtectedDirtyWorkspaceFiles(
    repoRoot: string,
    preflight: Record<string, unknown>
): Set<string> {
    const triggers = getPreflightTriggers(preflight);
    const protectedFiles = Array.isArray(triggers.dirty_workspace_protected_files)
        ? [...new Set(triggers.dirty_workspace_protected_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
    const protectedHashes = isPlainRecord(triggers.dirty_workspace_protected_file_hashes)
        ? triggers.dirty_workspace_protected_file_hashes
        : {};
    const unchanged = new Set<string>();
    for (const protectedFile of protectedFiles) {
        const expectedHash = String(protectedHashes[protectedFile] || '').trim().toLowerCase();
        if (!expectedHash) {
            continue;
        }
        const currentHash = fileSha256(path.join(repoRoot, protectedFile));
        if (currentHash && currentHash === expectedHash) {
            unchanged.add(protectedFile);
        }
    }
    return unchanged;
}

function getDocImpactDeclaredDocsUpdated(docImpactPath: string | null | undefined): string[] {
    if (!docImpactPath) {
        return [];
    }
    const docImpact = safeReadJson(docImpactPath);
    if (!docImpact || String(docImpact.decision || '').trim().toUpperCase() !== 'DOCS_UPDATED') {
        return [];
    }
    return Array.isArray(docImpact.docs_updated)
        ? [...new Set(docImpact.docs_updated.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
}

function hasPassedDocImpactArtifact(docImpactPath: string | null | undefined): boolean {
    if (!docImpactPath) {
        return false;
    }
    const docImpact = safeReadJson(docImpactPath);
    if (!docImpact) {
        return false;
    }
    return String(docImpact.status || '').trim().toUpperCase() === 'PASSED'
        && String(docImpact.outcome || '').trim().toUpperCase() === 'PASS';
}

function docImpactTimelineDetailsMatchArtifact(
    details: Record<string, unknown> | null,
    docImpact: Record<string, unknown>,
    taskId: string,
    preflightPath: string,
    preflightSha256: string
): boolean {
    if (!details) {
        return false;
    }
    const expectedDocsUpdated = Array.isArray(docImpact.docs_updated)
        ? docImpact.docs_updated.map((entry) => normalizePath(entry)).filter(Boolean).sort()
        : [];
    const actualDocsUpdated = Array.isArray(details.docs_updated)
        ? details.docs_updated.map((entry) => normalizePath(entry)).filter(Boolean).sort()
        : [];
    return String(details.task_id || '').trim() === taskId
        && normalizePath(String(details.preflight_path || '').trim()) === normalizePath(preflightPath)
        && String(details.preflight_hash_sha256 || '').trim().toLowerCase() === preflightSha256
        && String(details.decision || '').trim().toUpperCase() === String(docImpact.decision || '').trim().toUpperCase()
        && String(details.status || '').trim().toUpperCase() === String(docImpact.status || '').trim().toUpperCase()
        && String(details.outcome || '').trim().toUpperCase() === String(docImpact.outcome || '').trim().toUpperCase()
        && details.behavior_changed === docImpact.behavior_changed
        && details.changelog_updated === docImpact.changelog_updated
        && stringSha256(actualDocsUpdated.join('\n')) === stringSha256(expectedDocsUpdated.join('\n'));
}

function getPassedOrdinaryDocsOnlyDocImpactUpdatedFiles(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    preflightPath: string,
    preflightSha256: string | null,
    docImpactPath: string | null | undefined
): string[] {
    if (!docImpactPath) {
        return [];
    }
    const docImpact = safeReadJson(docImpactPath);
    if (!docImpact) {
        return [];
    }
    if (String(docImpact.task_id || '').trim() !== taskId) {
        return [];
    }
    const evidencePreflightPath = normalizePath(String(docImpact.preflight_path || '').trim());
    const expectedPreflightPath = normalizePath(preflightPath);
    if (!evidencePreflightPath || evidencePreflightPath !== expectedPreflightPath) {
        return [];
    }
    const evidencePreflightHash = String(docImpact.preflight_hash_sha256 || '').trim().toLowerCase();
    if (!preflightSha256 || !evidencePreflightHash || evidencePreflightHash !== preflightSha256) {
        return [];
    }
    const decision = String(docImpact.decision || '').trim().toUpperCase();
    const status = String(docImpact.status || '').trim().toUpperCase();
    const outcome = String(docImpact.outcome || '').trim().toUpperCase();
    if (
        decision !== 'DOCS_UPDATED'
        || status !== 'PASSED'
        || outcome !== 'PASS'
        || docImpact.behavior_changed !== false
    ) {
        return [];
    }
    const docsUpdated = Array.isArray(docImpact.docs_updated)
        ? [...new Set(docImpact.docs_updated.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
    if (docsUpdated.length === 0) {
        return [];
    }
    const classificationConfig = getClassificationConfig(repoRoot);
    if (docsUpdated.some((entry) => !isOrdinaryDocumentationDeltaPath(entry, classificationConfig))) {
        return [];
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return [];
    }
    const latestPreflight = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED'
    );
    const latestDocImpactAssessed = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'DOC_IMPACT_ASSESSED'
    );
    const latestCompletionFailure = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'COMPLETION_GATE_FAILED'
    );
    if (
        !latestPreflight
        || !latestDocImpactAssessed
        || !latestCompletionFailure
        || !docImpactTimelineDetailsMatchArtifact(
            latestDocImpactAssessed.details,
            docImpact,
            taskId,
            preflightPath,
            preflightSha256
        )
        || latestDocImpactAssessed.sequence < latestPreflight.sequence
        || latestDocImpactAssessed.sequence < latestCompletionFailure.sequence
    ) {
        return [];
    }
    return docsUpdated;
}

function buildStaleCompletionFailureDocCloseoutAllowance(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    preflightPath: string,
    preflightSha256: string | null,
    preflightWorkspaceReadiness: PreflightWorkspaceReadiness,
    docImpactPath: string
): PreflightCycleReadinessOptions {
    if (!preflightWorkspaceReadiness.ready) {
        return {};
    }
    if (hasPassedDocImpactArtifact(docImpactPath)) {
        const docImpactUpdatedFiles = getPassedOrdinaryDocsOnlyDocImpactUpdatedFiles(
            repoRoot,
            eventsRoot,
            taskId,
            preflightPath,
            preflightSha256,
            docImpactPath
        );
        if (docImpactUpdatedFiles.length > 0) {
            return {
                allowStaleCompletionFailureForDocCloseout: true,
                staleCompletionFailureDocCloseoutReason:
                    `latest doc-impact evidence records ordinary documentation updates ${describePathList(docImpactUpdatedFiles)} with behavior_changed=false`
            };
        }
        return {};
    }
    const acceptedDeltaFiles = preflightWorkspaceReadiness.acceptedDocsOnlyDeltaFiles || [];
    if (acceptedDeltaFiles.length > 0) {
        return {
            allowStaleCompletionFailureForDocCloseout: true,
            staleCompletionFailureDocCloseoutReason:
                `current workspace drift is limited to ordinary documentation updates ${describePathList(acceptedDeltaFiles)}`
        };
    }
    return {};
}

function isReviewScopeDetectionSourceSupportedForDocImpactExemption(detectionSource: string): boolean {
    const normalized = String(detectionSource || '').trim().toLowerCase();
    return normalized === 'git_auto' || normalized === 'explicit_changed_files';
}

function isOrdinaryDocumentationDeltaPath(
    filePath: string,
    classificationConfig: ResolvedClassificationConfig
): boolean {
    return isSafeOrdinaryDocumentationPath(filePath, classificationConfig);
}

function buildDocsOnlyDeltaReadiness(
    repoRoot: string,
    currentChangedFiles: string[],
    preflightChangedFiles: string[],
    expectedChangedLinesTotal: number,
    includeUntracked: boolean,
    detectionSource: string,
    expectedChangedFilesSha256: string,
    expectedScopeContentSha256: string,
    declaredDocsUpdated: string[]
): PreflightWorkspaceReadiness | null {
    if (!isReviewScopeDetectionSourceSupportedForDocImpactExemption(detectionSource)) {
        return null;
    }

    const classificationConfig = getClassificationConfig(repoRoot);

    const preflightSet = new Set(preflightChangedFiles);
    const currentFiles = [...new Set(currentChangedFiles.map((entry) => normalizePath(entry)).filter(Boolean))].sort();
    const missingPreflightFiles = preflightChangedFiles.filter((entry) => !currentFiles.includes(entry));
    const docsOnlyDeltaFiles = currentFiles.filter((entry) => !preflightSet.has(entry));
    if (missingPreflightFiles.length > 0 || docsOnlyDeltaFiles.length === 0) {
        return null;
    }

    const declaredDocsSet = declaredDocsUpdated.length > 0
        ? new Set(declaredDocsUpdated.map((entry) => normalizePath(entry)).filter(Boolean))
        : null;
    if (declaredDocsSet && docsOnlyDeltaFiles.some((entry) => !declaredDocsSet.has(entry))) {
        return null;
    }

    const nonOrdinaryDocs = docsOnlyDeltaFiles.filter((filePath) => (
        !isOrdinaryDocumentationDeltaPath(filePath, classificationConfig)
    ));
    if (nonOrdinaryDocs.length > 0) {
        return null;
    }

    const currentReviewScope = getWorkspaceSnapshotCached(
        repoRoot,
        'explicit_changed_files',
        includeUntracked,
        preflightChangedFiles,
        { noCache: true, readOnly: true }
    );
    const reviewScopeViolations: string[] = [];
    if (currentReviewScope.changed_files_sha256 !== expectedChangedFilesSha256) {
        reviewScopeViolations.push('preflight changed_files differ from the current non-doc workspace snapshot');
    }
    if (currentReviewScope.changed_lines_total !== expectedChangedLinesTotal) {
        reviewScopeViolations.push(
            `preflight changed_lines_total=${expectedChangedLinesTotal} differs from current non-doc changed_lines_total=${currentReviewScope.changed_lines_total}`
        );
    }
    if (
        expectedScopeContentSha256
        && currentReviewScope.scope_content_sha256 !== expectedScopeContentSha256
    ) {
        reviewScopeViolations.push(
            `preflight scope_content_sha256=${expectedScopeContentSha256} differs from current non-doc scope_content_sha256=${currentReviewScope.scope_content_sha256}`
        );
    }
    if (reviewScopeViolations.length > 0) {
        return null;
    }

    return {
        ready: true,
        reason:
            'Preflight implementation scope still matches the current workspace after accepting ordinary docs-only updates for doc-impact: ' +
            `${describePathList(docsOnlyDeltaFiles)}.`,
        currentChangedFiles: currentFiles,
        acceptedDocsOnlyDeltaFiles: docsOnlyDeltaFiles
    };
}

function readPreflightWorkspaceReadiness(
    repoRoot: string,
    preflight: Record<string, unknown>,
    options: PreflightWorkspaceReadinessOptions = {}
): PreflightWorkspaceReadiness {
    const metrics = isPlainRecord(preflight.metrics) ? preflight.metrics : {};
    const expectedChangedLinesTotal = typeof metrics.changed_lines_total === 'number'
        ? metrics.changed_lines_total
        : Number(metrics.changed_lines_total);
    if (!Number.isFinite(expectedChangedLinesTotal) || expectedChangedLinesTotal < 0) {
        return {
            ready: true,
            reason: 'Preflight workspace freshness cannot be checked because metrics.changed_lines_total is missing.'
        };
    }

    const detectionSource = String(preflight.detection_source || 'git_auto').trim() || 'git_auto';
    const normalizedDetectionSource = detectionSource.toLowerCase();
    const includeUntracked = normalizedDetectionSource === 'git_staged_only'
        ? false
        : (typeof preflight.include_untracked === 'boolean' ? preflight.include_untracked : true);
    const changedFiles = Array.isArray(preflight.changed_files)
        ? [...new Set(preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
    const expectedChangedFilesSha256 = stringSha256(changedFiles.join('\n'));
    const expectedScopeContentSha256 = typeof metrics.scope_content_sha256 === 'string'
        ? metrics.scope_content_sha256.trim().toLowerCase()
        : '';
    const currentScope = getWorkspaceSnapshotCached(
        repoRoot,
        detectionSource,
        includeUntracked,
        changedFiles,
        { noCache: true, readOnly: true }
    );
    const violations: string[] = [];
    if (currentScope.changed_files_sha256 !== expectedChangedFilesSha256) {
        const currentScopeFiles = Array.isArray(currentScope.changed_files)
            ? currentScope.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
            : [];
        const expectedSet = new Set(changedFiles);
        const currentSet = new Set(currentScopeFiles);
        const missingFromPreflight = currentScopeFiles.filter((entry) => !expectedSet.has(entry));
        const noLongerCurrent = changedFiles.filter((entry) => !currentSet.has(entry));
        violations.push(
            `stale preflight file set ${describePathList(changedFiles)} differs from current workspace snapshot ${describePathList(currentScopeFiles)}` +
            `; missing from preflight: ${describePathList(missingFromPreflight)}` +
            `; no longer current: ${describePathList(noLongerCurrent)}`
        );
    }
    if (currentScope.changed_lines_total !== expectedChangedLinesTotal) {
        violations.push(
            `preflight changed_lines_total=${expectedChangedLinesTotal} differs from current changed_lines_total=${currentScope.changed_lines_total}`
        );
    }
    if (expectedScopeContentSha256 && currentScope.scope_content_sha256 !== expectedScopeContentSha256) {
        violations.push(
            `preflight scope_content_sha256=${expectedScopeContentSha256} differs from current scope_content_sha256=${currentScope.scope_content_sha256}`
        );
    }
    const expectedScopeSha256 = typeof metrics.scope_sha256 === 'string'
        ? metrics.scope_sha256.trim().toLowerCase()
        : '';
    if (expectedScopeSha256 && currentScope.scope_sha256 !== expectedScopeSha256) {
        violations.push(
            `preflight scope_sha256=${expectedScopeSha256} differs from current scope_sha256=${currentScope.scope_sha256}`
        );
    }
    let currentChangedFiles: string[] | undefined;
    const allowDocsOnlyDelta = options.allowDocsOnlyDelta !== false;
    if (normalizedDetectionSource === 'explicit_changed_files') {
        const currentGitSnapshot = readCurrentGitWorkspaceSnapshot(repoRoot, includeUntracked);
        if (currentGitSnapshot) {
            const unchangedProtectedFiles = getUnchangedProtectedDirtyWorkspaceFiles(repoRoot, preflight);
            const currentGitChangedFiles = currentGitSnapshot.changed_files.filter((entry) => (
                !unchangedProtectedFiles.has(normalizePath(entry))
            ));
            currentChangedFiles = currentGitChangedFiles;
            if (allowDocsOnlyDelta) {
                const docsOnlyDeltaReadiness = buildDocsOnlyDeltaReadiness(
                    repoRoot,
                    currentGitChangedFiles,
                    changedFiles,
                    expectedChangedLinesTotal,
                    includeUntracked,
                    detectionSource,
                    expectedChangedFilesSha256,
                    expectedScopeContentSha256,
                    getDocImpactDeclaredDocsUpdated(options.docImpactPath)
                );
                if (docsOnlyDeltaReadiness) {
                    return docsOnlyDeltaReadiness;
                }
            }
            const currentFileSetHash = stringSha256(currentGitChangedFiles.join('\n'));
            if (currentFileSetHash !== expectedChangedFilesSha256) {
                const expectedSet = new Set(changedFiles);
                const currentSet = new Set(currentGitChangedFiles);
                const missingFromPreflight = currentGitChangedFiles.filter((entry) => !expectedSet.has(entry));
                const noLongerCurrent = changedFiles.filter((entry) => !currentSet.has(entry));
                const ignoredProtectedNote = unchangedProtectedFiles.size > 0
                    ? `; ignored unchanged dirty-baseline files: ${describePathList([...unchangedProtectedFiles])}`
                    : '';
                violations.push(
                    `stale preflight file set ${describePathList(changedFiles)} differs from current git snapshot ${describePathList(currentGitChangedFiles)}` +
                    `; missing from preflight: ${describePathList(missingFromPreflight)}` +
                    `; no longer current: ${describePathList(noLongerCurrent)}${ignoredProtectedNote}`
                );
            }
        }
    }

    if (allowDocsOnlyDelta) {
        const docsOnlyDeltaReadiness = buildDocsOnlyDeltaReadiness(
            repoRoot,
            currentScope.changed_files,
            changedFiles,
            expectedChangedLinesTotal,
            includeUntracked,
            detectionSource,
            expectedChangedFilesSha256,
            expectedScopeContentSha256,
            getDocImpactDeclaredDocsUpdated(options.docImpactPath)
        );
        if (docsOnlyDeltaReadiness) {
            return docsOnlyDeltaReadiness;
        }
    }

    if (violations.length === 0) {
        return {
            ready: true,
            reason: 'Preflight scope still matches the current workspace.',
            currentChangedFiles
        };
    }
    const failedReviewType = String(options.failedReviewType || '').trim();
    const failedReviewNote = failedReviewType
        ? ` Stale failed review detected: '${failedReviewType}' previously recorded '${String(options.failedReviewVerdict || 'FAILED').trim() || 'FAILED'}', but the workspace hash changed after that review.`
        : '';
    return {
        ready: false,
        reason: `Preflight scope is stale before compile (${violations.join('; ')}).${failedReviewNote} Refresh classify-change for the current scope first.`,
        currentChangedFiles
    };
}

function readPreflightCycleReadiness(
    eventsRoot: string,
    taskId: string,
    options: PreflightCycleReadinessOptions = {}
): PreflightCycleReadiness {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return {
            ready: true,
            reason: 'Timeline ordering could not be checked by next-step; downstream gates will report timeline integrity.'
        };
    }

    const latestPreflight = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED'
    );
    if (!latestPreflight) {
        return {
            ready: true,
            reason: 'No PREFLIGHT_CLASSIFIED event exists yet.'
        };
    }

    const latestTaskMode = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'TASK_MODE_ENTERED'
    );
    if (latestTaskMode && latestPreflight.sequence < latestTaskMode.sequence) {
        return {
            ready: false,
            reason: `Preflight evidence is older than the latest TASK_MODE_ENTERED event (preflight seq ${latestPreflight.sequence}, task-mode seq ${latestTaskMode.sequence}). Refresh classify-change for the current task-mode cycle.`
        };
    }

    const latestShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
    );
    if (latestShellSmoke && latestPreflight.sequence < latestShellSmoke.sequence) {
        return {
            ready: false,
            reason: `Preflight evidence is older than the latest SHELL_SMOKE_PREFLIGHT_RECORDED event (preflight seq ${latestPreflight.sequence}, shell-smoke seq ${latestShellSmoke.sequence}). Refresh classify-change before compile/review/completion.`
        };
    }

    const latestCompletionFailure = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'COMPLETION_GATE_FAILED'
    );
    if (latestCompletionFailure && latestPreflight.sequence < latestCompletionFailure.sequence) {
        if (options.allowStaleCompletionFailureForDocCloseout) {
            return {
                ready: true,
                reason:
                    `Preflight evidence predates latest COMPLETION_GATE_FAILED (preflight seq ${latestPreflight.sequence}, completion failure seq ${latestCompletionFailure.sequence}), ` +
                    `but the closeout lane remains current because ${options.staleCompletionFailureDocCloseoutReason || 'only ordinary documentation closeout evidence changed'}.`
            };
        }
        return {
            ready: false,
            reason: `Preflight evidence is older than the latest COMPLETION_GATE_FAILED event (preflight seq ${latestPreflight.sequence}, completion failure seq ${latestCompletionFailure.sequence}). Refresh classify-change for the resumed cycle.`
        };
    }

    return {
        ready: true,
        reason: 'Preflight evidence is current for the latest startup cycle.'
    };
}

function readPostPreflightRulePackReadiness(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    rulePackPath: string,
    taskModePath: string
): RulePackReadiness {
    const rebind = getPostPreflightRulePackRebindDecision(repoRoot, taskId, preflightPath, {
        artifactPath: rulePackPath,
        taskModePath
    });
    const evidence = getRulePackEvidence(repoRoot, taskId, 'POST_PREFLIGHT', {
        preflightPath,
        artifactPath: rulePackPath,
        taskModePath
    });
    const sequenceEvidence = getPostPreflightSequenceEvidence(repoRoot, taskId, preflightPath, {
        artifactPath: rulePackPath,
        taskModePath
    });
    const violations = [
        ...getRulePackEvidenceViolations(evidence),
        ...sequenceEvidence.violations
    ];
    if (violations.length === 0 && evidence.binding_equivalent_to_current_preflight && sequenceEvidence.binding_equivalent_to_current_preflight) {
        return {
            ready: true,
            reason: 'POST_PREFLIGHT rule-pack evidence is current for the latest preflight.',
            rebind: null
        };
    }
    if (violations.length === 0) {
        violations.push('POST_PREFLIGHT rule-pack evidence is not bound to the latest preflight.');
    }
    return {
        ready: false,
        reason: violations.join(' '),
        rebind
    };
}

function readStartupCycleReadiness(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    taskModePath: string
): StartupCycleReadiness {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return {
            ready: true,
            nextGate: null,
            title: 'Startup cycle ordering was not checked.',
            reason: 'Timeline ordering could not be checked by next-step; downstream gates will report timeline integrity.'
        };
    }

    const latestTaskMode = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'TASK_MODE_ENTERED'
    );
    if (!latestTaskMode) {
        return {
            ready: true,
            nextGate: null,
            title: 'No task-mode cycle exists yet.',
            reason: 'No TASK_MODE_ENTERED event exists yet.'
        };
    }

    const isStartupRulePackEvent = (entry: TimelineEventEntry): boolean => {
        if (entry.event_type !== 'RULE_PACK_LOADED') {
            return false;
        }
        const stage = String(entry.details?.stage || '').trim().toUpperCase();
        return stage !== 'POST_PREFLIGHT';
    };
    const latestRulePack = findLatestTimelineEvent(
        events,
        (entry) => isStartupRulePackEvent(entry) && entry.sequence > latestTaskMode.sequence
    );
    if (!latestRulePack) {
        return {
            ready: false,
            nextGate: 'load-rule-pack',
            title: 'Record TASK_ENTRY rule files for the current task-mode cycle.',
            reason: `The latest TASK_MODE_ENTERED event is seq ${latestTaskMode.sequence}, but no RULE_PACK_LOADED event exists after it. Load TASK_ENTRY rules before handshake, preflight, compile, review, or completion.`
        };
    }

    const rulePackArtifactPath = getTimelineEventDetailString(latestRulePack, 'artifact_path')
        || getTimelineEventDetailString(latestRulePack, 'artifactPath');
    const rulePackEvidence = getRulePackEvidence(repoRoot, taskId, 'TASK_ENTRY', {
        artifactPath: rulePackArtifactPath,
        taskModePath
    });
    const rulePackViolations = getRulePackEvidenceViolations(rulePackEvidence);
    if (rulePackViolations.length > 0) {
        return {
            ready: false,
            nextGate: 'load-rule-pack',
            title: 'Refresh TASK_ENTRY rule files for the current task-mode cycle.',
            reason:
                `The latest TASK_ENTRY rule-pack evidence after TASK_MODE_ENTERED seq ${latestTaskMode.sequence} is stale or invalid: ` +
                `${rulePackViolations.join(' ')} Load TASK_ENTRY rules again before handshake, preflight, compile, review, or completion.`
        };
    }

    const latestHandshake = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED' && entry.sequence > latestRulePack.sequence
    );
    if (!latestHandshake) {
        return {
            ready: false,
            nextGate: 'handshake-diagnostics',
            title: 'Run handshake diagnostics for the current task-mode cycle.',
            reason: `The latest TASK_MODE_ENTERED event is seq ${latestTaskMode.sequence}, and the latest startup rule-pack event is seq ${latestRulePack.sequence}, but no HANDSHAKE_DIAGNOSTICS_RECORDED event exists after them.`
        };
    }

    const latestShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED' && entry.sequence > latestHandshake.sequence
    );
    if (!latestShellSmoke) {
        return {
            ready: false,
            nextGate: 'shell-smoke-preflight',
            title: 'Run shell smoke preflight for the current task-mode cycle.',
            reason: `The latest HANDSHAKE_DIAGNOSTICS_RECORDED event is seq ${latestHandshake.sequence}, but no SHELL_SMOKE_PREFLIGHT_RECORDED event exists after it.`
        };
    }

    return {
        ready: true,
        nextGate: null,
        title: 'Startup cycle is current.',
        reason: 'TASK_ENTRY rule-pack, handshake, and shell-smoke evidence are current for the latest task-mode cycle.'
    };
}

function findLatestTimelineEvent(
    events: TimelineEventEntry[],
    predicate: (entry: TimelineEventEntry) => boolean
): TimelineEventEntry | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (predicate(entry)) {
            return entry;
        }
    }
    return null;
}

function getTimelineEventDetailString(
    event: TimelineEventEntry | null,
    fieldName: string
): string {
    const value = event?.details?.[fieldName];
    return typeof value === 'string' ? value.trim() : '';
}

function hasProtectedOrchestratorWorkRecoverySignal(message: string): boolean {
    const normalized = String(message || '').toLowerCase();
    return normalized.includes('protected')
        && normalized.includes('control-plane')
        && normalized.includes('enter-task-mode')
        && normalized.includes('--orchestrator-work');
}

function readFailedGateRecovery(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    cliPrefix: string,
    taskMode: Record<string, unknown> | null
): FailedGateRecovery | null {
    if (!taskMode) {
        return null;
    }

    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return null;
    }

    const latestPreflightFailure = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_FAILED'
    );
    if (!latestPreflightFailure) {
        return null;
    }

    const latestPreflightSuccess = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED'
    );
    if (latestPreflightSuccess && latestPreflightSuccess.sequence > latestPreflightFailure.sequence) {
        return null;
    }

    const latestTaskMode = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'TASK_MODE_ENTERED'
    );
    if (latestTaskMode && latestTaskMode.sequence > latestPreflightFailure.sequence) {
        return null;
    }

    const errorText = getTimelineEventDetailString(latestPreflightFailure, 'error');
    if (!hasProtectedOrchestratorWorkRecoverySignal(errorText)) {
        return null;
    }
    if (isGardaSelfGuardDenyAgentEntry(repoRoot)) {
        return {
            nextGate: 'operator-maintenance',
            title: 'Garda self-guard blocks agent-owned protected control-plane recovery.',
            reason:
                `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) contains a protected control-plane recovery signal. ` +
                formatGardaSelfGuardProtectedControlPlaneGuidance(),
            label: 'Operator policy change',
            command: buildGardaSelfGuardPolicyChangeCommand(cliPrefix)
        };
    }
    const currentWorkspace = readCurrentGitWorkspaceSnapshot(repoRoot, true);
    const currentChangedFiles = Array.isArray(currentWorkspace?.changed_files)
        ? currentWorkspace.changed_files
        : [];

    return {
        nextGate: 'enter-task-mode',
        title: 'Recover failed classify-change as orchestrator work.',
        reason:
            `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) contains a protected control-plane recovery signal. ` +
            'Run the deterministic recovery command rebuilt from current task-mode and workspace state before reclassifying, after fresh operator approval for protected task-mode entry.',
        label: 'Restart task mode with orchestrator work',
        command: buildOrchestratorWorkRestartCommand(cliPrefix, taskId, taskMode, currentChangedFiles)
    };
}

function getDefaultCommandsPath(repoRoot: string): string {
    return path.resolve(repoRoot, buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/40-commands.md'));
}

function getDefaultOutputFiltersPath(repoRoot: string): string {
    return path.resolve(repoRoot, buildBundleRelativePath(repoRoot, 'live/config/output-filters.json'));
}

function readCoherentCycleReadiness(
    repoRoot: string,
    eventsRoot: string,
    reviewsRoot: string,
    taskId: string,
    preflightPath: string,
    taskModePath: string | null
): CoherentCycleReadiness {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return {
            ready: true,
            reason: 'Timeline ordering could not be checked by next-step; downstream gates will report timeline integrity.',
            command: null
        };
    }

    const latestPreflight = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED'
    );
    if (!latestPreflight) {
        return {
            ready: true,
            reason: 'No PREFLIGHT_CLASSIFIED event exists yet.',
            command: null
        };
    }

    const latestBoundary = findLatestTimelineEvent(
        events,
        (entry) => entry.sequence < latestPreflight.sequence && COHERENT_CYCLE_BOUNDARY_EVENTS.has(entry.event_type)
    );
    const lowerBoundExclusive = latestBoundary?.sequence ?? Number.NEGATIVE_INFINITY;
    const latestHandshake = findLatestTimelineEvent(
        events,
        (entry) => (
            entry.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED'
            && entry.sequence > lowerBoundExclusive
            && entry.sequence < latestPreflight.sequence
        )
    );
    const latestShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => (
            entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
            && entry.sequence > lowerBoundExclusive
            && entry.sequence < latestPreflight.sequence
        )
    );

    const violations: string[] = [];
    if (!latestHandshake) {
        violations.push('HANDSHAKE_DIAGNOSTICS_RECORDED is missing before the latest PREFLIGHT_CLASSIFIED inside the latest execution cycle');
    }
    if (!latestShellSmoke) {
        violations.push('SHELL_SMOKE_PREFLIGHT_RECORDED is missing before the latest PREFLIGHT_CLASSIFIED inside the latest execution cycle');
    }
    if (latestHandshake && latestShellSmoke && latestShellSmoke.sequence < latestHandshake.sequence) {
        violations.push('SHELL_SMOKE_PREFLIGHT_RECORDED predates HANDSHAKE_DIAGNOSTICS_RECORDED inside the latest execution cycle');
    }

    if (violations.length === 0) {
        return {
            ready: true,
            reason: 'Latest preflight has current-cycle handshake and shell-smoke evidence.',
            command: null
        };
    }

    const compileEvidence = safeReadJson(path.join(reviewsRoot, `${taskId}-compile-gate.json`));
    const commandsPath = typeof compileEvidence?.commands_path === 'string' && compileEvidence.commands_path.trim()
        ? compileEvidence.commands_path.trim()
        : getDefaultCommandsPath(repoRoot);
    const outputFiltersPath = typeof compileEvidence?.output_filters_path === 'string' && compileEvidence.output_filters_path.trim()
        ? compileEvidence.output_filters_path.trim()
        : getDefaultOutputFiltersPath(repoRoot);
    const cycleAnchor = latestBoundary
        ? ` after latest ${latestBoundary.event_type} (seq ${latestBoundary.sequence})`
        : '';

    return {
        ready: false,
        reason: `Latest PREFLIGHT_CLASSIFIED (seq ${latestPreflight.sequence}) is not in a coherent preflight cycle${cycleAnchor}: ${violations.join('; ')}. Run restart-coherent-cycle before compile/review/completion so completion-gate does not fail on stage sequence.`,
        command: buildCoherentCycleRestartCommand(
            repoRoot,
            taskId,
            normalizePath(preflightPath),
            taskModePath,
            commandsPath,
            outputFiltersPath
        )
    };
}

function buildCommand(label: string, command: string): NextStepCommand {
    return { label, command };
}

function buildNavigatorCommand(cliPrefix: string, taskId: string): string {
    return `${cliPrefix} next-step "${taskId}" --repo-root "."`;
}

function resolveActiveTaskModeArtifactPath(
    repoRoot: string,
    eventsRoot: string,
    reviewsRoot: string,
    taskId: string
): string {
    const defaultTaskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return defaultTaskModePath;
    }

    const latestTaskMode = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'TASK_MODE_ENTERED'
    );
    const rawArtifactPath = latestTaskMode?.details?.artifact_path ?? latestTaskMode?.details?.artifactPath;
    const artifactPath = typeof rawArtifactPath === 'string' ? rawArtifactPath.trim() : '';
    if (!artifactPath) {
        return defaultTaskModePath;
    }
    return resolvePathInsideRepo(artifactPath, repoRoot, { allowMissing: true }) || defaultTaskModePath;
}

function buildProjectMemoryImpactCommand(
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    projectMemory: NextStepProjectMemorySummary
): string {
    const parts = [
        `${cliPrefix} gate project-memory-impact`,
        `--task-id "${taskId}"`,
        `--preflight-path "${preflightCommandPath}"`
    ];
    if (projectMemory.evidence_status === 'BLOCKED' && projectMemory.affected_memory_files.length > 0) {
        parts.push('--confirm-updated');
        for (const file of projectMemory.affected_memory_files) {
            parts.push(`--updated-memory-file ${quoteCommandValue(file)}`);
        }
    }
    parts.push('--repo-root "."');
    return parts.join(' ');
}

function quoteCommandValue(value: string): string {
    const text = String(value);
    if (/["$`]/.test(text)) {
        if (process.platform === 'win32') {
            return `'${text.replace(/'/g, "''")}'`;
        }
        return `'${text.replace(/'/g, "'\\''")}'`;
    }
    return `"${text.replace(/\\/g, '\\\\')}"`;
}

function parseTaskQueueEntriesFromContent(content: string): Map<string, TaskQueueEntry> {
    const entries = new Map<string, TaskQueueEntry>();
    for (const line of content.split('\n')) {
        if (!line.trim().startsWith('|')) {
            continue;
        }
        const cells = parseTaskMdTableRow(line);
        const rawTaskId = cells[0]?.trimmed || '';
        if (
            cells.length < 9
            || cells.every((cell) => /^:?-{3,}:?$/u.test(cell.trimmed))
            || rawTaskId.toUpperCase() === 'ID'
            || !TASK_QUEUE_TASK_ID_PATTERN.test(rawTaskId)
        ) {
            continue;
        }
        const taskId = rawTaskId;
        entries.set(taskId, {
            taskId,
            status: cells[1]?.trimmed || null,
            title: cells[4]?.trimmed || null,
            profile: cells[7]?.trimmed || null,
            notes: cells[8]?.trimmed || null
        });
    }
    return entries;
}

function readTaskQueueEntries(repoRoot: string): Map<string, TaskQueueEntry> {
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (!fileExists(taskPath)) {
        return new Map<string, TaskQueueEntry>();
    }
    return parseTaskQueueEntriesFromContent(fs.readFileSync(taskPath, 'utf8'));
}

function resolveTaskQueueCaseMismatch(taskEntries: Map<string, TaskQueueEntry>, taskId: string): string | null {
    const normalizedTaskId = taskId.toLowerCase();
    for (const entryTaskId of taskEntries.keys()) {
        if (entryTaskId !== taskId && entryTaskId.toLowerCase() === normalizedTaskId) {
            return entryTaskId;
        }
    }
    return null;
}

function resolveDefaultDepthFromTaskQueue(taskEntry: TaskQueueEntry | null): string {
    const profile = String(taskEntry?.profile || '').trim().toLowerCase();
    if (profile === 'fast' || profile === 'docs-only') {
        return '1';
    }
    return '2';
}

function parseOptionalNumberField(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function readWorkflowConfigRecordForNextStep(repoRoot: string): Record<string, unknown> | null {
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

function readScopeBudgetGuardEvaluation(
    repoRoot: string,
    preflight: Record<string, unknown> | null,
    profileSummary: NextStepProfileSummary | null,
    requiredReviewTypes: string[]
): ScopeBudgetGuardEvaluation | null {
    if (!preflight) {
        return null;
    }
    const metrics = isPlainRecord(preflight.metrics) ? preflight.metrics : {};
    const budgetForecast = isPlainRecord(preflight.budget_forecast) ? preflight.budget_forecast : {};
    const defaultWorkflowConfig = buildDefaultWorkflowConfig();
    let rawScopeBudgetGuard: unknown = defaultWorkflowConfig.scope_budget_guard;
    const workflowConfig = readWorkflowConfigRecordForNextStep(repoRoot);
    if (workflowConfig?.scope_budget_guard !== undefined) {
        const validatedWorkflowConfig = validateWorkflowConfig({
            full_suite_validation: defaultWorkflowConfig.full_suite_validation,
            review_execution_policy: defaultWorkflowConfig.review_execution_policy,
            scope_budget_guard: workflowConfig.scope_budget_guard
        });
        rawScopeBudgetGuard = isPlainRecord(validatedWorkflowConfig.scope_budget_guard)
            ? validatedWorkflowConfig.scope_budget_guard
            : defaultWorkflowConfig.scope_budget_guard;
    }

    const changedFilesCount =
        parseOptionalNumberField(metrics.changed_files_count)
        ?? (Array.isArray(preflight.changed_files) ? preflight.changed_files.length : 0);
    const changedLinesTotal =
        parseOptionalNumberField(metrics.changed_lines_total)
        ?? parseOptionalNumberField(budgetForecast.changed_lines_total)
        ?? 0;
    const totalEstimatedReviewTokens =
        parseOptionalNumberField(budgetForecast.total_estimated_review_tokens)
        ?? 0;
    return evaluateScopeBudgetGuard(
        normalizeScopeBudgetGuardConfig(rawScopeBudgetGuard),
        {
            profileName: profileSummary?.effective_profile || profileSummary?.task_selected_profile || null,
            changedFilesCount,
            changedLinesTotal,
            requiredReviewCount: requiredReviewTypes.length,
            totalEstimatedReviewTokens
        }
    );
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

interface ReviewCycleGuardReadResult {
    attempts: { reviewType: string; failed: boolean; passed: boolean }[];
    timelineValid: boolean;
    latestFailedReview: NextStepReviewCycleLatestFailedReview | null;
}

interface ReviewCycleGuardReadEvaluationResult {
    evaluation: ReviewCycleGuardEvaluation;
    latestFailedReview: NextStepReviewCycleLatestFailedReview | null;
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
    reviewCycleGuardConfig: ReturnType<typeof normalizeReviewCycleGuardConfig>
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
        if (!event || !['REVIEWER_INVOCATION_ATTESTED', 'REVIEW_RECORDED'].includes(event.event_type)) {
            return false;
        }
        const reviewType = getTimelineReviewType(event.details);
        if (!reviewType) {
            if (!guardLimitExceeded) {
                malformedReviewCycleEvent = true;
            }
            return reviewCycleGuardConfig.action === 'BLOCK_FOR_OPERATOR_DECISION' && !guardLimitExceeded;
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
            || (
                event.event_type === 'REVIEW_RECORDED'
                && event.outcome === 'PASS'
                && !hasReviewArtifactPath
            )
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

function readReviewCycleGuardEvaluation(
    repoRoot: string,
    eventsRoot: string,
    taskId: string
): ReviewCycleGuardReadEvaluationResult {
    const defaultWorkflowConfig = buildDefaultWorkflowConfig();
    let rawReviewCycleGuard: unknown = defaultWorkflowConfig.review_cycle_guard;
    const workflowConfig = readWorkflowConfigRecordForNextStep(repoRoot);
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
    const reviewCycleAttempts = readReviewCycleGuardAttempts(repoRoot, timelinePath, reviewCycleGuardConfig);

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

const REVIEW_CYCLE_OPERATOR_CHOICES = Object.freeze([
    'split_task',
    'mark_blocked',
    'raise_limits',
    'allow_one_more_cycle',
    'create_follow_up_tasks'
]);

const REVIEW_CYCLE_AUTO_SPLIT_TEMPLATE_PATH = 'template/docs/prompts/review-cycle-auto-split.md';

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
    const templatePath = path.join(resolveBundleRootForNextStep(repoRoot), REVIEW_CYCLE_AUTO_SPLIT_TEMPLATE_PATH);
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

function buildReviewCycleOperatorBlock(
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
    const autoSplitEnabled = evaluation.action === 'BLOCK_FOR_OPERATOR_DECISION'
        && evaluation.violations.length > 0
        && evaluation.active
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
        auto_split_prompt: autoSplitPrompt
    };
}

function buildNextStepProfileSummary(
    repoRoot: string,
    taskEntry: TaskQueueEntry | null,
    taskMode: Record<string, unknown> | null,
    preflight: Record<string, unknown> | null
): NextStepProfileSummary | null {
    const rawTaskProfile = typeof taskMode?.task_profile === 'string' && taskMode.task_profile.trim()
        ? taskMode.task_profile.trim()
        : typeof taskEntry?.profile === 'string' && taskEntry.profile.trim()
            ? taskEntry.profile.trim()
            : null;

    let resolvedSelection: ReturnType<typeof resolveTaskProfileSelection>['selection'] | null;
    try {
        resolvedSelection = resolveTaskProfileSelection(
            path.join(repoRoot, 'garda-agent-orchestrator'),
            rawTaskProfile,
            typeof preflight?.scope_category === 'string' ? preflight.scope_category : null
        ).selection;
    } catch {
        resolvedSelection = null;
    }

    const budgetForecast = preflight?.budget_forecast && typeof preflight.budget_forecast === 'object'
        ? preflight.budget_forecast as Record<string, unknown>
        : null;
    const depthEscalation = preflight?.depth_escalation && typeof preflight.depth_escalation === 'object'
        ? preflight.depth_escalation as Record<string, unknown>
        : null;

    const summary: NextStepProfileSummary = {
        task_selected_profile: rawTaskProfile || resolvedSelection?.task_profile || null,
        profile_selection_source:
            (typeof taskMode?.profile_selection_source === 'string' && taskMode.profile_selection_source.trim())
            || resolvedSelection?.profile_selection_source
            || null,
        effective_profile:
            (typeof taskMode?.active_profile === 'string' && taskMode.active_profile.trim())
            || resolvedSelection?.effective_profile
            || null,
        effective_profile_source:
            (typeof taskMode?.profile_source === 'string' && taskMode.profile_source.trim())
            || resolvedSelection?.effective_profile_source
            || null,
        runtime_active_profile:
            (typeof taskMode?.runtime_active_profile === 'string' && taskMode.runtime_active_profile.trim())
            || resolvedSelection?.runtime_active_profile
            || null,
        runtime_active_profile_source:
            (typeof taskMode?.runtime_profile_source === 'string' && taskMode.runtime_profile_source.trim())
            || resolvedSelection?.runtime_profile_source
            || null,
        requested_depth:
            parseOptionalNumberField(budgetForecast?.requested_depth)
            ?? parseOptionalNumberField(taskMode?.requested_depth),
        effective_depth:
            parseOptionalNumberField(budgetForecast?.effective_depth)
            ?? parseOptionalNumberField(preflight?.risk_aware_depth && typeof preflight.risk_aware_depth === 'object'
                ? (preflight.risk_aware_depth as Record<string, unknown>).effective_depth
                : null)
            ?? parseOptionalNumberField(taskMode?.effective_depth),
        depth_escalation_reason:
            typeof depthEscalation?.escalation_reason === 'string' && depthEscalation.escalation_reason.trim()
                ? depthEscalation.escalation_reason.trim()
                : null,
        total_forecast_tokens: parseOptionalNumberField(budgetForecast?.total_forecast_tokens),
        effective_forecast_tokens: parseOptionalNumberField(budgetForecast?.effective_forecast_tokens),
        token_economy_active_for_depth:
            typeof budgetForecast?.token_economy_active_for_depth === 'boolean'
                ? budgetForecast.token_economy_active_for_depth
                : null
    };

    if (
        summary.task_selected_profile == null
        && summary.effective_profile == null
        && summary.runtime_active_profile == null
        && summary.requested_depth == null
        && summary.effective_depth == null
        && summary.total_forecast_tokens == null
    ) {
        return null;
    }

    return summary;
}

function resolveProviderFromEnvironment(): string | null {
    const explicitProvider = normalizeProviderId(process.env.GARDA_EXECUTION_PROVIDER);
    if (explicitProvider) {
        return explicitProvider;
    }
    if (process.env.QWEN_CODE) {
        return 'Qwen';
    }
    if (process.env.CODEX_THREAD_ID || process.env.CODEX_HOME) {
        return 'Codex';
    }
    if (process.env.CLAUDE_CODE_SSE_PORT) {
        return 'Claude';
    }
    if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_AGENT) {
        return 'Cursor';
    }
    return null;
}

function quoteProviderForCommand(provider: string | null): string {
    if (provider) {
        return quoteCommandValue(provider);
    }
    return process.platform === 'win32'
        ? '"$env:GARDA_EXECUTION_PROVIDER"'
        : '"$GARDA_EXECUTION_PROVIDER"';
}

function buildEnterTaskModeCommand(
    cliPrefix: string,
    taskId: string,
    taskEntry: TaskQueueEntry | null,
    provider: string | null
): string {
    const parts = [
        `${cliPrefix} gate enter-task-mode`,
        `--task-id ${quoteCommandValue(taskId)}`,
        '--entry-mode "EXPLICIT_TASK_EXECUTION"',
        `--requested-depth ${quoteCommandValue(resolveDefaultDepthFromTaskQueue(taskEntry))}`,
        `--task-summary ${quoteCommandValue(taskEntry?.title || taskId)}`
    ];
    parts.push(`--provider ${quoteProviderForCommand(provider)}`);
    parts.push('--repo-root "."');
    return parts.join(' ');
}

function requiresSensitiveScopeDocAcknowledgement(preflight: Record<string, unknown> | null): boolean {
    const triggers = getPreflightTriggers(preflight);
    return ['api', 'security', 'infra', 'dependency', 'db'].some((trigger) => triggers[trigger] === true);
}

function getPreflightChangedFiles(preflight: Record<string, unknown> | null): string[] {
    return Array.isArray(preflight?.changed_files)
        ? [...new Set(preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
}

function getPostDoneAuditedChangedFiles(
    preflight: Record<string, unknown> | null,
    docImpactPath: string
): string[] {
    return [
        ...new Set([
            ...getPreflightChangedFiles(preflight),
            ...getDocImpactDeclaredDocsUpdated(docImpactPath).map((entry) => normalizePath(entry)).filter(Boolean)
        ])
    ].sort();
}

function isChangelogPath(filePath: string): boolean {
    return /(^|\/)CHANGELOG/i.test(normalizePath(filePath));
}

function getDocImpactChangedFiles(
    preflight: Record<string, unknown> | null,
    repoRoot: string
): string[] {
    const classificationConfig = getClassificationConfig(repoRoot);
    return getPreflightChangedFiles(preflight).filter((filePath) => (
        isDocumentationLikePath(filePath, classificationConfig.ordinary_doc_paths)
        && !isRuntimeCodeLikePath(filePath, classificationConfig.code_like_regexes, classificationConfig.runtime_roots)
    ));
}

function buildDocImpactCommand(
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    preflight: Record<string, unknown> | null,
    repoRoot: string,
    additionalDocsUpdated: string[] = []
): string {
    const docsUpdated = [...new Set([
        ...getDocImpactChangedFiles(preflight, repoRoot),
        ...additionalDocsUpdated.map((entry) => normalizePath(entry)).filter(Boolean)
    ])].sort();
    const changelogUpdated = docsUpdated.some((filePath) => isChangelogPath(filePath));
    const parts = [
        `${cliPrefix} gate doc-impact-gate`,
        `--task-id ${quoteCommandValue(taskId)}`,
        `--preflight-path ${quoteCommandValue(preflightCommandPath)}`
    ];
    if (docsUpdated.length > 0) {
        parts.push('--decision "DOCS_UPDATED"');
        parts.push('--behavior-changed false');
        for (const docPath of docsUpdated) {
            parts.push(`--docs-updated ${quoteCommandValue(docPath)}`);
        }
        parts.push(`--changelog-updated ${changelogUpdated ? 'true' : 'false'}`);
    } else {
        parts.push('--decision "NO_DOC_UPDATES"');
        parts.push('--behavior-changed false');
        parts.push('--changelog-updated false');
    }
    if (requiresSensitiveScopeDocAcknowledgement(preflight)) {
        parts.push('--sensitive-scope-reviewed true');
    }
    parts.push(docsUpdated.length > 0
        ? '--rationale "Documentation or changelog files were changed in the current preflight; next-step records them without requiring a fresh code/test review when non-doc scope is unchanged."'
        : '--rationale "No user-facing documentation impact detected by next-step; adjust this command before running if docs or behavior changed."');
    parts.push('--repo-root "."');
    return parts.join(' ');
}

function getLatestTimelineSequence(eventsRoot: string, taskId: string, eventType: string): number | null {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const errors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, errors);
    let latestSequence: number | null = null;
    for (const event of events) {
        if (event.event_type !== eventType) {
            continue;
        }
        const sequence = event.integrity?.task_sequence ?? event.sequence;
        if (!Number.isFinite(sequence)) {
            continue;
        }
        latestSequence = latestSequence == null ? sequence : Math.max(latestSequence, sequence);
    }
    return latestSequence;
}

function isLatestCompletionCurrent(eventsRoot: string, taskId: string): boolean {
    const latestCompletionSequence = getLatestTimelineSequence(eventsRoot, taskId, 'COMPLETION_GATE_PASSED');
    if (latestCompletionSequence == null) {
        return false;
    }
    const latestTaskModeSequence = getLatestTimelineSequence(eventsRoot, taskId, 'TASK_MODE_ENTERED');
    return latestTaskModeSequence == null || latestCompletionSequence >= latestTaskModeSequence;
}

function getStringField(source: Record<string, unknown> | null, field: string, fallback: string): string {
    const rawValue = source?.[field];
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    return value || fallback;
}

function getNumberField(source: Record<string, unknown> | null, field: string, fallback: string): string {
    const value = source?.[field];
    return Number.isInteger(value) ? String(value) : fallback;
}

function buildOrchestratorWorkRestartCommand(
    cliPrefix: string,
    taskId: string,
    taskMode: Record<string, unknown> | null,
    additionalPlannedChangedFiles: string[] = []
): string {
    const parts = [
        `${cliPrefix} gate enter-task-mode`,
        `--task-id ${quoteCommandValue(taskId)}`,
        `--entry-mode ${quoteCommandValue(getStringField(taskMode, 'entry_mode', 'EXPLICIT_TASK_EXECUTION'))}`,
        `--requested-depth ${quoteCommandValue(getNumberField(taskMode, 'requested_depth', '<1|2|3>'))}`,
        `--task-summary ${quoteCommandValue(getStringField(taskMode, 'task_summary', '<TASK.md summary>'))}`,
        `--provider ${quoteCommandValue(getStringField(taskMode, 'provider', '<provider>'))}`
    ];
    const startBanner = getStringField(taskMode, 'start_banner', '');
    if (startBanner) {
        parts.push(`--start-banner ${quoteCommandValue(startBanner)}`);
    }
    const routedTo = getStringField(taskMode, 'routed_to', '');
    if (routedTo) {
        parts.push(`--routed-to ${quoteCommandValue(routedTo)}`);
    }
    parts.push('--orchestrator-work');
    const plannedChangedFiles = Array.isArray(taskMode?.planned_changed_files)
        ? taskMode.planned_changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
    const mergedPlannedChangedFiles = [...new Set([
        ...plannedChangedFiles,
        ...additionalPlannedChangedFiles.map((entry) => normalizePath(entry)).filter(Boolean)
    ])].sort();
    for (const plannedChangedFile of mergedPlannedChangedFiles) {
        parts.push(`--planned-changed-file ${quoteCommandValue(plannedChangedFile)}`);
    }
    parts.push('--repo-root "."');
    return parts.join(' ');
}

function isGardaSelfGuardDenyAgentEntry(repoRoot: string): boolean {
    return isGardaSelfGuardDenyAgentEntryForBundle(
        isOrchestratorSourceCheckout(repoRoot),
        resolveBundleRootForNextStep(repoRoot)
    );
}

function getTaskModePlannedChangedFiles(taskMode: Record<string, unknown> | null): string[] {
    return Array.isArray(taskMode?.planned_changed_files)
        ? taskMode.planned_changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
}

function getPreflightRefreshChangedFiles(
    taskMode: Record<string, unknown> | null,
    preflight: Record<string, unknown> | null
): string[] {
    const plannedChangedFiles = getTaskModePlannedChangedFiles(taskMode);
    if (plannedChangedFiles.length > 0) {
        return plannedChangedFiles;
    }
    const detectionSource = String(preflight?.detection_source || '').trim().toLowerCase();
    if (detectionSource === 'explicit_changed_files') {
        return getPreflightChangedFiles(preflight);
    }
    return [];
}

function buildClassifyChangeCommand(params: {
    repoRoot: string;
    cliPrefix: string;
    taskId: string;
    taskMode: Record<string, unknown> | null;
    taskModePath: string | null;
    preflightCommandPath: string;
    includePlannedScope: boolean;
    changedFiles?: string[];
}): string {
    const parts = [
        `${params.cliPrefix} gate classify-change`,
        `--task-id ${quoteCommandValue(params.taskId)}`,
        `--task-intent ${quoteCommandValue(getStringField(params.taskMode, 'task_summary', '<task summary>'))}`
    ];
    const changedFiles = params.changedFiles || (params.includePlannedScope
        ? getTaskModePlannedChangedFiles(params.taskMode)
        : []);
    for (const changedFile of changedFiles) {
        parts.push(`--changed-file ${quoteCommandValue(changedFile)}`);
    }
    parts.push(...buildTaskModePathCommandParts(params.repoRoot, params.taskId, params.taskModePath));
    parts.push(`--output-path ${quoteCommandValue(params.preflightCommandPath)}`);
    parts.push('--repo-root "."');
    return parts.join(' ');
}

function getPreflightTriggers(preflight: Record<string, unknown> | null): Record<string, unknown> {
    return isPlainRecord(preflight?.triggers) ? preflight.triggers : {};
}

function preflightTouchesProtectedControlPlane(preflight: Record<string, unknown> | null): boolean {
    const triggers = getPreflightTriggers(preflight);
    if (triggers.protected_control_plane_changed === true) {
        return true;
    }
    return Array.isArray(triggers.changed_protected_files) && triggers.changed_protected_files.length > 0;
}

function getOrdinaryDocReviewSkips(preflight: Record<string, unknown> | null): { path: string; pattern: string }[] {
    const triggers = getPreflightTriggers(preflight);
    const matches = Array.isArray(triggers.ordinary_doc_path_matches)
        ? triggers.ordinary_doc_path_matches
        : [];
    return matches
        .map((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return null;
            }
            const raw = entry as Record<string, unknown>;
            const matchedPath = normalizePath(raw.path);
            const pattern = normalizePath(raw.pattern);
            return matchedPath && pattern ? { path: matchedPath, pattern } : null;
        })
        .filter((entry): entry is { path: string; pattern: string } => entry !== null)
        .sort((left, right) => left.path.localeCompare(right.path) || left.pattern.localeCompare(right.pattern));
}

function buildResult(params: {
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
    warnings?: string[];
    reviewCycleBlock?: NextStepReviewCycleBlock | null;
    finalReport?: NextStepFinalReportSummary | null;
    sourceRuntimeStaleness?: SourceCheckoutRuntimeStalenessResult | null;
}): NextStepResult {
    const intendedGateCommand = params.commands.find((command) => /\bgate\s+[a-z0-9-]+/iu.test(command.command));
    if (
        params.sourceRuntimeStaleness?.isStale
        && params.nextGate !== 'source-runtime-remediation'
        && intendedGateCommand
    ) {
        return buildSourceRuntimeRemediationResult({
            ...params,
            intendedGate: params.nextGate || intendedGateCommand.label,
            intendedCommand: intendedGateCommand.command,
            staleness: params.sourceRuntimeStaleness
        });
    }
    const missingArtifacts = params.status === 'DONE' ? [] : params.missingArtifacts;
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
        missing_artifacts: missingArtifacts,
        present_artifacts: params.presentArtifacts,
        full_suite_validation: params.fullSuite,
        project_memory: params.projectMemory || null,
        review: params.review,
        task_queue_status_contract: buildTaskQueueStatusContract(params.taskId),
        audit_status: params.auditStatus,
        profile: params.profile,
        markdown_working_plan: params.markdownWorkingPlan || null,
        warnings: params.warnings || [],
        review_cycle_block: params.reviewCycleBlock || null,
        final_report: params.finalReport || null
    };
}

function buildSourceRuntimeRemediationResult(params: {
    taskId: string;
    navigatorCommand: string;
    intendedGate: string;
    intendedCommand: string;
    staleness: SourceCheckoutRuntimeStalenessResult;
    missingArtifacts: NextStepArtifactState[];
    presentArtifacts: NextStepArtifactState[];
    fullSuite: NextStepFullSuiteSummary;
    projectMemory?: NextStepProjectMemorySummary | null;
    review: NextStepReviewSummary;
    auditStatus: TaskAuditSummaryResult['status'];
    profile: NextStepProfileSummary | null;
    markdownWorkingPlan?: TaskModeMarkdownWorkingPlanMetadata | null;
}): NextStepResult {
    const violationSummary = params.staleness.violations.length > 0
        ? params.staleness.violations.join('; ')
        : 'source checkout generated runtime may be stale';
    const remediation = params.staleness.remediation || 'Run "npm run build" before continuing gate execution from this source checkout.';
    return buildResult({
        taskId: params.taskId,
        navigatorCommand: params.navigatorCommand,
        status: 'BLOCKED',
        nextGate: 'source-runtime-remediation',
        title: 'Rebuild source-checkout runtime before continuing.',
        reason:
            `Source checkout generated runtime is stale: ${violationSummary}. ` +
            `Remediation blocks intended gate '${params.intendedGate}'. ` +
            `After the rebuild, rerun the navigator to continue with '${params.intendedGate}': ${params.intendedCommand}.`,
        commands: [
            buildCommand('Rebuild source-checkout runtime', remediation.replace(/^Run\s+"([^"]+)".*$/u, '$1'))
        ],
        missingArtifacts: params.missingArtifacts,
        presentArtifacts: params.presentArtifacts,
        fullSuite: params.fullSuite,
        projectMemory: params.projectMemory || null,
        review: params.review,
        auditStatus: params.auditStatus,
        profile: params.profile,
        markdownWorkingPlan: params.markdownWorkingPlan || null
    });
}

function buildFinalReportOrder(summary: TaskAuditSummaryResult, commitCommandSuggestion: string, commitQuestion: string): string[] {
    const requirements = summary.final_report_contract.implementation_summary_requirements
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);
    const implementationSummary = requirements.length > 0
        ? `implementation summary (include ${requirements.join(', ')})`
        : 'implementation summary';
    const contractOrder = summary.final_report_contract.required_order.length > 0
        ? summary.final_report_contract.required_order
        : [
            'review integrity attestation',
            'implementation summary',
            commitCommandSuggestion,
            ...(commitQuestion ? [commitQuestion] : [])
        ];
    return contractOrder
        .map((entry) => entry === 'implementation summary' ? implementationSummary : entry)
        .filter((entry) => String(entry || '').trim().length > 0);
}

function finalCloseoutMatchesCurrentCycle(
    expected: TaskAuditSummaryResult['final_closeout']['cycle_binding'] | null | undefined,
    actualPayload: Record<string, unknown>,
    repoRoot: string
): boolean {
    const expectedBinding = expected || null;
    const actualBinding = getCycleBindingSnapshotFromPayload(actualPayload, repoRoot);
    if (!expectedBinding?.compile_gate_timestamp || !actualBinding?.compile_gate_timestamp) {
        return false;
    }
    if (actualBinding.compile_gate_timestamp !== expectedBinding.compile_gate_timestamp) {
        return false;
    }
    if (expectedBinding.preflight_sha256 && actualBinding.preflight_sha256 !== expectedBinding.preflight_sha256) {
        return false;
    }
    return !(expectedBinding.preflight_path && actualBinding.preflight_path !== expectedBinding.preflight_path);
}

function readReadyFinalReportSummary(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    summary: TaskAuditSummaryResult
): NextStepFinalReportSummary | null {
    const closeoutJsonPath = path.join(reviewsRoot, `${taskId}-final-closeout.json`);
    const closeoutMarkdownPath = path.join(reviewsRoot, `${taskId}-final-closeout.md`);
    if (!fileExists(closeoutJsonPath) || !fileExists(closeoutMarkdownPath)) {
        return null;
    }

    const closeout = safeReadJson(closeoutJsonPath);
    if (!isPlainRecord(closeout)) {
        return null;
    }
    if (String(closeout.task_id || '').trim() !== taskId) {
        return null;
    }
    if (String(closeout.status || '').trim().toUpperCase() !== 'READY') {
        return null;
    }
    if (!finalCloseoutMatchesCurrentCycle(summary.final_closeout.cycle_binding, closeout, repoRoot)) {
        return null;
    }
    const generatedUtc = typeof closeout.generated_utc === 'string' ? closeout.generated_utc : '';
    const expectedCloseout = { ...summary.final_closeout, generated_utc: generatedUtc, artifact_state: 'MATERIALIZED' as const };
    const expectedAttestation = expectedCloseout.review_integrity_attestation;
    const expectedJson = `${JSON.stringify(expectedCloseout, null, 2)}\n`;
    if (!generatedUtc || !expectedAttestation || expectedAttestation.completion_allowed !== true || fs.readFileSync(closeoutJsonPath, 'utf8') !== expectedJson) {
        return null;
    }
    const expectedMarkdown = `${formatFinalCloseoutMarkdown(expectedCloseout)}\n`;
    if (fs.readFileSync(closeoutMarkdownPath, 'utf8') !== expectedMarkdown) {
        return null;
    }

    return {
        closeout_json_path: toRepoDisplayPath(repoRoot, closeoutJsonPath),
        closeout_markdown_path: toRepoDisplayPath(repoRoot, closeoutMarkdownPath),
        required_order: buildFinalReportOrder(summary, summary.final_report_contract.commit_command_suggestion, summary.final_report_contract.commit_question),
        commit_command_suggestion: summary.final_report_contract.commit_command_suggestion,
        commit_question: summary.final_report_contract.commit_question
    };
}

interface PostDoneWorkspaceDriftDecision {
    blocked: boolean;
    reason: string;
}

function readPostDoneWorkspaceDriftDecision(
    repoRoot: string,
    preflight: Record<string, unknown> | null,
    docImpactPath: string,
    finalCloseoutJsonPath: string
): PostDoneWorkspaceDriftDecision {
    if (!preflight) {
        return { blocked: false, reason: 'No preflight is available for post-DONE drift comparison.' };
    }

    const normalizedDetectionSource = String(preflight.detection_source || 'git_auto').trim().toLowerCase();
    const includeUntracked = normalizedDetectionSource === 'git_staged_only'
        ? false
        : (typeof preflight.include_untracked === 'boolean' ? preflight.include_untracked : true);
    let currentSnapshot: WorkspaceSnapshot & { cache_hit: boolean };
    try {
        currentSnapshot = getWorkspaceSnapshotCached(repoRoot, 'git_auto', includeUntracked, [], {
            noCache: true,
            readOnly: true
        });
    } catch (error) {
        const gitMetadataPath = path.join(repoRoot, '.git');
        if (!fs.existsSync(gitMetadataPath)) {
            return { blocked: false, reason: 'Workspace inspection is unavailable outside a git worktree.' };
        }
        return {
            blocked: true,
            reason:
                'Unable to inspect tracked post-DONE workspace drift for the completed task closeout: ' +
                `${error instanceof Error ? error.message : String(error)}. ` +
                'Do not report the task as DONE until workspace drift can be inspected or the task is explicitly reopened/reset.'
        };
    }
    const auditedChangedFiles = getPostDoneAuditedChangedFiles(preflight, docImpactPath);
    const auditedSet = new Set(auditedChangedFiles);
    const currentChangedFiles = currentSnapshot.changed_files.map((entry) => normalizePath(entry)).filter(Boolean);
    const unexpectedFiles = currentChangedFiles.filter((entry) => !auditedSet.has(entry));
    if (unexpectedFiles.length > 0) {
        return {
            blocked: true,
            reason:
                `Tracked post-DONE workspace drift detected outside completed scope ${describePathList(auditedChangedFiles)}: ` +
                `${describePathList(unexpectedFiles)}. ` +
                'Do not reopen stale lifecycle gates automatically. Commit or isolate the already-completed task diff, or explicitly reopen/reset the task before running classify, compile, review, full-suite, or completion gates again.'
        };
    }
    const closeout = safeReadJson(finalCloseoutJsonPath);
    const implementationSummary = isPlainRecord(closeout?.implementation_summary) ? closeout.implementation_summary : null;
    const expectedAuditedScopeContentSha256 = typeof implementationSummary?.scope_content_sha256 === 'string'
        ? implementationSummary.scope_content_sha256.trim().toLowerCase()
        : '';
    const expectedAuditedChangedFilesSha256 = typeof implementationSummary?.changed_files_sha256 === 'string'
        ? implementationSummary.changed_files_sha256.trim().toLowerCase()
        : '';
    if ((expectedAuditedScopeContentSha256 || expectedAuditedChangedFilesSha256) && auditedChangedFiles.length > 0) {
        let currentAuditedScope: WorkspaceSnapshot & { cache_hit: boolean };
        try {
            currentAuditedScope = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', includeUntracked, auditedChangedFiles, {
                noCache: true,
                readOnly: true
            });
        } catch (error) {
            return {
                blocked: true,
                reason:
                    'Unable to inspect audited post-DONE closeout content: ' +
                    `${error instanceof Error ? error.message : String(error)}. ` +
                    'Do not report the task as DONE until workspace drift can be inspected or the task is explicitly reopened/reset.'
            };
        }
        const auditedViolations = [
            expectedAuditedScopeContentSha256 && currentAuditedScope.scope_content_sha256 !== expectedAuditedScopeContentSha256
                ? `audited scope_content_sha256=${expectedAuditedScopeContentSha256} differs from current audited scope_content_sha256=${currentAuditedScope.scope_content_sha256}`
                : '',
            expectedAuditedChangedFilesSha256 && currentAuditedScope.changed_files_sha256 !== expectedAuditedChangedFilesSha256
                ? `audited changed_files_sha256=${expectedAuditedChangedFilesSha256} differs from current audited changed_files_sha256=${currentAuditedScope.changed_files_sha256}`
                : ''
        ].filter(Boolean);
        if (auditedViolations.length === 0) {
            return { blocked: false, reason: 'Audited final closeout scope still matches the current workspace after DONE.' };
        }
        return {
            blocked: true,
            reason:
                `Tracked post-DONE workspace drift detected in audited completed scope ${describePathList(auditedChangedFiles)}: ` +
                `${auditedViolations.join('; ')}. ` +
                'Do not reopen stale lifecycle gates automatically. Commit or isolate the already-completed task diff, or explicitly reopen/reset the task before running classify, compile, review, full-suite, or completion gates again.'
        };
    }

    if (currentSnapshot.changed_files.length === 0) {
        return { blocked: false, reason: 'Workspace is clean after DONE.' };
    }

    const readiness = readPreflightWorkspaceReadiness(repoRoot, preflight, {
        docImpactPath,
        allowDocsOnlyDelta: false
    });
    if (readiness.ready) {
        return { blocked: false, reason: readiness.reason };
    }

    return {
        blocked: true,
        reason:
            `Tracked post-DONE workspace drift detected in completed scope ${describePathList(getPreflightChangedFiles(preflight))}: ${readiness.reason} ` +
            'Do not reopen stale lifecycle gates automatically. Commit or isolate the already-completed task diff, or explicitly reopen/reset the task before running classify, compile, review, full-suite, or completion gates again.'
    };
}

function buildTaskEntryRulePackCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate load-rule-pack`,
        `--task-id "${taskId}"`,
        '--stage "TASK_ENTRY"',
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/00-core.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/15-project-memory.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/40-commands.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/80-task-workflow.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/90-skill-catalog.md')}"`,
        '--repo-root "."'
    ].join(' ');
}

function getEffectiveDepthForPostPreflightRules(
    preflight: Record<string, unknown> | null,
    taskMode: Record<string, unknown> | null
): number {
    const riskAwareDepth = isPlainRecord(preflight?.risk_aware_depth) ? preflight.risk_aware_depth : null;
    const preflightDepth = typeof riskAwareDepth?.effective_depth === 'number'
        ? riskAwareDepth.effective_depth
        : Number(riskAwareDepth?.effective_depth);
    if (Number.isInteger(preflightDepth) && preflightDepth >= 1) {
        return preflightDepth;
    }
    const taskModeDepth = typeof taskMode?.effective_depth === 'number'
        ? taskMode.effective_depth
        : Number(taskMode?.effective_depth);
    if (Number.isInteger(taskModeDepth) && taskModeDepth >= 1) {
        return taskModeDepth;
    }
    return 2;
}

function getPostPreflightRuleFileNames(
    preflight: Record<string, unknown> | null,
    taskMode: Record<string, unknown> | null
): string[] {
    const fileNames = new Set<string>([
        '00-core.md',
        '15-project-memory.md',
        '40-commands.md',
        '80-task-workflow.md',
        '90-skill-catalog.md'
    ]);
    const requiredReviews = isPlainRecord(preflight?.required_reviews) ? preflight.required_reviews : {};
    const effectiveDepth = getEffectiveDepthForPostPreflightRules(preflight, taskMode);
    for (const [reviewType, required] of Object.entries(requiredReviews)) {
        if (required !== true) {
            continue;
        }
        for (const fileName of selectRulePackFiles(reviewType, effectiveDepth)) {
            fileNames.add(fileName);
        }
    }
    return [...fileNames].sort();
}

function buildPostPreflightRulePackCommandForFiles(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    ruleFileNames: string[],
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate load-rule-pack`,
        `--task-id "${taskId}"`,
        '--stage "POST_PREFLIGHT"',
        `--preflight-path "${buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`)}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        ...ruleFileNames.map((fileName) => (
            `--loaded-rule-file "${buildBundleRelativePath(repoRoot, `live/docs/agent-rules/${fileName}`)}"`
        )),
        '--repo-root "."'
    ].join(' ');
}

function buildPostPreflightRulePackBindCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate bind-rule-pack-to-preflight`,
        `--task-id "${taskId}"`,
        `--preflight-path "${buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`)}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        '--repo-root "."'
    ].join(' ');
}

function buildTaskModePathCommandParts(
    repoRoot: string,
    taskId: string,
    taskModePath: string | null
): string[] {
    const trimmedTaskModePath = String(taskModePath || '').trim();
    if (!trimmedTaskModePath) {
        return [];
    }
    const resolvedTaskModePath = resolvePathInsideRepo(trimmedTaskModePath, repoRoot, { allowMissing: true });
    if (!resolvedTaskModePath) {
        return [];
    }
    const defaultTaskModePath = resolvePathInsideRepo(
        buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-task-mode.json`),
        repoRoot,
        { allowMissing: true }
    );
    if (
        defaultTaskModePath
        && normalizePath(resolvedTaskModePath).toLowerCase() === normalizePath(defaultTaskModePath).toLowerCase()
    ) {
        return [];
    }
    return [`--task-mode-path "${toRepoDisplayPath(repoRoot, resolvedTaskModePath)}"`];
}

function buildCompileGateCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate compile-gate`,
        `--task-id "${taskId}"`,
        `--preflight-path "${preflightCommandPath}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        '--repo-root "."'
    ].join(' ');
}

function buildReviewContextCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    reviewType: string,
    reviewDepth: number,
    preflightCommandPath: string,
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate build-review-context`,
        `--review-type "${reviewType}"`,
        `--depth "${reviewDepth}"`,
        `--preflight-path "${preflightCommandPath}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        '--repo-root "."'
    ].join(' ');
}

function buildReviewPhaseCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    gateName: string,
    parts: string[],
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate ${gateName}`,
        `--task-id "${taskId}"`,
        ...parts,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        '--repo-root "."'
    ].join(' ');
}

function buildRequiredReviewsCheckCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null
): string {
    return buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'required-reviews-check', [
        `--preflight-path "${preflightCommandPath}"`
    ], taskModePath);
}

function buildCompletionGateCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null
): string {
    return buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'completion-gate', [
        `--preflight-path "${preflightCommandPath}"`
    ], taskModePath);
}

function resolveRulePackStage(rulePack: Record<string, unknown> | null): string | null {
    const latestStage = typeof rulePack?.latest_stage === 'string'
        ? rulePack.latest_stage.trim()
        : '';
    if (latestStage) {
        return latestStage;
    }
    return typeof rulePack?.stage === 'string' ? rulePack.stage.trim() || null : null;
}

function buildProjectMemoryNextStepSummary(evidence: ReturnType<typeof getProjectMemoryImpactLifecycleEvidence>): NextStepProjectMemorySummary {
    return {
        enabled: evidence.enabled,
        required: evidence.required,
        mode: evidence.mode,
        evidence_status: evidence.evidence_status,
        status: evidence.status,
        update_needed: evidence.update_needed,
        affected_memory_files: [...evidence.affected_memory_files],
        updated_memory_files: [...evidence.updated_memory_files],
        compact_status: evidence.compact_status,
        compact_refreshed: evidence.compact_refreshed,
        artifact_path: evidence.artifact_path,
        update_artifact_path: evidence.update_artifact_path,
        visible_summary_line: evidence.visible_summary_line
    };
}

export function resolveNextStep(options: NextStepOptions): NextStepResult {
    const repoRoot = path.resolve(options.repoRoot || '.');
    const taskId = assertValidTaskId(options.taskId);
    const reviewsRoot = resolveReviewsRoot(repoRoot, options.reviewsRoot);
    const eventsRoot = resolveEventsRoot(repoRoot, options.eventsRoot);
    const cliPrefix = buildCliPrefix(repoRoot);
    const taskModePath = resolveActiveTaskModeArtifactPath(repoRoot, eventsRoot, reviewsRoot, taskId);
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const preflightCommandPath = buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`);
    const navigatorCommand = buildNavigatorCommand(cliPrefix, taskId);
    const markdownWorkingPlan = readOptionalMarkdownWorkingPlan(repoRoot, taskId);
    const rulePackPath = path.join(reviewsRoot, `${taskId}-rule-pack.json`);
    const preflight = safeReadJson(preflightPath);
    const rulePack = safeReadJson(rulePackPath);
    const taskMode = safeReadJson(taskModePath);
    const taskEntries = readTaskQueueEntries(repoRoot);
    const taskEntry = taskEntries.get(taskId) || null;
    const taskIdCaseMismatch = taskEntry ? null : resolveTaskQueueCaseMismatch(taskEntries, taskId);
    const defaultExecutionProvider = resolveProviderFromEnvironment();
    const profileSummary = buildNextStepProfileSummary(repoRoot, taskEntry, taskMode, preflight);
    try {
        readWorkflowConfigRecordForNextStep(repoRoot);
    } catch (error: unknown) {
        const fallbackFullSuiteConfig = loadFullSuiteValidationConfig(repoRoot);
        const coreArtifacts = artifactState(repoRoot, [
            { key: 'task-mode', path: taskModePath },
            { key: 'rule-pack', path: rulePackPath },
            { key: 'handshake', path: path.join(reviewsRoot, `${taskId}-handshake.json`) },
            { key: 'shell-smoke', path: path.join(reviewsRoot, `${taskId}-shell-smoke.json`) },
            { key: 'preflight', path: preflightPath },
            { key: 'compile-gate', path: path.join(reviewsRoot, `${taskId}-compile-gate.json`) },
            { key: 'review-gate', path: path.join(reviewsRoot, `${taskId}-review-gate.json`) },
            { key: 'doc-impact', path: path.join(reviewsRoot, `${taskId}-doc-impact.json`) },
            { key: 'full-suite-validation', path: path.join(reviewsRoot, `${taskId}-full-suite-validation.json`) },
            { key: 'completion-gate', path: path.join(reviewsRoot, `${taskId}-completion-gate.json`) }
        ]);
        return buildResult({
            taskId,
            navigatorCommand,
            status: 'BLOCKED',
            nextGate: 'workflow-config-validation',
            title: 'Validate workflow configuration before continuing.',
            reason: error instanceof Error ? error.message : String(error),
            commands: [
                buildCommand(
                    'Validate workflow config',
                    `${cliPrefix} workflow validate --target-root "."`
                )
            ],
            missingArtifacts: coreArtifacts.missing,
            presentArtifacts: coreArtifacts.present,
            fullSuite: {
                enabled: fallbackFullSuiteConfig.enabled,
                command: fallbackFullSuiteConfig.command,
                placement: fallbackFullSuiteConfig.placement,
                config_path: toRepoDisplayPath(repoRoot, resolveWorkflowConfigPath(repoRoot)),
                config_source: 'effective_workflow_config',
                note: 'Full-suite validation is unavailable until workflow config validation passes.'
            },
            review: {
                required_reviews: [],
                review_execution_policy_mode: LEGACY_REVIEW_EXECUTION_POLICY_MODE,
                review_execution_policy_source: 'workflow_config_fallback',
                launchable_review_types: [],
                blocked_review_lanes: [],
                failed_review_type: null,
                next_review_type: null,
                blocked_review_dependencies: [],
                ordinary_doc_review_skips: [],
                trust: null,
                trust_note: 'Review trust is unavailable until workflow config validation passes.'
            },
            auditStatus: 'INCOMPLETE',
            profile: profileSummary,
            markdownWorkingPlan,
            sourceRuntimeStaleness: detectSourceCheckoutRuntimeStaleness(repoRoot)
        });
    }
    const summary = buildTaskAuditSummary({
        taskId,
        repoRoot,
        eventsRoot,
        reviewsRoot
    });
    const preflightSha256 = fileExists(preflightPath) ? fileSha256(preflightPath) : null;
    const fullSuiteConfig = loadFullSuiteValidationConfig(repoRoot);
    const fullSuiteTimeoutForecast = fullSuiteConfig.enabled
        ? buildFullSuiteTimeoutForecast(repoRoot, fullSuiteConfig)
        : null;
    const fullSuiteTimeoutForecastLine = fullSuiteTimeoutForecast
        ? formatFullSuiteTimeoutForecast(fullSuiteTimeoutForecast)
        : null;
    const fullSuiteNotRequiredForDocsOnly = isFullSuiteNotRequiredForDocsOnlyScope(preflight || {});
    const requiredReviewTypes = getRequiredReviewTypes(summary.required_reviews);
    const fullSuiteNotRequiredForZeroDiffNoReviewableScope = hasZeroDiffNoReviewableScopeSuppression(preflight, requiredReviewTypes);
    const fullSuiteNotRequiredForCurrentScope = fullSuiteNotRequiredForDocsOnly || fullSuiteNotRequiredForZeroDiffNoReviewableScope;
    const fullSuiteGatePassed = fullSuiteNotRequiredForDocsOnly
        ? hasAcceptedDocsOnlyFullSuiteSkipArtifact(
                reviewsRoot,
                taskId,
                fullSuiteConfig.command,
                preflightPath,
                preflightSha256,
                summary
            )
        : fullSuiteNotRequiredForZeroDiffNoReviewableScope
            ? true
            : isGatePassed(summary, 'full-suite-validation');
    const fullSuiteSummary: NextStepFullSuiteSummary = {
        enabled: fullSuiteConfig.enabled,
        command: fullSuiteConfig.command,
        placement: fullSuiteConfig.placement,
        config_path: toRepoDisplayPath(repoRoot, resolveWorkflowConfigPath(repoRoot)),
        config_source: 'effective_workflow_config',
        recommended_timeout_seconds: fullSuiteTimeoutForecast?.recommended_timeout_seconds ?? null,
        timeout_forecast_note: fullSuiteTimeoutForecastLine,
        note: fullSuiteConfig.enabled && fullSuiteNotRequiredForDocsOnly
            ? 'Full-suite validation is enabled, but this docs-only scope only requires a NOT_REQUIRED artifact.'
            : fullSuiteConfig.enabled && fullSuiteNotRequiredForZeroDiffNoReviewableScope
            ? 'Full-suite validation is enabled, but this BASELINE_ONLY pre-implementation scope has no reviewable diff and requires audited no-op evidence instead.'
            : fullSuiteConfig.enabled
            ? 'Full-suite validation is mandatory because the effective workflow config enables it.'
            : 'Full-suite validation is disabled in the effective workflow config.'
    };
    const projectMemoryEvidence = getProjectMemoryImpactLifecycleEvidence({
        repoRoot,
        taskId,
        preflightPath
    });
    const projectMemorySummary = buildProjectMemoryNextStepSummary(projectMemoryEvidence);
    const reviewPolicy = resolveReviewPolicy(preflight);
    const reviewStates = requiredReviewTypes.map((reviewType) => (
        readReviewArtifactState(reviewsRoot, taskId, reviewType, preflightPath, preflightSha256, preflight)
    ));
    const fullSuiteGateStatus = getGateStatus(summary, 'full-suite-validation');
    const reviewLaunchPlan = applyFullSuiteReadinessToReviewLaunchPlan(
        getReviewLaunchPlan(
            repoRoot,
            requiredReviewTypes,
            reviewPolicy.mode,
            summary.required_reviews,
            reviewStates,
            eventsRoot,
            taskId
        ),
        fullSuiteConfig.enabled,
        fullSuiteConfig.placement,
        fullSuiteNotRequiredForCurrentScope,
        fullSuiteGateStatus
    );
    const reviewTrust = readReviewTrust(reviewsRoot, taskId, requiredReviewTypes, summary.scope_category);
    const reviewSummary: NextStepReviewSummary = {
        required_reviews: requiredReviewTypes,
        review_execution_policy_mode: reviewPolicy.mode,
        review_execution_policy_source: reviewPolicy.source,
        launchable_review_types: reviewLaunchPlan.launchable_review_types,
        blocked_review_lanes: toNextStepBlockedReviewLanes(reviewLaunchPlan),
        failed_review_type: reviewLaunchPlan.failed_review_type,
        next_review_type: reviewLaunchPlan.next_review_type,
        blocked_review_dependencies: reviewLaunchPlan.blocked_review_dependencies,
        ordinary_doc_review_skips: getOrdinaryDocReviewSkips(preflight),
        trust: reviewTrust,
        trust_note: reviewTrust?.visible_summary_line || (
            requiredReviewTypes.length > 0
                ? 'Review trust is unavailable until required review receipts exist.'
                : null
        )
    };
    const coreArtifacts = artifactState(repoRoot, [
        { key: 'task-mode', path: taskModePath },
        { key: 'rule-pack', path: rulePackPath },
        { key: 'handshake', path: path.join(reviewsRoot, `${taskId}-handshake.json`) },
        { key: 'shell-smoke', path: path.join(reviewsRoot, `${taskId}-shell-smoke.json`) },
        { key: 'preflight', path: preflightPath },
        { key: 'compile-gate', path: path.join(reviewsRoot, `${taskId}-compile-gate.json`) },
        { key: 'review-gate', path: path.join(reviewsRoot, `${taskId}-review-gate.json`) },
        { key: 'doc-impact', path: path.join(reviewsRoot, `${taskId}-doc-impact.json`) },
        { key: 'full-suite-validation', path: path.join(reviewsRoot, `${taskId}-full-suite-validation.json`) },
        ...(projectMemoryEvidence.required
            ? [{ key: 'project-memory-impact', path: projectMemoryEvidence.artifact_path }]
            : []),
        { key: 'completion-gate', path: path.join(reviewsRoot, `${taskId}-completion-gate.json`) }
    ]);

    const sourceRuntimeStaleness = detectSourceCheckoutRuntimeStaleness(repoRoot);
    const resultBase = {
        taskId,
        navigatorCommand,
        missingArtifacts: coreArtifacts.missing,
        presentArtifacts: coreArtifacts.present,
        fullSuite: fullSuiteSummary,
        projectMemory: projectMemorySummary,
        review: reviewSummary,
        profile: profileSummary,
        markdownWorkingPlan,
        auditStatus: summary.status,
        warnings: [] as string[],
        sourceRuntimeStaleness
    };

    if (taskIdCaseMismatch) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'task-id-casing',
            title: 'Task ID casing does not match TASK.md.',
            reason:
                `Requested task id ${formatNextStepInlineValue(taskId)} matches TASK.md row ` +
                `${formatNextStepInlineValue(taskIdCaseMismatch)} only by case. ` +
                'Use the exact TASK.md task id before any lifecycle gate so artifacts cannot fork into a parallel casing namespace.',
            commands: [
                buildCommand(
                    'Rerun navigator with TASK.md casing',
                    `${cliPrefix} next-step "${taskIdCaseMismatch}" --repo-root "."`
                )
            ],
            missingArtifacts: [],
            presentArtifacts: coreArtifacts.present,
            finalReport: null
        });
    }

    const taskQueueStatus = taskEntry?.status || null;
    const splitRequiredStatusInTaskQueue = isTaskQueueSplitRequiredStatus(taskQueueStatus);
    const permanentSplitRequiredLatchEvidence = splitRequiredStatusInTaskQueue
        ? null
        : readSplitRequiredLatchEvidence({ reviewsRoot, eventsRoot, taskId });
    const decomposedStatusHasClearedLatchEvidence =
        isTaskQueueDecomposedStatus(taskQueueStatus)
        && permanentSplitRequiredLatchEvidence?.valid === true
        && hasSplitRequiredClearedEvidence({
            eventsRoot,
            taskId,
            latchEvidence: permanentSplitRequiredLatchEvidence
        });
    const doneStatusHasCompletedClearedLatchEvidence =
        isTaskQueueDoneStatus(taskQueueStatus)
        && permanentSplitRequiredLatchEvidence?.valid === true
        && hasCompletedDecomposedParentAfterSplitRequiredClear({
            eventsRoot,
            taskId,
            latchEvidence: permanentSplitRequiredLatchEvidence
        });
    if (
        !splitRequiredStatusInTaskQueue
        && !decomposedStatusHasClearedLatchEvidence
        && !doneStatusHasCompletedClearedLatchEvidence
        && permanentSplitRequiredLatchEvidence?.valid
    ) {
        const restoreResult = restoreSplitRequiredParentFromPermanentLatch({
            repoRoot,
            eventsRoot,
            taskId,
            latchEvidence: permanentSplitRequiredLatchEvidence
        });
        if (!isSuccessfulSplitRequiredStatusSync(restoreResult)) {
            return buildResult({
                ...resultBase,
                status: 'SPLIT_REQUIRED',
                nextGate: 'split-required-latch',
                title: 'Split-required latch is active.',
                reason:
                    `A valid split-required latch already exists for ${formatNextStepInlineValue(taskId)}, ` +
                    'but the gate could not restore TASK.md to SPLIT_REQUIRED after detecting later status/config/scope drift. ' +
                    `Status sync outcome: ${formatNextStepInlineValue(restoreResult.outcome)}${restoreResult.error_message ? ` (${restoreResult.error_message})` : ''}. ` +
                    'Do not run classify, compile, review, full-suite, completion, or final closeout gates on the parent.',
                commands: [],
                missingArtifacts: [],
                presentArtifacts: coreArtifacts.present,
                finalReport: null
            });
        }

        const childRoute = resolveNextUnfinishedChildRoute(
            taskEntries,
            taskId,
            new Set<string>(),
            extractExplicitLinkedChildTaskIds
        );
        const hasChildren = hasLinkedChildTasks(taskEntries, taskId);
        if (hasChildren) {
            const syncResult = transitionSplitRequiredParentToDecomposed({ repoRoot, eventsRoot, taskId });
            if (syncResult.outcome !== 'updated' && syncResult.outcome !== 'already_synced') {
                return buildResult({
                    ...resultBase,
                    status: 'SPLIT_REQUIRED',
                    nextGate: 'split-required-latch',
                    title: 'Split-required latch is active.',
                    reason:
                        'A valid split-required latch is permanent for this task attempt, but the gate could not transition the parent to DECOMPOSED after detecting linked child tasks. ' +
                        `Status sync outcome: ${formatNextStepInlineValue(syncResult.outcome)}${syncResult.error_message ? ` (${syncResult.error_message})` : ''}. ` +
                        'Do not run classify, compile, review, full-suite, completion, or final closeout gates on the parent.',
                    commands: [],
                    missingArtifacts: [],
                    presentArtifacts: coreArtifacts.present,
                    finalReport: null
                });
            }
            if (childRoute) {
                const chain = [taskId, ...childRoute.chain].join(' -> ');
                return buildResult({
                    ...resultBase,
                    status: 'DECOMPOSED',
                    nextGate: 'child-task',
                    title: 'Split-required latch cleared; continue with the next child.',
                    reason:
                        'A valid split-required latch stayed permanent after later status/config/scope drift. Linked child tasks were detected, so the gate restored the parent latch and transitioned the parent to DECOMPOSED. ' +
                        `Parent tasks in this state are not executable lifecycle scopes. Continue through child chain ${chain}; ` +
                        `next unfinished child status is ${formatNextStepInlineValue(childRoute.status || 'unknown')}.`,
                    commands: [
                        buildCommand(
                            'Continue child task',
                            `${cliPrefix} next-step "${childRoute.taskId}" --repo-root "."`
                        )
                    ],
                    missingArtifacts: [],
                    presentArtifacts: coreArtifacts.present,
                    finalReport: null
                });
            }
            return buildResult({
                ...resultBase,
                status: 'DECOMPOSED',
                nextGate: null,
                title: 'Split-required latch cleared; no unfinished child remains.',
                reason:
                    'A valid split-required latch stayed permanent after later status/config/scope drift. Linked child tasks were detected, so the gate restored the parent latch and transitioned the parent to DECOMPOSED. ' +
                    'No unfinished child task could be resolved from its notes. Do not run classify, compile, review, full-suite, completion, or final closeout gates on the parent.',
                commands: [],
                missingArtifacts: [],
                presentArtifacts: coreArtifacts.present,
                finalReport: null
            });
        }

        return buildResult({
            ...resultBase,
            status: 'SPLIT_REQUIRED',
            nextGate: 'split-required-latch',
            title: 'Split-required latch is active.',
            reason:
                `A valid split-required latch already exists for ${formatNextStepInlineValue(taskId)}. ` +
                'The latch is permanent for this task attempt, so later status/config/scope changes cannot make the parent executable again. ' +
                'Create and link child tasks so the gate can transition the parent to DECOMPOSED, or use an explicit operator task-reset/discard command to clear the latch.',
            commands: [],
            missingArtifacts: [],
            presentArtifacts: coreArtifacts.present,
            finalReport: null
        });
    }

    if (splitRequiredStatusInTaskQueue) {
        const latchEvidence = readSplitRequiredLatchEvidence({ reviewsRoot, eventsRoot, taskId });
        if (!latchEvidence.valid) {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'split-required-latch',
                title: 'Split-required latch evidence is invalid.',
                reason:
                    `TASK.md marks ${formatNextStepInlineValue(taskId)} as SPLIT_REQUIRED, but gate-owned latch evidence is invalid: ${latchEvidence.reason}. ` +
                    'Do not clear the latch, route child tasks, or run parent classify, compile, review, full-suite, completion, or final closeout gates until an operator repairs or resets the task.',
                commands: [],
                missingArtifacts: [],
                presentArtifacts: coreArtifacts.present,
                finalReport: null
            });
        }
        const childRoute = resolveNextUnfinishedChildRoute(
            taskEntries,
            taskId,
            new Set<string>(),
            extractExplicitLinkedChildTaskIds
        );
        const hasChildren = hasLinkedChildTasks(taskEntries, taskId);
        if (hasChildren) {
            const syncResult = transitionSplitRequiredParentToDecomposed({ repoRoot, eventsRoot, taskId });
            if (syncResult.outcome !== 'updated' && syncResult.outcome !== 'already_synced') {
                return buildResult({
                    ...resultBase,
                    status: 'SPLIT_REQUIRED',
                    nextGate: 'split-required-latch',
                    title: 'Split-required latch is active.',
                    reason:
                        `TASK.md marks ${formatNextStepInlineValue(taskId)} as SPLIT_REQUIRED, but the gate could not transition the parent to DECOMPOSED after detecting linked child tasks. ` +
                        `Status sync outcome: ${formatNextStepInlineValue(syncResult.outcome)}${syncResult.error_message ? ` (${syncResult.error_message})` : ''}. ` +
                        'Do not run classify, compile, review, full-suite, completion, or final closeout gates on the parent.',
                    commands: [],
                    missingArtifacts: [],
                    presentArtifacts: coreArtifacts.present,
                    finalReport: null
                });
            }
            if (childRoute) {
                const chain = [taskId, ...childRoute.chain].join(' -> ');
                return buildResult({
                    ...resultBase,
                    status: 'DECOMPOSED',
                    nextGate: 'child-task',
                    title: 'Split-required latch cleared; continue with the next child.',
                    reason:
                        'Linked child tasks were detected, so the gate transitioned the parent from SPLIT_REQUIRED to DECOMPOSED. ' +
                        `Parent tasks in this state are not executable lifecycle scopes. Continue through child chain ${chain}; ` +
                        `next unfinished child status is ${formatNextStepInlineValue(childRoute.status || 'unknown')}.`,
                    commands: [
                        buildCommand(
                            'Continue child task',
                            `${cliPrefix} next-step "${childRoute.taskId}" --repo-root "."`
                        )
                    ],
                    missingArtifacts: [],
                    presentArtifacts: coreArtifacts.present,
                    finalReport: null
                });
            }
            return buildResult({
                ...resultBase,
                status: 'DECOMPOSED',
                nextGate: null,
                title: 'Split-required latch cleared; no unfinished child remains.',
                reason:
                    'Linked child tasks were detected, so the gate transitioned the parent from SPLIT_REQUIRED to DECOMPOSED. ' +
                    'No unfinished child task could be resolved from its notes. Do not run classify, compile, review, full-suite, completion, or final closeout gates on the parent.',
                commands: [],
                missingArtifacts: [],
                presentArtifacts: coreArtifacts.present,
                finalReport: null
            });
        }
        return buildResult({
            ...resultBase,
            status: 'SPLIT_REQUIRED',
            nextGate: 'split-required-latch',
            title: 'Split-required latch is active.',
            reason:
                `TASK.md marks ${formatNextStepInlineValue(taskId)} as SPLIT_REQUIRED. ` +
                'This parent task was blocked by an auto-split guard and cannot continue through classify, compile, review, full-suite, completion, or final closeout gates. ' +
                'Create and link child tasks so the gate can transition the parent to DECOMPOSED, or use an explicit operator task-reset/discard command to clear the latch.',
            commands: [],
            missingArtifacts: [],
            presentArtifacts: coreArtifacts.present,
            finalReport: null
        });
    }

    if (isGatePassed(summary, 'completion-gate') && isLatestCompletionCurrent(eventsRoot, taskId)) {
        const hasFinalCloseoutArtifact = fs.existsSync(path.join(reviewsRoot, `${taskId}-final-closeout.json`))
            || fs.existsSync(path.join(reviewsRoot, `${taskId}-final-closeout.md`));
        if (hasFinalCloseoutArtifact) {
            const postDoneDrift = readPostDoneWorkspaceDriftDecision(
                repoRoot,
                preflight,
                path.join(reviewsRoot, `${taskId}-doc-impact.json`),
                path.join(reviewsRoot, `${taskId}-final-closeout.json`)
            );
            if (postDoneDrift.blocked) {
                return buildResult({
                    ...resultBase,
                    status: 'BLOCKED',
                    nextGate: 'post-done-drift',
                    title: 'Resolve tracked post-DONE workspace drift.',
                    reason: postDoneDrift.reason,
                    commands: [],
                    finalReport: null
                });
            }
        }
        if (summary.final_report_contract.status !== 'READY') {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'task-audit-summary',
                title: 'Final report integrity attestation is not ready.',
                reason:
                    `${summary.final_report_contract.blocker || 'Final report contract is not ready.'} ` +
                    'Do not deliver a task-complete final report until review integrity is independently attested or the scope requires no review.',
                commands: [],
                finalReport: null
            });
        }
        const finalReport = readReadyFinalReportSummary(repoRoot, reviewsRoot, taskId, summary);
        if (finalReport) {
            return buildResult({
                ...resultBase,
                status: 'DONE',
                nextGate: null,
                title: 'Task gate flow is complete.',
                reason: 'Completion gate passed and the canonical final closeout is materialized. Deliver the final report in the required order below; do not auto-commit without explicit user approval.',
                commands: [],
                finalReport
            });
        }
        return buildResult({
            ...resultBase,
            status: 'READY',
            nextGate: 'task-audit-summary',
            title: 'Materialize final closeout before stopping.',
            reason: 'Completion gate passed, but the canonical final closeout artifacts are not materialized yet. Run task-audit-summary to materialize the final report order and commit guidance before stopping.',
            commands: [
                buildCommand(
                    'Build final audit summary',
                    `${cliPrefix} gate task-audit-summary --task-id "${taskId}" --repo-root "."`
                )
            ],
            finalReport: null
        });
    }

    if (isTaskQueueDoneStatus(taskEntry?.status || null)) {
        const doneConflictBlockers = summary.blockers.map((blocker) => `${blocker.gate}: ${blocker.reason}`);
        if (!isGatePassed(summary, 'completion-gate')) {
            doneConflictBlockers.unshift('completion-gate: missing or not passed');
        } else if (!isLatestCompletionCurrent(eventsRoot, taskId)) {
            doneConflictBlockers.unshift('completion-gate: pass exists but is stale for the current task cycle');
        }
        if (summary.final_report_contract.status !== 'READY') {
            doneConflictBlockers.push(
                `final-closeout: ${summary.final_report_contract.blocker || 'canonical final closeout is not ready'}`
            );
        }
        if (doneConflictBlockers.length > 0 && !doneStatusHasCompletedClearedLatchEvidence) {
            const blockerSummary = doneConflictBlockers.slice(0, 4).join('; ');
            const extraBlockerCount = doneConflictBlockers.length > 4
                ? ` (+${doneConflictBlockers.length - 4} more blocker(s))`
                : '';
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'task-reset',
                title: 'TASK.md DONE conflicts with lifecycle evidence.',
                reason:
                    `TASK.md marks ${formatNextStepInlineValue(taskId)} as DONE, but current lifecycle evidence is not terminal-clean: ` +
                    `${blockerSummary}${extraBlockerCount}. ` +
                    'Completion-gate remains the only normal owner of DONE. Do not hand-edit TASK.md or run stale lifecycle gates while this false-DONE conflict exists; use explicit operator task-reset/reopen recovery first.',
                commands: [
                    buildCommand(
                        'Preview explicit operator reopen',
                        `${cliPrefix} gate task-reset --task-id "${taskId}" --reopen --dry-run --repo-root "."`
                    )
                ],
                missingArtifacts: coreArtifacts.missing,
                presentArtifacts: coreArtifacts.present,
                finalReport: null
            });
        }
        return buildResult({
            ...resultBase,
            status: 'DONE',
            nextGate: null,
            title: 'Task is already marked DONE in TASK.md.',
            reason:
                `TASK.md marks ${formatNextStepInlineValue(taskId)} as DONE. ` +
                'Treat this task as terminal and do not run stale lifecycle recovery, classify, compile, review, full-suite, or completion gates. ' +
                'Use an explicit operator task-reset/reopen command before starting a new lifecycle cycle for this task; do not hand-edit active TASK.md lifecycle statuses.',
            commands: [],
            missingArtifacts: [],
            presentArtifacts: coreArtifacts.present,
            finalReport: null
        });
    }

    if (!isGatePassed(summary, 'completion-gate') && isDecomposedParentTask(taskEntry)) {
        const completionState = isTaskQueueDecomposedStatus(taskEntry?.status || null)
            ? resolveDecomposedParentCompletionState(
                taskEntries,
                taskId,
                new Set<string>(),
                extractExplicitLinkedChildTaskIds
            )
            : null;
        const childRoute = completionState?.unfinishedRoute || resolveNextUnfinishedChildRoute(
            taskEntries,
            taskId,
            new Set<string>(),
            extractExplicitLinkedChildTaskIds
        );
        const decomposedReason = isTaskQueueDecomposedStatus(taskEntry?.status || null)
            ? 'Task queue marks this parent as DECOMPOSED.'
            : 'Task queue marks this parent as a legacy BLOCKED split umbrella.';
        if (childRoute) {
            const chain = [taskId, ...childRoute.chain].join(' -> ');
            return buildResult({
                ...resultBase,
                status: 'DECOMPOSED',
                nextGate: 'child-task',
                title: 'Parent task is decomposed; continue with the next child.',
                reason:
                    `${decomposedReason} Parent tasks in this state are not executable lifecycle scopes. ` +
                    `Continue through child chain ${chain}; next unfinished child status is ${formatNextStepInlineValue(childRoute.status || 'unknown')}.`,
                commands: [
                    buildCommand(
                        'Continue child task',
                        `${cliPrefix} next-step "${childRoute.taskId}" --repo-root "."`
                    )
                ],
                missingArtifacts: [],
                presentArtifacts: coreArtifacts.present,
                finalReport: null
            });
        }
        if (completionState?.hasLinkedChildren && completionState.missingChildTaskIds.length > 0) {
            return buildResult({
                ...resultBase,
                status: 'DECOMPOSED',
                nextGate: null,
                title: 'Parent task is decomposed but explicit child links are missing.',
                reason:
                    `${decomposedReason} Explicit child task link(s) could not be found in TASK.md: ` +
                    `${completionState.missingChildTaskIds.map(formatNextStepInlineValue).join(', ')}. ` +
                    'Do not mark the parent DONE or run stale parent gates until every explicit child task exists and reaches DONE, or the parent notes are corrected by an operator.',
                commands: [],
                missingArtifacts: [],
                presentArtifacts: coreArtifacts.present,
                finalReport: null
            });
        }
        if (completionState?.hasLinkedChildren && completionState.complete) {
            const tasksToComplete = [...new Set([...completionState.completedDecomposedTaskIds, taskId])];
            const syncResult = transitionDecomposedParentsToDone({
                repoRoot,
                eventsRoot,
                rootTaskId: taskId,
                taskIds: tasksToComplete
            });
            if (syncResult.outcome !== 'updated' && syncResult.outcome !== 'already_synced') {
                return buildResult({
                    ...resultBase,
                    status: 'DECOMPOSED',
                    nextGate: 'task-status-sync',
                    title: 'Decomposed parent completion status sync failed.',
                    reason:
                        `Every explicit child task under ${formatNextStepInlineValue(taskId)} appeared DONE, but the gate could not atomically transition ` +
                        `the completed decomposed parent task set from DECOMPOSED to DONE after write-time revalidation. ` +
                        `Status sync outcome: ${formatNextStepInlineValue(syncResult.outcome)}${syncResult.error_message ? ` (${syncResult.error_message})` : ''}. ` +
                        'Do not hand-edit TASK.md status cells; repair the task queue or rerun next-step after resolving the sync failure.',
                    commands: [],
                    missingArtifacts: [],
                    presentArtifacts: coreArtifacts.present,
                    finalReport: null
                });
            }
            const completedChain = syncResult.task_ids.join(', ');
            return buildResult({
                ...resultBase,
                status: 'DONE',
                nextGate: null,
                title: 'Decomposed parent completed because all explicit children are DONE.',
                reason:
                    `${decomposedReason} Every explicit child task, including nested decomposed children, is DONE. ` +
                    `The gate-owned status sync transitioned completed parent task(s) to DONE: ${completedChain}. ` +
                    'Do not run stale parent classify, compile, review, full-suite, or completion gates unless an operator explicitly reopens the task.',
                commands: [],
                missingArtifacts: [],
                presentArtifacts: coreArtifacts.present,
                finalReport: null
            });
        }
        return buildResult({
            ...resultBase,
            status: 'DECOMPOSED',
            nextGate: null,
            title: 'Parent task is decomposed and has no unfinished child.',
            reason:
                `${decomposedReason} No unfinished child task could be resolved from its notes. ` +
                'Do not run classify, compile, review, full-suite, or completion gates on the parent; add or reopen a child task if the parent objective is not complete.',
            commands: [],
            missingArtifacts: [],
            presentArtifacts: coreArtifacts.present,
            finalReport: null
        });
    }

    if (!isGatePassed(summary, 'enter-task-mode')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Enter task mode first.',
            reason: defaultExecutionProvider
                ? 'No TASK_MODE_ENTERED event exists for this task.'
                : 'No TASK_MODE_ENTERED event exists for this task, and runtime provider could not be detected from GARDA_EXECUTION_PROVIDER or known provider environment markers. Set GARDA_EXECUTION_PROVIDER to the current execution provider before running the command; do not use SourceOfTruth as a runtime-provider fallback.',
            commands: [
                buildCommand(
                    'Enter task mode',
                    buildEnterTaskModeCommand(cliPrefix, taskId, taskEntry, defaultExecutionProvider)
                )
            ]
        });
    }

    const startupCycleReadiness = readStartupCycleReadiness(repoRoot, eventsRoot, taskId, taskModePath);
    if (!startupCycleReadiness.ready) {
        const command = startupCycleReadiness.nextGate === 'load-rule-pack'
            ? buildTaskEntryRulePackCommand(repoRoot, cliPrefix, taskId, taskModePath)
            : startupCycleReadiness.nextGate === 'handshake-diagnostics'
                ? `${cliPrefix} gate handshake-diagnostics --task-id "${taskId}" --repo-root "."`
                : `${cliPrefix} gate shell-smoke-preflight --task-id "${taskId}" --repo-root "."`;
        const label = startupCycleReadiness.nextGate === 'load-rule-pack'
            ? 'Load TASK_ENTRY rules'
            : startupCycleReadiness.nextGate === 'handshake-diagnostics'
                ? 'Run handshake diagnostics'
                : 'Run shell smoke preflight';
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: startupCycleReadiness.nextGate,
            title: startupCycleReadiness.title,
            reason: startupCycleReadiness.reason,
            commands: [buildCommand(label, command)]
        });
    }

    if (!isGatePassed(summary, 'load-rule-pack') || resolveRulePackStage(rulePack) !== 'TASK_ENTRY' && !preflight) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'load-rule-pack',
            title: 'Record TASK_ENTRY rule files.',
            reason: 'Task execution must record the loaded core workflow rule pack before preflight.',
            commands: [buildCommand('Load TASK_ENTRY rules', buildTaskEntryRulePackCommand(repoRoot, cliPrefix, taskId, taskModePath))]
        });
    }

    if (!isGatePassed(summary, 'handshake-diagnostics')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'handshake-diagnostics',
            title: 'Run handshake diagnostics.',
            reason: 'Runtime identity and reviewer launchability have not been recorded.',
            commands: [
                buildCommand('Run handshake diagnostics', `${cliPrefix} gate handshake-diagnostics --task-id "${taskId}" --repo-root "."`)
            ]
        });
    }

    if (!isGatePassed(summary, 'shell-smoke-preflight')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'shell-smoke-preflight',
            title: 'Run shell smoke preflight.',
            reason: 'CLI launchability and filesystem probes have not been recorded.',
            commands: [
                buildCommand('Run shell smoke preflight', `${cliPrefix} gate shell-smoke-preflight --task-id "${taskId}" --repo-root "."`)
            ]
        });
    }

    if (!preflight || !isGatePassed(summary, 'classify-change')) {
        const failedGateRecovery = readFailedGateRecovery(repoRoot, eventsRoot, taskId, cliPrefix, taskMode);
        if (failedGateRecovery) {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: failedGateRecovery.nextGate,
                title: failedGateRecovery.title,
                reason: failedGateRecovery.reason,
                commands: [
                    buildCommand(failedGateRecovery.label, failedGateRecovery.command)
                ]
            });
        }

        const classifyCommand = buildClassifyChangeCommand({
            repoRoot,
            cliPrefix,
            taskId,
            taskMode,
            taskModePath,
            preflightCommandPath,
            includePlannedScope: true
        });
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'classify-change',
            title: 'Classify the task scope.',
            reason: 'No current preflight artifact exists, so required reviews and compile scope are unknown.',
            commands: [
                buildCommand(
                    'Classify changed files',
                    classifyCommand
                )
            ]
        });
    }

    const docImpactPath = path.join(reviewsRoot, `${taskId}-doc-impact.json`);
    const preflightWorkspaceReadiness = preflight
        ? readPreflightWorkspaceReadiness(repoRoot, preflight, {
            failedReviewType: null,
            failedReviewVerdict: null,
            docImpactPath
        })
        : { ready: false, reason: 'No current preflight exists.' };
    const preflightCycleReadiness = readPreflightCycleReadiness(
        eventsRoot,
        taskId,
        buildStaleCompletionFailureDocCloseoutAllowance(
            repoRoot,
            eventsRoot,
            taskId,
            preflightPath,
            preflightSha256,
            preflightWorkspaceReadiness,
            docImpactPath
        )
    );
    if (!preflightCycleReadiness.ready) {
        const classifyCommand = buildClassifyChangeCommand({
            repoRoot,
            cliPrefix,
            taskId,
            taskMode,
            taskModePath,
            preflightCommandPath,
            includePlannedScope: false,
            changedFiles: getPreflightRefreshChangedFiles(taskMode, preflight)
        });
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'classify-change',
            title: 'Refresh preflight for the current task cycle.',
            reason: preflightCycleReadiness.reason,
            commands: [
                buildCommand(
                    'Refresh preflight',
                    classifyCommand
                )
            ]
        });
    }

    if (
        preflightTouchesProtectedControlPlane(preflight)
        && !taskMode?.orchestrator_work
    ) {
        if (isGardaSelfGuardDenyAgentEntry(repoRoot)) {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'operator-maintenance',
                title: 'Garda self-guard blocks agent-owned protected control-plane work.',
                reason:
                    'The current preflight touches protected Garda control-plane files. ' +
                    formatGardaSelfGuardProtectedControlPlaneGuidance(),
                commands: [
                    buildCommand(
                        'Operator policy change',
                        buildGardaSelfGuardPolicyChangeCommand(cliPrefix)
                    )
                ]
            });
        }
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Restart task mode as orchestrator work.',
            reason: 'The current preflight touches protected orchestrator control-plane files, but task-mode evidence does not declare --orchestrator-work. Fresh operator approval is required before the agent can rerun protected task-mode entry.',
            commands: [
                buildCommand(
                    'Restart task mode with orchestrator work',
                    buildOrchestratorWorkRestartCommand(cliPrefix, taskId, taskMode)
                )
            ]
        });
    }

    const failedCurrentReviewStateForPreflight = reviewLaunchPlan.next_review_type
        ? reviewStates.find((candidate) => (
            candidate.reviewType === reviewLaunchPlan.next_review_type && candidate.failed
        ))
        : undefined;
    const effectivePreflightWorkspaceReadiness = failedCurrentReviewStateForPreflight
        ? readPreflightWorkspaceReadiness(repoRoot, preflight, {
            failedReviewType: failedCurrentReviewStateForPreflight?.reviewType || null,
            failedReviewVerdict: failedCurrentReviewStateForPreflight?.verdictToken || failedCurrentReviewStateForPreflight?.failToken || null,
            docImpactPath
        })
        : preflightWorkspaceReadiness;
    if (!effectivePreflightWorkspaceReadiness.ready) {
        const classifyCommand = buildClassifyChangeCommand({
            repoRoot,
            cliPrefix,
            taskId,
            taskMode,
            taskModePath,
            preflightCommandPath,
            includePlannedScope: false,
            changedFiles: effectivePreflightWorkspaceReadiness.currentChangedFiles
                ?? getPreflightRefreshChangedFiles(taskMode, preflight)
        });
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'classify-change',
            title: 'Refresh preflight for the current workspace.',
            reason: effectivePreflightWorkspaceReadiness.reason,
            commands: [
                buildCommand(
                    'Refresh preflight',
                    classifyCommand
                )
            ]
        });
    }

    const coherentCycleReadiness = readCoherentCycleReadiness(
        repoRoot,
        eventsRoot,
        reviewsRoot,
        taskId,
        preflightPath,
        taskModePath
    );
    if (!coherentCycleReadiness.ready) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'restart-coherent-cycle',
            title: 'Restart the latest coherent task cycle.',
            reason: coherentCycleReadiness.reason,
            commands: [
                buildCommand(
                    'Restart coherent cycle',
                    coherentCycleReadiness.command || navigatorCommand
                )
            ]
        });
    }

    const postPreflightRulePackReadiness = readPostPreflightRulePackReadiness(
        repoRoot,
        taskId,
        preflightPath,
        rulePackPath,
        taskModePath
    );
    if (resolveRulePackStage(rulePack) !== 'POST_PREFLIGHT' || !postPreflightRulePackReadiness.ready) {
        const canBindPostPreflightRules = resolveRulePackStage(rulePack) === 'POST_PREFLIGHT'
            && postPreflightRulePackReadiness.rebind?.can_bind === true;
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: canBindPostPreflightRules ? 'bind-rule-pack-to-preflight' : 'load-rule-pack',
            title: canBindPostPreflightRules
                ? 'Bind existing POST_PREFLIGHT rule-pack evidence to the current preflight.'
                : 'Read and record POST_PREFLIGHT rule files.',
            reason: canBindPostPreflightRules
                ? `${postPreflightRulePackReadiness.rebind?.reason || 'Rule files are already loaded.'} Rebind the machine-readable evidence to the latest preflight before compile.`
                : postPreflightRulePackReadiness.ready
                ? 'Preflight exists; downstream rule files and risk-specific packs must be recorded for the current scope.'
                : postPreflightRulePackReadiness.reason,
            commands: [
                buildCommand(
                    canBindPostPreflightRules ? 'Bind POST_PREFLIGHT rules to current preflight' : 'Load POST_PREFLIGHT rules',
                    canBindPostPreflightRules
                        ? buildPostPreflightRulePackBindCommand(
                            repoRoot,
                            cliPrefix,
                            taskId,
                            taskModePath
                        )
                        : buildPostPreflightRulePackCommandForFiles(
                        repoRoot,
                        cliPrefix,
                        taskId,
                        getPostPreflightRuleFileNames(preflight, taskMode),
                        taskModePath
                    )
                )
            ]
        });
    }

    let scopeBudgetGuardEvaluation: ScopeBudgetGuardEvaluation | null = null;
    try {
        scopeBudgetGuardEvaluation = readScopeBudgetGuardEvaluation(
            repoRoot,
            preflight,
            profileSummary,
            requiredReviewTypes
        );
    } catch (error: unknown) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'workflow-config-validation',
            title: 'Validate workflow configuration before continuing.',
            reason: error instanceof Error ? error.message : String(error),
            commands: [
                buildCommand(
                    'Validate workflow config',
                    `${cliPrefix} workflow validate --target-root "."`
                )
            ]
        });
    }
    if (scopeBudgetGuardEvaluation?.should_block) {
        const guardReason = sanitizeScopeBudgetGuardSummary(scopeBudgetGuardEvaluation);
        const latchResult = materializeSplitRequiredLatch({
            repoRoot,
            eventsRoot,
            reviewsRoot,
            taskId,
            guardKind: 'scope_budget',
            guardReason,
            rawGuardSummary: scopeBudgetGuardEvaluation.summary_line,
            preflightPath,
            guardDetails: {
                action: scopeBudgetGuardEvaluation.action,
                profile_name: scopeBudgetGuardEvaluation.profile_name,
                violations: scopeBudgetGuardEvaluation.violations.map((violation) => ({
                    metric: violation.metric,
                    actual: violation.actual,
                    limit: violation.limit
                }))
            }
        });
        if (!isSuccessfulSplitRequiredStatusSync(latchResult.status_sync)) {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'split-required-latch',
                title: 'Split-required latch could not update TASK.md.',
                reason:
                    `${guardReason}. The split-required latch artifact was materialized at ${formatNextStepInlineValue(toRepoDisplayPath(repoRoot, latchResult.artifact_path))}, ` +
                    `but TASK.md status sync failed with outcome ${formatNextStepInlineValue(latchResult.status_sync.outcome)}. ` +
                    `${latchResult.status_sync.error_message ? `${latchResult.status_sync.error_message} ` : ''}` +
                    'Do not continue parent compile, review, full-suite, completion, or final closeout gates until the latch is repaired.',
                commands: [],
                finalReport: null
            });
        }
        return buildResult({
            ...resultBase,
            status: 'SPLIT_REQUIRED',
            nextGate: 'split-required-latch',
            title: 'Split-required latch is active.',
            reason:
                `${guardReason}. The gate moved this parent task to SPLIT_REQUIRED and materialized latch evidence at ` +
                `${formatNextStepInlineValue(toRepoDisplayPath(repoRoot, latchResult.artifact_path))}. ` +
                'Create and link child tasks before continuing; do not shrink or reshape the diff merely to bypass the guard. ' +
                'Ordinary classify, compile, review, full-suite, completion, and final closeout gates are suppressed for the parent while the latch is active.',
            commands: [],
            missingArtifacts: [],
            presentArtifacts: coreArtifacts.present,
            finalReport: null
        });
    }

    let reviewCycleGuardEvaluation: ReviewCycleGuardEvaluation | null = null;
    let latestFailedReviewCycleAttempt: NextStepReviewCycleLatestFailedReview | null = null;
    try {
        const reviewCycleGuardResult = readReviewCycleGuardEvaluation(repoRoot, eventsRoot, taskId);
        reviewCycleGuardEvaluation = reviewCycleGuardResult.evaluation;
        latestFailedReviewCycleAttempt = reviewCycleGuardResult.latestFailedReview;
    } catch (error: unknown) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'workflow-config-validation',
            title: 'Validate workflow configuration before continuing.',
            reason: error instanceof Error ? error.message : String(error),
            commands: [
                buildCommand(
                    'Validate workflow config',
                    `${cliPrefix} workflow validate --target-root "."`
                )
            ]
        });
    }
    if (reviewCycleGuardEvaluation?.should_block) {
        const reviewCycleBlock = buildReviewCycleOperatorBlock(
            repoRoot,
            reviewsRoot,
            taskId,
            reviewCycleGuardEvaluation,
            latestFailedReviewCycleAttempt
        );
        const autoSplitEnabled = reviewCycleBlock.auto_split_enabled;
        let splitRequiredLatch: SplitRequiredLatchResult | null = null;
        if (autoSplitEnabled) {
            splitRequiredLatch = materializeSplitRequiredLatch({
                repoRoot,
                eventsRoot,
                reviewsRoot,
                taskId,
                guardKind: 'review_cycle',
                guardReason: reviewCycleBlock.reason,
                rawGuardSummary: reviewCycleGuardEvaluation.summary_line,
                preflightPath,
                guardDetails: {
                    action: reviewCycleGuardEvaluation.action,
                    total_non_test_review_count: reviewCycleGuardEvaluation.total_non_test_review_count,
                    failed_non_test_review_count: reviewCycleGuardEvaluation.failed_non_test_review_count,
                    excluded_review_types: reviewCycleGuardEvaluation.excluded_review_types,
                    violations: reviewCycleGuardEvaluation.violations.map((violation) => ({
                        metric: violation.metric,
                        actual: violation.actual,
                        limit: violation.limit
                    })),
                    auto_split_prompt: reviewCycleBlock.auto_split_prompt
                }
            });
            if (!isSuccessfulSplitRequiredStatusSync(splitRequiredLatch.status_sync)) {
                return buildResult({
                    ...resultBase,
                    status: 'BLOCKED',
                    nextGate: 'split-required-latch',
                    title: 'Split-required latch could not update TASK.md.',
                    reason:
                        `${reviewCycleBlock.reason}. The split-required latch artifact was materialized at ` +
                        `${formatNextStepInlineValue(toRepoDisplayPath(repoRoot, splitRequiredLatch.artifact_path))}, ` +
                        `but TASK.md status sync failed with outcome ${formatNextStepInlineValue(splitRequiredLatch.status_sync.outcome)}. ` +
                        `${splitRequiredLatch.status_sync.error_message ? `${splitRequiredLatch.status_sync.error_message} ` : ''}` +
                        'Do not continue parent compile, review, full-suite, completion, or final closeout gates until the latch is repaired.',
                    commands: [],
                    reviewCycleBlock,
                    finalReport: null
                });
            }
        }
        return buildResult({
            ...resultBase,
            status: autoSplitEnabled ? 'SPLIT_REQUIRED' : 'BLOCKED',
            nextGate: autoSplitEnabled ? 'split-required-latch' : 'review-cycle-attempt-guard',
            title: autoSplitEnabled ? 'Split-required latch is active.' : 'Review cycle limit exceeded.',
            reason:
                `${reviewCycleBlock.reason}. ` +
                `Counts: total_non_test_reviews=${reviewCycleGuardEvaluation.total_non_test_review_count}, ` +
                `failed_non_test_reviews=${reviewCycleGuardEvaluation.failed_non_test_review_count}, ` +
                `excluded_review_types=${formatNextStepInlineList(reviewCycleGuardEvaluation.excluded_review_types)}. ` +
                (autoSplitEnabled
                    ? `The gate moved this parent task to SPLIT_REQUIRED and materialized latch evidence at ${formatNextStepInlineValue(toRepoDisplayPath(repoRoot, splitRequiredLatch?.artifact_path || ''))}. Follow the auto-split prompt artifact and create linked child tasks before continuing child work.`
                    : 'The configured workflow guard blocks additional compile, review, or full-suite continuation until operator decision; wait for the operator before continuing.'),
            commands: autoSplitEnabled
                ? []
                : [
                    buildCommand(
                        'Inspect review cycle guard',
                        `${cliPrefix} workflow explain --target-root "."`
                    )
                ],
            reviewCycleBlock,
            missingArtifacts: autoSplitEnabled ? [] : resultBase.missingArtifacts,
            presentArtifacts: coreArtifacts.present,
            finalReport: null
        });
    }
    if (
        reviewCycleGuardEvaluation?.active
        && reviewCycleGuardEvaluation.action === 'WARN_ONLY'
        && reviewCycleGuardEvaluation.violations.length > 0
    ) {
        resultBase.warnings.push(
            `${reviewCycleGuardEvaluation.summary_line}. ` +
            `Counts: total_non_test_reviews=${reviewCycleGuardEvaluation.total_non_test_review_count}, ` +
            `failed_non_test_reviews=${reviewCycleGuardEvaluation.failed_non_test_review_count}, ` +
            `excluded_review_types=${formatNextStepInlineList(reviewCycleGuardEvaluation.excluded_review_types)}.`
        );
    }

    const compileReadiness = preflight
        ? readCompileReadiness(repoRoot, reviewsRoot, taskId, preflightPath)
        : { ready: false, reason: 'No current preflight exists.' };
    if (!isGatePassed(summary, 'compile-gate') || !compileReadiness.ready) {
        const compileCommand = buildCompileGateCommand(
            repoRoot,
            cliPrefix,
            taskId,
            preflightCommandPath,
            taskModePath
        );
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'compile-gate',
            title: 'Run compile gate.',
            reason: compileReadiness.reason,
            commands: [
                buildCommand(
                    'Run compile gate',
                    compileCommand
                )
            ]
        });
    }

    if (shouldRunFullSuiteAfterCompileBeforeReviews(
        fullSuiteConfig.enabled,
        fullSuiteConfig.placement,
        fullSuiteNotRequiredForCurrentScope
    )) {
        if (fullSuiteGateStatus === 'FAIL') {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'implementation',
                title: 'Fix full-suite failures before reviewer launch.',
                reason:
                    `Full-suite validation is configured for placement '${fullSuiteConfig.placement}' and already failed for the current compiled scope. ` +
                    `Do not launch independent reviewers until the configured full-suite command passes; ` +
                    `fix the failures, rerun compile-gate if implementation changed, then rerun full-suite-validation.`,
                commands: [
                    buildCommand(
                        'Rerun navigator after fixing implementation',
                        navigatorCommand
                    )
                ]
            });
        }
        if (!fullSuiteGatePassed) {
            const fullSuiteCommand = `${cliPrefix} gate full-suite-validation --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`;
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'full-suite-validation',
                title: 'Run full-suite validation after compile before reviews.',
                reason:
                    `Effective workflow config enables full-suite validation at ${fullSuiteSummary.config_path} with placement '${fullSuiteConfig.placement}'. ` +
                    `Run it after compile-gate and before launching independent reviewers so suite failures fail fast on the same compiled scope. ` +
                    `The final closeout can reuse this artifact only if no relevant task scope changes occur afterward. ` +
                    `Command: ${fullSuiteConfig.command}. ${fullSuiteTimeoutForecastLine || ''}`.trim(),
                commands: [
                    buildCommand(
                        'Run full-suite validation',
                        fullSuiteCommand
                    )
                ]
            });
        }
    }

    if (
        shouldRunFullSuiteBeforeTestReview(
            fullSuiteConfig.enabled,
            fullSuiteConfig.placement,
            fullSuiteNotRequiredForCurrentScope
        )
        && reviewLaunchPlan.next_review_type === 'test'
    ) {
        if (fullSuiteGateStatus === 'FAIL') {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'implementation',
                title: 'Fix full-suite failures before launching test review.',
                reason:
                    `Full-suite validation is enabled and already failed for the current compiled scope. ` +
                    `Do not launch the mandatory test reviewer until the configured full-suite command passes; ` +
                    `fix the failures, rerun compile-gate if implementation changed, then rerun full-suite-validation.`,
                commands: [
                    buildCommand(
                        'Rerun navigator after fixing implementation',
                        navigatorCommand
                    )
                ]
            });
        }
        if (!fullSuiteGatePassed) {
            const fullSuiteCommand = `${cliPrefix} gate full-suite-validation --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`;
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'full-suite-validation',
                title: 'Run full-suite validation before test review.',
                reason:
                    `Effective workflow config enables full-suite validation at ${fullSuiteSummary.config_path} with placement '${fullSuiteConfig.placement}'. ` +
                    `Run it before launching the mandatory test reviewer so suite failures fail fast on the same compiled scope. ` +
                    `The final closeout can reuse this artifact only if no relevant task scope changes occur afterward. ` +
                    `Command: ${fullSuiteConfig.command}. ${fullSuiteTimeoutForecastLine || ''}`.trim(),
                commands: [
                    buildCommand(
                        'Run full-suite validation',
                        fullSuiteCommand
                    )
                ]
            });
        }
    }

    if (reviewLaunchPlan.next_review_type) {
        const reviewType = reviewLaunchPlan.next_review_type;
        const state = reviewStates.find((candidate) => candidate.reviewType === reviewType);
        const currentReviewReuseRecorded = state
            ? state.reusedExistingReview && timelineHasReviewReuseRecordedAfterCompile(eventsRoot, taskId, state)
            : false;
        const currentReviewEvidenceSatisfied = state
            ? reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, state)
            : false;
        const currentReviewRecordedEvidenceCurrent = state
            ? reviewStateHasCurrentRecordedEvidence(repoRoot, eventsRoot, taskId, state)
            : false;
        const currentReviewContextInvocationAttested = state
            ? timelineHasDelegatedReviewInvocationForCurrentContext(repoRoot, eventsRoot, taskId, state)
            : false;
        const currentReviewContextPrepared = state
            ? timelineHasReviewContextPreparedAfterCompile(eventsRoot, taskId, reviewType, state.contextPath)
            : false;
        const dependencies = reviewLaunchPlan.blocked_review_dependencies;
        const reviewDepth = getEffectiveDepthForPostPreflightRules(preflight, taskMode);
        const scopedDiffMetadataPath = path.join(reviewsRoot, `${taskId}-${reviewType}-scoped.json`);
        const scopedDiffOutputPath = path.join(reviewsRoot, `${taskId}-${reviewType}-scoped.diff`);
        const scopedDiffReadiness = scopedDiffExpectedForReview({
            preflight,
            reviewType
        })
            ? getScopedDiffMetadataReadiness({
                metadataPath: scopedDiffMetadataPath,
                preflight,
                preflightPath,
                preflightSha256,
                reviewType
            })
            : { ready: true, reason: 'Scoped diff metadata is not required for this review context.' };
        const reviewerReadinessChain = buildReviewerReadinessChainSummary(
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            state
        );
        if (dependencies.length > 0) {
            const dependencyDetails = describeBlockedReviewDependencies(dependencies, reviewStates);
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'build-review-context',
                title: `Review '${reviewType}' is waiting for upstream review evidence.`,
                reason: `Configured review policy '${reviewPolicy.mode}' requires upstream PASS evidence before '${reviewType}': ${dependencyDetails}. Do not launch '${reviewType}' reviewer until those dependencies pass. ${reviewerReadinessChain}`,
                commands: [
                    buildCommand(
                        'Finish upstream review first',
                        navigatorCommand
                    )
                ]
            });
        }
        if (state?.failed && state.failureKind === 'launch-package' && currentReviewRecordedEvidenceCurrent) {
            const taskIntent = getStringField(taskMode, 'task_summary', taskEntry?.title || taskId);
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'reviewer-launch-retry',
                title: `Retry '${reviewType}' reviewer launch package.`,
                reason:
                    `Recorded '${reviewType}' review verdict is '${state.verdictToken || state.failToken || 'FAILED'}', ` +
                    `but the failure matches reviewer launch package or binding evidence (${state.failureReason || 'launch package mismatch'}). ` +
                    'Preserve the failed review artifact and receipt as audit evidence; do not edit them by hand and do not make fake implementation changes. ' +
                    `Restart the review cycle to rebuild '${reviewType}' launch metadata and launch a fresh reviewer before downstream reviews.`,
                commands: [
                    buildCommand(
                        'Restart review cycle for reviewer launch retry',
                        [
                            `${cliPrefix} gate restart-review-cycle`,
                            `--task-id "${taskId}"`,
                            `--task-intent ${quoteCommandValue(taskIntent)}`,
                            `--impact-analysis ${quoteCommandValue('<replace with main-agent remediation impact analysis>')}`,
                            ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
                            '--repo-root "."'
                        ].join(' ')
                    )
                ]
            });
        }
        if (state?.failed && currentReviewRecordedEvidenceCurrent) {
            const downstreamReviewTypes = getDownstreamReviewTypesFor(
                reviewType,
                requiredReviewTypes,
                summary.required_reviews,
                reviewPolicy.mode
            );
            const downstreamText = downstreamReviewTypes.length > 0
                ? ` Dependent reviews currently blocked by this failure: ${downstreamReviewTypes.join(', ')}.`
                : '';
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'implementation',
                title: `Fix failed '${reviewType}' review findings before continuing.`,
                reason:
                    `Recorded '${reviewType}' review verdict is '${state.verdictToken || state.failToken || 'FAILED'}'. ` +
                    `Do not launch downstream reviewers or rerun '${reviewType}' before implementation changes are made. ` +
                    `Fix the findings, rerun compile-gate, then rebuild and rerun '${reviewType}' review.${downstreamText}`,
                commands: [
                    buildCommand(
                        'Rerun navigator after fixing implementation',
                        navigatorCommand
                    )
                ]
            });
        }
        if (state?.failed && !currentReviewRecordedEvidenceCurrent && !currentReviewContextPrepared) {
            const reviewContextChain = buildReviewGateChainStatusSummary({
                repoRoot,
                eventsRoot,
                taskId,
                reviewType,
                edgeId: 'compile-to-review-context',
                reason: `latest compile evidence is current before rebuilding '${reviewType}' review context`,
                preflightPath: preflightCommandPath,
                reviewContextPath: state.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
                depth: reviewDepth
            });
            if (!scopedDiffReadiness.ready) {
                return buildResult({
                    ...resultBase,
                    status: 'BLOCKED',
                    nextGate: 'build-scoped-diff',
                    title: `Prepare '${reviewType}' scoped diff metadata.`,
                    reason:
                        `${scopedDiffReadiness.reason} A previous '${reviewType}' review recorded ` +
                        `'${state.verdictToken || state.failToken || 'FAILED'}', but scoped diff metadata must be refreshed ` +
                        `before rebuilding '${reviewType}' review context. ${reviewerReadinessChain} ${reviewContextChain}`,
                    commands: [
                        buildCommand(
                            'Build scoped diff',
                            `${cliPrefix} gate build-scoped-diff --review-type "${reviewType}" --preflight-path "${preflightCommandPath}" --output-path "${toRepoDisplayPath(repoRoot, scopedDiffOutputPath)}" --metadata-path "${toRepoDisplayPath(repoRoot, scopedDiffMetadataPath)}" --repo-root "."`
                        )
                    ]
                });
            }
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'build-review-context',
                title: `Refresh '${reviewType}' review context after implementation changes.`,
                reason:
                    `A previous '${reviewType}' review recorded '${state.verdictToken || state.failToken || 'FAILED'}', ` +
                    'but that failed-review routing is no longer current after the latest compile cycle. ' +
                    `Rebuild '${reviewType}' review context and launch a fresh reviewer before any dependent reviews. ${reviewerReadinessChain} ${reviewContextChain}`,
                commands: [
                    buildCommand(
                        'Build review context',
                        buildReviewContextCommand(repoRoot, cliPrefix, taskId, reviewType, reviewDepth, preflightCommandPath, taskModePath)
                    )
                ]
            });
        }
        if (!state || !state.contextExists || !state.contextCurrent) {
            const reviewContextChain = buildReviewGateChainStatusSummary({
                repoRoot,
                eventsRoot,
                taskId,
                reviewType,
                edgeId: 'compile-to-review-context',
                reason: `latest compile evidence is current before '${reviewType}' review-context preparation`,
                preflightPath: preflightCommandPath,
                reviewContextPath: state?.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
                depth: reviewDepth
            });
            const contextDetails = state?.violations
                .filter((violation) => violation.includes('review context'))
                .join(' ');
            const contextDetailsSuffix = contextDetails ? ` ${contextDetails}` : '';
            if (!scopedDiffReadiness.ready) {
                return buildResult({
                    ...resultBase,
                    status: 'BLOCKED',
                    nextGate: 'build-scoped-diff',
                    title: `Prepare '${reviewType}' scoped diff metadata.`,
                    reason: `${scopedDiffReadiness.reason} Required '${reviewType}' review contexts for code-changing scopes must include scoped diff metadata before reviewer routing. ${reviewerReadinessChain} ${reviewContextChain}`,
                    commands: [
                        buildCommand(
                            'Build scoped diff',
                            `${cliPrefix} gate build-scoped-diff --review-type "${reviewType}" --preflight-path "${preflightCommandPath}" --output-path "${toRepoDisplayPath(repoRoot, scopedDiffOutputPath)}" --metadata-path "${toRepoDisplayPath(repoRoot, scopedDiffMetadataPath)}" --repo-root "."`
                        )
                    ]
                });
            }
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'build-review-context',
                title: `Prepare '${reviewType}' review context.`,
                reason: !state || !state.contextExists
                    ? `Required review '${reviewType}' has no canonical review-context artifact. ${reviewerReadinessChain} ${reviewContextChain}`
                    : `Required review '${reviewType}' review-context artifact is stale for the current preflight.${contextDetailsSuffix} ${reviewerReadinessChain} ${reviewContextChain}`,
                commands: [
                    buildCommand(
                        'Build review context',
                        buildReviewContextCommand(repoRoot, cliPrefix, taskId, reviewType, reviewDepth, preflightCommandPath, taskModePath)
                    )
                ]
            });
        }
        const contextReviewerIdentity = state.contextReviewerIdentity || '';
        if (
            !currentReviewReuseRecorded
            && (
                !contextReviewerIdentity.startsWith('agent:')
                || !timelineHasDelegatedReviewRoutingAfterCompile(eventsRoot, taskId, reviewType, contextReviewerIdentity)
            )
        ) {
            const reviewerIdentity = contextReviewerIdentity || '<agent:reviewer-session-id-from-delegated-agent>';
            const reviewRoutingChain = buildReviewGateChainStatusSummary({
                repoRoot,
                eventsRoot,
                taskId,
                reviewType,
                edgeId: 'review-context-to-routing',
                reason: `current '${reviewType}' review context is ready for routing before reviewer launch preparation`,
                preflightPath: preflightCommandPath,
                reviewContextPath: state?.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
                depth: reviewDepth
            });
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'record-review-routing',
                title: `Record '${reviewType}' delegated reviewer routing.`,
                reason: `Required review '${reviewType}' needs current REVIEWER_DELEGATION_ROUTED telemetry after the latest compile pass before a review receipt can be recorded. ${REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION} ${REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION} ${REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION} ${reviewerReadinessChain} ${reviewRoutingChain}`,
                commands: [
                    buildCommand(
                        'Record fresh delegated review routing',
                        buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'record-review-routing', [
                            `--review-type "${reviewType}"`,
                            '--reviewer-execution-mode "delegated_subagent"',
                            `--reviewer-identity "${reviewerIdentity}"`
                        ], taskModePath)
                    )
                ]
            });
        }
        if (
            !currentReviewReuseRecorded
            && !currentReviewContextInvocationAttested
            && (
                !state.artifactExists
                || !state.receiptExists
                || state.reviewerIdentity !== state.contextReviewerIdentity
                || state.ready
            )
        ) {
            const reviewerIdentity = state.contextReviewerIdentity
                || '<agent:reviewer-session-id-from-review-context>';
            const launchArtifactPath = buildDefaultReviewScratchCommandPath(
                repoRoot,
                taskId,
                reviewType,
                'reviewer-launch.json'
            );
            const launchArtifactState = getCurrentReviewerLaunchArtifactStateForInvocation(
                repoRoot,
                eventsRoot,
                taskId,
                state
            );
            if (launchArtifactState === 'missing_or_invalid') {
                const launchPreparationChain = buildReviewGateChainStatusSummary({
                    repoRoot,
                    eventsRoot,
                    taskId,
                    reviewType,
                    edgeId: 'review-routing-to-launch-prepared',
                    reason: `current '${reviewType}' routing telemetry is ready before reviewer launch preparation`,
                    preflightPath: preflightCommandPath,
                    reviewContextPath: state.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
                    depth: reviewDepth
                });
                return buildResult({
                    ...resultBase,
                    status: 'BLOCKED',
                    nextGate: 'prepare-reviewer-launch',
                    title: `Prepare '${reviewType}' delegated reviewer launch metadata.`,
                    reason: `Required review '${reviewType}' needs task-owned reviewer launch metadata bound to the current routing event and review context before launch. This prepares hashes and prompt paths only; it is not completed invocation evidence. ${reviewerReadinessChain} ${launchPreparationChain}`,
                    commands: [
                    buildCommand(
                        'Prepare delegated reviewer launch metadata',
                            buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'prepare-reviewer-launch', [
                                `--review-type "${reviewType}"`,
                                '--reviewer-execution-mode "delegated_subagent"',
                                `--reviewer-identity "${reviewerIdentity}"`,
                                `--reviewer-launch-artifact-path "${launchArtifactPath}"`
                            ], taskModePath)
                        )
                    ]
                });
            }
            if (launchArtifactState === 'prepared') {
                const launchCompletionChain = buildReviewGateChainStatusSummary({
                    repoRoot,
                    eventsRoot,
                    taskId,
                    reviewType,
                    edgeId: 'review-launch-prepared-to-launch-completed',
                    reason: `prepared '${reviewType}' launch metadata is ready to be completed with provider-owned invocation evidence`,
                    preflightPath: preflightCommandPath,
                    reviewContextPath: state.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
                    depth: reviewDepth
                });
                return buildResult({
                    ...resultBase,
                    status: 'BLOCKED',
                nextGate: 'complete-reviewer-launch',
                title: `Complete '${reviewType}' delegated reviewer launch metadata.`,
                reason:
                    `Required review '${reviewType}' has prepared launch metadata for the current routing event and review context. ` +
                    `Launch the delegated reviewer with the prepared prompt path as an opaque handoff, then run complete-reviewer-launch so the gate records post-launch fields, including its own launch timestamp, before invocation attestation. ${REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION} ${REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION} ${reviewerReadinessChain} ${launchCompletionChain}`,
                commands: [
                    buildCommand(
                        'Complete delegated reviewer launch metadata',
                            `${cliPrefix} gate complete-reviewer-launch --task-id "${taskId}" --review-type "${reviewType}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "${reviewerIdentity}" --reviewer-launch-artifact-path "${launchArtifactPath}" --provider-invocation-id "<actual-invocation-id>" --attestation-source "<provider-source>" --fork-context false --repo-root "."`
                        )
                    ]
                });
            }
            const reviewInvocationChain = buildReviewGateChainStatusSummary({
                repoRoot,
                eventsRoot,
                taskId,
                reviewType,
                edgeId: 'review-launch-completed-to-invocation',
                reason: `completed '${reviewType}' launch evidence is ready for invocation attestation before review output materialization`,
                preflightPath: preflightCommandPath,
                reviewContextPath: state.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
                depth: reviewDepth
            });
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'record-review-invocation',
                title: `Record '${reviewType}' delegated reviewer launch attestation.`,
                reason:
                    `Required review '${reviewType}' has launch metadata for the current routing event and review context. ` +
                    `The launch artifact already contains completed launch evidence; record that evidence with record-review-invocation. ${reviewerReadinessChain} ${reviewInvocationChain}`,
                commands: [
                    buildCommand(
                        'Record delegated reviewer launch attestation',
                        buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'record-review-invocation', [
                            `--review-type "${reviewType}"`,
                            '--reviewer-execution-mode "delegated_subagent"',
                            `--reviewer-identity "${reviewerIdentity}"`,
                            `--reviewer-launch-artifact-path "${launchArtifactPath}"`
                        ], taskModePath)
                    )
                ]
            });
        }
        if (!state.ready) {
            const stateViolations = state.violations.length > 0
                ? state.violations.join('; ')
                : 'review artifact or receipt is missing';
            const reviewerIdentity = state.contextReviewerIdentity
                || '<agent:reviewer-session-id-from-review-context>';
            const reviewResultChain = buildReviewGateChainStatusSummary({
                repoRoot,
                eventsRoot,
                taskId,
                reviewType,
                edgeId: 'review-invocation-to-result',
                reason: `current '${reviewType}' invocation attestation is ready before review result materialization`,
                preflightPath: preflightCommandPath,
                reviewContextPath: state.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
                depth: reviewDepth
            });
            const acceptedVerdictTokens = formatAcceptedReviewVerdictTokens(
                buildReviewVerdictTokenSet(reviewType, state.passToken || null, state.failToken || null)
            );
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'record-review-result',
                title: `Record '${reviewType}' review result from a delegated reviewer.`,
                reason: `Required review '${reviewType}' needs a valid delegated artifact and receipt (${stateViolations}). ${acceptedVerdictTokens} ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION} ${reviewerReadinessChain} ${reviewResultChain}`,
                commands: [
                    buildCommand(
                        'Record delegated review output, then close reviewer',
                        buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'record-review-result', [
                            `--review-type "${reviewType}"`,
                            `--preflight-path "${preflightCommandPath}"`,
                            '--review-output-stdin',
                            '--reviewer-execution-mode "delegated_subagent"',
                            `--reviewer-identity "${reviewerIdentity}"`
                        ], taskModePath)
                    )
                ]
            });
        }
        if (!currentReviewEvidenceSatisfied) {
            const reviewerIdentity = state.contextReviewerIdentity
                || '<agent:reviewer-session-id-from-review-context>';
            const acceptedVerdictTokens = formatAcceptedReviewVerdictTokens(
                buildReviewVerdictTokenSet(reviewType, state.passToken || null, state.failToken || null)
            );
            const hiddenTimingTrustRemediation = getHiddenReviewTimingTrustRemediation(eventsRoot, taskId, state);
            const missingEvidenceReason = hiddenTimingTrustRemediation
                ? `Required review '${reviewType}' evidence is not sufficiently trustworthy. ${hiddenTimingTrustRemediation}`
                : state.reusedExistingReview && !currentReviewReuseRecorded
                ? `Required review '${reviewType}' is reused, but current-cycle REVIEW_RECORDED reuse telemetry is missing or does not match the receipt, review artifact, review context, and tree-state provenance, so rerun review reuse materialization or record a fresh delegated review result.`
                : `Required review '${reviewType}' has stale or invalid reviewer_provenance; fresh delegated-review launch evidence is missing, stale, or spoof-like for the current receipt, so launch a fresh delegated reviewer with the printed handoff artifacts and record the exact reviewer output again.`;
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'record-review-result',
                title: `Record '${reviewType}' review result from a delegated reviewer.`,
                reason: `${missingEvidenceReason} ${acceptedVerdictTokens} ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION} ${reviewerReadinessChain}`,
                commands: [
                    buildCommand(
                        'Record delegated review output, then close reviewer',
                        buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'record-review-result', [
                            `--review-type "${reviewType}"`,
                            `--preflight-path "${preflightCommandPath}"`,
                            '--review-output-stdin',
                            '--reviewer-execution-mode "delegated_subagent"',
                            `--reviewer-identity "${reviewerIdentity}"`
                        ], taskModePath)
                    )
                ]
            });
        }
    }

    if (preflightRequiresAuditedNoOp(preflight)) {
        const noOpEvidence = getNoOpEvidence(repoRoot, taskId, '', preflightCommandPath);
        if (noOpEvidence.evidence_status !== 'PASS') {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'record-no-op',
                title: 'Record audited zero-diff no-op evidence.',
                reason:
                    'The current preflight is BASELINE_ONLY with no reviewable diff and requires audited no-op evidence before review or completion gates can pass. ' +
                    `Record no-op evidence or implement changes and refresh preflight; current no-op evidence status: ${noOpEvidence.evidence_status}.`,
                commands: [
                    buildCommand(
                        'Record audited no-op evidence',
                        `${cliPrefix} gate record-no-op --task-id "${taskId}" --classification "AUDIT_ONLY" --reason "<why no code changed>" --preflight-path "${preflightCommandPath}" --repo-root "."`
                    )
                ]
            });
        }
    }

    if (!isGatePassed(summary, 'required-reviews-check')) {
        const zeroDiffNoReviewCloseout = hasZeroDiffNoReviewableScopeSuppression(preflight, requiredReviewTypes);
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'required-reviews-check',
            title: zeroDiffNoReviewCloseout
                ? 'Validate zero-diff no-review closeout.'
                : 'Run required reviews check.',
            reason: zeroDiffNoReviewCloseout
                ? 'Profile-forced reviews were suppressed because the current preflight is BASELINE_ONLY with no reviewable diff; required-reviews-check must validate audited no-op evidence before closeout.'
                : 'All required review artifacts appear present, but the review gate has not validated them.',
            commands: [
                buildCommand(
                    'Run required reviews check',
                    buildRequiredReviewsCheckCommand(repoRoot, cliPrefix, taskId, preflightCommandPath, taskModePath)
                )
            ]
        });
    }

    if (!isGatePassed(summary, 'doc-impact-gate')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'doc-impact-gate',
            title: 'Record documentation impact.',
            reason: 'Completion requires an explicit docs decision.',
            commands: [
                buildCommand(
                    'Run doc impact gate',
                    buildDocImpactCommand(
                        cliPrefix,
                        taskId,
                        preflightCommandPath,
                        preflight,
                        repoRoot,
                        effectivePreflightWorkspaceReadiness.acceptedDocsOnlyDeltaFiles || []
                    )
                )
            ]
        });
    }

    if (fullSuiteConfig.enabled && !fullSuiteGatePassed) {
        const fullSuiteCommand = `${cliPrefix} gate full-suite-validation --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`;
        if (fullSuiteNotRequiredForDocsOnly) {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'full-suite-validation',
                title: 'Record full-suite validation as not required.',
                reason:
                    `Effective workflow config enables full-suite validation at ${fullSuiteSummary.config_path}, ` +
                    'but the current scope is docs-only. Record a SKIPPED/NOT_REQUIRED artifact instead of running the configured full-suite command.',
                commands: [
                    buildCommand(
                        'Record full-suite not required',
                        fullSuiteCommand
                    )
                ]
            });
        }
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'full-suite-validation',
            title: fullSuiteConfig.placement === 'before_completion'
                ? 'Run full-suite validation before completion.'
                : 'Run full-suite validation.',
            reason:
                `Effective workflow config enables full-suite validation at ${fullSuiteSummary.config_path} with placement '${fullSuiteConfig.placement}'. ` +
                `Command: ${fullSuiteConfig.command}. ${fullSuiteTimeoutForecastLine || ''}`.trim(),
            commands: [
                buildCommand(
                    'Run full-suite validation',
                    fullSuiteCommand
                )
            ]
        });
    }

    if (projectMemoryEvidence.required && projectMemoryEvidence.evidence_status !== 'CURRENT') {
        const staleDetails = projectMemoryEvidence.violations.length > 0
            ? ` Violations: ${projectMemoryEvidence.violations.join('; ')}`
            : '';
        const affectedFiles = projectMemoryEvidence.affected_memory_files.length > 0
            ? ` Affected memory files: ${projectMemoryEvidence.affected_memory_files.join(', ')}.`
            : '';
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'project-memory-impact',
            title: 'Record project memory impact.',
            reason:
                `Project memory maintenance is enabled before final closeout (${projectMemoryEvidence.visible_summary_line}). ` +
                `Record current project-memory impact evidence after upstream validation and before completion.${affectedFiles}${staleDetails}`,
            commands: [
                buildCommand(
                    'Run project memory impact gate',
                    buildProjectMemoryImpactCommand(cliPrefix, taskId, preflightCommandPath, projectMemorySummary)
                )
            ]
        });
    }

    if (!isGatePassed(summary, 'completion-gate')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'completion-gate',
            title: 'Run completion gate.',
            reason: 'All upstream gates appear ready; completion has not finalized the task.',
            commands: [
                buildCommand(
                    'Run completion gate',
                    buildCompletionGateCommand(repoRoot, cliPrefix, taskId, preflightCommandPath, taskModePath)
                )
            ]
        });
    }

    return buildResult({
        ...resultBase,
        status: 'BLOCKED',
        nextGate: 'completion-gate',
        title: 'Rerun completion gate for the current task cycle.',
        reason: 'A previous completion gate pass exists, but it is older than the latest task-mode entry. Continue the restarted task cycle before treating the task as DONE.',
        commands: [
            buildCommand(
                'Run completion gate',
                buildCompletionGateCommand(repoRoot, cliPrefix, taskId, preflightCommandPath, taskModePath)
            )
        ]
    });
}

export function formatNextStepText(result: NextStepResult): string {
    const lines = [
        'GARDA_NEXT_STEP',
        `Task: ${result.task_id}`,
        `Navigator: ${result.navigator_command}`,
        'Loop: run the Navigator first, rerun it after every suggested command, and follow only the single Commands entry it prints.',
        `Status: ${result.status}`,
        `NextGate: ${result.next_gate || 'none'}`,
        `Title: ${result.title}`,
        `Reason: ${result.reason}`
    ];
    if (result.warnings.length > 0) {
        lines.push('Warnings:');
        for (const warning of result.warnings) {
            lines.push(`  - ${warning}`);
        }
    }
    if (result.review_cycle_block) {
        const block = result.review_cycle_block;
        lines.push(`OperatorDecisionRequired: ${block.operator_decision_required}`);
        lines.push(`ReviewCycleBlock: reason=${formatNextStepInlineValue(block.reason)}; auto_split_enabled=${block.auto_split_enabled}; wait_for_operator=${block.wait_for_operator}`);
        lines.push(
            `ReviewCycleCounts: total_non_test_reviews=${block.total_non_test_review_count}; ` +
            `failed_non_test_reviews=${block.failed_non_test_review_count}; ` +
            `excluded_review_types=${formatNextStepInlineList(block.excluded_review_types)}`
        );
        lines.push(
            `ReviewCycleLimits: max_total_non_test_reviews=${block.max_total_non_test_reviews}; ` +
            `max_failed_non_test_reviews=${block.max_failed_non_test_reviews}`
        );
        const countEntries = Object.entries(block.counts_by_review_type);
        lines.push('ReviewCycleCountsByType:');
        if (countEntries.length === 0) {
            lines.push('  none');
        } else {
            for (const [reviewType, counts] of countEntries) {
                lines.push(`  ${formatNextStepInlineValue(reviewType)}: total=${counts.total}; passed=${counts.passed}; failed=${counts.failed}; pending=${counts.pending}`);
            }
        }
        if (block.latest_failed_review) {
            const latest = block.latest_failed_review;
            const summary = latest.summary ? `; summary=${formatNextStepInlineValue(latest.summary)}` : '';
            const artifactPath = latest.review_artifact_path ? `; artifact=${formatNextStepInlineValue(latest.review_artifact_path)}` : '';
            lines.push(
                `LatestFailedReview: review_type=${formatNextStepInlineValue(latest.review_type)}; event=${formatNextStepInlineValue(latest.event_type)}; ` +
                `outcome=${formatNextStepInlineValue(latest.outcome || 'unknown')}; sequence=${latest.sequence}${artifactPath}${summary}`
            );
        } else {
            lines.push('LatestFailedReview: none');
        }
        lines.push(`TestReviewExcluded: ${block.excluded_review_types.includes('test')}`);
        lines.push(`OperatorChoices: ${block.choices.join(', ')}`);
        if (block.auto_split_prompt) {
            lines.push(
                `AutoSplitPromptArtifact: path=${formatNextStepInlineValue(block.auto_split_prompt.artifact_path)}; ` +
                `sha256=${block.auto_split_prompt.artifact_sha256}; next_action=${block.auto_split_prompt.next_action}`
            );
            lines.push(`AutoSplitInstructions: ${block.auto_split_prompt.instructions.join(', ')}`);
            lines.push(`AutoSplitConstraints: ${block.auto_split_prompt.constraints.join(', ')}`);
        }
    }
    if (result.profile) {
        lines.push(`TaskProfile: ${result.profile.task_selected_profile || 'default'} (${result.profile.profile_selection_source || 'unknown'})`);
        if (result.profile.runtime_active_profile) {
            lines.push(`RuntimeActiveProfile: ${result.profile.runtime_active_profile} (${result.profile.runtime_active_profile_source || 'unknown'})`);
        }
        if (result.profile.effective_profile) {
            lines.push(`EffectiveProfile: ${result.profile.effective_profile} (${result.profile.effective_profile_source || 'unknown'})`);
        }
        if (result.profile.total_forecast_tokens != null) {
            const tokenParts = [`total~${result.profile.total_forecast_tokens}`];
            if (result.profile.effective_forecast_tokens != null) {
                tokenParts.push(`effective~${result.profile.effective_forecast_tokens}`);
            }
            if (result.profile.token_economy_active_for_depth != null) {
                tokenParts.push(`token_economy_active=${result.profile.token_economy_active_for_depth}`);
            }
            lines.push(`TokenBudget: ${tokenParts.join('; ')}`);
        }
    }
    if (result.markdown_working_plan) {
        lines.push(`MarkdownWorkingPlanPath: ${result.markdown_working_plan.working_plan_path}`);
        lines.push(`MarkdownWorkingPlanSha256: ${result.markdown_working_plan.working_plan_sha256}`);
    }
    lines.push(`FullSuite: enabled=${result.full_suite_validation.enabled}; placement=${result.full_suite_validation.placement}; command="${result.full_suite_validation.command}"; config=${result.full_suite_validation.config_path}`);
    if (result.full_suite_validation.timeout_forecast_note) {
        lines.push(`FullSuiteTimeout: ${result.full_suite_validation.timeout_forecast_note}`);
    }
    if (result.project_memory) {
        lines.push(result.project_memory.visible_summary_line);
    }
    lines.push(`ReviewPolicy: ${result.review.review_execution_policy_mode} (${result.review.review_execution_policy_source})`);
    if (result.review.required_reviews.length > 0) {
        lines.push(`RequiredReviews: ${result.review.required_reviews.join(', ')}`);
    } else {
        lines.push('RequiredReviews: none');
    }
    if (result.review.launchable_review_types.length > 0) {
        lines.push(`ReviewLaunchableBatch: ${result.review.launchable_review_types.join(', ')}`);
    }
    if (result.review.blocked_review_lanes.length > 0) {
        const blockedLanes = result.review.blocked_review_lanes
            .map((lane) => `${lane.review_type} blocked by ${lane.blocked_by.join(', ') || 'unknown'}`)
            .join('; ');
        lines.push(`BlockedReviewLanes: ${blockedLanes}`);
    }
    if (result.review.failed_review_type) {
        lines.push(`ReviewFailedCurrent: ${result.review.failed_review_type}`);
    }
    if (result.review.ordinary_doc_review_skips.length > 0 && result.review.required_reviews.length === 0) {
        const skipped = result.review.ordinary_doc_review_skips
            .map((entry) => `${entry.path} (matched ${entry.pattern})`)
            .join('; ');
        lines.push(`OrdinaryDocReviewSkips: ${skipped}`);
    }
    if (result.review.next_review_type) {
        lines.push(`NextReview: ${result.review.next_review_type}`);
    }
    if (result.review.blocked_review_dependencies.length > 0) {
        lines.push(`ReviewBlockedBy: ${result.review.blocked_review_dependencies.join(', ')}`);
        lines.push(`BlockedReviewerLaunches: do not prepare or launch '${result.review.next_review_type}' until current-cycle ${result.review.blocked_review_dependencies.join(', ')} review artifacts and receipts pass.`);
    }
    if (result.review.trust_note) {
        lines.push(result.review.trust_note);
    }
    lines.push(result.task_queue_status_contract.visible_summary_line);
    if (result.missing_artifacts.length > 0) {
        lines.push(`MissingArtifacts: ${result.missing_artifacts.map((artifact) => artifact.key).join(', ')}`);
    }
    if (result.final_report) {
        lines.push(`CloseoutArtifact: ${result.final_report.closeout_json_path}`);
        lines.push(`CloseoutMarkdown: ${result.final_report.closeout_markdown_path}`);
        lines.push('FinalReportOrder:');
        for (const [index, entry] of result.final_report.required_order.entries()) {
            lines.push(`  ${index + 1}. ${entry}`);
        }
    }
    if (result.commands.length > 0 || result.final_report) {
        lines.push('');
        lines.push('Commands:');
        if (result.commands.length === 0) {
            lines.push('  none');
        } else {
            for (const command of result.commands) {
                lines.push(`  ${command.label}: ${command.command}`);
            }
        }
    }
    if (result.status !== 'DONE' && result.review_cycle_block?.auto_split_prompt) {
        lines.push('AfterCommand: follow AutoSplitPromptArtifact instructions; do not run parent compile, review, or full-suite gates before split handling.');
    } else if (result.status !== 'DONE' && result.review_cycle_block) {
        lines.push('AfterCommand: inspect diagnostics only if needed, then wait for operator choice; do not run compile, review, or full-suite gates.');
    } else if (result.status !== 'DONE') {
        lines.push(`AfterCommand: rerun ${result.navigator_command} after the command above completes.`);
    }
    return `${lines.join('\n')}\n`;
}

function formatNextStepInlineValue(value: string): string {
    return JSON.stringify(value);
}

function formatNextStepInlineList(values: string[]): string {
    return values.length > 0
        ? values.map((value) => formatNextStepInlineValue(value)).join(',')
        : 'none';
}

function parseTaskIdFromPreflightPath(preflightPath: string): string | null {
    const basename = path.basename(preflightPath).trim();
    const suffix = '-preflight.json';
    if (!basename.endsWith(suffix)) {
        return null;
    }
    return basename.slice(0, -suffix.length) || null;
}

function pickConsistentTaskId(candidates: Array<{ source: string; value: string | null }>): string {
    const normalized = candidates
        .map((candidate) => ({
            source: candidate.source,
            value: String(candidate.value || '').trim()
        }))
        .filter((candidate) => candidate.value);
    const uniqueValues = [...new Set(normalized.map((candidate) => candidate.value))];
    if (uniqueValues.length > 1) {
        throw new Error(`Conflicting task identifiers for next-step: ${normalized.map((candidate) => `${candidate.source}=${candidate.value}`).join(', ')}.`);
    }
    return uniqueValues[0] || '';
}

export function resolveNextStepFromCliOptions(options: {
    taskId?: unknown;
    repoRoot?: unknown;
    eventsRoot?: unknown;
    reviewsRoot?: unknown;
    preflightPath?: unknown;
    positionals?: unknown;
}): NextStepResult {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const positionals = Array.isArray(options.positionals)
        ? options.positionals.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
    const preflightPathText = String(options.preflightPath || '').trim();
    const resolvedPreflightPath = preflightPathText
        ? resolvePathInsideRepo(preflightPathText, repoRoot, { allowMissing: true })
        : null;
    const taskId = pickConsistentTaskId([
        { source: '--task-id', value: String(options.taskId || '').trim() || null },
        { source: 'positional', value: positionals[0] || null },
        { source: '--preflight-path', value: resolvedPreflightPath ? parseTaskIdFromPreflightPath(resolvedPreflightPath) : null }
    ]);
    const reviewsRoot = options.reviewsRoot
        ? resolvePathInsideRepo(String(options.reviewsRoot), repoRoot, { allowMissing: true })
        : resolvedPreflightPath
            ? path.dirname(resolvedPreflightPath)
        : null;
    const eventsRoot = options.eventsRoot
        ? resolvePathInsideRepo(String(options.eventsRoot), repoRoot, { allowMissing: true })
        : null;
    return resolveNextStep({
        taskId,
        repoRoot,
        eventsRoot,
        reviewsRoot
    });
}

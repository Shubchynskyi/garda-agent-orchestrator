import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertValidTaskId, inspectTaskEventFile } from '../../gate-runtime/task-events';
import { withReviewArtifactReadBarrier } from '../../gate-runtime/review-artifacts';
import { inspectCompletionGateFinalizationLock, type CompletionGateFinalizationLockPolicy } from '../locks/finalization-lock';
import { fileSha256, toPosix } from '../shared/helpers';
import {
    buildTokenEconomySummary,
    normalizeCycleBindingPath,
    parseTimestamp,
    resolveTaskCycleBindingSnapshot,
    type TaskCycleBindingSnapshot
} from '../task-events-summary/task-events-summary';
import { readOptionalSkillSelectionTimelineEvidence } from '../../runtime/optional-skill-selection';
import {
    isFullSuiteNotRequiredForZeroDiffNoReviewableScope,
    loadFullSuiteValidationConfig
} from '../full-suite/full-suite-validation';
import {
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    getProjectMemoryImpactLifecycleEvidence
} from '../project-memory-impact';
import { evaluateHiddenReviewTimingTrust } from '../review/review-timing-trust';
import {
    LEGACY_REVIEW_EXECUTION_POLICY_MODE,
    buildReviewExecutionPolicySummaryLine,
    loadReviewExecutionPolicyConfig,
    resolveReviewExecutionPolicyModeFromPreflight,
    type EffectiveReviewExecutionPolicyMode
} from '../../core/review-execution-policy';
import { getStatusSnapshot } from '../../validators';
import { getWorkspaceSnapshotCached } from '../workspace/workspace-snapshot-cache';
import { buildDomainScopeFingerprints } from '../scope/domain-scope-fingerprints';
import {
    buildUnavailableRequiredReviewTrustSummary,
    type BlockerEntry,
    type EvidenceArtifact,
    type FinalCloseoutArtifactPaths,
    type FinalCloseoutDocsSummary,
    type FinalCloseoutImplementationSummary,
    type FinalCloseoutReviewIntegrityAttestation,
    type FinalCloseoutOptionalSkillsSummary,
    type ReviewAttemptSummary,
    type FinalCloseoutReviewTrustSummary,
    type FinalReportContract,
    type GateOutcome,
    type ProfileReviewDecisionSummary,
    parseOptionalNumber,
    buildReviewIntegrityAttestation,
    readDocImpactSummary,
    readReviewTrustSummary,
    readReviewTrustSummaryFromReviewGate,
    buildReviewAttemptSummary,
    readOptionalSkillsSummary,
    readReviewVerdicts,
    readTaskQueueMetadata,
    resolveEventsRoot,
    resolveReviewsRoot,
    safeReadJson
} from './task-audit-summary-collectors';
import { buildCommitCommandSuggestion } from './task-audit-summary-renderers';
import {
    buildTaskQueueStatusContract,
    type TaskQueueStatusContract
} from '../../core/task-queue-status-contract';
import {
    buildCompletionReviewOrderBlocker,
    buildLifecycleGateOutcomes,
    getLifecycleGates,
    hasCurrentCycleProjectMemoryImpactEvent,
    readOrderedTaskEvents,
    resolveFullSuiteValidationRequirementForCurrentCycle,
    type TaskAuditEvent
} from './task-audit-summary-lifecycle';
import {
    buildAuditedChangedFiles,
    buildPostDoneWorkspaceDriftBlocker,
    isLocalControlPlaneCommitPath,
    resolveCommittableChangedFiles
} from './task-audit-summary-drift';
import {
    collectEvidenceArtifacts,
    collectRequiredReviewBlockers
} from './task-audit-summary-review-evidence';
import { buildFinalCloseoutProjectMemorySummary } from './task-audit-summary-project-memory';
export { formatFinalCloseoutMarkdown, formatFinalUserReport, formatTaskAuditSummaryText } from './task-audit-summary-renderers';
export { synchronizeFinalCloseoutArtifacts } from './task-audit-summary-closeout-sync';

const NO_COMMIT_REQUIRED_MESSAGE = 'No commit required: no committable changes are present.';
const NO_COMMIT_CONFIRMATION_MESSAGE = 'No commit confirmation required.';

export interface TaskAuditSummaryOptions {
    taskId: string;
    repoRoot: string;
    eventsRoot?: string | null;
    reviewsRoot?: string | null;
}

export interface FinalCloseoutArtifact {
    schema_version: 1;
    event_source: 'task-audit-summary';
    task_id: string;
    generated_utc: string;
    audit_status: 'PASS' | 'BLOCKED' | 'INCOMPLETE';
    status: 'READY' | 'NOT_READY';
    blocker: string | null;
    artifact_state: 'PENDING' | 'MATERIALIZED' | 'REMOVED' | 'NOT_READY';
    cycle_binding?: TaskCycleBindingSnapshot | null;
    artifact_paths: FinalCloseoutArtifactPaths;
    implementation_summary: FinalCloseoutImplementationSummary;
    review_trust?: FinalCloseoutReviewTrustSummary | null;
    review_timing_audit?: FinalCloseoutReviewTimingAuditSummary | null;
    review_integrity_attestation?: FinalCloseoutReviewIntegrityAttestation;
    review_attempt_summary?: ReviewAttemptSummary | null;
    optional_skills?: FinalCloseoutOptionalSkillsSummary | null;
    workflow?: {
        mandatory_full_suite_enabled: boolean;
        visible_summary_line: string;
        review_execution_policy_mode?: EffectiveReviewExecutionPolicyMode | null;
        review_execution_policy_summary_line?: string | null;
    } | null;
    docs: FinalCloseoutDocsSummary;
    project_memory?: FinalCloseoutProjectMemorySummary | null;
    token_economy: ReturnType<typeof buildTokenEconomySummary> | null;
    task_queue_status_contract?: TaskQueueStatusContract;
    agent_report?: {
        assistant_language: string | null;
        assistant_language_confirmed: boolean | null;
        next_task_command: string | null;
        latest_update_notice: string | null;
    } | null;
    commit_command_template: string;
    commit_command_suggestion: string;
    commit_question: string;
}

export interface TaskAuditSummaryResult {
    task_id: string;
    generated_utc: string;
    status: 'PASS' | 'BLOCKED' | 'INCOMPLETE';
    events_count: number;
    first_event_utc: string | null;
    last_event_utc: string | null;
    integrity_status: string;
    gates: GateOutcome[];
    changed_files: string[];
    changed_files_count: number;
    changed_lines_total: number;
    required_reviews: Record<string, boolean>;
    scope_category: string | null;
    profile_review_decisions: ProfileReviewDecisionSummary | null;
    evidence: EvidenceArtifact[];
    blockers: BlockerEntry[];
    point_in_time_snapshot: PointInTimeSnapshot;
    review_attempt_summary?: ReviewAttemptSummary | null;
    final_report_contract: FinalReportContract;
    final_closeout: FinalCloseoutArtifact;
}

export interface FinalCloseoutProjectMemorySummary {
    enabled: boolean;
    required: boolean;
    mode: string;
    evidence_status: string;
    status: string | null;
    update_needed: boolean | null;
    affected_memory_files: string[];
    updated_memory_files: string[];
    compact_status: string | null;
    compact_refreshed: boolean | null;
    artifact_path: string;
    update_artifact_path: string;
    visible_summary_line: string;
}

export interface FinalCloseoutReviewTimingAuditEntry {
    review_type: string;
    reviewer_identity: string | null;
    reviewer_execution_mode: string | null;
    reused_existing_review: boolean;
    receipt_path: string;
    receipt_sha256: string | null;
    review_output_path: string | null;
    review_output_sha256: string | null;
    provider: string | null;
    provider_invocation_id: string | null;
    reviewer_launch_attestation_source: string | null;
    launch_prepared_at_utc: string | null;
    delegation_started_at_utc: string | null;
    launched_at_utc: string | null;
    launch_completed_at_utc: string | null;
    invocation_attested_at_utc: string | null;
    review_result_recorded_at_utc: string | null;
    review_output_source_mtime_utc: string | null;
    delegation_to_result_ms: number | null;
    delegation_to_source_mtime_ms: number | null;
    gate_finalize_ms: number | null;
    launch_to_result_ms: number | null;
    launch_to_source_mtime_ms: number | null;
    hidden_timing_status: 'TRUSTED' | 'DISTRUSTED' | 'SKIPPED_REUSED';
    hidden_timing_distrust_code: string | null;
}

export interface FinalCloseoutReviewTimingAuditSummary {
    entries: FinalCloseoutReviewTimingAuditEntry[];
    visible_summary_line: string;
}

export interface PointInTimeSnapshot {
    status: 'STABLE' | 'FINALIZATION_IN_FLIGHT';
    gate: 'completion-gate' | null;
    message: string | null;
    recommended_action: string | null;
    lock_path: string | null;
    owner_pid?: number | null;
    owner_hostname?: string | null;
    owner_created_at_utc?: string | null;
    owner_alive?: boolean | null;
    owner_metadata_status?: string | null;
    stale_reason?: string | null;
    subsystem_scope_note?: string | null;
    acquisition_policy?: CompletionGateFinalizationLockPolicy | null;
}

interface PreflightSummary {
    path: string;
    sha256: string | null;
    raw: Record<string, unknown> | null;
    changedFiles: string[];
    changedFilesCount: number;
    changedLinesTotal: number;
    requiredReviews: Record<string, boolean>;
    scopeCategory: string | null;
    pathMode: string | null;
}

const REVIEW_TIMING_AUDIT_TYPES = [
    'code',
    'db',
    'security',
    'refactor',
    'test',
    'api',
    'performance',
    'infra',
    'dependency'
] as const;

function readPreflightSummary(reviewsRoot: string, taskId: string): PreflightSummary {
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const preflight = safeReadJson(preflightPath);
    const requiredReviews: Record<string, boolean> = {};

    if (preflight?.required_reviews && typeof preflight.required_reviews === 'object') {
        for (const [key, value] of Object.entries(preflight.required_reviews as Record<string, unknown>)) {
            requiredReviews[key] = value === true;
        }
    }

    const changedFiles = Array.isArray(preflight?.changed_files)
        ? preflight.changed_files.map((changedFile: unknown) => String(changedFile))
        : [];
    const metrics = preflight?.metrics && typeof preflight.metrics === 'object'
        ? preflight.metrics as Record<string, unknown>
        : null;

    return {
        path: preflightPath,
        sha256: fs.existsSync(preflightPath) ? fileSha256(preflightPath) : null,
        raw: preflight,
        changedFiles,
        changedFilesCount: changedFiles.length,
        changedLinesTotal: metrics ? Number(metrics.changed_lines_total) || 0 : 0,
        requiredReviews,
        scopeCategory: typeof preflight?.scope_category === 'string' ? preflight.scope_category : null,
        pathMode: typeof preflight?.mode === 'string' && preflight.mode.trim() ? preflight.mode.trim() : null
    };
}

function readProfileReviewDecisions(
    taskMode: Record<string, unknown> | null,
    preflight: Record<string, unknown> | null,
    scopeCategory: string | null
): ProfileReviewDecisionSummary | null {
    if (!taskMode || typeof taskMode.active_profile !== 'string' || !taskMode.active_profile) {
        return null;
    }

    const baseSummary = {
        profile_name: String(taskMode.active_profile || ''),
        scope_category: scopeCategory
    };
    const guardrails = preflight?.profile_guardrails && typeof preflight.profile_guardrails === 'object'
        ? preflight.profile_guardrails as Record<string, unknown>
        : null;

    if (!guardrails) {
        return {
            ...baseSummary,
            guardrails_active: false,
            lightening_eligible: false,
            safety_floors_applied: [],
            decisions: []
        };
    }

    const decisions = Array.isArray(guardrails.decisions)
        ? guardrails.decisions.flatMap((decision): Array<{ review_type: string; effective_value: boolean; decision: string }> => {
            if (!decision || typeof decision !== 'object') {
                return [];
            }
            const record = decision as Record<string, unknown>;
            return [{
                review_type: String(record.review_type || ''),
                effective_value: record.effective_value === true,
                decision: String(record.decision || '')
            }];
        })
        : [];
    const safetyFloorsApplied = Array.isArray(guardrails.safety_floors_applied)
        ? guardrails.safety_floors_applied.map((entry) => String(entry))
        : [];

    return {
        ...baseSummary,
        guardrails_active: guardrails.guardrails_active === true,
        lightening_eligible: guardrails.lightening_eligible === true,
        safety_floors_applied: safetyFloorsApplied,
        decisions
    };
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

function asAuditRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readAuditString(value: unknown): string | null {
    const text = String(value || '').trim();
    return text || null;
}

function readAuditTimestamp(value: unknown): string | null {
    const text = readAuditString(value);
    if (!text) {
        return null;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function readAuditSequence(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readAuditSha256(value: unknown): string | null {
    const text = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(text) ? text : null;
}

function elapsedMs(fromUtc: string | null, toUtc: string | null): number | null {
    if (!fromUtc || !toUtc) {
        return null;
    }
    const from = Date.parse(fromUtc);
    const to = Date.parse(toUtc);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
        return null;
    }
    return to - from;
}

function readEventIntegrity(event: TaskAuditEvent | null): Record<string, unknown> | null {
    return asAuditRecord(event?.integrity);
}

function findReviewerInvocationEvent(
    events: readonly TaskAuditEvent[],
    provenance: Record<string, unknown> | null
): TaskAuditEvent | null {
    const expectedSequence = readAuditSequence(provenance?.task_sequence);
    const expectedEventSha256 = readAuditSha256(provenance?.event_sha256);
    const expectedPrevEventSha256 = provenance?.prev_event_sha256 == null
        ? null
        : readAuditSha256(provenance.prev_event_sha256);
    if (!expectedSequence || !expectedEventSha256) {
        return null;
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim().toUpperCase() !== 'REVIEWER_INVOCATION_ATTESTED') {
            continue;
        }
        const integrity = readEventIntegrity(event);
        if (
            readAuditSequence(integrity?.task_sequence) === expectedSequence
            && readAuditSha256(integrity?.event_sha256) === expectedEventSha256
            && (integrity?.prev_event_sha256 == null
                ? null
                : readAuditSha256(integrity.prev_event_sha256)) === expectedPrevEventSha256
        ) {
            return event;
        }
    }
    return null;
}

function latestCompileSequence(events: readonly TaskAuditEvent[]): number | null {
    let latest: number | null = null;
    for (const event of events) {
        if (String(event.event_type || '').trim().toUpperCase() !== 'COMPILE_GATE_PASSED') {
            continue;
        }
        const sequence = readAuditSequence(readEventIntegrity(event)?.task_sequence);
        if (sequence != null && (latest == null || sequence > latest)) {
            latest = sequence;
        }
    }
    return latest;
}

function listReviewReceiptPaths(reviewsRoot: string, taskId: string, reviewType: string): string[] {
    const canonicalPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    const candidates = new Set<string>();
    if (fs.existsSync(canonicalPath) && fs.statSync(canonicalPath).isFile()) {
        candidates.add(canonicalPath);
    }
    if (fs.existsSync(reviewsRoot) && fs.statSync(reviewsRoot).isDirectory()) {
        const prefix = `${taskId}-${reviewType}-receipt-`;
        for (const entry of fs.readdirSync(reviewsRoot)) {
            if (entry.startsWith(prefix) && entry.endsWith('.json')) {
                candidates.add(path.join(reviewsRoot, entry));
            }
        }
    }
    return [...candidates].sort((left, right) => {
        const leftReceipt = safeReadJson(left);
        const rightReceipt = safeReadJson(right);
        const leftTime = Date.parse(readAuditTimestamp(leftReceipt?.review_result_recorded_at_utc ?? leftReceipt?.recorded_at_utc) || '');
        const rightTime = Date.parse(readAuditTimestamp(rightReceipt?.review_result_recorded_at_utc ?? rightReceipt?.recorded_at_utc) || '');
        const leftOrder = Number.isFinite(leftTime) ? leftTime : Number.MAX_SAFE_INTEGER;
        const rightOrder = Number.isFinite(rightTime) ? rightTime : Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.localeCompare(right);
    });
}

function buildReviewTimingAuditEntry(
    taskId: string,
    reviewType: string,
    receiptPath: string,
    events: readonly TaskAuditEvent[],
    compileSequence: number | null
): FinalCloseoutReviewTimingAuditEntry | null {
    if (!fs.existsSync(receiptPath) || !fs.statSync(receiptPath).isFile()) {
        return null;
    }
    const receipt = safeReadJson(receiptPath);
    if (!receipt || receipt.task_id !== taskId || receipt.review_type !== reviewType) {
        return null;
    }
    const provenance = asAuditRecord(receipt.reviewer_provenance);
    const invocationEvent = findReviewerInvocationEvent(events, provenance);
    const invocationDetails = asAuditRecord(invocationEvent?.details);
    const launchPreparedAtUtc = readAuditTimestamp(
        provenance?.launch_prepared_at_utc ?? invocationDetails?.launch_prepared_at_utc
    );
    const delegationStartedAtUtc = readAuditTimestamp(
        provenance?.delegation_started_at_utc ?? invocationDetails?.delegation_started_at_utc
    );
    const launchedAtUtc = readAuditTimestamp(
        provenance?.launched_at_utc ?? invocationDetails?.launched_at_utc
    );
    const launchCompletedAtUtc = readAuditTimestamp(
        provenance?.launch_completed_at_utc ?? invocationDetails?.launch_completed_at_utc
    );
    const invocationAttestedAtUtc = readAuditTimestamp(
        provenance?.invocation_attested_at_utc ?? invocationDetails?.invocation_attested_at_utc
    );
    const reviewResultRecordedAtUtc = readAuditTimestamp(
        receipt.review_result_recorded_at_utc ?? receipt.recorded_at_utc
    );
    const reviewOutputSourceMtimeUtc = readAuditTimestamp(receipt.review_output_source_mtime_utc);
    const reusedExistingReview = receipt.reused_existing_review === true;
    const timingTrust = evaluateHiddenReviewTimingTrust({
        reviewType,
        reusedExistingReview,
        reviewerProvenance: provenance,
        reviewResultRecordedAtUtc,
        recordedAtUtc: readAuditTimestamp(receipt.recorded_at_utc),
        reviewOutputSourceMtimeUtc,
        timelineEvents: events,
        latestCompileSequence: compileSequence
    });
    return {
        review_type: reviewType,
        reviewer_identity: readAuditString(receipt.reviewer_identity),
        reviewer_execution_mode: readAuditString(receipt.reviewer_execution_mode),
        reused_existing_review: reusedExistingReview,
        receipt_path: toPosix(receiptPath),
        receipt_sha256: fileSha256(receiptPath),
        review_output_path: readAuditString(receipt.review_output_path),
        review_output_sha256: readAuditSha256(receipt.review_output_sha256),
        provider: readAuditString(
            invocationDetails?.execution_provider
            ?? invocationDetails?.provider
            ?? invocationDetails?.provider_family
            ?? invocationDetails?.reviewer_launch_tool
        ),
        provider_invocation_id: readAuditString(invocationDetails?.provider_invocation_id),
        reviewer_launch_attestation_source: readAuditString(invocationDetails?.reviewer_launch_attestation_source),
        launch_prepared_at_utc: launchPreparedAtUtc,
        delegation_started_at_utc: delegationStartedAtUtc,
        launched_at_utc: launchedAtUtc,
        launch_completed_at_utc: launchCompletedAtUtc,
        invocation_attested_at_utc: invocationAttestedAtUtc,
        review_result_recorded_at_utc: reviewResultRecordedAtUtc,
        review_output_source_mtime_utc: reviewOutputSourceMtimeUtc,
        delegation_to_result_ms: elapsedMs(delegationStartedAtUtc, reviewResultRecordedAtUtc),
        delegation_to_source_mtime_ms: elapsedMs(delegationStartedAtUtc, reviewOutputSourceMtimeUtc),
        gate_finalize_ms: elapsedMs(launchCompletedAtUtc, reviewResultRecordedAtUtc),
        launch_to_result_ms: elapsedMs(launchedAtUtc, reviewResultRecordedAtUtc),
        launch_to_source_mtime_ms: elapsedMs(launchedAtUtc, reviewOutputSourceMtimeUtc),
        hidden_timing_status: reusedExistingReview
            ? 'SKIPPED_REUSED'
            : timingTrust.trusted
                ? 'TRUSTED'
                : 'DISTRUSTED',
        hidden_timing_distrust_code: timingTrust.code
    };
}

function buildReviewTimingAuditSummary(
    reviewsRoot: string,
    taskId: string,
    events: readonly TaskAuditEvent[]
): FinalCloseoutReviewTimingAuditSummary | null {
    const compileSequence = latestCompileSequence(events);
    const entries: FinalCloseoutReviewTimingAuditEntry[] = [];
    const seenReceiptHashes = new Set<string>();

    for (const reviewType of REVIEW_TIMING_AUDIT_TYPES) {
        for (const receiptPath of listReviewReceiptPaths(reviewsRoot, taskId, reviewType)) {
            const entry = buildReviewTimingAuditEntry(taskId, reviewType, receiptPath, events, compileSequence);
            if (entry) {
                const receiptIdentity = entry.receipt_sha256
                    ? `${entry.review_type}:${entry.receipt_sha256}`
                    : `${entry.review_type}:${entry.receipt_path}`;
                if (seenReceiptHashes.has(receiptIdentity)) {
                    continue;
                }
                seenReceiptHashes.add(receiptIdentity);
                entries.push(entry);
            }
        }
    }

    if (entries.length === 0) {
        return null;
    }
    const compactEntries = entries.map((entry) => {
        const resultMs = entry.delegation_to_result_ms == null ? 'unknown' : `${entry.delegation_to_result_ms}ms`;
        const sourceMs = entry.delegation_to_source_mtime_ms == null ? 'unknown' : `${entry.delegation_to_source_mtime_ms}ms`;
        const finalizeMs = entry.gate_finalize_ms == null ? 'unknown' : `${entry.gate_finalize_ms}ms`;
        const flag = entry.hidden_timing_distrust_code
            ? `${entry.hidden_timing_status}:${entry.hidden_timing_distrust_code}`
            : entry.hidden_timing_status;
        return `${entry.review_type}(${flag}, delegation_to_result=${resultMs}, delegation_to_source_mtime=${sourceMs}, gate_finalize=${finalizeMs})`;
    });
    return {
        entries,
        visible_summary_line: `Review timing audit: ${compactEntries.join('; ')}.`
    };
}

function readReviewExecutionPolicyModeFromCurrentCycleTimeline(
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string
): EffectiveReviewExecutionPolicyMode | null {
    const expectedPreflightPath = currentCycle?.preflight_path
        ? toPosix(currentCycle.preflight_path)
        : null;
    const compileGateTime = currentCycle?.compile_gate_timestamp
        ? parseTimestamp(currentCycle.compile_gate_timestamp).getTime()
        : 0;

    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const eventType = String(event.event_type || '').trim().toUpperCase();
        if (eventType !== 'PREFLIGHT_CLASSIFIED') {
            continue;
        }

        const eventTime = parseTimestamp(event.timestamp_utc).getTime();
        if (compileGateTime > 0 && eventTime > 0 && eventTime > compileGateTime) {
            continue;
        }

        const details = event.details && typeof event.details === 'object'
            ? event.details as Record<string, unknown>
            : null;
        if (!details) {
            continue;
        }

        const eventPreflightPath = normalizeCycleBindingPath(details.output_path, repoRoot);
        if (expectedPreflightPath && eventPreflightPath && eventPreflightPath !== expectedPreflightPath) {
            continue;
        }

        const rawPolicy = details.review_execution_policy;
        if (rawPolicy && typeof rawPolicy === 'object' && !Array.isArray(rawPolicy)) {
            return resolveReviewExecutionPolicyModeFromPreflight(
                { review_execution_policy: rawPolicy },
                LEGACY_REVIEW_EXECUTION_POLICY_MODE
            );
        }
        return LEGACY_REVIEW_EXECUTION_POLICY_MODE;
    }

    return null;
}

export function buildTaskAuditSummary(options: TaskAuditSummaryOptions): TaskAuditSummaryResult {
    const repoRoot = path.resolve(options.repoRoot);
    const safeTaskId = assertValidTaskId(options.taskId);
    const eventsRoot = resolveEventsRoot(repoRoot, options.eventsRoot);
    const reviewsRoot = resolveReviewsRoot(repoRoot, options.reviewsRoot);
    const liveFullSuiteValidationEnabled = loadFullSuiteValidationConfig(repoRoot).enabled;
    const liveReviewExecutionPolicyMode = loadReviewExecutionPolicyConfig(repoRoot).mode;
    const taskMetadata = readTaskQueueMetadata(repoRoot, safeTaskId);
    const taskPath = path.join(repoRoot, 'TASK.md');
    const taskFileExists = fs.existsSync(taskPath) && fs.statSync(taskPath).isFile();
    const taskEventFile = path.join(eventsRoot, `${safeTaskId}.jsonl`);
    const orderedEvents = readOrderedTaskEvents(taskEventFile);
    const events = orderedEvents.events;
    const currentCycle = resolveTaskCycleBindingSnapshot(safeTaskId, events, repoRoot, reviewsRoot);
    const fullSuiteValidationEnabled = resolveFullSuiteValidationRequirementForCurrentCycle(
        events,
        currentCycle,
        repoRoot,
        liveFullSuiteValidationEnabled
    );
    const preflightForLifecycle = safeReadJson(path.join(reviewsRoot, `${safeTaskId}-preflight.json`));
    const fullSuiteValidationRequiredForLifecycle = fullSuiteValidationEnabled
        && !isFullSuiteNotRequiredForZeroDiffNoReviewableScope(preflightForLifecycle || {});
    const projectMemoryImpactEvidence = getProjectMemoryImpactLifecycleEvidence({
        repoRoot,
        taskId: safeTaskId,
        preflightPath: path.join(reviewsRoot, `${safeTaskId}-preflight.json`)
    });
    const hasCurrentProjectMemoryImpactEvent = hasCurrentCycleProjectMemoryImpactEvent(events, currentCycle, repoRoot);
    const hasCompletionPassEvent = events.some((event) => String(event.event_type || '').trim().toUpperCase() === 'COMPLETION_GATE_PASSED');
    const projectMemoryImpactRequired = projectMemoryImpactEvidence.required
        && (!hasCompletionPassEvent || hasCurrentProjectMemoryImpactEvent);
    const workspaceStatusSnapshot = getStatusSnapshot(repoRoot);
    const lifecycleGates = getLifecycleGates(fullSuiteValidationRequiredForLifecycle, projectMemoryImpactRequired);
    let integrityStatus: string;
    if (fs.existsSync(taskEventFile) && fs.statSync(taskEventFile).isFile()) {
        try {
            const report = inspectTaskEventFile(taskEventFile, safeTaskId);
            integrityStatus = report.status;
        } catch {
            integrityStatus = 'ERROR';
        }
    } else {
        integrityStatus = 'MISSING';
    }
    const lifecycleStatus = buildLifecycleGateOutcomes(
        lifecycleGates,
        events,
        currentCycle,
        repoRoot
    );
    const gates = [...lifecycleStatus.gates];
    const blockers = [...lifecycleStatus.blockers];
    let pointInTimeSnapshot: PointInTimeSnapshot = {
        status: 'STABLE',
        gate: null,
        message: null,
        recommended_action: null,
        lock_path: null,
        owner_pid: null,
        owner_hostname: null,
        owner_created_at_utc: null,
        owner_alive: null,
        owner_metadata_status: null,
        stale_reason: null,
        subsystem_scope_note: null,
        acquisition_policy: null
    };

    const preflightSummary = readPreflightSummary(reviewsRoot, safeTaskId);
    const requiredReviews = preflightSummary.requiredReviews;
    const scopeCategory = preflightSummary.scopeCategory;
    const pathMode = preflightSummary.pathMode;
    const preflightPath = preflightSummary.path;
    const preflight = preflightSummary.raw;
    const docImpactPath = path.join(reviewsRoot, `${safeTaskId}-doc-impact.json`);
    const docImpact = safeReadJson(docImpactPath);
    const docsSummary = readDocImpactSummary(docImpact);
    const auditedChangedFiles = buildAuditedChangedFiles(repoRoot, preflightSummary.changedFiles, docsSummary);
    const changedFiles = auditedChangedFiles.changedFiles;
    const changedFilesCount = changedFiles.length;
    const changedLinesTotal = preflightSummary.changedLinesTotal;
    const finalCloseoutJsonPath = path.join(reviewsRoot, `${safeTaskId}-final-closeout.json`);
    const finalCloseoutMarkdownPath = path.join(reviewsRoot, `${safeTaskId}-final-closeout.md`);
    const finalUserReportPath = path.join(reviewsRoot, `${safeTaskId}-final-user-report.md`);
    const hasCompletionPass = gates.some(
        (g) => g.gate === 'completion-gate' && g.status === 'PASS'
    );
    const hasMaterializedFinalCloseoutArtifact = fs.existsSync(finalCloseoutJsonPath) || fs.existsSync(finalCloseoutMarkdownPath);
    if (hasCompletionPass && hasMaterializedFinalCloseoutArtifact) {
        const postDoneDriftBlocker = buildPostDoneWorkspaceDriftBlocker(
            repoRoot,
            changedFiles,
            preflightSummary.changedFiles,
            preflight,
            finalCloseoutJsonPath
        );
        if (postDoneDriftBlocker) {
            blockers.push(postDoneDriftBlocker);
        }
    }
    const timelineReviewExecutionPolicyMode = preflight
        ? null
        : readReviewExecutionPolicyModeFromCurrentCycleTimeline(events, currentCycle, repoRoot);
    const reviewExecutionPolicyMode = preflight
        ? resolveReviewExecutionPolicyModeFromPreflight(preflight)
        : timelineReviewExecutionPolicyMode || liveReviewExecutionPolicyMode;
    const preflightSha256 = preflightSummary.sha256;
    const taskModePath = path.join(reviewsRoot, `${safeTaskId}-task-mode.json`);
    const taskMode = safeReadJson(taskModePath);
    const profileReviewDecisions = readProfileReviewDecisions(taskMode, preflight, scopeCategory);
    const reviewGatePath = path.join(reviewsRoot, `${safeTaskId}-review-gate.json`);
    const reviewSnapshot = withReviewArtifactReadBarrier(reviewsRoot, () => {
        const requiredReviewBlockers = collectRequiredReviewBlockers(
            requiredReviews,
            safeTaskId,
            reviewsRoot,
            events,
            currentCycle
        );
        const evidence = collectEvidenceArtifacts(
            repoRoot,
            reviewsRoot,
            safeTaskId,
            taskEventFile,
            projectMemoryImpactEvidence
        );
        const reviewGate = safeReadJson(reviewGatePath);
        const reviewVerdicts = readReviewVerdicts(requiredReviews, reviewGate);
        const receiptReviewTrustSummary = readReviewTrustSummary(
            requiredReviews,
            reviewsRoot,
            safeTaskId,
            scopeCategory,
            preflightSha256,
            preflight,
            repoRoot
        );
        const reviewGateTrustSummary = readReviewTrustSummaryFromReviewGate(
            reviewGate,
            requiredReviews,
            safeTaskId,
            scopeCategory,
            preflightSha256
        );
        const hasRequiredReviews = Object.values(requiredReviews).some((value) => value);
        const reviewTrustSummary = reviewGateTrustSummary
            ?? receiptReviewTrustSummary
            ?? (hasRequiredReviews
                ? buildUnavailableRequiredReviewTrustSummary(requiredReviews, scopeCategory)
                : null);
        const reviewIntegrityAttestation = buildReviewIntegrityAttestation({
            requiredReviews,
            reviewsRoot,
            taskId: safeTaskId,
            scopeCategory,
            preflightSha256,
            reviewTrustSummary,
            repoRoot,
            currentPreflight: preflight,
            timelineEvents: events
        });
        const reviewAttemptSummary = buildReviewAttemptSummary({
            reviewsRoot,
            taskId: safeTaskId,
            timelineEvents: events
        });
        const reviewTimingAudit = buildReviewTimingAuditSummary(reviewsRoot, safeTaskId, events);
        return {
            evidence,
            requiredReviewBlockers,
            reviewAttemptSummary,
            reviewIntegrityAttestation,
            reviewTimingAudit,
            reviewTrustSummary,
            reviewVerdicts
        };
    });
    blockers.push(...auditedChangedFiles.violations.map((reason) => ({
        gate: 'doc-impact-gate',
        reason
    })));
    if (!hasCompletionPass) {
        blockers.push(...reviewSnapshot.requiredReviewBlockers);
    }
    if (projectMemoryImpactRequired && projectMemoryImpactEvidence.evidence_status !== 'CURRENT') {
        blockers.push({
            gate: 'project-memory-impact',
            reason:
                `Project memory impact evidence is ${projectMemoryImpactEvidence.evidence_status}. ` +
                `${projectMemoryImpactEvidence.visible_summary_line}`
        });
    }
    const completionReviewOrderBlocker = buildCompletionReviewOrderBlocker(
        requiredReviews,
        events,
        currentCycle,
        repoRoot
    );
    if (completionReviewOrderBlocker) {
        blockers.push(completionReviewOrderBlocker);
    }
    const tokenEconomy = buildTokenEconomySummary(safeTaskId, events, repoRoot, reviewsRoot);
    const evidence = reviewSnapshot.evidence;
    const hasFailedGate = gates.some((g) => g.status === 'FAIL');
    const failedGateNames = gates.filter((g) => g.status === 'FAIL').map((g) => g.gate);
    const hasNonCompletionFailure = failedGateNames.some((gateName) => gateName !== 'completion-gate');
    const hasIntegrityFailure = integrityStatus === 'FAILED';
    const completionGateLock = inspectCompletionGateFinalizationLock(reviewsRoot, safeTaskId);
    if (completionGateLock.active || completionGateLock.stale) {
        const ownerPidText = completionGateLock.owner_pid === null ? 'unknown' : String(completionGateLock.owner_pid);
        const ownerHostText = completionGateLock.owner_hostname || 'unknown';
        pointInTimeSnapshot = {
            status: 'FINALIZATION_IN_FLIGHT',
            gate: 'completion-gate',
            message: completionGateLock.active
                ? `Completion gate finalization is currently in flight under PID ${ownerPidText} on ${ownerHostText}, so this audit summary is a point-in-time snapshot and may still reflect an older completion result.`
                : `Completion finalization lock is stale (${completionGateLock.stale_reason || 'unknown reason'}, metadata=${completionGateLock.owner_metadata_status}) for PID ${ownerPidText} on ${ownerHostText}, so this audit summary is treated as a point-in-time snapshot and may still reflect an older completion result.`,
            recommended_action: completionGateLock.active
                ? `Re-run task-audit-summary sequentially after completion-gate finishes. ${completionGateLock.remediation}`
                : completionGateLock.remediation,
            lock_path: toPosix(completionGateLock.lock_path),
            owner_pid: completionGateLock.owner_pid,
            owner_hostname: completionGateLock.owner_hostname,
            owner_created_at_utc: completionGateLock.owner_created_at_utc,
            owner_alive: completionGateLock.owner_alive,
            owner_metadata_status: completionGateLock.owner_metadata_status,
            stale_reason: completionGateLock.stale_reason,
            subsystem_scope_note: completionGateLock.subsystem_scope_note,
            acquisition_policy: completionGateLock.acquisition_policy
        };
    }

    if (hasIntegrityFailure) {
        blockers.push({
            gate: 'integrity',
            reason: `Task event timeline integrity check returned ${integrityStatus}`
        });
    }

    const hasNonCompletionBlockers = blockers.some((blocker) => blocker.gate !== 'completion-gate');
    if (
        pointInTimeSnapshot.status === 'FINALIZATION_IN_FLIGHT'
        && !hasIntegrityFailure
        && !hasNonCompletionBlockers
        && !hasNonCompletionFailure
    ) {
        for (let index = blockers.length - 1; index >= 0; index--) {
            if (blockers[index].gate === 'completion-gate') {
                blockers.splice(index, 1);
            }
        }
    }

    let status: 'PASS' | 'BLOCKED' | 'INCOMPLETE';
    const reviewsRequired = Object.keys(requiredReviews).some((reviewType) => requiredReviews[reviewType]);
    const reviewDomainFinalitySatisfied = reviewsRequired
        && reviewSnapshot.reviewIntegrityAttestation.completion_allowed === true
        && reviewSnapshot.reviewIntegrityAttestation.completion_review_attested === true;
    const supportingLifecycleAnchorEvents = new Set([
        'HANDSHAKE_DIAGNOSTICS_RECORDED',
        'SHELL_SMOKE_PREFLIGHT_RECORDED',
        'PREFLIGHT_CLASSIFIED',
        'COMPILE_GATE_PASSED',
        'REVIEW_PHASE_STARTED',
        'REVIEW_GATE_PASSED',
        'REVIEW_GATE_PASSED_WITH_OVERRIDE',
        'DOC_IMPACT_ASSESSED',
        PROJECT_MEMORY_IMPACT_ASSESSED_EVENT
    ]);
    const requireSupportingGateCompleteness = events.some((event) =>
        supportingLifecycleAnchorEvents.has(String(event.event_type || ''))
    );
    const supportingGateGaps = requireSupportingGateCompleteness
        ? gates
            .filter((gate) => {
                if (gate.gate === 'completion-gate') {
                    return false;
                }
                if (!reviewsRequired && gate.gate === 'review-phase') {
                    return false;
                }
                if (gate.gate === 'required-reviews-check' && reviewDomainFinalitySatisfied) {
                    return false;
                }
                return gate.status !== 'PASS';
            })
            .map((gate) => gate.gate)
        : [];
    if (pointInTimeSnapshot.status === 'FINALIZATION_IN_FLIGHT') {
        status = !hasIntegrityFailure && blockers.length === 0 && !hasNonCompletionFailure
            ? 'INCOMPLETE'
            : 'BLOCKED';
    } else if (
        hasCompletionPass
        && blockers.length === 0
        && !hasIntegrityFailure
        && supportingGateGaps.length === 0
    ) {
        status = 'PASS';
    } else if (hasFailedGate || blockers.length > 0) {
        status = 'BLOCKED';
    } else {
        status = 'INCOMPLETE';
    }

    const commitGuardEnabled = workspaceStatusSnapshot.enforceNoAutoCommit === true;
    const committableChangedFiles = resolveCommittableChangedFiles(repoRoot);
    const commitCandidateChangedFiles = committableChangedFiles == null
        ? changedFiles.filter((changedFile) => !isLocalControlPlaneCommitPath(changedFile))
        : committableChangedFiles;
    const commitCommand = buildCommitCommandSuggestion(
        commitCandidateChangedFiles.length > 0 ? commitCandidateChangedFiles : changedFiles,
        taskMetadata,
        commitGuardEnabled
    );
    const commitRequired = committableChangedFiles == null
        ? changedFiles.some((changedFile) => !isLocalControlPlaneCommitPath(changedFile))
        : committableChangedFiles.length > 0;
    const commitCommandTemplate = commitRequired
        ? commitCommand.template
        : 'No commit command required.';
    const commitCommandSuggestion = commitRequired
        ? commitCommand.suggestion
        : NO_COMMIT_REQUIRED_MESSAGE;
    const commitQuestionText = commitRequired
        ? 'Do you want me to commit now? (yes/no)'
        : NO_COMMIT_CONFIRMATION_MESSAGE;
    
    const {
        reviewVerdicts,
        reviewTrustSummary,
        reviewAttemptSummary,
        reviewTimingAudit,
        reviewIntegrityAttestation
    } = reviewSnapshot;
    const reviewIntegrityBlocker = hasCompletionPass && reviewIntegrityAttestation.completion_allowed === false
        ? {
            gate: 'review-integrity',
            reason: reviewIntegrityAttestation.reason
        }
        : null;
    if (reviewIntegrityBlocker && !blockers.some((blocker) => blocker.gate === reviewIntegrityBlocker.gate)) {
        blockers.push(reviewIntegrityBlocker);
    }
    if (status === 'PASS' && reviewIntegrityBlocker) {
        status = 'BLOCKED';
    }
    const optionalSkillsPath = path.join(reviewsRoot, `${safeTaskId}-optional-skill-selection.json`);
    const bundleRoot = path.dirname(path.dirname(reviewsRoot));
    const taskEventsTimelineEvidence = readOptionalSkillSelectionTimelineEvidence(bundleRoot, safeTaskId, taskEventFile);
    const optionalSkillsSummary = readOptionalSkillsSummary(
        bundleRoot,
        preflightPath,
        preflightSha256,
        taskMetadata?.title || null,
        taskFileExists && taskMetadata == null,
        optionalSkillsPath,
        safeReadJson(optionalSkillsPath),
        taskEventsTimelineEvidence
    );
    const implementationSummaryRequirements = [
        'path mode',
        'review verdicts',
        'docs updated'
    ];
    if (projectMemoryImpactRequired || projectMemoryImpactEvidence.evidence_status !== 'NOT_REQUIRED') {
        implementationSummaryRequirements.push('project memory status');
    }
    const finalReportContract: FinalReportContract = {
        status: status === 'PASS' ? 'READY' : 'NOT_READY',
        blocker: status === 'PASS'
            ? null
            : reviewIntegrityBlocker
                ? `Review integrity blocked final closeout: ${reviewIntegrityBlocker.reason}`
            : pointInTimeSnapshot.status === 'FINALIZATION_IN_FLIGHT' && status === 'INCOMPLETE'
                ? `${pointInTimeSnapshot.message} ${pointInTimeSnapshot.recommended_action}`
                : hasCompletionPass && supportingGateGaps.length > 0
                    ? `Completion gate passed, but supporting lifecycle evidence is incomplete: ${supportingGateGaps.join(', ')}.`
                : hasCompletionPass && blockers.length > 0
                    ? `Completion gate passed, but final closeout is blocked: ${blockers.map((blocker) => blocker.reason).join(' ')}`
                : 'Completion gate has not passed cleanly yet; do not deliver the task-complete final report contract.',
        required_order: [
            'short agent-authored summary of what changed',
            'verbatim Garda final user report'
        ],
        implementation_summary_requirements: implementationSummaryRequirements,
        commit_command_template: commitCommandTemplate,
        commit_command_suggestion: commitCommandSuggestion,
        commit_question: commitQuestionText
    };
    let closeoutScopeSnapshot: ReturnType<typeof getWorkspaceSnapshotCached> | null = null;
    if (changedFiles.length > 0) {
        try {
            closeoutScopeSnapshot = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', true, changedFiles, {
                noCache: true,
                readOnly: true
            });
        } catch {
            closeoutScopeSnapshot = null;
        }
    }
    const finalCloseout: FinalCloseoutArtifact = {
        schema_version: 1,
        event_source: 'task-audit-summary',
        task_id: safeTaskId,
        generated_utc: new Date().toISOString(),
        audit_status: status,
        status: finalReportContract.status,
        blocker: finalReportContract.blocker,
        artifact_state: finalReportContract.status === 'READY' ? 'PENDING' : 'NOT_READY',
        cycle_binding: currentCycle
            ? {
                preflight_path: currentCycle.preflight_path,
                preflight_sha256: currentCycle.preflight_sha256,
                compile_gate_timestamp: currentCycle.compile_gate_timestamp
            }
            : null,
        artifact_paths: {
            json: toPosix(finalCloseoutJsonPath),
            markdown: toPosix(finalCloseoutMarkdownPath),
            final_user_report: toPosix(finalUserReportPath)
        },
        implementation_summary: {
            requested_depth: parseOptionalNumber(taskMode?.requested_depth),
            effective_depth: parseOptionalNumber(taskMode?.effective_depth),
            path_mode: pathMode,
            orchestrator_work: taskMode?.orchestrator_work === true,
            workflow_config_work: taskMode?.workflow_config_work === true,
            planned_changed_files: readTaskModePlannedChangedFiles(taskMode),
            review_verdicts: reviewVerdicts,
            docs_updated: docsSummary.decision === 'DOCS_UPDATED',
            changed_files: changedFiles,
            changed_files_sha256: closeoutScopeSnapshot?.changed_files_sha256 ?? null,
            scope_content_sha256: closeoutScopeSnapshot?.scope_content_sha256 ?? null,
            scope_sha256: closeoutScopeSnapshot?.scope_sha256 ?? null,
            domain_scope_fingerprints: closeoutScopeSnapshot
                ? buildDomainScopeFingerprints({
                    repoRoot,
                    detectionSource: closeoutScopeSnapshot.detection_source,
                    includeUntracked: !!closeoutScopeSnapshot.include_untracked,
                    changedFiles: closeoutScopeSnapshot.changed_files
                })
                : null,
            changed_files_count: changedFilesCount,
            changed_lines_total: changedLinesTotal,
            scope_category: scopeCategory,
            active_profile: typeof taskMode?.active_profile === 'string' && taskMode.active_profile.trim()
                ? taskMode.active_profile.trim()
                : null
        },
        review_trust: reviewTrustSummary,
        review_timing_audit: reviewTimingAudit,
        review_integrity_attestation: reviewIntegrityAttestation,
        review_attempt_summary: reviewAttemptSummary,
        optional_skills: optionalSkillsSummary,
        workflow: {
            mandatory_full_suite_enabled: fullSuiteValidationRequiredForLifecycle,
            visible_summary_line: `Mandatory full-suite: ${fullSuiteValidationRequiredForLifecycle ? 'true' : 'false'}`,
            review_execution_policy_mode: reviewExecutionPolicyMode,
            review_execution_policy_summary_line: buildReviewExecutionPolicySummaryLine(reviewExecutionPolicyMode)
        },
        docs: docsSummary,
        project_memory: buildFinalCloseoutProjectMemorySummary(projectMemoryImpactEvidence),
        token_economy: tokenEconomy,
        task_queue_status_contract: buildTaskQueueStatusContract(safeTaskId),
        agent_report: {
            assistant_language: workspaceStatusSnapshot.assistantLanguage,
            assistant_language_confirmed: workspaceStatusSnapshot.assistantLanguageConfirmed,
            next_task_command: workspaceStatusSnapshot.readyForTasks
                ? workspaceStatusSnapshot.recommendedNextCommand
                : null,
            latest_update_notice: workspaceStatusSnapshot.latestUpdateNotice
        },
        commit_command_template: commitCommandTemplate,
        commit_command_suggestion: commitCommandSuggestion,
        commit_question: finalReportContract.commit_question
    };

    return {
        task_id: safeTaskId,
        generated_utc: finalCloseout.generated_utc,
        status,
        events_count: orderedEvents.count,
        first_event_utc: orderedEvents.firstEventUtc,
        last_event_utc: orderedEvents.lastEventUtc,
        integrity_status: integrityStatus,
        gates,
        changed_files: changedFiles,
        changed_files_count: changedFilesCount,
        changed_lines_total: changedLinesTotal,
        required_reviews: requiredReviews,
        scope_category: scopeCategory,
        profile_review_decisions: profileReviewDecisions,
        evidence,
        blockers,
        point_in_time_snapshot: pointInTimeSnapshot,
        review_attempt_summary: reviewAttemptSummary,
        final_report_contract: finalReportContract,
        final_closeout: finalCloseout
    };
}

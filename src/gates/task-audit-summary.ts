import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomically } from '../core/filesystem';
import { assertValidTaskId, inspectTaskEventFile } from '../gate-runtime/task-events';
import { withReviewArtifactReadBarrier } from '../gate-runtime/review-artifacts';
import { inspectCompletionGateFinalizationLock, type CompletionGateFinalizationLockPolicy } from './finalization-lock';
import { fileSha256, toPosix } from './helpers';
import {
    buildTokenEconomySummary,
    formatTimestamp,
    normalizeCycleBindingPath,
    parseTimestamp,
    resolveTaskCycleBindingSnapshot,
    shouldIncludeFullSuiteTelemetryForCurrentCycle,
    type TaskCycleBindingSnapshot
} from './task-events-summary';
import { readOptionalSkillSelectionTimelineEvidence } from '../runtime/optional-skill-selection';
import { resolveFullSuiteValidationRequirementForOrderedTaskEvents } from '../gate-runtime/lifecycle-event-types';
import { getClassificationConfig, isSafeOrdinaryDocumentationPath } from './classify-change';
import { loadFullSuiteValidationConfig } from './full-suite-validation';
import {
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    PROJECT_MEMORY_IMPACT_BLOCKED_EVENT,
    getProjectMemoryImpactLifecycleEvidence,
    type ProjectMemoryImpactLifecycleEvidence
} from './project-memory-impact';
import {
    LEGACY_REVIEW_EXECUTION_POLICY_MODE,
    buildReviewExecutionPolicySummaryLine,
    loadReviewExecutionPolicyConfig,
    resolveReviewExecutionPolicyModeFromPreflight,
    type EffectiveReviewExecutionPolicyMode
} from '../core/review-execution-policy';
import { getStatusSnapshot } from '../validators';
import { getWorkspaceSnapshotCached } from './workspace-snapshot-cache';
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
    collectKnownRequiredReviewTypes,
    readDocImpactSummary,
    readReviewTrustSummary,
    readReviewTrustSummaryFromReviewGate,
    buildReviewAttemptSummary,
    readOptionalSkillsSummary,
    readReviewVerdicts,
    readTaskQueueMetadata,
    resolveEventsRoot,
    resolveReviewsRoot,
    safeReadJson,
    updateEvidenceArtifactState
} from './task-audit-summary-collectors';
import { buildCommitCommandSuggestion, formatFinalCloseoutMarkdown } from './task-audit-summary-renderers';
import { cleanupTerminalReviewTempOutputs } from '../cli/commands/gates-artifacts';
import {
    buildTaskQueueStatusContract,
    type TaskQueueStatusContract
} from '../core/task-queue-status-contract';
export { formatFinalCloseoutMarkdown, formatTaskAuditSummaryText } from './task-audit-summary-renderers';

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

type TaskAuditEvent = Record<string, unknown>;

interface LifecycleGateSpec {
    gate: string;
    pass_event: string;
    fail_events: string[];
}

interface OrderedTaskEvents {
    events: TaskAuditEvent[];
    count: number;
    firstEventUtc: string | null;
    lastEventUtc: string | null;
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

const BASE_LIFECYCLE_GATES: ReadonlyArray<LifecycleGateSpec> = [
    { gate: 'enter-task-mode', pass_event: 'TASK_MODE_ENTERED', fail_events: [] },
    { gate: 'load-rule-pack', pass_event: 'RULE_PACK_LOADED', fail_events: ['RULE_PACK_LOAD_FAILED'] },
    { gate: 'handshake-diagnostics', pass_event: 'HANDSHAKE_DIAGNOSTICS_RECORDED', fail_events: [] },
    { gate: 'shell-smoke-preflight', pass_event: 'SHELL_SMOKE_PREFLIGHT_RECORDED', fail_events: [] },
    { gate: 'classify-change', pass_event: 'PREFLIGHT_CLASSIFIED', fail_events: ['PREFLIGHT_FAILED'] },
    { gate: 'compile-gate', pass_event: 'COMPILE_GATE_PASSED', fail_events: ['COMPILE_GATE_FAILED'] },
    { gate: 'review-phase', pass_event: 'REVIEW_PHASE_STARTED', fail_events: [] },
    { gate: 'required-reviews-check', pass_event: 'REVIEW_GATE_PASSED', fail_events: ['REVIEW_GATE_FAILED'] },
    { gate: 'doc-impact-gate', pass_event: 'DOC_IMPACT_ASSESSED', fail_events: ['DOC_IMPACT_ASSESSMENT_FAILED'] },
    { gate: 'completion-gate', pass_event: 'COMPLETION_GATE_PASSED', fail_events: ['COMPLETION_GATE_FAILED'] }
];

function getLifecycleGates(fullSuiteValidationEnabled: boolean, projectMemoryImpactRequired: boolean): LifecycleGateSpec[] {
    const gates = BASE_LIFECYCLE_GATES.map((entry) => ({
        gate: entry.gate,
        pass_event: entry.pass_event,
        fail_events: [...entry.fail_events]
    }));
    if (fullSuiteValidationEnabled) {
        const completionIndex = gates.findIndex((entry) => entry.gate === 'completion-gate');
        const fullSuiteGate = {
            gate: 'full-suite-validation',
            pass_event: 'FULL_SUITE_VALIDATION_PASSED',
            fail_events: ['FULL_SUITE_VALIDATION_FAILED', 'FULL_SUITE_VALIDATION_SKIPPED']
        };
        if (completionIndex === -1) {
            gates.push(fullSuiteGate);
        } else {
            gates.splice(completionIndex, 0, fullSuiteGate);
        }
    }
    if (projectMemoryImpactRequired) {
        const currentCompletionIndex = gates.findIndex((entry) => entry.gate === 'completion-gate');
        const projectMemoryGate = {
            gate: 'project-memory-impact',
            pass_event: PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
            fail_events: [PROJECT_MEMORY_IMPACT_BLOCKED_EVENT]
        };
        if (currentCompletionIndex === -1) {
            gates.push(projectMemoryGate);
        } else {
            gates.splice(currentCompletionIndex, 0, projectMemoryGate);
        }
    }
    return gates;
}

function readOrderedTaskEvents(taskEventFile: string): OrderedTaskEvents {
    const events: TaskAuditEvent[] = [];

    if (fs.existsSync(taskEventFile) && fs.statSync(taskEventFile).isFile()) {
        const rawLines = fs.readFileSync(taskEventFile, 'utf8')
            .split('\n')
            .filter((line) => line.trim());
        for (const line of rawLines) {
            try {
                const event = JSON.parse(line);
                if (event != null) {
                    events.push(event);
                }
            } catch {
                // Skip malformed event lines so one bad write does not hide the rest of the timeline.
            }
        }
    }

    events.sort((a, b) => {
        const ta = parseTimestamp(a.timestamp_utc);
        const tb = parseTimestamp(b.timestamp_utc);
        return ta.getTime() - tb.getTime();
    });

    return {
        events,
        count: events.length,
        firstEventUtc: events.length > 0 ? formatTimestamp(events[0].timestamp_utc) : null,
        lastEventUtc: events.length > 0 ? formatTimestamp(events[events.length - 1].timestamp_utc) : null
    };
}

function findLatestEventForTypes(
    eventTypes: string[],
    events: TaskAuditEvent[],
    predicate?: (eventType: string, event: TaskAuditEvent) => boolean
): { event: TaskAuditEvent; eventType: string } | null {
    if (events.length === 0 || eventTypes.length === 0) {
        return null;
    }
    const wantedTypes = new Set(eventTypes);
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const eventType = String(event.event_type || '');
        if (!wantedTypes.has(eventType)) {
            continue;
        }
        if (predicate && !predicate(eventType, event)) {
            continue;
        }
        return { event, eventType };
    }
    return null;
}

const CURRENT_CYCLE_DOWNSTREAM_GATES = new Set([
    'review-phase',
    'required-reviews-check',
    'doc-impact-gate',
    'full-suite-validation',
    'project-memory-impact',
    'completion-gate'
]);

function isEventRelevantForLifecycleGate(
    gateSpec: LifecycleGateSpec,
    eventType: string,
    event: TaskAuditEvent,
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string
): boolean {
    if (!CURRENT_CYCLE_DOWNSTREAM_GATES.has(gateSpec.gate) || !currentCycle?.compile_gate_timestamp) {
        return true;
    }

    const eventTime = parseTimestamp(event.timestamp_utc).getTime();
    const compileTime = parseTimestamp(currentCycle.compile_gate_timestamp).getTime();
    if (eventTime > 0 && compileTime > 0 && eventTime < compileTime) {
        return false;
    }

    if (gateSpec.gate !== 'full-suite-validation') {
        return true;
    }

    const details = event.details && typeof event.details === 'object'
        ? event.details as Record<string, unknown>
        : null;
    return shouldIncludeFullSuiteTelemetryForCurrentCycle(
        eventType,
        event.timestamp_utc,
        details,
        currentCycle,
        repoRoot
    );
}

function readTaskEventSequence(event: TaskAuditEvent): number | null {
    const integrity = event.integrity && typeof event.integrity === 'object' ? event.integrity as Record<string, unknown> : null;
    const sequence = typeof integrity?.task_sequence === 'number' ? integrity.task_sequence : Number(integrity?.task_sequence);
    return Number.isInteger(sequence) ? sequence : null;
}

function taskEventOccursAfter(candidate: TaskAuditEvent, anchor: TaskAuditEvent, currentCycle: TaskCycleBindingSnapshot | null): boolean {
    const candidateSequence = readTaskEventSequence(candidate);
    const anchorSequence = readTaskEventSequence(anchor);
    if (candidateSequence != null && anchorSequence != null) {
        return candidateSequence > anchorSequence;
    }
    const candidateTime = parseTimestamp(candidate.timestamp_utc).getTime();
    const anchorTime = parseTimestamp(anchor.timestamp_utc).getTime();
    const compileTime = currentCycle?.compile_gate_timestamp ? parseTimestamp(currentCycle.compile_gate_timestamp).getTime() : 0;
    if (candidateTime > 0 && compileTime > 0 && candidateTime < compileTime) {
        return false;
    }
    return candidateTime > 0 && anchorTime > 0 && candidateTime > anchorTime;
}

function buildCompletionReviewOrderBlocker(
    requiredReviews: Record<string, boolean>,
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string
): BlockerEntry | null {
    if (!Object.values(requiredReviews).some((required) => required === true)) {
        return null;
    }
    const reviewGatePass = findLatestEventForTypes(
        ['REVIEW_GATE_PASSED', 'REVIEW_GATE_PASSED_WITH_OVERRIDE'],
        events,
        (eventType, event) => isEventRelevantForLifecycleGate(
            { gate: 'required-reviews-check', pass_event: 'REVIEW_GATE_PASSED', fail_events: ['REVIEW_GATE_FAILED'] },
            eventType,
            event,
            currentCycle,
            repoRoot
        )
    );
    if (reviewGatePass) {
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index];
            if (!taskEventOccursAfter(event, reviewGatePass.event, currentCycle)) {
                continue;
            }
            const eventType = String(event.event_type || '').trim().toUpperCase();
            const details = event.details && typeof event.details === 'object' ? event.details as Record<string, unknown> : null;
            const reviewType = String(details?.review_type || details?.reviewType || '').trim().toLowerCase();
            if (eventType === 'REVIEW_RECORDED' && requiredReviews[reviewType] === true) {
                return {
                    gate: 'required-reviews-check',
                    reason: 'Required review evidence changed after REVIEW_GATE_PASSED; rerun required-reviews-check and completion-gate.'
                };
            }
        }
    }
    const completionPass = findLatestEventForTypes(
        ['COMPLETION_GATE_PASSED'],
        events,
        (eventType, event) => isEventRelevantForLifecycleGate(
            { gate: 'completion-gate', pass_event: 'COMPLETION_GATE_PASSED', fail_events: ['COMPLETION_GATE_FAILED'] },
            eventType,
            event,
            currentCycle,
            repoRoot
        )
    );
    if (!completionPass) {
        return null;
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!taskEventOccursAfter(event, completionPass.event, currentCycle)) {
            continue;
        }
        const eventType = String(event.event_type || '').trim().toUpperCase();
        const details = event.details && typeof event.details === 'object' ? event.details as Record<string, unknown> : null;
        const reviewType = String(details?.review_type || details?.reviewType || '').trim().toLowerCase();
        const reviewEvidenceChanged =
            (eventType === 'REVIEW_RECORDED' && requiredReviews[reviewType] === true)
            || eventType === 'REVIEW_GATE_PASSED'
            || eventType === 'REVIEW_GATE_PASSED_WITH_OVERRIDE'
            || eventType === 'REVIEW_GATE_FAILED';
        if (!reviewEvidenceChanged) {
            continue;
        }
        return {
            gate: 'completion-gate',
            reason: `Completion gate pass is stale because ${eventType} occurred afterward; rerun review gates and completion-gate.`
        };
    }
    return null;
}

function resolveFullSuiteValidationRequirementForCurrentCycle(
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string,
    liveFullSuiteValidationEnabled: boolean
): boolean {
    if (!currentCycle?.compile_gate_timestamp) {
        return resolveFullSuiteValidationRequirementForOrderedTaskEvents(
            events.map((event) => String(event.event_type || '')),
            liveFullSuiteValidationEnabled
        ).required;
    }

    const currentCycleFullSuiteEventTypes = events
        .filter((event) => shouldIncludeFullSuiteTelemetryForCurrentCycle(
            String(event.event_type || ''),
            event.timestamp_utc,
            event.details && typeof event.details === 'object'
                ? event.details as Record<string, unknown>
                : null,
            currentCycle,
            repoRoot
        ))
        .map((event) => String(event.event_type || '').trim().toUpperCase())
        .filter((eventType) => eventType.startsWith('FULL_SUITE_VALIDATION_'));

    if (currentCycleFullSuiteEventTypes.length > 0) {
        return resolveFullSuiteValidationRequirementForOrderedTaskEvents(
            currentCycleFullSuiteEventTypes,
            liveFullSuiteValidationEnabled
        ).required;
    }

    return liveFullSuiteValidationEnabled;
}

function hasCurrentCycleProjectMemoryImpactEvent(
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string
): boolean {
    const gateSpec: LifecycleGateSpec = {
        gate: 'project-memory-impact',
        pass_event: PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
        fail_events: [PROJECT_MEMORY_IMPACT_BLOCKED_EVENT]
    };
    return events.some((event) => {
        const eventType = String(event.event_type || '').trim().toUpperCase();
        if (eventType !== PROJECT_MEMORY_IMPACT_ASSESSED_EVENT && eventType !== PROJECT_MEMORY_IMPACT_BLOCKED_EVENT) {
            return false;
        }
        return isEventRelevantForLifecycleGate(gateSpec, eventType, event, currentCycle, repoRoot);
    });
}

function resolveLifecycleGateStatus(
    gateSpec: LifecycleGateSpec,
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string
): { gateOutcome: GateOutcome; blocker: BlockerEntry | null } {
    const passEvents = gateSpec.pass_event === 'REVIEW_GATE_PASSED'
        ? [gateSpec.pass_event, 'REVIEW_GATE_PASSED_WITH_OVERRIDE']
        : gateSpec.pass_event === 'FULL_SUITE_VALIDATION_PASSED'
            ? [gateSpec.pass_event, 'FULL_SUITE_VALIDATION_WARNED']
            : [gateSpec.pass_event];
    const lifecyclePredicate = (eventType: string, event: TaskAuditEvent): boolean => (
        isEventRelevantForLifecycleGate(gateSpec, eventType, event, currentCycle, repoRoot)
    );
    const latestPass = findLatestEventForTypes(passEvents, events, lifecyclePredicate);
    const latestFail = findLatestEventForTypes(gateSpec.fail_events, events, lifecyclePredicate);

    if (latestPass && latestFail) {
        const passTime = parseTimestamp(latestPass.event.timestamp_utc).getTime();
        const failTime = parseTimestamp(latestFail.event.timestamp_utc).getTime();
        if (failTime > passTime) {
            return {
                gateOutcome: {
                    gate: gateSpec.gate,
                    status: 'FAIL',
                    event_type: latestFail.eventType,
                    timestamp_utc: formatTimestamp(latestFail.event.timestamp_utc)
                },
                blocker: {
                    gate: gateSpec.gate,
                    reason: `Gate emitted ${latestFail.eventType} after earlier pass`
                }
            };
        }
    }

    if (latestPass) {
        return {
            gateOutcome: {
                gate: gateSpec.gate,
                status: 'PASS',
                event_type: latestPass.eventType,
                timestamp_utc: formatTimestamp(latestPass.event.timestamp_utc)
            },
            blocker: null
        };
    }

    if (latestFail) {
        return {
            gateOutcome: {
                gate: gateSpec.gate,
                status: 'FAIL',
                event_type: latestFail.eventType,
                timestamp_utc: formatTimestamp(latestFail.event.timestamp_utc)
            },
            blocker: {
                gate: gateSpec.gate,
                reason: `Gate emitted ${latestFail.eventType}`
            }
        };
    }

    return {
        gateOutcome: {
            gate: gateSpec.gate,
            status: 'MISSING',
            event_type: gateSpec.pass_event
        },
        blocker: null
    };
}

function buildLifecycleGateOutcomes(
    lifecycleGates: LifecycleGateSpec[],
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string
): { gates: GateOutcome[]; blockers: BlockerEntry[] } {
    const gates: GateOutcome[] = [];
    const blockers: BlockerEntry[] = [];

    for (const gateSpec of lifecycleGates) {
        const resolvedGate = resolveLifecycleGateStatus(gateSpec, events, currentCycle, repoRoot);
        gates.push(resolvedGate.gateOutcome);
        if (resolvedGate.blocker) {
            blockers.push(resolvedGate.blocker);
        }
    }

    return { gates, blockers };
}

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

function buildAuditedChangedFiles(
    repoRoot: string,
    preflightChangedFiles: string[],
    docsSummary: FinalCloseoutDocsSummary
): { changedFiles: string[]; violations: string[] } {
    const changedFiles: string[] = [];
    const seen = new Set<string>();
    const preflightPathSet = new Set(preflightChangedFiles.map((entry) => toPosix(String(entry || '').trim())).filter(Boolean));
    const classificationConfig = getClassificationConfig(repoRoot);
    const violations: string[] = [];
    const appendPath = (value: unknown): void => {
        const normalized = toPosix(String(value || '').trim());
        if (!normalized || seen.has(normalized)) {
            return;
        }
        seen.add(normalized);
        changedFiles.push(normalized);
    };

    for (const changedFile of preflightChangedFiles) {
        appendPath(changedFile);
    }
    if (docsSummary.decision === 'DOCS_UPDATED') {
        for (const docsUpdatedPath of docsSummary.docs_updated) {
            const normalized = toPosix(String(docsUpdatedPath || '').trim());
            if (!normalized || preflightPathSet.has(normalized)) {
                appendPath(normalized);
                continue;
            }
            const isAcceptedDocPath = isSafeOrdinaryDocumentationPath(normalized, classificationConfig);
            if (isAcceptedDocPath) {
                appendPath(normalized);
                continue;
            }
            violations.push(
                `Doc impact docs_updated contains non-documentation path '${normalized}' that is not in preflight changed_files. ` +
                'Refresh preflight for implementation drift or remove the path from docs_updated.'
            );
        }
    }
    return { changedFiles, violations };
}

function buildPostDoneWorkspaceDriftBlocker(
    repoRoot: string,
    auditedChangedFiles: string[],
    preflightChangedFiles: string[],
    preflight: Record<string, unknown> | null,
    finalCloseoutJsonPath: string
): BlockerEntry | null {
    let currentChangedFiles: string[];
    try {
        currentChangedFiles = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, [], {
            noCache: true,
            readOnly: true
        }).changed_files.map((entry) => toPosix(entry)).filter(Boolean);
    } catch (error) {
        const gitMetadataPath = path.join(repoRoot, '.git');
        if (!fs.existsSync(gitMetadataPath)) {
            return null;
        }
        return {
            gate: 'post-done-drift',
            reason:
                'Unable to inspect tracked post-DONE workspace drift for the completed task closeout: ' +
                `${error instanceof Error ? error.message : String(error)}. ` +
                'Do not report final closeout as ready until workspace drift can be inspected or the task is explicitly reopened/reset.'
        };
    }
    const auditedSet = new Set(auditedChangedFiles.map((entry) => toPosix(entry)).filter(Boolean));
    const auditedScopeBlocker = buildPostDoneAuditedScopeDriftBlocker(
        repoRoot,
        [...auditedSet].sort(),
        finalCloseoutJsonPath
    );
    if (auditedScopeBlocker) {
        return auditedScopeBlocker;
    }
    if (currentChangedFiles.length === 0) {
        return null;
    }

    const unexpectedFiles = [...new Set(currentChangedFiles.filter((entry) => !auditedSet.has(entry)))].sort();
    if (unexpectedFiles.length === 0) {
        return buildPostDoneSameScopeDriftBlocker(
            repoRoot,
            auditedChangedFiles,
            preflightChangedFiles,
            preflight,
            finalCloseoutJsonPath
        );
    }

    return {
        gate: 'post-done-drift',
        reason:
            'Tracked post-DONE workspace drift exists outside the completed task closeout scope: ' +
            `${unexpectedFiles.join(', ')}. ` +
            'Do not reopen classify, compile, review, full-suite, or completion gates automatically; isolate or explicitly reopen/reset the task before continuing.'
    };
}

function buildPostDoneSameScopeDriftBlocker(
    repoRoot: string,
    auditedChangedFiles: string[],
    preflightChangedFiles: string[],
    preflight: Record<string, unknown> | null,
    finalCloseoutJsonPath: string
): BlockerEntry | null {
    const implementationFiles = [...new Set(preflightChangedFiles.map((entry) => toPosix(entry)).filter(Boolean))].sort();
    const auditedFiles = [...new Set(auditedChangedFiles.map((entry) => toPosix(entry)).filter(Boolean))].sort();
    if (implementationFiles.length === 0) {
        return buildPostDoneAuditedScopeDriftBlocker(repoRoot, auditedFiles, finalCloseoutJsonPath);
    }
    if (!preflight || typeof preflight !== 'object') {
        return null;
    }
    const metrics = preflight.metrics && typeof preflight.metrics === 'object'
        ? preflight.metrics as Record<string, unknown>
        : null;
    const expectedScopeContentSha256 = typeof metrics?.scope_content_sha256 === 'string'
        ? metrics.scope_content_sha256.trim().toLowerCase()
        : '';
    const expectedChangedLinesTotal = typeof metrics?.changed_lines_total === 'number'
        ? metrics.changed_lines_total
        : Number(metrics?.changed_lines_total);
    if (!expectedScopeContentSha256 && !Number.isFinite(expectedChangedLinesTotal)) {
        return null;
    }

    let currentImplementationSnapshot: ReturnType<typeof getWorkspaceSnapshotCached>;
    try {
        currentImplementationSnapshot = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', true, implementationFiles, {
            noCache: true,
            readOnly: true
        });
    } catch (error) {
        const gitMetadataPath = path.join(repoRoot, '.git');
        if (!fs.existsSync(gitMetadataPath)) {
            return null;
        }
        return {
            gate: 'post-done-drift',
            reason:
                'Unable to inspect audited post-DONE implementation content for the completed task closeout: ' +
                `${error instanceof Error ? error.message : String(error)}. ` +
                'Do not report final closeout as ready until workspace drift can be inspected or the task is explicitly reopened/reset.'
        };
    }

    const currentScopeContentSha256 = typeof currentImplementationSnapshot.scope_content_sha256 === 'string'
        ? currentImplementationSnapshot.scope_content_sha256.trim().toLowerCase()
        : '';
    const contentChanged = !!expectedScopeContentSha256
        && !!currentScopeContentSha256
        && currentScopeContentSha256 !== expectedScopeContentSha256;
    const lineCountChanged = Number.isFinite(expectedChangedLinesTotal)
        && currentImplementationSnapshot.changed_lines_total !== expectedChangedLinesTotal;
    if (!contentChanged && !lineCountChanged) {
        return buildPostDoneAuditedScopeDriftBlocker(repoRoot, auditedFiles, finalCloseoutJsonPath);
    }

    const details = [
        contentChanged ? 'scope_content_sha256 differs from completed preflight' : '',
        lineCountChanged ? `changed_lines_total ${currentImplementationSnapshot.changed_lines_total} differs from completed preflight ${expectedChangedLinesTotal}` : ''
    ].filter(Boolean).join('; ');
    return {
        gate: 'post-done-drift',
        reason:
            'Tracked post-DONE workspace drift changed audited implementation content: ' +
            `${implementationFiles.join(', ')} (${details}). ` +
            'Do not reopen classify, compile, review, full-suite, or completion gates automatically; isolate or explicitly reopen/reset the task before continuing.'
    };
}

function buildPostDoneAuditedScopeDriftBlocker(
    repoRoot: string,
    auditedFiles: string[],
    finalCloseoutJsonPath: string
): BlockerEntry | null {
    if (auditedFiles.length === 0) {
        return null;
    }
    const closeout = safeReadJson(finalCloseoutJsonPath);
    const implementationSummary = closeout && typeof closeout.implementation_summary === 'object'
        ? closeout.implementation_summary as Record<string, unknown>
        : null;
    const expectedScopeContentSha256 = typeof implementationSummary?.scope_content_sha256 === 'string'
        ? implementationSummary.scope_content_sha256.trim().toLowerCase()
        : '';
    const expectedChangedFilesSha256 = typeof implementationSummary?.changed_files_sha256 === 'string'
        ? implementationSummary.changed_files_sha256.trim().toLowerCase()
        : '';
    if (!expectedScopeContentSha256 && !expectedChangedFilesSha256) {
        return null;
    }

    let currentAuditedSnapshot: ReturnType<typeof getWorkspaceSnapshotCached>;
    try {
        currentAuditedSnapshot = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', true, auditedFiles, {
            noCache: true,
            readOnly: true
        });
    } catch (error) {
        const gitMetadataPath = path.join(repoRoot, '.git');
        if (!fs.existsSync(gitMetadataPath)) {
            return null;
        }
        return {
            gate: 'post-done-drift',
            reason:
                'Unable to inspect audited post-DONE closeout content: ' +
                `${error instanceof Error ? error.message : String(error)}. ` +
                'Do not report final closeout as ready until workspace drift can be inspected or the task is explicitly reopened/reset.'
        };
    }

    const contentChanged = !!expectedScopeContentSha256
        && currentAuditedSnapshot.scope_content_sha256 !== expectedScopeContentSha256;
    const fileSetChanged = !!expectedChangedFilesSha256
        && currentAuditedSnapshot.changed_files_sha256 !== expectedChangedFilesSha256;
    if (!contentChanged && !fileSetChanged) {
        return null;
    }

    const details = [
        contentChanged ? 'audited scope_content_sha256 differs from materialized final closeout' : '',
        fileSetChanged ? 'audited changed_files_sha256 differs from materialized final closeout' : ''
    ].filter(Boolean).join('; ');
    return {
        gate: 'post-done-drift',
        reason:
            'Tracked post-DONE workspace drift changed audited closeout content: ' +
            `${auditedFiles.join(', ')} (${details}). ` +
            'Do not reopen classify, compile, review, full-suite, or completion gates automatically; isolate or explicitly reopen/reset the task before continuing.'
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

function buildRequiredReviewBlocker(reviewType: string, taskId: string, reviewsRoot: string): BlockerEntry | null {
    const gate = `${reviewType}-review`;
    const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    const reviewPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    const hasReceipt = fs.existsSync(receiptPath);
    const hasReview = fs.existsSync(reviewPath);

    if (!hasReceipt && !hasReview) {
        return { gate, reason: `Required ${reviewType} review artifact not found` };
    }
    if (!hasReceipt) {
        return {
            gate,
            reason: `Required ${reviewType} review receipt not found (review markdown exists but receipt is missing)`
        };
    }
    if (!hasReview) {
        return {
            gate,
            reason: `Required ${reviewType} review markdown not found (receipt exists but review document is missing)`
        };
    }

    const receipt = safeReadJson(receiptPath);
    if (!receipt) {
        return {
            gate,
            reason: `Required ${reviewType} review receipt is malformed or unreadable`
        };
    }
    if (receipt.task_id !== taskId) {
        return {
            gate,
            reason: `Required ${reviewType} review receipt belongs to a different task: ${receipt.task_id}`
        };
    }
    if (receipt.review_type !== reviewType) {
        return {
            gate,
            reason: `Required ${reviewType} review receipt has mismatched review type: ${receipt.review_type}`
        };
    }
    if (typeof receipt.review_artifact_sha256 === 'string' && receipt.review_artifact_sha256) {
        const actualHash = fileSha256(reviewPath);
        if (actualHash && receipt.review_artifact_sha256 !== actualHash) {
            return {
                gate,
                reason: `Required ${reviewType} review artifact was modified after receipt was issued`
            };
        }
    }

    return null;
}

function shouldValidateRequiredReviewArtifactForCurrentCycle(
    reviewType: string,
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null
): boolean {
    if (!currentCycle?.compile_gate_timestamp) {
        return true;
    }

    const compileGateTime = parseTimestamp(currentCycle.compile_gate_timestamp).getTime();
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const eventTime = parseTimestamp(event.timestamp_utc).getTime();
        if (eventTime > 0 && compileGateTime > 0 && eventTime < compileGateTime) {
            continue;
        }

        const eventType = String(event.event_type || '').trim().toUpperCase();
        if (
            eventType === 'REVIEW_GATE_PASSED'
            || eventType === 'REVIEW_GATE_PASSED_WITH_OVERRIDE'
            || eventType === 'REVIEW_GATE_FAILED'
            || eventType === 'COMPLETION_GATE_PASSED'
            || eventType === 'COMPLETION_GATE_FAILED'
        ) {
            return true;
        }

        if (eventType !== 'REVIEW_RECORDED') {
            continue;
        }
        const details = event.details && typeof event.details === 'object'
            ? event.details as Record<string, unknown>
            : null;
        const recordedReviewType = String(
            details?.review_type
            || details?.reviewType
            || ''
        ).trim().toLowerCase();
        if (recordedReviewType === reviewType) {
            return true;
        }
    }

    return false;
}

function collectRequiredReviewBlockers(
    requiredReviews: Record<string, boolean>,
    taskId: string,
    reviewsRoot: string,
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null
): BlockerEntry[] {
    return withReviewArtifactReadBarrier(reviewsRoot, () => (
        collectKnownRequiredReviewTypes(requiredReviews)
            .flatMap((reviewType) => {
                if (!shouldValidateRequiredReviewArtifactForCurrentCycle(reviewType, events, currentCycle)) {
                    return [];
                }
                const blocker = buildRequiredReviewBlocker(reviewType, taskId, reviewsRoot);
                return blocker ? [blocker] : [];
            })
    ));
}

function collectEvidenceArtifacts(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    taskEventFile: string,
    projectMemoryImpact: ProjectMemoryImpactLifecycleEvidence
): EvidenceArtifact[] {
    const evidence = withReviewArtifactReadBarrier(reviewsRoot, () => (
        ARTIFACT_PATTERNS.map(({ kind, suffix }) => {
            const artifactPath = path.join(reviewsRoot, `${taskId}${suffix}`);
            const exists = fs.existsSync(artifactPath);
            return {
                kind,
                path: toPosix(artifactPath),
                exists,
                sha256: exists ? fileSha256(artifactPath) : null
            };
        })
    ));

    if (projectMemoryImpact.required || projectMemoryImpact.evidence_status !== 'NOT_REQUIRED') {
        for (const [kind, artifactPath] of [
            ['project-memory-impact', projectMemoryImpact.artifact_path],
            ['project-memory-update', projectMemoryImpact.update_artifact_path]
        ] as const) {
            const resolvedPath = path.resolve(repoRoot, artifactPath);
            const exists = fs.existsSync(resolvedPath);
            evidence.push({
                kind,
                path: toPosix(resolvedPath),
                exists,
                sha256: exists ? fileSha256(resolvedPath) : null
            });
        }
    }

    evidence.push({
        kind: 'task-events',
        path: toPosix(taskEventFile),
        exists: fs.existsSync(taskEventFile),
        sha256: fs.existsSync(taskEventFile) ? fileSha256(taskEventFile) : null
    });

    return evidence;
}

function buildFinalCloseoutProjectMemorySummary(
    evidence: ProjectMemoryImpactLifecycleEvidence
): FinalCloseoutProjectMemorySummary {
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

// Artifact name patterns relative to reviews root, keyed by kind.
const ARTIFACT_PATTERNS: ReadonlyArray<{ kind: string; suffix: string }> = [
    { kind: 'task-mode', suffix: '-task-mode.json' },
    { kind: 'rule-pack', suffix: '-rule-pack.json' },
    { kind: 'handshake', suffix: '-handshake.json' },
    { kind: 'shell-smoke', suffix: '-shell-smoke.json' },
    { kind: 'preflight', suffix: '-preflight.json' },
    { kind: 'compile-gate', suffix: '-compile-gate.json' },
    { kind: 'compile-output', suffix: '-compile-output.log' },
    { kind: 'review-gate', suffix: '-review-gate.json' },
    { kind: 'doc-impact', suffix: '-doc-impact.json' },
    { kind: 'full-suite-validation', suffix: '-full-suite-validation.json' },
    { kind: 'full-suite-output', suffix: '-full-suite-output.log' },
    { kind: 'optional-skill-selection', suffix: '-optional-skill-selection.json' },
    { kind: 'final-closeout-json', suffix: '-final-closeout.json' },
    { kind: 'final-closeout-markdown', suffix: '-final-closeout.md' },
    { kind: 'no-op', suffix: '-no-op.json' },
    { kind: 'code-review', suffix: '-code.md' },
    { kind: 'code-review-context', suffix: '-code-review-context.json' },
    { kind: 'code-receipt', suffix: '-code-receipt.json' },
    { kind: 'db-review', suffix: '-db.md' },
    { kind: 'db-review-context', suffix: '-db-review-context.json' },
    { kind: 'db-receipt', suffix: '-db-receipt.json' },
    { kind: 'security-review', suffix: '-security.md' },
    { kind: 'security-review-context', suffix: '-security-review-context.json' },
    { kind: 'security-receipt', suffix: '-security-receipt.json' },
    { kind: 'refactor-review', suffix: '-refactor.md' },
    { kind: 'refactor-review-context', suffix: '-refactor-review-context.json' },
    { kind: 'refactor-receipt', suffix: '-refactor-receipt.json' },
    { kind: 'test-review', suffix: '-test.md' },
    { kind: 'test-review-context', suffix: '-test-review-context.json' },
    { kind: 'test-receipt', suffix: '-test-receipt.json' },
    { kind: 'api-review', suffix: '-api.md' },
    { kind: 'api-review-context', suffix: '-api-review-context.json' },
    { kind: 'api-receipt', suffix: '-api-receipt.json' },
    { kind: 'performance-review', suffix: '-performance.md' },
    { kind: 'performance-review-context', suffix: '-performance-review-context.json' },
    { kind: 'performance-receipt', suffix: '-performance-receipt.json' },
    { kind: 'infra-review', suffix: '-infra.md' },
    { kind: 'infra-review-context', suffix: '-infra-review-context.json' },
    { kind: 'infra-receipt', suffix: '-infra-receipt.json' },
    { kind: 'dependency-review', suffix: '-dependency.md' },
    { kind: 'dependency-review-context', suffix: '-dependency-review-context.json' },
    { kind: 'dependency-receipt', suffix: '-dependency-receipt.json' }
];

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
    const lifecycleGates = getLifecycleGates(fullSuiteValidationEnabled, projectMemoryImpactRequired);
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
            preflightSha256
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
            ?? (hasRequiredReviews
                ? buildUnavailableRequiredReviewTrustSummary(requiredReviews, scopeCategory)
                : receiptReviewTrustSummary);
        const reviewIntegrityAttestation = buildReviewIntegrityAttestation({
            requiredReviews,
            reviewsRoot,
            taskId: safeTaskId,
            scopeCategory,
            preflightSha256,
            reviewTrustSummary,
            repoRoot,
            timelineEvents: events
        });
        const reviewAttemptSummary = buildReviewAttemptSummary({
            reviewsRoot,
            taskId: safeTaskId,
            timelineEvents: events
        });
        return {
            evidence,
            requiredReviewBlockers,
            reviewAttemptSummary,
            reviewIntegrityAttestation,
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
    const commitCommand = buildCommitCommandSuggestion(changedFiles, taskMetadata, commitGuardEnabled);
    let isCleanWorktree: boolean;
    try {
        const currentWorkspaceSnapshot = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
        isCleanWorktree = currentWorkspaceSnapshot.changed_files_count === 0;
    } catch (e) {
        // Fallback for tests or non-git workspaces
        isCleanWorktree = false;
    }
    const commitQuestionText = isCleanWorktree
        ? 'Worktree is already clean; no further commit necessary.'
        : 'Do you want me to commit now? (yes/no)';
    
    const {
        reviewVerdicts,
        reviewTrustSummary,
        reviewAttemptSummary,
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
        'depth',
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
            'review integrity attestation',
            'implementation summary',
            commitCommand.suggestion,
            commitQuestionText
        ],
        implementation_summary_requirements: implementationSummaryRequirements,
        commit_command_template: commitCommand.template,
        commit_command_suggestion: commitCommand.suggestion,
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
            markdown: toPosix(finalCloseoutMarkdownPath)
        },
        implementation_summary: {
            requested_depth: parseOptionalNumber(taskMode?.requested_depth),
            effective_depth: parseOptionalNumber(taskMode?.effective_depth),
            path_mode: pathMode,
            review_verdicts: reviewVerdicts,
            docs_updated: docsSummary.decision === 'DOCS_UPDATED',
            changed_files: changedFiles,
            changed_files_sha256: closeoutScopeSnapshot?.changed_files_sha256 ?? null,
            scope_content_sha256: closeoutScopeSnapshot?.scope_content_sha256 ?? null,
            scope_sha256: closeoutScopeSnapshot?.scope_sha256 ?? null,
            changed_files_count: changedFilesCount,
            changed_lines_total: changedLinesTotal,
            scope_category: scopeCategory,
            active_profile: typeof taskMode?.active_profile === 'string' && taskMode.active_profile.trim()
                ? taskMode.active_profile.trim()
                : null
        },
        review_trust: reviewTrustSummary,
        review_integrity_attestation: reviewIntegrityAttestation,
        review_attempt_summary: reviewAttemptSummary,
        optional_skills: optionalSkillsSummary,
        workflow: {
            mandatory_full_suite_enabled: fullSuiteValidationEnabled,
            visible_summary_line: `Mandatory full-suite: ${fullSuiteValidationEnabled ? 'true' : 'false'}`,
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
        commit_command_template: commitCommand.template,
        commit_command_suggestion: commitCommand.suggestion,
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

export function synchronizeFinalCloseoutArtifacts(summary: TaskAuditSummaryResult): TaskAuditSummaryResult {
    const jsonPath = summary.final_closeout.artifact_paths.json;
    const markdownPath = summary.final_closeout.artifact_paths.markdown;

    if (summary.final_closeout.status === 'READY') {
        const closeout = {
            ...summary.final_closeout,
            artifact_state: 'MATERIALIZED' as const
        };
        writeFileAtomically(jsonPath, JSON.stringify(closeout, null, 2) + '\n', { encoding: 'utf8' });
        writeFileAtomically(markdownPath, formatFinalCloseoutMarkdown(closeout) + '\n', { encoding: 'utf8' });
        cleanupTerminalReviewTempOutputs(path.resolve(path.dirname(jsonPath), '..', '..', '..'), summary.task_id);
        summary.final_closeout = closeout;
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-json', jsonPath, true);
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-markdown', markdownPath, true);
        return summary;
    }

    if (summary.point_in_time_snapshot.status === 'FINALIZATION_IN_FLIGHT') {
        const jsonExists = fs.existsSync(jsonPath);
        const markdownExists = fs.existsSync(markdownPath);
        summary.final_closeout = {
            ...summary.final_closeout,
            artifact_state: jsonExists || markdownExists ? 'MATERIALIZED' : 'NOT_READY'
        };
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-json', jsonPath, jsonExists);
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-markdown', markdownPath, markdownExists);
        return summary;
    }

    if (summary.blockers.some((blocker) => blocker.gate === 'post-done-drift')) {
        const jsonExists = fs.existsSync(jsonPath);
        const markdownExists = fs.existsSync(markdownPath);
        summary.final_closeout = {
            ...summary.final_closeout,
            artifact_state: jsonExists || markdownExists ? 'MATERIALIZED' : 'NOT_READY'
        };
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-json', jsonPath, jsonExists);
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-markdown', markdownPath, markdownExists);
        return summary;
    }

    let removed = false;
    for (const artifactPath of [jsonPath, markdownPath]) {
        if (fs.existsSync(artifactPath)) {
            fs.rmSync(artifactPath, { force: true });
            removed = true;
        }
    }
    summary.final_closeout = {
        ...summary.final_closeout,
        artifact_state: removed ? 'REMOVED' : 'NOT_READY'
    };
    updateEvidenceArtifactState(summary.evidence, 'final-closeout-json', jsonPath, false);
    updateEvidenceArtifactState(summary.evidence, 'final-closeout-markdown', markdownPath, false);
    return summary;
}

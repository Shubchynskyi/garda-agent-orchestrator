import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBundleCliCommand, getSourceCliCommand, resolveBundleName } from '../core/constants';
import { assertValidTaskId } from '../gate-runtime/task-events';
import { normalizeReviewerExecutionMode, type ReviewReceipt } from '../gate-runtime/review-context';
import { getReviewSkillCandidates } from './build-review-context';
import {
    computeProtectedSnapshotDigest,
    fileSha256,
    normalizePath,
    joinOrchestratorPath,
    resolvePathInsideRepo,
    toPlainRecord,
    getProtectedControlPlaneRoots,
    isOrchestratorSourceCheckout,
    scanProtectedPathHashes,
    evaluateProtectedControlPlaneManifest
} from './helpers';
import { detectCodeChanged, preflightRequiresAnyReview } from './preflight-code-change';
import { evaluateIsolationModePostTask, loadIsolationModeConfig } from './isolation-mode';
import { validateSandbox, compareSandboxToLive } from './isolation-sandbox';
import {
    detectProtectedDirtyWorkspaceDrift,
    getProtectedDirtyWorkspaceScopeFromPreflight
} from './dirty-worktree-protection';
import { getProtectedManifestLifecycleGuard } from './protected-manifest-guard';
import { getNoOpEvidence, type NoOpEvidenceResult } from './no-op';
import { getHandshakeEvidence, getHandshakeEvidenceViolations } from './handshake-diagnostics';
import { getShellSmokeEvidence, getShellSmokeEvidenceViolations } from './shell-smoke-preflight';
import { getRulePackEvidence, getRulePackEvidenceViolations } from './rule-pack';
import { getReviewContextContractViolations } from './review-context-contract';
import { getCanonicalReviewContextPath, resolveCanonicalReviewContextPath } from './review-context-paths';
import {
    getRequiredUpstreamReviewsFromRecord,
    normalizeRequiredReviewRecord
} from './review-dependencies';
import { readRuntimeReviewerProvider, resolveReviewerRoutingPolicy } from './reviewer-routing';
import { collectTaskTimelineEventTypes, getTaskModeEvidence, getTaskModeEvidenceViolations } from './task-mode';

/**
 * Canonical stage ordering for code-changing tasks.
 * Each entry is the earliest-allowed position (0-based) in the lifecycle.
 * Completion gate fails when a required stage event appears before its prerequisites.
 */
export const STAGE_SEQUENCE_ORDER: readonly string[] = Object.freeze([
    'TASK_MODE_ENTERED',
    'HANDSHAKE_DIAGNOSTICS_RECORDED',
    'SHELL_SMOKE_PREFLIGHT_RECORDED',
    'PREFLIGHT_CLASSIFIED',
    'IMPLEMENTATION_STARTED',
    'COMPILE_GATE_PASSED',
    'REVIEW_PHASE_STARTED',
    'REVIEW_RECORDED',
    'REVIEW_GATE_PASSED'
]);

export const NO_REVIEW_RECORDED_STAGE_SEQUENCE_ORDER: readonly string[] = Object.freeze(
    STAGE_SEQUENCE_ORDER.filter((stage) => stage !== 'REVIEW_RECORDED')
);

export const NON_CODE_STAGE_SEQUENCE_ORDER = NO_REVIEW_RECORDED_STAGE_SEQUENCE_ORDER;

export { detectCodeChanged, preflightRequiresAnyReview } from './preflight-code-change';

export interface TimelineEventEntry {
    event_type: string;
    timestamp_utc: string;
    sequence: number;
    details: Record<string, unknown> | null;
}

export interface StageSequenceEvidence {
    observed_order: string[];
    expected_order: string[];
    code_changed: boolean;
    review_skill_ids: string[];
    review_skill_reference_paths: string[];
    review_artifact_keys: string[];
    reviewer_execution_modes: string[];
    violations: string[];
}

export interface ZeroDiffCompletionEvidence {
    zero_diff_detected: boolean;
    status: 'NOT_APPLICABLE' | 'REQUIRES_AUDITED_NO_OP' | 'SATISFIED_BY_AUDITED_NO_OP';
    no_op_evidence_path: string | null;
    no_op_classification: string | null;
    no_op_reason: string | null;
    violations: string[];
}

function eventMatchesStage(entry: TimelineEventEntry, stage: string): boolean {
    if (stage === 'REVIEW_GATE_PASSED') {
        return entry.event_type === 'REVIEW_GATE_PASSED' || entry.event_type === 'REVIEW_GATE_PASSED_WITH_OVERRIDE';
    }
    return entry.event_type === stage;
}

function findLatestStageOccurrence(
    events: readonly TimelineEventEntry[],
    stage: string,
    upperBoundExclusive: number
): TimelineEventEntry | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (entry.sequence >= upperBoundExclusive) {
            continue;
        }
        if (eventMatchesStage(entry, stage)) {
            return entry;
        }
    }
    return null;
}

function findLatestRecordedReviewContextPath(
    events: readonly TimelineEventEntry[],
    reviewKey: string
): string | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (entry.event_type !== 'REVIEW_RECORDED') {
            continue;
        }
        const recordedReviewType = String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase();
        if (recordedReviewType !== reviewKey) {
            continue;
        }
        const reviewContextPath = String(entry.details?.review_context_path || entry.details?.reviewContextPath || '').trim();
        if (reviewContextPath) {
            return reviewContextPath;
        }
    }
    return null;
}

function findLatestStageOccurrenceInRange(
    events: readonly TimelineEventEntry[],
    stage: string,
    lowerBoundExclusive: number,
    upperBoundExclusive: number
): TimelineEventEntry | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (entry.sequence >= upperBoundExclusive) {
            continue;
        }
        if (entry.sequence <= lowerBoundExclusive) {
            break;
        }
        if (eventMatchesStage(entry, stage)) {
            return entry;
        }
    }
    return null;
}

const CYCLE_BOUNDARY_EVENTS = new Set([
    'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE',
    'COMPLETION_GATE_FAILED',
    'COMPLETION_GATE_PASSED'
]);

/**
 * Read ordered timeline events from a JSONL file.
 * Returns events in file order (integrity-sequence order) with their event types.
 */
export function collectOrderedTimelineEvents(timelinePath: string, errors: string[]): TimelineEventEntry[] {
    const entries: TimelineEventEntry[] = [];
    const resolvedPath = path.resolve(String(timelinePath || ''));
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        errors.push(`Task timeline not found: ${normalizePath(resolvedPath)}`);
        return entries;
    }

    const lines = fs.readFileSync(resolvedPath, 'utf8').split('\n').filter(line => line.trim().length > 0);
    let seq = 0;
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const eventType = String(parsed.event_type || '').trim().toUpperCase();
            const timestampUtc = String(parsed.timestamp_utc || '').trim();
            const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                ? parsed.details as Record<string, unknown>
                : null;
            if (eventType) {
                entries.push({ event_type: eventType, timestamp_utc: timestampUtc, sequence: seq, details });
            }
            seq++;
        } catch {
            errors.push(`Task timeline contains invalid JSON line: ${normalizePath(resolvedPath)}`);
            seq++;
            continue;
        }
    }

    return entries;
}

function findLatestTimelineEvent(
    events: readonly TimelineEventEntry[],
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

/**
 * Validate that required stage events occurred in the canonical order.
 * Returns the first position of each required stage event in the timeline
 * and reports violations when ordering constraints are broken.
 */
export function validateStageSequence(
    events: TimelineEventEntry[],
    codeChanged: boolean,
    timelinePath: string,
    reviewRecordedRequired: boolean = codeChanged
): StageSequenceEvidence {
    const normalizedTimelinePath = normalizePath(timelinePath);
    const violations: string[] = [];
    const observedOrder: string[] = [];
    const expectedStages = reviewRecordedRequired
        ? [...STAGE_SEQUENCE_ORDER]
        : [...NO_REVIEW_RECORDED_STAGE_SEQUENCE_ORDER];

    const anchorStage = expectedStages[expectedStages.length - 1];
    const anchorEntry = anchorStage
        ? findLatestStageOccurrence(events, anchorStage, Number.POSITIVE_INFINITY)
        : null;

    const cycleLocalStages = new Set([
        'HANDSHAKE_DIAGNOSTICS_RECORDED',
        'SHELL_SMOKE_PREFLIGHT_RECORDED',
        'PREFLIGHT_CLASSIFIED',
        'IMPLEMENTATION_STARTED',
        'COMPILE_GATE_PASSED',
        'REVIEW_PHASE_STARTED',
        'REVIEW_GATE_PASSED',
        ...(reviewRecordedRequired ? ['REVIEW_RECORDED'] : [])
    ]);

    let cycleFloorExclusive = Number.NEGATIVE_INFINITY;
    if (anchorEntry) {
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const entry = events[index];
            if (entry.sequence >= anchorEntry.sequence) {
                continue;
            }
            if (CYCLE_BOUNDARY_EVENTS.has(entry.event_type)) {
                cycleFloorExclusive = entry.sequence;
                break;
            }
        }
    }

    const stageEntries = new Map<string, TimelineEventEntry>();
    const upperBoundExclusive = anchorEntry ? anchorEntry.sequence + 1 : Number.POSITIVE_INFINITY;
    for (const stage of expectedStages) {
        const lowerBoundExclusive = cycleLocalStages.has(stage) ? cycleFloorExclusive : Number.NEGATIVE_INFINITY;
        const latest = findLatestStageOccurrenceInRange(events, stage, lowerBoundExclusive, upperBoundExclusive);
        if (latest) {
            stageEntries.set(stage, latest);
        }
    }

    for (const stage of expectedStages) {
        if (stageEntries.has(stage)) {
            observedOrder.push(stage);
        }
    }

    for (let index = 0; index < expectedStages.length; index += 1) {
        const stage = expectedStages[index];
        if (stageEntries.has(stage)) {
            continue;
        }
        const laterStage = expectedStages
            .slice(index + 1)
            .find((candidate) => stageEntries.has(candidate));
        if (!laterStage) {
            continue;
        }
        const laterEntry = stageEntries.get(laterStage);
        const olderStage = findLatestStageOccurrence(events, stage, upperBoundExclusive);
        const backfillHint = olderStage
            ? ` Do not backfill '${stage}' from an older execution cycle.`
            : '';
        violations.push(
            `Stage sequence violation in '${normalizedTimelinePath}': ` +
            `latest '${laterStage}' evidence (seq ${laterEntry?.sequence ?? 'unknown'}) has no matching ` +
            `'${stage}' evidence inside the latest execution cycle.` +
            `${backfillHint} Expected order: ${expectedStages.join(' → ')}.`
        );
    }

    for (let index = 1; index < expectedStages.length; index += 1) {
        const previousStage = expectedStages[index - 1];
        const currentStage = expectedStages[index];
        const previousEntry = stageEntries.get(previousStage);
        const currentEntry = stageEntries.get(currentStage);

        if (!currentEntry) {
            continue;
        }

        if (!previousEntry) {
            const olderPrevious = findLatestStageOccurrence(events, previousStage, upperBoundExclusive);
            const backfillHint = olderPrevious
                ? ` Do not backfill '${previousStage}' from an older execution cycle.`
                : '';
            violations.push(
                `Stage sequence violation in '${normalizedTimelinePath}': ` +
                `latest '${currentStage}' evidence (seq ${currentEntry.sequence}) has no matching ` +
                `'${previousStage}' evidence inside the latest execution cycle.` +
                `${backfillHint} Expected order: ${expectedStages.join(' → ')}.`
            );
            continue;
        }

        if (currentEntry.sequence < previousEntry.sequence) {
            const olderPrevious = findLatestStageOccurrence(events, previousStage, currentEntry.sequence);
            const backfillHint = olderPrevious
                ? ` Do not backfill '${previousStage}' from an older execution cycle.`
                : '';
            violations.push(
                `Stage sequence violation in '${normalizedTimelinePath}': ` +
                `latest '${currentStage}' evidence (seq ${currentEntry.sequence}) appears before ` +
                `latest '${previousStage}' evidence (seq ${previousEntry.sequence}) in the latest execution cycle.` +
                `${backfillHint} Expected order: ${expectedStages.join(' → ')}.`
            );
        }
    }

    // For code-changing tasks, PREFLIGHT_CLASSIFIED is mandatory
    if (codeChanged && !stageEntries.has('PREFLIGHT_CLASSIFIED')) {
        violations.push(
            `Task timeline '${normalizedTimelinePath}' is missing PREFLIGHT_CLASSIFIED. ` +
            'Code-changing tasks must carry preflight classification evidence.'
        );
    }

    return {
        observed_order: observedOrder,
        expected_order: expectedStages,
        code_changed: codeChanged,
        review_skill_ids: [],
        review_skill_reference_paths: [],
        review_artifact_keys: [],
        reviewer_execution_modes: [],
        violations
    };
}

/**
 * Detect whether a task changed code, based on the preflight artifact.
 * Returns true when the preflight indicates code-like/runtime changes or any
 * review-requiring scope. Non-code categories such as docs/config/audit-only
 * must not force REVIEW_RECORDED evidence during completion.
 */
function detectZeroDiffPreflight(preflight: Record<string, unknown> | null): boolean {
    if (!preflight) return false;
    const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
        ? preflight.metrics as Record<string, unknown>
        : null;
    const changedLinesTotal = metrics && typeof metrics.changed_lines_total === 'number'
        ? metrics.changed_lines_total
        : 0;
    const changedFilesCount = Array.isArray(preflight.changed_files) ? preflight.changed_files.length : 0;
    return changedLinesTotal === 0 && changedFilesCount === 0;
}

export function validateZeroDiffCompletionEvidence(
    preflight: Record<string, unknown> | null,
    taskId: string,
    taskSummary: string | null,
    noOpEvidence: NoOpEvidenceResult
): ZeroDiffCompletionEvidence {
    const zeroDiffDetected = detectZeroDiffPreflight(preflight);
    if (!zeroDiffDetected) {
        return {
            zero_diff_detected: false,
            status: 'NOT_APPLICABLE',
            no_op_evidence_path: noOpEvidence.evidence_path,
            no_op_classification: noOpEvidence.classification,
            no_op_reason: noOpEvidence.reason,
            violations: []
        };
    }

    if (noOpEvidence.evidence_status === 'PASS') {
        return {
            zero_diff_detected: true,
            status: 'SATISFIED_BY_AUDITED_NO_OP',
            no_op_evidence_path: noOpEvidence.evidence_path,
            no_op_classification: noOpEvidence.classification,
            no_op_reason: noOpEvidence.reason,
            violations: []
        };
    }

    const summarySuffix = taskSummary ? ` (${taskSummary})` : '';
    return {
        zero_diff_detected: true,
        status: 'REQUIRES_AUDITED_NO_OP',
        no_op_evidence_path: noOpEvidence.evidence_path,
        no_op_classification: noOpEvidence.classification,
        no_op_reason: noOpEvidence.reason,
        violations: [
            `Task '${taskId}'${summarySuffix} has zero-diff preflight on a clean tree. ` +
            'Baseline-only preflight cannot complete the task by itself. ' +
            `Produce a real diff or record an audited no-op artifact at '${normalizePath(noOpEvidence.evidence_path || '')}' before DONE.`
        ]
    };
}

function quotePowerShellCliValue(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function buildCoherentCycleRestartCommand(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    taskModePath: string | null,
    commandsPath: string | null,
    outputFiltersPath: string | null
): string {
    const cliPrefix = isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleName());
    const parts = [
        `${cliPrefix} gate restart-coherent-cycle`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`,
        `--preflight-path ${quotePowerShellCliValue(preflightPath)}`
    ];
    if (taskModePath) {
        parts.push(`--task-mode-path ${quotePowerShellCliValue(taskModePath)}`);
    }
    if (commandsPath) {
        parts.push(`--commands-path ${quotePowerShellCliValue(commandsPath)}`);
    }
    if (outputFiltersPath) {
        parts.push(`--output-filters-path ${quotePowerShellCliValue(outputFiltersPath)}`);
    }
    return parts.join(' ');
}

function buildReviewCycleRestartCommand(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    taskModePath: string | null,
    commandsPath: string | null,
    outputFiltersPath: string | null
): string {
    const cliPrefix = isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleName());
    const parts = [
        `${cliPrefix} gate restart-review-cycle`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`,
        `--preflight-path ${quotePowerShellCliValue(preflightPath)}`
    ];
    if (taskModePath) {
        parts.push(`--task-mode-path ${quotePowerShellCliValue(taskModePath)}`);
    }
    if (commandsPath) {
        parts.push(`--commands-path ${quotePowerShellCliValue(commandsPath)}`);
    }
    if (outputFiltersPath) {
        parts.push(`--output-filters-path ${quotePowerShellCliValue(outputFiltersPath)}`);
    }
    return parts.join(' ');
}

function readOptionalArtifactStringField(
    artifact: Record<string, unknown> | null,
    fieldName: string
): string | null {
    if (!artifact) {
        return null;
    }
    const value = artifact[fieldName];
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed || null;
}

function normalizeTimelineDetailString(value: unknown): string | null {
    const text = String(value || '').trim();
    return text || null;
}

function getTimelineSkillId(event: TimelineEventEntry): string | null {
    if (!event.details) {
        return null;
    }
    return normalizeTimelineDetailString(event.details.skill_id ?? event.details.skillId)?.toLowerCase() || null;
}

function getTimelineReferencePath(event: TimelineEventEntry): string | null {
    if (!event.details) {
        return null;
    }
    const raw = normalizeTimelineDetailString(event.details.reference_path ?? event.details.referencePath);
    return raw ? normalizePath(raw).toLowerCase() : null;
}

function eventMatchesReviewSkill(event: TimelineEventEntry, candidateSkillIds: string[]): boolean {
    const normalizedCandidates = candidateSkillIds.map(candidate => candidate.toLowerCase());
    const skillId = getTimelineSkillId(event);
    if (skillId && normalizedCandidates.includes(skillId)) {
        return true;
    }

    const referencePath = getTimelineReferencePath(event);
    if (!referencePath) {
        return false;
    }

    return normalizedCandidates.some((candidate) => referencePath.includes(`/live/skills/${candidate.toLowerCase()}/`));
}

/**
 * Check if review artifact content is trivial (too short or only boilerplate).
 */
export function isTrivialReview(content: string): boolean {
    const text = (content || '').trim();
    if (text.length < 100) return true;
    const hasImplementationReference = text.includes('`')
        || /\b[A-Za-z0-9_./-]+\.[A-Za-z0-9]+(?::\d+)?\b/.test(text);

    // Check if findings and risks are all 'none' or 'n/a'
    const lines = text.split('\n');
    const findings = getMarkdownMeaningfulEntries(extractMarkdownSectionLines(lines, 'Findings by Severity'));
    const risks = getMarkdownMeaningfulEntries(extractMarkdownSectionLines(lines, 'Residual Risks'));

    // If both sections are empty of meaningful content, it might be trivial,
    // but we only block if total length is very low or no implementation details are mentioned.
    if (findings.length === 0 && risks.length === 0) {
        // Trivial if very few words
        const wordCount = text.split(/\s+/).length;
        if (wordCount < 30) return true;
        if (!hasImplementationReference && wordCount < 60) return true;
    }

    return false;
}

/**
 * Validate review-skill evidence for code-changing tasks.
 * When code changed but the review-gate artifact does not carry evidence
 * of actual review-skill invocations (review_checks with non-NOT_REQUIRED verdicts),
 * the completion gate fails.
 */
export function validateReviewSkillEvidence(
    events: TimelineEventEntry[],
    requiredReviews: Record<string, unknown>,
    reviewArtifacts: Record<string, {
        path: string;
        content?: string;
        reviewContext?: Record<string, unknown> | null;
        receipt?: ReviewReceipt | null;
    }>,
    codeChanged: boolean,
    timelinePath: string,
    sourceOfTruth: string | null = null
): { skill_ids: string[]; reference_paths: string[]; artifact_keys: string[]; reviewer_execution_modes: string[]; violations: string[] } {
    const result = {
        skill_ids: [] as string[],
        reference_paths: [] as string[],
        artifact_keys: [] as string[],
        reviewer_execution_modes: [] as string[],
        violations: [] as string[]
    };
    if (!codeChanged) return result;

    const normalizedTimelinePath = normalizePath(timelinePath);

    const requiredKeys: string[] = [];
    for (const [key, value] of Object.entries(requiredReviews)) {
        if (value === true) {
            requiredKeys.push(key);
        }
    }

    const compilePassSequence = findLatestTimelineEvent(events, (entry) => entry.event_type === 'COMPILE_GATE_PASSED')?.sequence ?? null;
    const reviewPhaseSequence = findLatestTimelineEvent(events, (entry) => entry.event_type === 'REVIEW_PHASE_STARTED')?.sequence ?? null;
    const reviewGatePassSequence = findLatestTimelineEvent(events, (entry) => (
        entry.event_type === 'REVIEW_GATE_PASSED' || entry.event_type === 'REVIEW_GATE_PASSED_WITH_OVERRIDE'
    ))?.sequence ?? null;
    const typedReviewPhaseEventsPresent = events.some((entry) => (
        entry.event_type === 'REVIEW_PHASE_STARTED'
        && normalizeTimelineDetailString(entry.details?.review_type ?? entry.details?.reviewType) !== null
    ));
    const getReviewPhaseSequenceForKey = (reviewKey: string): number | null => {
        const normalizedReviewKey = reviewKey.toLowerCase();
        const matchingTypedPhase = findLatestTimelineEvent(events, (entry) => (
            entry.event_type === 'REVIEW_PHASE_STARTED'
            && normalizeTimelineDetailString(entry.details?.review_type ?? entry.details?.reviewType) === normalizedReviewKey
        ));
        if (matchingTypedPhase) {
            return matchingTypedPhase.sequence;
        }
        if (!typedReviewPhaseEventsPresent) {
            return reviewPhaseSequence;
        }
        return null;
    };
    const reviewPhaseSequenceByKey = new Map<string, number | null>();
    const reviewRecordedEventByKey = new Map<string, TimelineEventEntry | null>();

    if (requiredKeys.length > 0 && reviewPhaseSequence == null) {
        result.violations.push(
            `Task timeline '${normalizedTimelinePath}' is missing REVIEW_PHASE_STARTED. ` +
            'Required review skills must be prepared before review gate completion.'
        );
    }

    const routingPolicy = resolveReviewerRoutingPolicy(sourceOfTruth);

    for (const key of requiredKeys) {
        const candidateSkillIds = getReviewSkillCandidates(key);
        const reviewPhaseSequenceForKey = getReviewPhaseSequenceForKey(key);
        reviewPhaseSequenceByKey.set(key, reviewPhaseSequenceForKey);
        const selectionEvent = findLatestTimelineEvent(events, (entry) => (
            entry.event_type === 'SKILL_SELECTED' && eventMatchesReviewSkill(entry, candidateSkillIds)
        ));
        const referenceEvent = findLatestTimelineEvent(events, (entry) => (
            entry.event_type === 'SKILL_REFERENCE_LOADED' && eventMatchesReviewSkill(entry, candidateSkillIds)
        ));
        const recordEvent = findLatestTimelineEvent(events, (entry) => (
            entry.event_type === 'REVIEW_RECORDED' && 
            String(entry.details?.review_type || entry.details?.reviewType || '').toLowerCase() === key.toLowerCase()
        ));
        reviewRecordedEventByKey.set(key, recordEvent);
        const routingEvent = findLatestTimelineEvent(events, (entry) => (
            entry.event_type === 'REVIEWER_DELEGATION_ROUTED' &&
            String(entry.details?.review_type || entry.details?.reviewType || '').toLowerCase() === key.toLowerCase()
        ));

        if (reviewPhaseSequence != null && reviewPhaseSequenceForKey == null) {
            result.violations.push(
                `Task timeline '${normalizedTimelinePath}' is missing REVIEW_PHASE_STARTED for required review '${key}'. ` +
                'Required review skills must be prepared before review gate completion.'
            );
        }

        if (!selectionEvent) {
            result.violations.push(
                `Code-changing task is missing SKILL_SELECTED telemetry for required review '${key}'. ` +
                `Expected one of: ${candidateSkillIds.join(', ')}.`
            );
        } else {
            const selectedSkillId = getTimelineSkillId(selectionEvent) || candidateSkillIds[0];
            if (!result.skill_ids.includes(selectedSkillId)) {
                result.skill_ids.push(selectedSkillId);
            }
            if (compilePassSequence != null && selectionEvent.sequence < compilePassSequence) {
                result.violations.push(
                    `Review skill '${selectedSkillId}' was selected before COMPILE_GATE_PASSED in '${normalizedTimelinePath}'.`
                );
            }
            if (reviewPhaseSequenceForKey != null && selectionEvent.sequence < reviewPhaseSequenceForKey) {
                result.violations.push(
                    `Review skill '${selectedSkillId}' was selected before REVIEW_PHASE_STARTED in '${normalizedTimelinePath}'.`
                );
            }
            if (reviewGatePassSequence != null && selectionEvent.sequence > reviewGatePassSequence) {
                result.violations.push(
                    `Review skill '${selectedSkillId}' was selected after REVIEW_GATE_PASSED in '${normalizedTimelinePath}'.`
                );
            }
        }

        if (!referenceEvent) {
            result.violations.push(
                `Code-changing task is missing SKILL_REFERENCE_LOADED telemetry for required review '${key}'. ` +
                `Expected one of: ${candidateSkillIds.join(', ')}.`
            );
        } else {
            const referencePath = getTimelineReferencePath(referenceEvent);
            if (referencePath && !result.reference_paths.includes(referencePath)) {
                result.reference_paths.push(referencePath);
            }
            if (reviewPhaseSequenceForKey != null && referenceEvent.sequence < reviewPhaseSequenceForKey) {
                result.violations.push(
                    `Review skill reference for '${key}' was loaded before REVIEW_PHASE_STARTED in '${normalizedTimelinePath}'.`
                );
            }
            if (reviewGatePassSequence != null && referenceEvent.sequence > reviewGatePassSequence) {
                result.violations.push(
                    `Review skill reference for '${key}' was loaded after REVIEW_GATE_PASSED in '${normalizedTimelinePath}'.`
                );
            }
        }

        if (!recordEvent) {
            result.violations.push(
                `Code-changing task is missing REVIEW_RECORDED telemetry for required review '${key}'. ` +
                "Review evidence was not officially recorded via 'gate record-review-receipt'."
            );
        } else if (compilePassSequence != null && recordEvent.sequence < compilePassSequence) {
            result.violations.push(
                `Required review '${key}' was recorded before the latest COMPILE_GATE_PASSED in '${normalizedTimelinePath}'. ` +
                `Do not backfill '${key}' review evidence from an older execution cycle.`
            );
        }
        if (!routingEvent) {
            result.violations.push(
                `Code-changing task is missing REVIEWER_DELEGATION_ROUTED telemetry for required review '${key}'. ` +
                'Required reviews must record whether delegated fresh-context execution or fallback mode was used.'
            );
        } else {
            const executionMode = normalizeTimelineDetailString(
                routingEvent.details?.reviewer_execution_mode ?? routingEvent.details?.reviewerExecutionMode
            );
            if (executionMode && !result.reviewer_execution_modes.includes(executionMode)) {
                result.reviewer_execution_modes.push(executionMode);
            }
            if (reviewPhaseSequenceForKey != null && routingEvent.sequence < reviewPhaseSequenceForKey) {
                result.violations.push(
                    `Reviewer routing telemetry for '${key}' was emitted before REVIEW_PHASE_STARTED in '${normalizedTimelinePath}'.`
                );
            }
            if (recordEvent && routingEvent.sequence > recordEvent.sequence) {
                result.violations.push(
                    `Reviewer routing telemetry for '${key}' was emitted after REVIEW_RECORDED in '${normalizedTimelinePath}'.`
                );
            }
        }
    }

    const normalizedRequiredReviewRecord = normalizeRequiredReviewRecord(requiredReviews);
    const upstreamRequiredReviewsByKey = new Map<string, string[]>();
    for (const key of requiredKeys) {
        upstreamRequiredReviewsByKey.set(
            key,
            getRequiredUpstreamReviewsFromRecord(key, normalizedRequiredReviewRecord)
        );
    }

    for (const key of requiredKeys) {
        const downstreamPhaseSequence = reviewPhaseSequenceByKey.get(key) ?? null;
        if (downstreamPhaseSequence == null) {
            continue;
        }
        const upstreamRequiredReviews = upstreamRequiredReviewsByKey.get(key) || [];
        for (const upstreamKey of upstreamRequiredReviews) {
            const upstreamRecordedEvent = reviewRecordedEventByKey.get(upstreamKey) ?? null;
            if (!upstreamRecordedEvent) {
                result.violations.push(
                    `Required review '${key}' cannot start before upstream review '${upstreamKey}' is recorded in '${normalizedTimelinePath}'. ` +
                    `Run and record '${upstreamKey}' for the current cycle before launching '${key}'.`
                );
                continue;
            }
            if (compilePassSequence != null && upstreamRecordedEvent.sequence < compilePassSequence) {
                result.violations.push(
                    `Required review '${key}' depends on upstream review '${upstreamKey}', but the latest '${upstreamKey}' evidence predates ` +
                    `COMPILE_GATE_PASSED in '${normalizedTimelinePath}'. Re-run or reuse '${upstreamKey}' for the current cycle before '${key}'.`
                );
                continue;
            }
            if (upstreamRecordedEvent.sequence > downstreamPhaseSequence) {
                result.violations.push(
                    `Required review '${key}' started before upstream review '${upstreamKey}' completed in '${normalizedTimelinePath}'. ` +
                    `Downstream '${key}' review must wait for current-cycle '${upstreamKey}' evidence.`
                );
            }
        }
    }

    // Verify that each required review has a corresponding review artifact
    for (const key of requiredKeys) {
        const artifact = reviewArtifacts[key];
        if (!artifact) {
            result.violations.push(
                `Code-changing task is missing review artifact for required review '${key}'. ` +
                'Review skill must be invoked and produce a review artifact before completion.'
            );
        } else {
            if (!result.artifact_keys.includes(key)) {
                result.artifact_keys.push(key);
            }

            const reviewContext = artifact.reviewContext && typeof artifact.reviewContext === 'object' && !Array.isArray(artifact.reviewContext)
                ? artifact.reviewContext as Record<string, unknown>
                : null;
            const reviewerRouting = reviewContext?.reviewer_routing && typeof reviewContext.reviewer_routing === 'object' && !Array.isArray(reviewContext.reviewer_routing)
                ? reviewContext.reviewer_routing as Record<string, unknown>
                : null;
            const routingEvent = findLatestTimelineEvent(events, (entry) => (
                entry.event_type === 'REVIEWER_DELEGATION_ROUTED' &&
                String(entry.details?.review_type || entry.details?.reviewType || '').toLowerCase() === key.toLowerCase()
            ));
            if (!reviewContext || !reviewerRouting) {
                result.violations.push(
                    `Required review '${key}' is missing a valid review-context artifact with reviewer_routing metadata.`
                );
            } else {
                const actualExecutionMode = normalizeReviewerExecutionMode(reviewerRouting.actual_execution_mode);
                const reviewerSessionId = normalizeTimelineDetailString(reviewerRouting.reviewer_session_id);
                const fallbackReason = normalizeTimelineDetailString(reviewerRouting.fallback_reason);
                if (reviewerRouting.actual_execution_mode && !actualExecutionMode) {
                    result.violations.push(
                        `Required review '${key}' has invalid reviewer_routing.actual_execution_mode ` +
                        `('${String(reviewerRouting.actual_execution_mode)}') in review-context.`
                    );
                } else if (!actualExecutionMode) {
                    result.violations.push(`Required review '${key}' is missing reviewer_routing.actual_execution_mode in review-context.`);
                } else {
                    if (!result.reviewer_execution_modes.includes(actualExecutionMode)) {
                        result.reviewer_execution_modes.push(actualExecutionMode);
                    }
                    if (routingPolicy.delegation_required && actualExecutionMode !== 'delegated_subagent') {
                        result.violations.push(
                            `Required review '${key}' must use delegated_subagent for provider '${routingPolicy.source_of_truth || 'unknown'}'.`
                        );
                    }
                    if (routingPolicy.capability_level === 'single_agent_only' && actualExecutionMode === 'delegated_subagent') {
                        result.violations.push(
                            `Required review '${key}' cannot use delegated_subagent for provider '${routingPolicy.source_of_truth || 'unknown'}'. ` +
                            'Explicit same_agent_fallback evidence is required on single-agent providers.'
                        );
                    }
                    if (!routingPolicy.fallback_allowed && actualExecutionMode === 'same_agent_fallback') {
                        result.violations.push(
                            `Required review '${key}' used same_agent_fallback on provider '${routingPolicy.source_of_truth || 'unknown'}', but fallback is not allowed.`
                        );
                    }
                    if (routingPolicy.fallback_reason_required && actualExecutionMode === 'same_agent_fallback' && !fallbackReason) {
                        result.violations.push(
                            `Required review '${key}' used same_agent_fallback without reviewer_routing.fallback_reason.`
                        );
                    }
                    if (actualExecutionMode === 'delegated_subagent' && reviewerSessionId && !reviewerSessionId.startsWith('agent:')) {
                        result.violations.push(
                            `Required review '${key}' claims delegated_subagent execution but reviewer_routing.reviewer_session_id ` +
                            `must be agent-scoped (expected prefix 'agent:').`
                        );
                    }
                    if (actualExecutionMode === 'same_agent_fallback' && reviewerSessionId && !reviewerSessionId.startsWith('self:')) {
                        result.violations.push(
                            `Required review '${key}' claims same_agent_fallback but reviewer_routing.reviewer_session_id ` +
                            `must be self-scoped (expected prefix 'self:').`
                        );
                    }
                }
                if (!reviewerSessionId) {
                    result.violations.push(`Required review '${key}' is missing reviewer_routing.reviewer_session_id in review-context.`);
                }
                const receipt = artifact.receipt;
                if (receipt) {
                    const receiptExecutionMode = normalizeReviewerExecutionMode(receipt.reviewer_execution_mode);
                    const receiptReviewerIdentity = normalizeTimelineDetailString(receipt.reviewer_identity);
                    const receiptFallbackReason = normalizeTimelineDetailString(receipt.reviewer_fallback_reason);
                    if (receipt.reviewer_execution_mode && !receiptExecutionMode) {
                        result.violations.push(
                            `Required review '${key}' has invalid receipt reviewer_execution_mode ` +
                            `('${String(receipt.reviewer_execution_mode)}').`
                        );
                    }
                    // T-1005: Enforce receipt field presence (not just consistency)
                    if (!receiptExecutionMode) {
                        result.violations.push(
                            `Required review '${key}' receipt is missing reviewer_execution_mode. ` +
                            'Every receipt must include reviewer_execution_mode for routing enforcement.'
                        );
                    }
                    if (!receiptReviewerIdentity) {
                        result.violations.push(
                            `Required review '${key}' receipt is missing reviewer_identity. ` +
                            'Every receipt must include reviewer_identity for routing enforcement.'
                        );
                    }
                    if (receiptExecutionMode === 'same_agent_fallback' && !receiptFallbackReason) {
                        result.violations.push(
                            `Required review '${key}' receipt used same_agent_fallback without reviewer_fallback_reason. ` +
                            'Fallback receipts must include reviewer_fallback_reason.'
                        );
                    }
                    // T-1005: Provider policy enforcement against receipt fields
                    if (receiptExecutionMode) {
                        if (routingPolicy.delegation_required && receiptExecutionMode !== 'delegated_subagent') {
                            result.violations.push(
                                `Required review '${key}' receipt must use delegated_subagent for provider '${routingPolicy.source_of_truth || 'unknown'}'. ` +
                                'Same-agent self-review is invalid on delegation-capable providers.'
                            );
                        }
                        if (routingPolicy.capability_level === 'single_agent_only' && receiptExecutionMode === 'delegated_subagent') {
                            result.violations.push(
                                `Required review '${key}' receipt cannot use delegated_subagent for provider '${routingPolicy.source_of_truth || 'unknown'}'. ` +
                                'Explicit same_agent_fallback evidence is required on single-agent providers.'
                            );
                        }
                        if (!routingPolicy.fallback_allowed && receiptExecutionMode === 'same_agent_fallback') {
                            result.violations.push(
                                `Required review '${key}' receipt used same_agent_fallback on provider '${routingPolicy.source_of_truth || 'unknown'}', but fallback is not allowed.`
                            );
                        }
                        if (routingPolicy.fallback_reason_required && receiptExecutionMode === 'same_agent_fallback' && !receiptFallbackReason) {
                            result.violations.push(
                                `Required review '${key}' receipt used same_agent_fallback on provider '${routingPolicy.source_of_truth || 'unknown'}' without reviewer_fallback_reason.`
                            );
                        }
                    }
                    if (receiptExecutionMode && actualExecutionMode && receiptExecutionMode !== actualExecutionMode) {
                        result.violations.push(
                            `Required review '${key}' has inconsistent execution mode between receipt (${receiptExecutionMode}) ` +
                            `and review-context (${actualExecutionMode}).`
                        );
                    }
                    if (receiptReviewerIdentity && reviewerSessionId && receiptReviewerIdentity !== reviewerSessionId) {
                        result.violations.push(
                            `Required review '${key}' has inconsistent reviewer identity between receipt (${receiptReviewerIdentity}) ` +
                            `and review-context (${reviewerSessionId}).`
                        );
                    }
                    if (receiptFallbackReason && fallbackReason && receiptFallbackReason !== fallbackReason) {
                        result.violations.push(
                            `Required review '${key}' has inconsistent fallback reason between receipt and review-context.`
                        );
                    }
                }
                if (routingEvent?.details) {
                    const routingExecutionMode = normalizeReviewerExecutionMode(
                        routingEvent.details.reviewer_execution_mode ?? routingEvent.details.reviewerExecutionMode
                    );
                    const routingSessionId = normalizeTimelineDetailString(
                        routingEvent.details.reviewer_session_id ?? routingEvent.details.reviewerSessionId
                    );
                    if (routingExecutionMode && actualExecutionMode && routingExecutionMode !== actualExecutionMode) {
                        result.violations.push(
                            `Required review '${key}' has inconsistent execution mode between REVIEWER_DELEGATION_ROUTED telemetry ` +
                            `(${routingExecutionMode}) and review-context (${actualExecutionMode}).`
                        );
                    }
                    if (routingSessionId && reviewerSessionId && routingSessionId !== reviewerSessionId) {
                        result.violations.push(
                            `Required review '${key}' has inconsistent reviewer identity between REVIEWER_DELEGATION_ROUTED telemetry ` +
                            `(${routingSessionId}) and review-context (${reviewerSessionId}).`
                        );
                    }
                }
            }

            // Triviality check.
            let artifactPath = (artifact as any).path;
            if (!artifactPath && timelinePath) {
                artifactPath = path.join(path.dirname(timelinePath.replace('task-events', 'reviews')), `${path.basename(timelinePath, '.jsonl')}-${key}.md`);
            }
            if (artifactPath && fs.existsSync(artifactPath)) {
                const content = (artifact as any).content || fs.readFileSync(artifactPath, 'utf8');
                if (isTrivialReview(content)) {
                    result.violations.push(
                        `Review artifact '${normalizePath(artifactPath)}' is trivial or obviously synthetic. ` +
                        'Meaningful review artifacts must include implementation details and carry at least 100 characters of content.'
                    );
                }
            }
        }
    }

    return result;
}

export const REVIEW_CONTRACTS = [
    ['code', 'REVIEW PASSED'],
    ['db', 'DB REVIEW PASSED'],
    ['security', 'SECURITY REVIEW PASSED'],
    ['refactor', 'REFACTOR REVIEW PASSED'],
    ['api', 'API REVIEW PASSED'],
    ['test', 'TEST REVIEW PASSED'],
    ['performance', 'PERFORMANCE REVIEW PASSED'],
    ['infra', 'INFRA REVIEW PASSED'],
    ['dependency', 'DEPENDENCY REVIEW PASSED']
];

export const EMPTY_REVIEW_MARKERS = new Set([
    'none', 'n/a', 'na', 'no findings', 'no residual risks',
    'no deferred findings', 'no open findings', 'no outstanding findings'
]);

/**
 * Extract lines from a markdown section by heading.
 */
export function extractMarkdownSectionLines(lines: string[], heading: string): string[] {
    const sectionLines: string[] = [];
    let capture = false;
    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        const headingMatch = /^(#{2,6})\s+(.+?)\s*$/.exec(trimmed);
        if (headingMatch) {
            if (capture) break;
            capture = headingMatch[2].trim().toLowerCase() === heading.trim().toLowerCase();
            continue;
        }
        if (capture) sectionLines.push(rawLine);
    }
    return sectionLines;
}

/**
 * Normalize review list text: strip bullets, backticks.
 */
export function normalizeReviewListText(value: unknown): string {
    if (value == null) return '';
    let text = String(value).trim();
    text = text.replace(/^(?:[-*+]\s+|\d+\.\s+)+/, '').trim();
    while (text.length >= 2 && text.startsWith('`') && text.endsWith('`')) {
        text = text.slice(1, -1).trim();
    }
    return text;
}

/**
 * Check if a review entry is meaningful (not an empty marker).
 */
export function isMeaningfulReviewEntry(value: unknown): boolean {
    const text = normalizeReviewListText(value);
    if (!text) return false;
    const normalized = text.trim().replace(/\.$/, '').trim().replace(/^`|`$/g, '').trim().toLowerCase();
    return !EMPTY_REVIEW_MARKERS.has(normalized);
}

/**
 * Get meaningful entries from a markdown section.
 */
export function getMarkdownMeaningfulEntries(sectionLines: string[]): string[] {
    const entries: string[] = [];
    let currentEntry: string | null = null;

    for (const rawLine of sectionLines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;

        const bulletMatch = /^(?:[-*+]\s+|\d+\.\s+)(.*)$/.exec(trimmed);
        if (bulletMatch) {
            if (isMeaningfulReviewEntry(currentEntry)) {
                entries.push(normalizeReviewListText(currentEntry));
            }
            const candidate = normalizeReviewListText(bulletMatch[1]);
            currentEntry = isMeaningfulReviewEntry(candidate) ? candidate : null;
            continue;
        }

        const candidate = normalizeReviewListText(trimmed);
        if (!isMeaningfulReviewEntry(candidate)) continue;
        currentEntry = currentEntry ? `${currentEntry} ${candidate}`.trim() : candidate;
    }

    if (isMeaningfulReviewEntry(currentEntry)) {
        entries.push(normalizeReviewListText(currentEntry));
    }

    return entries;
}

/**
 * Parse findings by severity from section lines.
 */
type SeverityLevel = 'critical' | 'high' | 'medium' | 'low';

export function getFindingsBySeverity(sectionLines: string[]): Record<SeverityLevel, string[]> {
    const findings: Record<SeverityLevel, string[]> = { critical: [], high: [], medium: [], low: [] };
    let currentSeverity: SeverityLevel | null = null;

    for (const rawLine of sectionLines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;

        const severityMatch = /^(?:[-*+]\s*)?(Critical|High|Medium|Low)\s*:\s*(.*)$/i.exec(trimmed);
        if (severityMatch) {
            currentSeverity = severityMatch[1].trim().toLowerCase() as SeverityLevel;
            const remainder = normalizeReviewListText(severityMatch[2]);
            if (isMeaningfulReviewEntry(remainder)) {
                findings[currentSeverity].push(remainder);
            }
            continue;
        }

        if (!currentSeverity) continue;

        const bulletMatch = /^(?:[-*+]\s+|\d+\.\s+)(.*)$/.exec(trimmed);
        if (bulletMatch) {
            const entry = normalizeReviewListText(bulletMatch[1]);
            if (isMeaningfulReviewEntry(entry)) {
                findings[currentSeverity].push(entry);
            }
            continue;
        }

        const entry = normalizeReviewListText(trimmed);
        if (!isMeaningfulReviewEntry(entry)) continue;
        if (findings[currentSeverity].length > 0) {
            findings[currentSeverity][findings[currentSeverity].length - 1] =
                `${findings[currentSeverity][findings[currentSeverity].length - 1]} ${entry}`.trim();
        } else {
            findings[currentSeverity].push(entry);
        }
    }

    return findings;
}

/**
 * Analyze review artifact for findings evidence.
 * Matches Python get_review_artifact_findings_evidence.
 */
export function getReviewArtifactFindingsEvidence(artifactPath: string, content: string) {
    const artifactPathNormalized = normalizePath(artifactPath);
    const result: {
        status: string;
        findings_section_present: boolean;
        residual_risks_section_present: boolean;
        deferred_findings_section_present: boolean;
        findings_by_severity: Record<SeverityLevel, string[]>;
        residual_risks: string[];
        deferred_findings: string[];
        missing_sections: string[];
        invalid_deferred_findings: string[];
        violations: string[];
    } = {
        status: 'UNKNOWN',
        findings_section_present: false,
        residual_risks_section_present: false,
        deferred_findings_section_present: false,
        findings_by_severity: { critical: [], high: [], medium: [], low: [] },
        residual_risks: [],
        deferred_findings: [],
        missing_sections: [],
        invalid_deferred_findings: [],
        violations: []
    };

    const lines = (content || '').split('\n');

    // Findings by Severity section
    const findingsLines = extractMarkdownSectionLines(lines, 'Findings by Severity');
    if (!findingsLines.length) {
        result.missing_sections.push('Findings by Severity');
        result.violations.push(
            `Review artifact '${artifactPathNormalized}' is missing required section '## Findings by Severity' for lifecycle validation.`
        );
    } else {
        result.findings_section_present = true;
        const findingsBySeverity = getFindingsBySeverity(findingsLines);
        result.findings_by_severity = findingsBySeverity;
        for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
            if (findingsBySeverity[severity].length > 0) {
                const severityLabel = severity.charAt(0).toUpperCase() + severity.slice(1);
                result.violations.push(
                    `Review artifact '${artifactPathNormalized}' still contains active ${severityLabel} findings. ` +
                    "Resolve them or move accepted non-blocking follow-up to 'Deferred Findings' with 'Justification:'."
                );
            }
        }
    }

    // Residual Risks section
    const residualLines = extractMarkdownSectionLines(lines, 'Residual Risks');
    if (!residualLines.length) {
        result.missing_sections.push('Residual Risks');
        result.violations.push(
            `Review artifact '${artifactPathNormalized}' is missing required section '## Residual Risks' for lifecycle validation.`
        );
    } else {
        result.residual_risks_section_present = true;
        const residualRisks = getMarkdownMeaningfulEntries(residualLines);
        result.residual_risks = residualRisks;
        if (residualRisks.length > 0) {
            result.violations.push(
                `Review artifact '${artifactPathNormalized}' still contains active residual risks. ` +
                "Move accepted non-blocking follow-up to 'Deferred Findings' with 'Justification:' before DONE."
            );
        }
    }

    // Deferred Findings section
    const deferredLines = extractMarkdownSectionLines(lines, 'Deferred Findings');
    if (deferredLines.length > 0) {
        result.deferred_findings_section_present = true;
        const deferredFindings = getMarkdownMeaningfulEntries(deferredLines);
        result.deferred_findings = deferredFindings;
        for (const entry of deferredFindings) {
            const justificationMatch = /\bJustification\s*:\s*(.+)$/i.exec(entry);
            const justification = justificationMatch ? justificationMatch[1].trim() : '';
            if (!justification || justification.length < 12) {
                result.invalid_deferred_findings.push(entry);
                result.violations.push(
                    `Review artifact '${artifactPathNormalized}' has deferred finding without usable 'Justification:': ${entry}`
                );
            }
        }
    }

    result.status = result.violations.length > 0 ? 'FAILED' : 'PASS';
    return result;
}

/**
 * Validate preflight for completion gate.
 */
export function validatePreflightForCompletion(preflightPath: string, explicitTaskId: string) {
    let preflight;
    try {
        preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    } catch {
        throw new Error(`Preflight artifact is not valid JSON: ${preflightPath}`);
    }

    const errors: string[] = [];
    let resolvedTaskId: string | null = null;
    if (explicitTaskId && explicitTaskId.trim()) {
        try {
            resolvedTaskId = assertValidTaskId(explicitTaskId);
        } catch (exc: unknown) {
            const message = exc instanceof Error ? exc.message : String(exc);
            errors.push(String(message));
        }
    }

    let preflightTaskId: string | null = preflight.task_id != null ? String(preflight.task_id).trim() : '';
    if (preflightTaskId) {
        try {
            preflightTaskId = assertValidTaskId(preflightTaskId);
        } catch (exc: unknown) {
            const message = exc instanceof Error ? exc.message : String(exc);
            errors.push(`preflight.task_id: ${message}`);
            preflightTaskId = null;
        }
    } else {
        preflightTaskId = null;
    }

    if (resolvedTaskId && preflightTaskId && resolvedTaskId !== preflightTaskId) {
        errors.push(`TaskId '${resolvedTaskId}' does not match preflight.task_id '${preflightTaskId}'.`);
    }
    if (!resolvedTaskId && preflightTaskId) resolvedTaskId = preflightTaskId;
    if (!resolvedTaskId) {
        errors.push('TaskId is required and must be provided either via --task-id or preflight.task_id.');
    }

    return {
        preflight,
        resolved_task_id: resolvedTaskId,
        preflight_path: path.resolve(preflightPath),
        preflight_hash: fileSha256(path.resolve(preflightPath)),
        errors
    };
}

function readJsonArtifact(artifactPath: string, label: string, errors: string[], { required = true } = {}): Record<string, unknown> | null {
    const resolvedPath = path.resolve(String(artifactPath || ''));
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        if (required) {
            errors.push(`${label} artifact not found: ${normalizePath(resolvedPath)}`);
        }
        return null;
    }

    try {
        return JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    } catch {
        errors.push(`${label} artifact is not valid JSON: ${normalizePath(resolvedPath)}`);
        return null;
    }
}

function ensurePassedArtifactStatus(artifact: Record<string, unknown> | null, label: string, errors: string[]): void {
    if (!artifact) {
        return;
    }
    if (String(artifact.status || '').trim().toUpperCase() !== 'PASSED') {
        errors.push(`${label} artifact status must be PASSED, got '${String(artifact.status || 'UNKNOWN')}'.`);
    }
    if (String(artifact.outcome || '').trim().toUpperCase() !== 'PASS') {
        errors.push(`${label} artifact outcome must be PASS, got '${String(artifact.outcome || 'UNKNOWN')}'.`);
    }
}

export interface RunCompletionGateOptions {
    repoRoot?: string;
    preflightPath: string;
    taskId?: string;
    taskModePath?: string;
    rulePackPath?: string;
    reviewsRoot?: string;
    compileEvidencePath?: string;
    reviewEvidencePath?: string;
    docImpactPath?: string;
    timelinePath?: string;
    noOpArtifactPath?: string;
    handshakePath?: string;
    shellSmokePath?: string;
}

export function runCompletionGate(options: RunCompletionGateOptions) {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const preflightPath = resolvePathInsideRepo(options.preflightPath, repoRoot) as string;
    const validatedPreflight = validatePreflightForCompletion(preflightPath, options.taskId || '');
    const errors: string[] = [...validatedPreflight.errors];
    const resolvedTaskId = validatedPreflight.resolved_task_id;

    const reviewsRoot = options.reviewsRoot
        ? resolvePathInsideRepo(options.reviewsRoot, repoRoot, { allowMissing: true }) as string
        : path.dirname(preflightPath);
    const compileEvidencePath = options.compileEvidencePath
        ? resolvePathInsideRepo(options.compileEvidencePath, repoRoot, { allowMissing: true }) as string
        : path.join(reviewsRoot, `${resolvedTaskId}-compile-gate.json`);
    const reviewEvidencePath = options.reviewEvidencePath
        ? resolvePathInsideRepo(options.reviewEvidencePath, repoRoot, { allowMissing: true }) as string
        : path.join(reviewsRoot, `${resolvedTaskId}-review-gate.json`);
    const docImpactPath = options.docImpactPath
        ? resolvePathInsideRepo(options.docImpactPath, repoRoot, { allowMissing: true }) as string
        : path.join(reviewsRoot, `${resolvedTaskId}-doc-impact.json`);
    const timelinePath = options.timelinePath
        ? resolvePathInsideRepo(options.timelinePath, repoRoot, { allowMissing: true }) as string
        : joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${resolvedTaskId}.jsonl`));
    const taskModeEvidence = getTaskModeEvidence(repoRoot, resolvedTaskId, options.taskModePath || '');
    const rulePackEvidence = getRulePackEvidence(repoRoot, resolvedTaskId, 'POST_PREFLIGHT', {
        artifactPath: options.rulePackPath || '',
        preflightPath,
        taskModePath: options.taskModePath || ''
    });
    const noOpEvidence = getNoOpEvidence(repoRoot, resolvedTaskId, options.noOpArtifactPath || '');
    const handshakeEvidence = getHandshakeEvidence(repoRoot, resolvedTaskId, {
        artifactPath: options.handshakePath || '',
        timelinePath
    });
    const shellSmokeEvidence = getShellSmokeEvidence(repoRoot, resolvedTaskId, {
        artifactPath: options.shellSmokePath || '',
        timelinePath
    });

    const preflight = validatedPreflight.preflight || {};
    const dirtyWorkspaceProtectionEvidence = detectProtectedDirtyWorkspaceDrift(
        repoRoot,
        getProtectedDirtyWorkspaceScopeFromPreflight(preflight)
    );
    const preflightTriggers = toPlainRecord(preflight.triggers) || {};
    const preflightProtectedSnapshot = toPlainRecord(preflightTriggers.protected_control_plane_snapshot) || {};
    const hasProtectedSnapshot = Object.prototype.hasOwnProperty.call(preflightTriggers, 'protected_control_plane_snapshot');
    const preflightProtectedSnapshotDigest = String(preflightTriggers.protected_control_plane_snapshot_sha256 || '').trim().toLowerCase();
    const hasProtectedSnapshotDigest = /^[a-f0-9]{64}$/.test(preflightProtectedSnapshotDigest);
    const orchestratorWork = !!taskModeEvidence.orchestrator_work;

    // T-1010: Re-scan protected paths at completion to detect tampering
    // T-1011: When isolation mode is enabled, enforcement level governs
    //         whether drift is a hard error (STRICT) or a logged warning (LOG_ONLY).
    const isolationConfig = loadIsolationModeConfig(repoRoot);
    const isolationWarnings: string[] = [];
    let currentProtectedSnapshot: Record<string, string> | null = null;
    if (hasProtectedSnapshot || hasProtectedSnapshotDigest) {
        currentProtectedSnapshot = scanProtectedPathHashes(
            repoRoot,
            getProtectedControlPlaneRoots(repoRoot)
        );
        const currentProtectedSnapshotDigest = computeProtectedSnapshotDigest(currentProtectedSnapshot);
        let changedFiles: string[] = [];
        let taskMutatedProtectedControlPlane = false;

        if (hasProtectedSnapshot) {
            const allProtectedPaths = new Set([...Object.keys(preflightProtectedSnapshot), ...Object.keys(currentProtectedSnapshot)]);
            for (const p of allProtectedPaths) {
                if (preflightProtectedSnapshot[p] !== currentProtectedSnapshot[p]) {
                    changedFiles.push(p);
                }
            }
            taskMutatedProtectedControlPlane = changedFiles.length > 0;
        } else if (hasProtectedSnapshotDigest) {
            taskMutatedProtectedControlPlane = currentProtectedSnapshotDigest !== preflightProtectedSnapshotDigest;
        }

        if (taskMutatedProtectedControlPlane && !orchestratorWork) {
            const driftMessage = changedFiles.length > 0
                ? `Control-plane files were modified in a non-orchestrator task: ${changedFiles.join(', ')}. ` +
                  'Protected orchestrator runtime paths are only allowed for tasks started with --orchestrator-work.'
                : 'Control-plane files were modified in a non-orchestrator task after the preflight protected snapshot digest changed. ' +
                  'Protected orchestrator runtime paths are only allowed for tasks started with --orchestrator-work.';
            if (isolationConfig.enabled && isolationConfig.enforcement === 'LOG_ONLY') {
                isolationWarnings.push(driftMessage + ' (LOG_ONLY mode — logged as warning)');
            } else {
                errors.push(driftMessage);
            }
        }
    }

    const protectedManifestEvidence = evaluateProtectedControlPlaneManifest(repoRoot, currentProtectedSnapshot);
    const protectedManifestGuard = getProtectedManifestLifecycleGuard({
        repoRoot,
        orchestratorWork,
        phaseLabel: 'completion gate',
        preflight,
        manifestEvidence: protectedManifestEvidence
    });
    if (!orchestratorWork && protectedManifestGuard.status === 'BLOCK') {
        if (isolationConfig.enabled && isolationConfig.enforcement === 'LOG_ONLY') {
            isolationWarnings.push(`${protectedManifestGuard.violations.join(' ')} (LOG_ONLY mode — logged as warning)`);
        } else {
            errors.push(...protectedManifestGuard.violations);
        }
    }

    const compileEvidence = readJsonArtifact(compileEvidencePath, 'Compile gate', errors);
    const reviewEvidence = readJsonArtifact(reviewEvidencePath, 'Review gate', errors);
    const docImpactEvidence = readJsonArtifact(docImpactPath, 'Doc impact gate', errors);
    const compileCommandsPath = readOptionalArtifactStringField(compileEvidence, 'commands_path');
    const compileOutputFiltersPath = readOptionalArtifactStringField(compileEvidence, 'output_filters_path');

    ensurePassedArtifactStatus(compileEvidence, 'Compile gate', errors);
    ensurePassedArtifactStatus(reviewEvidence, 'Review gate', errors);
    ensurePassedArtifactStatus(docImpactEvidence, 'Doc impact gate', errors);
    errors.push(...getTaskModeEvidenceViolations(taskModeEvidence));
    errors.push(...getRulePackEvidenceViolations(rulePackEvidence));
    errors.push(...getHandshakeEvidenceViolations(handshakeEvidence));
    errors.push(...getShellSmokeEvidenceViolations(shellSmokeEvidence));
    errors.push(...dirtyWorkspaceProtectionEvidence.violations);

    // T-1011: post-task isolation mode enforcement (complements T-1010 drift check above)
    if (hasProtectedSnapshot && !orchestratorWork && isolationConfig.enabled) {
        const typedSnapshot: Record<string, string> = {};
        for (const [k, v] of Object.entries(preflightProtectedSnapshot)) {
            typedSnapshot[k] = String(v);
        }
        const isolationEvidence = evaluateIsolationModePostTask(repoRoot, typedSnapshot);
        errors.push(...isolationEvidence.violations);
        isolationWarnings.push(...isolationEvidence.warnings);
    }

    // T-1011: Sandbox integrity check at completion
    if (isolationConfig.enabled && isolationConfig.use_sandbox && !orchestratorWork) {
        const sandboxState = validateSandbox(repoRoot);
        if (sandboxState.exists) {
            if (sandboxState.drift_files.length > 0) {
                const sbMessage = `Isolation sandbox was modified during task (${sandboxState.drift_files.length} file(s) drifted). ` +
                    'This indicates the sandbox was tampered with during execution.';
                if (isolationConfig.enforcement === 'STRICT') {
                    errors.push(sbMessage);
                } else {
                    isolationWarnings.push(sbMessage + ' (LOG_ONLY mode — logged as warning)');
                }
            }
            if (!sandboxState.read_only_intact) {
                isolationWarnings.push(
                    'Isolation sandbox read-only flags were removed on some files. ' +
                    'Same-user limitation: read-only attributes are advisory, not a security boundary.'
                );
            }
        }
    }

    // --- T-003: ordered timeline + stage-sequence enforcement ---
    const timelineErrors: string[] = [];
    const orderedEvents = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    const timelineEventTypes = new Set(orderedEvents.map(e => e.event_type));
    const codeChanged = detectCodeChanged(validatedPreflight.preflight, repoRoot);
    const reviewRecordedRequired = preflightRequiresAnyReview(validatedPreflight.preflight);

    // Propagate timeline parse errors
    errors.push(...timelineErrors);

    if (!timelineEventTypes.has('TASK_MODE_ENTERED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing TASK_MODE_ENTERED.`);
    }
    if (!timelineEventTypes.has('RULE_PACK_LOADED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing RULE_PACK_LOADED.`);
    }
    if (!timelineEventTypes.has('HANDSHAKE_DIAGNOSTICS_RECORDED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing HANDSHAKE_DIAGNOSTICS_RECORDED. Run handshake-diagnostics before preflight.`);
    }
    if (!timelineEventTypes.has('SHELL_SMOKE_PREFLIGHT_RECORDED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing SHELL_SMOKE_PREFLIGHT_RECORDED. Run shell-smoke-preflight before preflight.`);
    }
    if (!timelineEventTypes.has('COMPILE_GATE_PASSED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing COMPILE_GATE_PASSED.`);
    }
    if (!timelineEventTypes.has('REVIEW_PHASE_STARTED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing REVIEW_PHASE_STARTED.`);
    }
    if (!timelineEventTypes.has('REVIEW_GATE_PASSED') && !timelineEventTypes.has('REVIEW_GATE_PASSED_WITH_OVERRIDE')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing REVIEW_GATE_PASSED.`);
    }

    const zeroDiffEvidence = validateZeroDiffCompletionEvidence(
        validatedPreflight.preflight,
        resolvedTaskId || '',
        taskModeEvidence.task_summary,
        noOpEvidence
    );
    errors.push(...zeroDiffEvidence.violations);

    // Validate stage sequence ordering
    const stageSequence = validateStageSequence(orderedEvents, codeChanged, timelinePath, reviewRecordedRequired);
    errors.push(...stageSequence.violations);

    const requiredReviews = validatedPreflight.preflight && typeof validatedPreflight.preflight.required_reviews === 'object'
        ? validatedPreflight.preflight.required_reviews
        : {};
    const reviewArtifacts: Record<string, {
        path: string;
        content: string;
        reviewContext: Record<string, unknown> | null;
        receipt: ReviewReceipt | null;
        findings_evidence: ReturnType<typeof getReviewArtifactFindingsEvidence>;
    }> = {};
    const sourceOfTruth = readRuntimeReviewerProvider(repoRoot, resolvedTaskId);

    for (const [reviewKey] of REVIEW_CONTRACTS) {
        const required = !!requiredReviews[reviewKey];
        if (!required) {
            continue;
        }
        const artifactPath = path.join(reviewsRoot, `${resolvedTaskId}-${reviewKey}.md`);
        const recordedReviewContextPath = findLatestRecordedReviewContextPath(orderedEvents, reviewKey);
        const reviewContextPath = resolveCanonicalReviewContextPath({
            reviewsRoot,
            taskId: resolvedTaskId,
            reviewType: reviewKey,
            explicitPath: recordedReviewContextPath
        });
        const normalizedReviewContextPath = normalizePath(reviewContextPath);
        const requireStrictBindingMetadata = normalizedReviewContextPath !== normalizePath(
            getCanonicalReviewContextPath(reviewsRoot, resolvedTaskId, reviewKey)
        );
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const artifactExists = fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile();

        if (!artifactExists) {
            if (required) {
                errors.push(`Required review artifact not found: ${normalizePath(artifactPath)}`);
            }
            continue;
        }

        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        let reviewContext: Record<string, unknown> | null = null;
        let receipt: ReviewReceipt | null = null;
        if (fs.existsSync(reviewContextPath) && fs.statSync(reviewContextPath).isFile()) {
            try {
                const parsedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
                if (parsedReviewContext && typeof parsedReviewContext === 'object' && !Array.isArray(parsedReviewContext)) {
                    reviewContext = parsedReviewContext as Record<string, unknown>;
                    if (required) {
                        errors.push(...getReviewContextContractViolations({
                            contextPath: reviewContextPath,
                            reviewContext,
                            expectedTaskId: resolvedTaskId,
                            expectedReviewType: reviewKey,
                            expectedPreflightPath: validatedPreflight.preflight_path,
                            expectedPreflightSha256: validatedPreflight.preflight_hash,
                            requireReviewType: true,
                            requireTaskId: requireStrictBindingMetadata,
                            requirePreflightPath: requireStrictBindingMetadata,
                            requirePreflightSha256: requireStrictBindingMetadata
                        }));
                    }
                }
            } catch {
                if (required) {
                    errors.push(`Required review-context artifact is invalid JSON: ${normalizePath(reviewContextPath)}`);
                }
            }
        } else if (required) {
            errors.push(`Required review-context artifact not found: ${normalizePath(reviewContextPath)}`);
        }
        if (fs.existsSync(receiptPath) && fs.statSync(receiptPath).isFile()) {
            try {
                const parsedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
                if (parsedReceipt && typeof parsedReceipt === 'object' && !Array.isArray(parsedReceipt)) {
                    receipt = parsedReceipt as ReviewReceipt;
                }
            } catch {
                if (required) {
                    errors.push(`Required review receipt is invalid JSON: ${normalizePath(receiptPath)}`);
                }
            }
        } else if (required) {
            errors.push(`Required review receipt not found: ${normalizePath(receiptPath)}`);
        }
        const findingsEvidence = getReviewArtifactFindingsEvidence(artifactPath, artifactContent);
        reviewArtifacts[reviewKey] = {
            path: normalizePath(artifactPath),
            content: artifactContent,
            reviewContext,
            receipt,
            findings_evidence: findingsEvidence
        };
        if (Array.isArray(findingsEvidence.violations) && findingsEvidence.violations.length > 0) {
            errors.push(...findingsEvidence.violations);
        }
    }

    // T-003: review-skill invocation evidence for code-changing tasks
    const reviewSkillEvidence = validateReviewSkillEvidence(
        orderedEvents,
        requiredReviews,
        reviewArtifacts,
        codeChanged,
        timelinePath,
        sourceOfTruth
    );
    errors.push(...reviewSkillEvidence.violations);

    // Merge skill evidence into stage-sequence record
    stageSequence.review_skill_ids = reviewSkillEvidence.skill_ids;
    stageSequence.review_skill_reference_paths = reviewSkillEvidence.reference_paths;
    stageSequence.review_artifact_keys = reviewSkillEvidence.artifact_keys;
    stageSequence.reviewer_execution_modes = reviewSkillEvidence.reviewer_execution_modes;

    // T-1005: Build reviewer routing enforcement summary
    const routingPolicy = resolveReviewerRoutingPolicy(sourceOfTruth);
    const reviewerRoutingEnforcement = {
        source_of_truth: routingPolicy.source_of_truth,
        capability_level: routingPolicy.capability_level,
        delegation_required: routingPolicy.delegation_required,
        expected_execution_mode: routingPolicy.expected_execution_mode,
        fallback_allowed: routingPolicy.fallback_allowed,
        fallback_reason_required: routingPolicy.fallback_reason_required,
        observed_execution_modes: reviewSkillEvidence.reviewer_execution_modes,
        enforcement_level: 'hard_block'
    };

    // Plan metadata from task-mode evidence (informational, never blocks)
    const planEvidence = {
        plan_guided: !!taskModeEvidence.plan,
        plan_path: taskModeEvidence.plan?.plan_path ?? null,
        plan_sha256: taskModeEvidence.plan?.plan_sha256 ?? null,
        plan_summary: taskModeEvidence.plan?.plan_summary ?? null
    };

    const status = errors.length > 0 ? 'FAILED' : 'PASSED';
    const outcome = errors.length > 0 ? 'FAIL' : 'PASS';
    const coherentCycleRestartCommand = stageSequence.violations.length > 0 && resolvedTaskId
        ? buildCoherentCycleRestartCommand(
            repoRoot,
            resolvedTaskId,
            normalizePath(preflightPath),
            taskModeEvidence.evidence_path,
            compileCommandsPath,
            compileOutputFiltersPath
        )
        : null;
    const reviewCycleRecoveryRelevant = resolvedTaskId
        && stageSequence.violations.length === 0
        && errors.length > 0
        && (
            reviewSkillEvidence.violations.length > 0
            || (!timelineEventTypes.has('REVIEW_GATE_PASSED') && !timelineEventTypes.has('REVIEW_GATE_PASSED_WITH_OVERRIDE'))
            || REVIEW_CONTRACTS.some(([reviewKey]) => {
                if (!requiredReviews[reviewKey]) {
                    return false;
                }
                const artifact = reviewArtifacts[reviewKey];
                if (!artifact) {
                    return true;
                }
                return !artifact.content
                    || !artifact.reviewContext
                    || !artifact.receipt
                    || artifact.findings_evidence.violations.length > 0;
            })
        );
    const reviewCycleRestartCommand = reviewCycleRecoveryRelevant
        ? buildReviewCycleRestartCommand(
            repoRoot,
            resolvedTaskId,
            normalizePath(preflightPath),
            taskModeEvidence.evidence_path,
            compileCommandsPath,
            compileOutputFiltersPath
        )
        : null;

    return {
        status,
        outcome,
        task_id: resolvedTaskId,
        preflight_path: normalizePath(preflightPath),
        reviews_root: normalizePath(reviewsRoot),
        task_mode_path: taskModeEvidence.evidence_path,
        rule_pack_path: rulePackEvidence.evidence_path,
        handshake_path: handshakeEvidence.evidence_path,
        shell_smoke_path: shellSmokeEvidence.evidence_path,
        compile_evidence_path: normalizePath(compileEvidencePath),
        review_evidence_path: normalizePath(reviewEvidencePath),
        doc_impact_path: normalizePath(docImpactPath),
        timeline_path: normalizePath(timelinePath),
        review_artifacts: reviewArtifacts,
        stage_sequence_evidence: stageSequence,
        reviewer_routing_enforcement: reviewerRoutingEnforcement,
        zero_diff_evidence: zeroDiffEvidence,
        dirty_workspace_protection_evidence: dirtyWorkspaceProtectionEvidence,
        plan: planEvidence,
        isolation_mode_warnings: isolationWarnings,
        coherent_cycle_restart_command: coherentCycleRestartCommand,
        review_cycle_restart_command: reviewCycleRestartCommand,
        violations: errors
    };
}

export function formatCompletionGateResult(result: Record<string, unknown>): string {
    const lines: string[] = [
        result.outcome === 'PASS' ? 'COMPLETION_GATE_PASSED' : 'COMPLETION_GATE_FAILED',
        `TaskId: ${result.task_id}`,
        `Status: ${result.status}`,
        `Outcome: ${result.outcome}`
    ];

    const trustLevels = new Set<string>();
    if (result.review_artifacts && typeof result.review_artifacts === 'object') {
        for (const key of Object.keys(result.review_artifacts)) {
            const artifact = (result.review_artifacts as any)[key];
            if (artifact && artifact.receipt && artifact.receipt.trust_level) {
                trustLevels.add(artifact.receipt.trust_level);
            }
        }
    }
    if (trustLevels.size > 0) {
        lines.push(`TrustStatus: ${Array.from(trustLevels).join(', ')}`);
    }

    const plan = result.plan as Record<string, unknown> | undefined;
    if (plan) {
        lines.push(`PlanGuided: ${!!plan.plan_guided}`);
        if (plan.plan_guided && plan.plan_path) {
            lines.push(`PlanPath: ${plan.plan_path}`);
        }
    }

    if (Array.isArray(result.violations) && result.violations.length > 0) {
        lines.push('Violations:');
        for (const violation of result.violations) {
            lines.push(`- ${violation}`);
        }
    }

    if (typeof result.coherent_cycle_restart_command === 'string' && result.coherent_cycle_restart_command.trim()) {
        lines.push(`RecoveryCommand: ${result.coherent_cycle_restart_command}`);
    }
    if (typeof result.review_cycle_restart_command === 'string' && result.review_cycle_restart_command.trim()) {
        lines.push(
            typeof result.coherent_cycle_restart_command === 'string' && result.coherent_cycle_restart_command.trim()
                ? `ReviewRecoveryCommand: ${result.review_cycle_restart_command}`
                : `RecoveryCommand: ${result.review_cycle_restart_command}`
        );
    }

    if (Array.isArray(result.isolation_mode_warnings) && result.isolation_mode_warnings.length > 0) {
        lines.push('IsolationModeWarnings:');
        for (const warning of result.isolation_mode_warnings) {
            lines.push(`- ${warning}`);
        }
    }

    return lines.join('\n');
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathExists } from '../../core/filesystem';
import { BASELINE_SKILL_DIRECTORIES } from '../skill-manifest';

import {
    type OptionalSkillSelectionTimelineEvidence,
    type OptionalSkillSelectionActivationEvidence,
    type OptionalSkillSelectionReferenceLoadEvidence,
    type OptionalSkillSelectionArtifact,
    computeOptionalSkillSelectionFingerprint,
    normalizeText,
    resolvePortableRepoPath,
    selectLatestTimestamp,
    toTimestampMs
} from './types';

interface TimelinePoint {
    timestampUtc: string | null;
    taskSequence: number | null;
}

export interface OptionalSkillActivationPoint {
    timestampMs: number;
    eventSequence: number | null;
}

function readTaskEventSequence(event: Record<string, unknown>): number | null {
    const integrity = event.integrity;
    if (!integrity || typeof integrity !== 'object' || Array.isArray(integrity)) {
        return null;
    }
    const value = Number((integrity as Record<string, unknown>).task_sequence);
    return Number.isFinite(value) ? value : null;
}

function selectLatestTimelinePoint(current: TimelinePoint, next: TimelinePoint): TimelinePoint {
    if (next.taskSequence !== null && current.taskSequence !== null) {
        return next.taskSequence >= current.taskSequence ? next : current;
    }
    if (next.taskSequence !== null && current.taskSequence === null) {
        return next;
    }
    if (next.taskSequence === null && current.taskSequence !== null) {
        return current;
    }
    return selectLatestTimestamp(current.timestampUtc, next.timestampUtc) === next.timestampUtc
        ? next
        : current;
}

export function readOptionalSkillSelectionTimelineEvidence(
    bundleRoot: string,
    taskId: string,
    taskEventsPath?: string | null
): OptionalSkillSelectionTimelineEvidence {
    const resolvedTaskEventsPath = taskEventsPath
        ? path.resolve(taskEventsPath)
        : path.join(bundleRoot, 'runtime', 'task-events', `${taskId}.jsonl`);
    const eventTypes = new Set<string>();
    const optionalSkillActivations: OptionalSkillSelectionActivationEvidence[] = [];
    const optionalSkillReferenceLoads: OptionalSkillSelectionReferenceLoadEvidence[] = [];
    let latestTaskModeEntered: TimelinePoint = { timestampUtc: null, taskSequence: null };
    let latestCycleBoundary: TimelinePoint = { timestampUtc: null, taskSequence: null };
    let latestImplementationStarted: TimelinePoint = { timestampUtc: null, taskSequence: null };

    if (!pathExists(resolvedTaskEventsPath)) {
        return {
            timelinePath: resolvedTaskEventsPath,
            exists: false,
            invalidJson: false,
            eventTypes,
            latestTaskModeEnteredTimestampUtc: latestTaskModeEntered.timestampUtc,
            latestTaskModeEnteredTaskSequence: latestTaskModeEntered.taskSequence,
            latestCycleBoundaryTimestampUtc: latestCycleBoundary.timestampUtc,
            latestCycleBoundaryTaskSequence: latestCycleBoundary.taskSequence,
            latestImplementationStartedTimestampUtc: latestImplementationStarted.timestampUtc,
            latestImplementationStartedTaskSequence: latestImplementationStarted.taskSequence,
            optionalSkillActivations,
            optionalSkillReferenceLoads
        };
    }

    const liveSkillsRoot = normalizeText(path.join(bundleRoot, 'live', 'skills'));
    let invalidJson = false;
    for (const rawLine of fs.readFileSync(resolvedTaskEventsPath, 'utf8').split(/\r?\n/)) {
        if (!rawLine.trim()) {
            continue;
        }
        let parsedLine: Record<string, unknown> | null = null;
        try {
            parsedLine = JSON.parse(rawLine) as Record<string, unknown>;
        } catch {
            invalidJson = true;
            break;
        }
        const eventType = String(parsedLine.event_type || '').trim().toUpperCase();
        const eventTimestampUtc = String(parsedLine.timestamp_utc || '').trim() || null;
        const taskSequence = readTaskEventSequence(parsedLine);
        const timelinePoint = { timestampUtc: eventTimestampUtc, taskSequence };
        if (eventType) {
            eventTypes.add(eventType);
        }
        if (eventType === 'TASK_MODE_ENTERED') {
            latestTaskModeEntered = selectLatestTimelinePoint(latestTaskModeEntered, timelinePoint);
        }
        if (eventType === 'TASK_MODE_ENTERED' || eventType === 'PREFLIGHT_STARTED' || eventType === 'PREFLIGHT_CLASSIFIED') {
            latestCycleBoundary = selectLatestTimelinePoint(latestCycleBoundary, timelinePoint);
        }
        if (eventType === 'IMPLEMENTATION_STARTED') {
            latestImplementationStarted = selectLatestTimelinePoint(latestImplementationStarted, timelinePoint);
        }
        const details = parsedLine.details;
        if (eventType === 'SKILL_SELECTED' && details && typeof details === 'object' && !Array.isArray(details)) {
            const detailRecord = details as Record<string, unknown>;
            const triggerReason = String(detailRecord.trigger_reason || '').trim();
            if (triggerReason === 'optional_skill_selection') {
                optionalSkillActivations.push({
                    skillId: String(detailRecord.skill_id || '').trim() || null,
                    triggerReason: triggerReason || null,
                    timestampUtc: eventTimestampUtc,
                    eventSequence: taskSequence,
                    selectionFingerprintSha256: String(detailRecord.optional_skill_selection_fingerprint_sha256 || '').trim() || null
                });
            }
        }
        if (eventType !== 'SKILL_REFERENCE_LOADED') {
            continue;
        }
        if (!details || typeof details !== 'object' || Array.isArray(details)) {
            continue;
        }
        const detailRecord = details as Record<string, unknown>;
        const triggerReason = String(detailRecord.trigger_reason || '').trim();
        if (triggerReason === 'review_skill') {
            continue;
        }
        const referencePath = String(detailRecord.reference_path || '').trim();
        if (!referencePath) {
            continue;
        }
        const resolvedReferencePath = resolvePortableRepoPath(bundleRoot, referencePath);
        if (!normalizeText(resolvedReferencePath).startsWith(liveSkillsRoot)) {
            continue;
        }
        const relativeReferencePath = path.relative(path.join(bundleRoot, 'live', 'skills'), resolvedReferencePath).replace(/\\/g, '/');
        const skillDirectory = relativeReferencePath.split('/').filter(Boolean)[0] || '';
        if (BASELINE_SKILL_DIRECTORIES.includes(skillDirectory)) {
            continue;
        }
        optionalSkillReferenceLoads.push({
            skillId: String(detailRecord.skill_id || '').trim() || null,
            referencePath,
            resolvedReferencePath,
            triggerReason: triggerReason || null,
            timestampUtc: String(parsedLine.timestamp_utc || '').trim() || null
        });
    }

    return {
        timelinePath: resolvedTaskEventsPath,
        exists: true,
        invalidJson,
        eventTypes,
        latestTaskModeEnteredTimestampUtc: latestTaskModeEntered.timestampUtc,
        latestTaskModeEnteredTaskSequence: latestTaskModeEntered.taskSequence,
        latestCycleBoundaryTimestampUtc: latestCycleBoundary.timestampUtc,
        latestCycleBoundaryTaskSequence: latestCycleBoundary.taskSequence,
        latestImplementationStartedTimestampUtc: latestImplementationStarted.timestampUtc,
        latestImplementationStartedTaskSequence: latestImplementationStarted.taskSequence,
        optionalSkillActivations,
        optionalSkillReferenceLoads
    };
}

export function getCurrentCycleOptionalSkillReferenceLoads(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): OptionalSkillSelectionReferenceLoadEvidence[] {
    const lowerBoundTimestampMs = toTimestampMs(
        timelineEvidence.latestCycleBoundaryTimestampUtc
        || timelineEvidence.latestTaskModeEnteredTimestampUtc
        || payload.timestamp_utc
    );
    return timelineEvidence.optionalSkillReferenceLoads.filter((entry) => {
        if (lowerBoundTimestampMs === null) {
            return true;
        }
        const eventTimestampMs = toTimestampMs(entry.timestampUtc);
        return eventTimestampMs !== null && eventTimestampMs >= lowerBoundTimestampMs;
    });
}

export function getCurrentCycleOptionalSkillActivations(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): OptionalSkillSelectionActivationEvidence[] {
    const taskModeLowerBoundTimestampMs = toTimestampMs(
        timelineEvidence.latestTaskModeEnteredTimestampUtc
        || payload.timestamp_utc
    );
    const cycleLowerBoundTimestampMs = toTimestampMs(
        timelineEvidence.latestCycleBoundaryTimestampUtc
        || timelineEvidence.latestTaskModeEnteredTimestampUtc
        || payload.timestamp_utc
    );
    const selectionFingerprintSha256 = String(
        payload.selection_fingerprint_sha256
        || computeOptionalSkillSelectionFingerprint(payload)
    ).trim();
    return timelineEvidence.optionalSkillActivations.filter((entry) => {
        const eventTimestampMs = toTimestampMs(entry.timestampUtc);
        if (eventTimestampMs === null) {
            return false;
        }
        if (taskModeLowerBoundTimestampMs !== null && eventTimestampMs < taskModeLowerBoundTimestampMs) {
            return false;
        }
        if (cycleLowerBoundTimestampMs === null || eventTimestampMs >= cycleLowerBoundTimestampMs) {
            return true;
        }
        return Boolean(
            selectionFingerprintSha256
            && entry.selectionFingerprintSha256
            && entry.selectionFingerprintSha256 === selectionFingerprintSha256
        );
    });
}

export function buildCurrentCycleOptionalSkillActivationIndex(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): Map<string, number> {
    const activationIndex = new Map<string, number>();
    for (const activation of getCurrentCycleOptionalSkillActivations(payload, timelineEvidence)) {
        const skillId = String(activation.skillId || '').trim();
        const timestampMs = toTimestampMs(activation.timestampUtc);
        if (!skillId || timestampMs === null) {
            continue;
        }
        const previousTimestampMs = activationIndex.get(skillId);
        if (previousTimestampMs === undefined || timestampMs > previousTimestampMs) {
            activationIndex.set(skillId, timestampMs);
        }
    }
    return activationIndex;
}

function getCurrentCycleBoundaryPoint(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): OptionalSkillActivationPoint | null {
    const cycleBoundaryTimestampMs = toTimestampMs(
        timelineEvidence.latestCycleBoundaryTimestampUtc
        || timelineEvidence.latestTaskModeEnteredTimestampUtc
        || payload.timestamp_utc
    );
    if (cycleBoundaryTimestampMs === null) {
        return null;
    }
    return {
        timestampMs: cycleBoundaryTimestampMs,
        eventSequence: timelineEvidence.latestCycleBoundaryTaskSequence
            ?? timelineEvidence.latestTaskModeEnteredTaskSequence
            ?? null
    };
}

function didActivationOccurBeforeCycleBoundary(
    activation: OptionalSkillActivationPoint,
    cycleBoundary: OptionalSkillActivationPoint
): boolean {
    if (activation.eventSequence !== null && cycleBoundary.eventSequence !== null) {
        return activation.eventSequence < cycleBoundary.eventSequence;
    }
    return activation.timestampMs < cycleBoundary.timestampMs;
}

export function getCurrentImplementationStartPoint(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): OptionalSkillActivationPoint | null {
    const implementationTimestampMs = toTimestampMs(timelineEvidence.latestImplementationStartedTimestampUtc);
    if (implementationTimestampMs === null) {
        return null;
    }
    const implementationSequence = timelineEvidence.latestImplementationStartedTaskSequence ?? null;
    const cycleBoundarySequence = timelineEvidence.latestCycleBoundaryTaskSequence ?? null;
    if (
        implementationSequence !== null
        && cycleBoundarySequence !== null
        && implementationSequence < cycleBoundarySequence
    ) {
        return null;
    }

    const cycleBoundaryTimestampMs = toTimestampMs(
        timelineEvidence.latestCycleBoundaryTimestampUtc
        || timelineEvidence.latestTaskModeEnteredTimestampUtc
        || payload.timestamp_utc
    );
    if (
        (implementationSequence === null || cycleBoundarySequence === null)
        && cycleBoundaryTimestampMs !== null
        && implementationTimestampMs < cycleBoundaryTimestampMs
    ) {
        return null;
    }

    return {
        timestampMs: implementationTimestampMs,
        eventSequence: implementationSequence
    };
}

export function didActivationOccurAfterImplementationStart(
    activation: OptionalSkillActivationPoint,
    implementationStart: OptionalSkillActivationPoint
): boolean {
    if (activation.eventSequence !== null && implementationStart.eventSequence !== null) {
        return activation.eventSequence >= implementationStart.eventSequence;
    }
    return activation.timestampMs > implementationStart.timestampMs;
}

export function buildFreshCurrentCycleOptionalSkillActivationPointIndex(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): Map<string, OptionalSkillActivationPoint> {
    const activationIndex = new Map<string, OptionalSkillActivationPoint>();
    const cycleBoundary = getCurrentCycleBoundaryPoint(payload, timelineEvidence);
    for (const activation of getCurrentCycleOptionalSkillActivations(payload, timelineEvidence)) {
        const skillId = String(activation.skillId || '').trim();
        const timestampMs = toTimestampMs(activation.timestampUtc);
        if (!skillId || timestampMs === null) {
            continue;
        }
        const eventSequence = activation.eventSequence ?? null;
        const activationPoint = { timestampMs, eventSequence };
        if (cycleBoundary && didActivationOccurBeforeCycleBoundary(activationPoint, cycleBoundary)) {
            continue;
        }
        const previous = activationIndex.get(skillId);
        if (!previous) {
            activationIndex.set(skillId, activationPoint);
            continue;
        }
        const isNewer = eventSequence !== null && previous.eventSequence !== null
            ? eventSequence > previous.eventSequence
            : timestampMs > previous.timestampMs;
        if (isNewer) {
            activationIndex.set(skillId, activationPoint);
        }
    }
    return activationIndex;
}

export function buildMandatoryCurrentCycleOptionalSkillActivationIndex(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): Map<string, number> {
    const implementationStart = getCurrentImplementationStartPoint(payload, timelineEvidence);
    const activationIndex = new Map<string, number>();
    for (const [skillId, activation] of buildFreshCurrentCycleOptionalSkillActivationPointIndex(payload, timelineEvidence)) {
        if (implementationStart && didActivationOccurAfterImplementationStart(activation, implementationStart)) {
            continue;
        }
        activationIndex.set(skillId, activation.timestampMs);
    }
    return activationIndex;
}

export function getActivatedCurrentCycleOptionalSkillReferenceLoads(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): OptionalSkillSelectionReferenceLoadEvidence[] {
    if (timelineEvidence.invalidJson) {
        return [];
    }
    const activationIndex = buildCurrentCycleOptionalSkillActivationIndex(payload, timelineEvidence);
    return getCurrentCycleOptionalSkillReferenceLoads(payload, timelineEvidence).filter((entry) => {
        const skillId = String(entry.skillId || '').trim();
        const activationTimestampMs = activationIndex.get(skillId);
        if (!skillId || activationTimestampMs === undefined) {
            return false;
        }
        const eventTimestampMs = toTimestampMs(entry.timestampUtc);
        return eventTimestampMs !== null && eventTimestampMs >= activationTimestampMs;
    });
}

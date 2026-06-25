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
    let latestTaskModeEnteredTimestampUtc: string | null = null;
    let latestCycleBoundaryTimestampUtc: string | null = null;

    if (!pathExists(resolvedTaskEventsPath)) {
        return {
            timelinePath: resolvedTaskEventsPath,
            exists: false,
            invalidJson: false,
            eventTypes,
            latestTaskModeEnteredTimestampUtc,
            latestCycleBoundaryTimestampUtc,
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
        if (eventType) {
            eventTypes.add(eventType);
        }
        if (eventType === 'TASK_MODE_ENTERED') {
            latestTaskModeEnteredTimestampUtc = selectLatestTimestamp(
                latestTaskModeEnteredTimestampUtc,
                eventTimestampUtc
            );
        }
        if (eventType === 'TASK_MODE_ENTERED' || eventType === 'PREFLIGHT_STARTED' || eventType === 'PREFLIGHT_CLASSIFIED') {
            latestCycleBoundaryTimestampUtc = selectLatestTimestamp(
                latestCycleBoundaryTimestampUtc,
                eventTimestampUtc
            );
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
        latestTaskModeEnteredTimestampUtc,
        latestCycleBoundaryTimestampUtc,
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

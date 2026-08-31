import * as path from 'node:path';

import {
    getHandshakeEvidence,
    getHandshakeEvidenceViolations
} from '../../../../gates/diagnostics/handshake-diagnostics';
import {
    getShellSmokeEvidence,
    getShellSmokeEvidenceViolations
} from '../../../../gates/diagnostics/shell-smoke-preflight';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { forEachJsonlLine } from '../../../../gate-runtime/task-events';
import {
    computeOptionalSkillTaskTextSha256,
    getOptionalSkillSelectionGateViolations,
    isOptionalSkillSelectionPolicyConfigured,
    loadOptionalSkillSelectionHeadlinesCache,
    readOptionalSkillSelectionPolicyConfig,
    readOptionalSkillSelectionTimelineEvidence
} from '../../../../runtime/optional-skill-selection';

type OptionalSkillTimelineEvidence = ReturnType<typeof readOptionalSkillSelectionTimelineEvidence>;

export interface GateFlowTimelineRequirement {
    eventType: string;
    recoveryInstruction: string;
}

export interface GateFlowTimelineReadiness {
    timelinePath: string;
    timelineEvidence: OptionalSkillTimelineEvidence;
    violations: string[];
}

export function resolveGateFlowTimelinePath(repoRoot: string, taskId: string): string {
    return gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
}

function recoverRequiredEventTypesFromTruncatedTimeline(
    timelinePath: string,
    taskId: string,
    requirements: GateFlowTimelineRequirement[],
    timelineEvidence: OptionalSkillTimelineEvidence
): void {
    if (!timelineEvidence.boundedRead?.truncated) {
        return;
    }
    const missingEventTypes = new Set(
        requirements
            .map((requirement) => requirement.eventType.trim().toUpperCase())
            .filter((eventType) => eventType && !timelineEvidence.eventTypes.has(eventType))
    );
    if (missingEventTypes.size === 0) {
        return;
    }

    forEachJsonlLine(timelinePath, (rawLine) => {
        let event: Record<string, unknown>;
        try {
            event = JSON.parse(rawLine) as Record<string, unknown>;
        } catch {
            timelineEvidence.invalidJson = true;
            return;
        }
        const eventTaskId = String(event.task_id || '').trim();
        if (eventTaskId && eventTaskId !== taskId) {
            return;
        }
        const eventType = String(event.event_type || '').trim().toUpperCase();
        if (missingEventTypes.has(eventType)) {
            timelineEvidence.eventTypes.add(eventType);
            missingEventTypes.delete(eventType);
        }
    });
}

export function evaluateGateFlowTimelineReadiness(params: {
    orchestratorRoot: string;
    repoRoot: string;
    taskId: string;
    requirements: GateFlowTimelineRequirement[];
    timelinePath?: string | null;
}): GateFlowTimelineReadiness {
    const timelinePath = params.timelinePath || resolveGateFlowTimelinePath(params.repoRoot, params.taskId);
    const timelineEvidence = readOptionalSkillSelectionTimelineEvidence(
        params.orchestratorRoot,
        params.taskId,
        timelinePath
    );
    recoverRequiredEventTypesFromTruncatedTimeline(
        timelinePath,
        params.taskId,
        params.requirements,
        timelineEvidence
    );
    const violations: string[] = [];
    if (!timelineEvidence.exists) {
        violations.push(`Task timeline not found: ${gateHelpers.normalizePath(timelineEvidence.timelinePath)}`);
    } else if (timelineEvidence.invalidJson) {
        violations.push(`Task timeline contains invalid JSON line: ${gateHelpers.normalizePath(timelineEvidence.timelinePath)}`);
    }

    if (violations.length === 0) {
        for (const requirement of params.requirements) {
            if (!timelineEvidence.eventTypes.has(requirement.eventType)) {
                violations.push(
                    `Task timeline '${gateHelpers.normalizePath(timelinePath)}' is missing ${requirement.eventType}. ${requirement.recoveryInstruction}`
                );
            }
        }
    }

    return {
        timelinePath,
        timelineEvidence,
        violations
    };
}

export function evaluateGateFlowStartupDiagnostics(params: {
    repoRoot: string;
    taskId: string;
    taskModePath?: string;
    timelinePath: string;
}): string[] {
    const handshakeEvidence = getHandshakeEvidence(params.repoRoot, params.taskId, {
        taskModePath: params.taskModePath || '',
        timelinePath: params.timelinePath
    });
    const shellSmokeEvidence = getShellSmokeEvidence(params.repoRoot, params.taskId, {
        timelinePath: params.timelinePath
    });
    return [
        ...getHandshakeEvidenceViolations(handshakeEvidence),
        ...getShellSmokeEvidenceViolations(shellSmokeEvidence)
    ];
}

export function evaluateGateFlowOptionalSkillSelection(params: {
    orchestratorRoot: string;
    taskId: string;
    expectedPreflightPath: string;
    expectedPreflightSha256: string | null;
    taskSummary: string;
    timelineEvidence: OptionalSkillTimelineEvidence;
}): string[] {
    const optionalSkillPolicyMode = isOptionalSkillSelectionPolicyConfigured(params.orchestratorRoot)
        ? readOptionalSkillSelectionPolicyConfig(params.orchestratorRoot).mode
        : null;
    const loadedHeadlinesCache = optionalSkillPolicyMode
        ? loadOptionalSkillSelectionHeadlinesCache(params.orchestratorRoot, optionalSkillPolicyMode, {
            preferPersistedSurface: true
        })
        : null;
    const expectedTaskTextSha256 = computeOptionalSkillTaskTextSha256(params.taskSummary);
    return getOptionalSkillSelectionGateViolations(params.orchestratorRoot, params.taskId, {
        expectedPreflightPath: params.expectedPreflightPath,
        expectedPreflightSha256: params.expectedPreflightSha256,
        expectedTaskTextSha256,
        timelineEvidence: params.timelineEvidence,
        loadedHeadlinesCache
    });
}

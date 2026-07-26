import {
    appendMandatoryTaskEvent
} from '../../../../gate-runtime/task-events';
import {
    buildCurrentCycleOptionalSkillActivationIndex,
    buildCurrentCycleOptionalSkillDeclineIndex,
    buildFreshCurrentCycleOptionalSkillDeclinePointIndex,
    buildMandatoryCurrentCycleOptionalSkillActivationIndex,
    compareOptionalSkillEvidencePoints,
    computeOptionalSkillSelectionFingerprint,
    getCurrentCycleOptionalSkillDeclines,
    isMandatoryOptionalSkillSelectionPolicyMode,
    isOptionalSkillSelectionPolicyConfigured,
    isPostDiffOptionalSkillSelection,
    readOptionalSkillSelectionArtifact,
    readOptionalSkillSelectionPolicyConfig,
    readOptionalSkillSelectionTimelineEvidence,
    type OptionalSkillSelectionArtifact
} from '../../../../runtime/optional-skill-selection';
import { SKILL_TELEMETRY_ACTOR } from '../../../../runtime/skill-telemetry';

export interface RestartOptionalSkillActivationSnapshot {
    selectionFingerprintSha256: string;
    activatedSkills: Array<{ id: string; pack: string | null }>;
}

export interface RestartOptionalSkillDeclineSnapshot {
    selectionFingerprintSha256: string;
    declinedSkills: Array<{ id: string; pack: string | null; reason: string | null }>;
}

export interface RestartOptionalSkillActivationRebind {
    reboundSkillIds: string[];
    selectionFingerprintSha256: string | null;
}

export interface RestartOptionalSkillDeclineRebind {
    reboundSkillIds: string[];
    selectionFingerprintSha256: string | null;
}

function getOptionalSkillSelectionFingerprint(payload: OptionalSkillSelectionArtifact): string {
    return String(payload.selection_fingerprint_sha256 || computeOptionalSkillSelectionFingerprint(payload)).trim();
}

function getSelectedOptionalSkills(payload: OptionalSkillSelectionArtifact): Array<{ id: string; pack: string | null }> {
    return Array.isArray(payload.selected_installed_skills)
        ? payload.selected_installed_skills
            .map((entry) => ({
                id: String(entry.id || '').trim(),
                pack: entry.pack || null
            }))
            .filter((entry) => entry.id)
        : [];
}

export function readRestartOptionalSkillActivationSnapshot(
    orchestratorRoot: string,
    taskId: string
): RestartOptionalSkillActivationSnapshot | null {
    if (!isOptionalSkillSelectionPolicyConfigured(orchestratorRoot)) {
        return null;
    }
    const policyConfig = readOptionalSkillSelectionPolicyConfig(orchestratorRoot);
    if (!isMandatoryOptionalSkillSelectionPolicyMode(policyConfig.mode)) {
        return null;
    }
    const artifact = readOptionalSkillSelectionArtifact(orchestratorRoot, taskId);
    if (!artifact) {
        return null;
    }
    const selectionFingerprintSha256 = getOptionalSkillSelectionFingerprint(artifact.payload);
    if (!selectionFingerprintSha256) {
        return null;
    }
    const selectedSkills = getSelectedOptionalSkills(artifact.payload);
    if (selectedSkills.length === 0) {
        return null;
    }
    const timelineEvidence = readOptionalSkillSelectionTimelineEvidence(orchestratorRoot, taskId);
    if (!timelineEvidence.exists || timelineEvidence.invalidJson) {
        return null;
    }
    const activationIndex = buildMandatoryCurrentCycleOptionalSkillActivationIndex(artifact.payload, timelineEvidence);
    const activatedSkills = selectedSkills.filter((skill) => activationIndex.has(skill.id));
    return activatedSkills.length > 0
        ? { selectionFingerprintSha256, activatedSkills }
        : null;
}

function getLatestDeclineReasonsBySkill(
    payload: OptionalSkillSelectionArtifact,
    timelineEvidence: ReturnType<typeof readOptionalSkillSelectionTimelineEvidence>
): Map<string, string | null> {
    const declineReasons = new Map<string, {
        timestampMs: number;
        eventSequence: number | null;
        reason: string | null;
    }>();
    for (const decline of getCurrentCycleOptionalSkillDeclines(payload, timelineEvidence)) {
        const skillId = String(decline.skillId || '').trim();
        const timestampMs = Date.parse(String(decline.timestampUtc || '').trim());
        if (!skillId || !Number.isFinite(timestampMs)) {
            continue;
        }
        const previous = declineReasons.get(skillId);
        const eventSequence = decline.eventSequence ?? null;
        const isNewer = !previous || compareOptionalSkillEvidencePoints(
            { timestampMs, eventSequence },
            previous
        ) >= 0;
        if (isNewer) {
            declineReasons.set(skillId, {
                timestampMs,
                eventSequence,
                reason: decline.reason || null
            });
        }
    }
    return new Map([...declineReasons].map(([skillId, value]) => [skillId, value.reason]));
}

export function readRestartOptionalSkillDeclineSnapshot(
    orchestratorRoot: string,
    taskId: string
): RestartOptionalSkillDeclineSnapshot | null {
    if (!isOptionalSkillSelectionPolicyConfigured(orchestratorRoot)) {
        return null;
    }
    const policyConfig = readOptionalSkillSelectionPolicyConfig(orchestratorRoot);
    if (isMandatoryOptionalSkillSelectionPolicyMode(policyConfig.mode) || policyConfig.mode === 'off') {
        return null;
    }
    const artifact = readOptionalSkillSelectionArtifact(orchestratorRoot, taskId);
    if (!artifact) {
        return null;
    }
    const selectionFingerprintSha256 = getOptionalSkillSelectionFingerprint(artifact.payload);
    if (!selectionFingerprintSha256) {
        return null;
    }
    const selectedSkills = getSelectedOptionalSkills(artifact.payload);
    if (selectedSkills.length === 0) {
        return null;
    }
    const timelineEvidence = readOptionalSkillSelectionTimelineEvidence(orchestratorRoot, taskId);
    if (!timelineEvidence.exists || timelineEvidence.invalidJson) {
        return null;
    }
    const declineIndex = buildCurrentCycleOptionalSkillDeclineIndex(artifact.payload, timelineEvidence);
    const activationIndex = buildCurrentCycleOptionalSkillActivationIndex(artifact.payload, timelineEvidence);
    const declineReasons = getLatestDeclineReasonsBySkill(artifact.payload, timelineEvidence);
    const declinedSkills = selectedSkills
        .filter((skill) => declineIndex.has(skill.id) && !activationIndex.has(skill.id))
        .map((skill) => ({
            ...skill,
            reason: declineReasons.get(skill.id) || null
        }));
    return declinedSkills.length > 0
        ? { selectionFingerprintSha256, declinedSkills }
        : null;
}

export async function rebindRestartOptionalSkillActivationsForCurrentCycle(input: {
    orchestratorRoot: string;
    taskId: string;
    snapshot: RestartOptionalSkillActivationSnapshot | null;
}): Promise<RestartOptionalSkillActivationRebind> {
    const emptyRebind = {
        reboundSkillIds: [],
        selectionFingerprintSha256: input.snapshot?.selectionFingerprintSha256 || null
    };
    if (!input.snapshot) {
        return emptyRebind;
    }
    if (!isOptionalSkillSelectionPolicyConfigured(input.orchestratorRoot)) {
        return emptyRebind;
    }
    const policyConfig = readOptionalSkillSelectionPolicyConfig(input.orchestratorRoot);
    if (!isMandatoryOptionalSkillSelectionPolicyMode(policyConfig.mode)) {
        return emptyRebind;
    }
    const artifact = readOptionalSkillSelectionArtifact(input.orchestratorRoot, input.taskId);
    if (!artifact) {
        return emptyRebind;
    }
    const currentSelectionFingerprintSha256 = getOptionalSkillSelectionFingerprint(artifact.payload);
    if (isPostDiffOptionalSkillSelection(artifact.payload)) {
        return {
            reboundSkillIds: [],
            selectionFingerprintSha256: currentSelectionFingerprintSha256 || null
        };
    }

    const selectedSkills = getSelectedOptionalSkills(artifact.payload);
    const rebindableSkills = new Map(input.snapshot.activatedSkills.map((skill) => [skill.id, skill]));
    const timelineEvidence = readOptionalSkillSelectionTimelineEvidence(input.orchestratorRoot, input.taskId);
    const currentActivationIndex = timelineEvidence.exists && !timelineEvidence.invalidJson
        ? buildMandatoryCurrentCycleOptionalSkillActivationIndex(artifact.payload, timelineEvidence)
        : new Map<string, number>();
    const reboundSkillIds: string[] = [];
    for (const selectedSkill of selectedSkills) {
        const rebindableSkill = rebindableSkills.get(selectedSkill.id);
        if (
            currentActivationIndex.has(selectedSkill.id)
            || !rebindableSkill
            || rebindableSkill.pack !== selectedSkill.pack
        ) {
            continue;
        }
        appendMandatoryTaskEvent(
            input.orchestratorRoot,
            input.taskId,
            'SKILL_SELECTED',
            'INFO',
            `Skill selected: ${selectedSkill.id}`,
            {
                telemetry_type: 'skill_activation',
                skill_id: selectedSkill.id,
                reference_path: null,
                trigger_reason: 'optional_skill_selection',
                ...(selectedSkill.pack ? { pack_id: selectedSkill.pack } : {}),
                optional_skill_selection_fingerprint_sha256: currentSelectionFingerprintSha256
            },
            { actor: SKILL_TELEMETRY_ACTOR }
        );
        reboundSkillIds.push(selectedSkill.id);
    }

    return {
        reboundSkillIds,
        selectionFingerprintSha256: currentSelectionFingerprintSha256
    };
}

export async function rebindRestartOptionalSkillDeclinesForCurrentCycle(input: {
    orchestratorRoot: string;
    taskId: string;
    snapshot: RestartOptionalSkillDeclineSnapshot | null;
}): Promise<RestartOptionalSkillDeclineRebind> {
    const emptyRebind = {
        reboundSkillIds: [],
        selectionFingerprintSha256: input.snapshot?.selectionFingerprintSha256 || null
    };
    if (!input.snapshot) {
        return emptyRebind;
    }
    if (!isOptionalSkillSelectionPolicyConfigured(input.orchestratorRoot)) {
        return emptyRebind;
    }
    const policyConfig = readOptionalSkillSelectionPolicyConfig(input.orchestratorRoot);
    if (isMandatoryOptionalSkillSelectionPolicyMode(policyConfig.mode) || policyConfig.mode === 'off') {
        return emptyRebind;
    }
    const artifact = readOptionalSkillSelectionArtifact(input.orchestratorRoot, input.taskId);
    if (!artifact) {
        return emptyRebind;
    }
    const currentSelectionFingerprintSha256 = getOptionalSkillSelectionFingerprint(artifact.payload);
    if (isPostDiffOptionalSkillSelection(artifact.payload)) {
        return {
            reboundSkillIds: [],
            selectionFingerprintSha256: currentSelectionFingerprintSha256 || null
        };
    }

    const selectedSkills = getSelectedOptionalSkills(artifact.payload);
    const rebindableDeclines = new Map(input.snapshot.declinedSkills.map((skill) => [skill.id, skill]));
    const timelineEvidence = readOptionalSkillSelectionTimelineEvidence(input.orchestratorRoot, input.taskId);
    const currentActivationIndex = timelineEvidence.exists && !timelineEvidence.invalidJson
        ? buildCurrentCycleOptionalSkillActivationIndex(artifact.payload, timelineEvidence)
        : new Map<string, number>();
    const currentFreshDeclineIndex = timelineEvidence.exists && !timelineEvidence.invalidJson
        ? buildFreshCurrentCycleOptionalSkillDeclinePointIndex(artifact.payload, timelineEvidence)
        : new Map();
    const reboundSkillIds: string[] = [];
    for (const selectedSkill of selectedSkills) {
        const rebindableDecline = rebindableDeclines.get(selectedSkill.id);
        if (
            !rebindableDecline
            || rebindableDecline.pack !== selectedSkill.pack
            || currentActivationIndex.has(selectedSkill.id)
            || currentFreshDeclineIndex.has(selectedSkill.id)
        ) {
            continue;
        }
        appendMandatoryTaskEvent(
            input.orchestratorRoot,
            input.taskId,
            'SKILL_DECLINED',
            'INFO',
            `Optional skill declined: ${selectedSkill.id}`,
            {
                telemetry_type: 'skill_decision',
                skill_id: selectedSkill.id,
                pack_id: selectedSkill.pack || null,
                reference_path: null,
                trigger_reason: 'optional_skill_selection',
                optional_skill_selection_fingerprint_sha256: currentSelectionFingerprintSha256,
                reason: rebindableDecline.reason || 'not_used_for_current_implementation'
            },
            { actor: 'optional-skill-selection' }
        );
        reboundSkillIds.push(selectedSkill.id);
    }

    return {
        reboundSkillIds,
        selectionFingerprintSha256: currentSelectionFingerprintSha256
    };
}

export function buildOptionalSkillRebindDetails(
    activationRebind: RestartOptionalSkillActivationRebind,
    declineRebind: RestartOptionalSkillDeclineRebind
): Record<string, unknown> | undefined {
    const details: Record<string, unknown> = {};
    if (activationRebind.reboundSkillIds.length > 0) {
        details.optional_skill_activation_rebound_skill_ids = activationRebind.reboundSkillIds;
        details.optional_skill_activation_rebind_fingerprint_sha256 = activationRebind.selectionFingerprintSha256;
    }
    if (declineRebind.reboundSkillIds.length > 0) {
        details.optional_skill_decline_rebound_skill_ids = declineRebind.reboundSkillIds;
        details.optional_skill_decline_rebind_fingerprint_sha256 = declineRebind.selectionFingerprintSha256;
    }
    return Object.keys(details).length > 0 ? details : undefined;
}

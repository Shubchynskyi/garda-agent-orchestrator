import * as path from 'node:path';
import { pathExists } from '../../core/filesystem';
import { readInstalledSkillPacks } from '../skill-activation';
import { type SkillsHeadlineSkillEntry, type SkillsHeadlinePackEntry } from '../skill-headlines';

import {
    type OptionalSkillSelectionArtifact,
    type OptionalSkillSelectionArtifactData,
    type OptionalSkillSelectionDecision,
    type OptionalSkillSelectionPolicyMode,
    type OptionalSkillSelectionTimelineEvidence,
    OPTIONAL_SKILL_SELECTION_POLICY_MODES,
    MAX_SELECTED_SKILLS,
    MAX_RECOMMENDED_PACKS,
    computeOptionalSkillSelectionFingerprint,
    isMandatoryOptionalSkillSelectionPolicyMode,
    normalizeOptionalSkillSelectionPolicyMode,
    resolvePortableRepoPath,
    toPortableBundlePath,
    toTimestampMs
} from './types';

import {
    readOptionalSkillSelectionTimelineEvidence,
    buildCurrentCycleOptionalSkillActivationIndex,
    buildMandatoryCurrentCycleOptionalSkillActivationIndex,
    buildFreshCurrentCycleOptionalSkillActivationPointIndex,
    getCurrentImplementationStartPoint,
    didActivationOccurAfterImplementationStart,
    getCurrentCycleOptionalSkillReferenceLoads
} from './timeline-evidence';

import {
    loadSkillsHeadlines
} from './headlines-cache';

import {
    readOptionalSkillSelectionPolicyConfig,
    isOptionalSkillSelectionPolicyConfigured
} from './config';

import {
    getOptionalSkillSelectionArtifactPath,
    readOptionalSkillSelectionArtifact
} from './artifact-store';

import { buildVisibleSummaryLine } from './artifact-builder';

export function isPathWithinResolvedRoot(rootPath: string, candidatePath: string): boolean {
    const resolvedRootPath = path.resolve(rootPath);
    const resolvedCandidatePath = path.resolve(candidatePath);
    const relativePath = path.relative(resolvedRootPath, resolvedCandidatePath);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

export function collectOptionalSkillReferenceLoadViolations(
    bundleRoot: string,
    taskId: string,
    policyMode: OptionalSkillSelectionPolicyMode,
    payload: OptionalSkillSelectionArtifact,
    taskEventsPath?: string | null,
    timelineEvidence?: OptionalSkillSelectionTimelineEvidence | null
): string[] {
    const resolvedTimelineEvidence = timelineEvidence || readOptionalSkillSelectionTimelineEvidence(bundleRoot, taskId, taskEventsPath);
    if (!resolvedTimelineEvidence.exists || resolvedTimelineEvidence.invalidJson) {
        return [];
    }

    const allowedPaths = new Set(
        Array.isArray(payload.selected_installed_skills)
            ? payload.selected_installed_skills
                .map((entry) => resolvePortableRepoPath(bundleRoot, String(entry.allowed_skill_path || '').trim()))
                .filter(Boolean)
            : []
    );
    const allowedRoots = new Set(
        Array.isArray(payload.selected_installed_skills)
            ? payload.selected_installed_skills
                .map((entry) => resolvePortableRepoPath(bundleRoot, String(entry.allowed_skill_path || '').trim()))
                .filter(Boolean)
                .map((resolvedPath) => path.dirname(resolvedPath))
            : []
    );
    const selectedSkillIds = new Set(
        Array.isArray(payload.selected_installed_skills)
            ? payload.selected_installed_skills
                .map((entry) => String(entry.id || '').trim())
                .filter(Boolean)
            : []
    );
    const activationIndex = isMandatoryOptionalSkillSelectionPolicyMode(policyMode)
        ? buildMandatoryCurrentCycleOptionalSkillActivationIndex(payload, resolvedTimelineEvidence)
        : buildCurrentCycleOptionalSkillActivationIndex(payload, resolvedTimelineEvidence);
    const violations: string[] = [];
    for (const referenceLoad of getCurrentCycleOptionalSkillReferenceLoads(payload, resolvedTimelineEvidence)) {
        if (policyMode === 'off') {
            violations.push(
                `Optional skill reference '${referenceLoad.referencePath}' was loaded while policy mode is 'off'.`
            );
            continue;
        }
        const isAuthorized = allowedPaths.has(referenceLoad.resolvedReferencePath)
            || [...allowedRoots].some((allowedRoot) => isPathWithinResolvedRoot(allowedRoot, referenceLoad.resolvedReferencePath));
        if (!isAuthorized) {
            violations.push(
                `Optional skill reference '${referenceLoad.referencePath}' is not authorized by the current optional skill selection artifact.`
            );
            continue;
        }
        const activatedSkillId = String(referenceLoad.skillId || '').trim();
        const activationTimestampMs = activationIndex.get(activatedSkillId);
        if (!activatedSkillId || !selectedSkillIds.has(activatedSkillId) || activationTimestampMs === undefined) {
            violations.push(
                `Optional skill reference '${referenceLoad.referencePath}' was loaded before the selected optional skill was activated for the current task cycle.`
            );
            continue;
        }
        const referenceTimestampMs = toTimestampMs(referenceLoad.timestampUtc);
        if (referenceTimestampMs === null || referenceTimestampMs < activationTimestampMs) {
            violations.push(
                `Optional skill reference '${referenceLoad.referencePath}' was loaded before optional skill activation completed for the current task cycle.`
            );
            continue;
        }
    }

    return violations;
}

export function getOptionalSkillSelectionArtifactViolations(
    bundleRoot: string,
    artifact: OptionalSkillSelectionArtifactData,
    options: {
        requireMaterializedArtifact?: boolean;
        expectedPreflightPath?: string | null;
        expectedPreflightSha256?: string | null;
        expectedTaskTextSha256?: string | null;
        expectedPolicyMode?: OptionalSkillSelectionPolicyMode | null;
        enforceMandatorySelection?: boolean;
        validateAgainstCurrentHeadlines?: boolean;
        validateAgainstCurrentInventory?: boolean;
        loadedHeadlinesCache?: {
            headlinesPath: string;
            headlinesSha256: string | null;
            materializationNeeded?: boolean;
            skills: SkillsHeadlineSkillEntry[];
            optional_packs: SkillsHeadlinePackEntry[];
        } | null;
    } = {}
): string[] {
    const violations: string[] = [];
    const { payload } = artifact;
    const schemaVersion = Number(payload.schema_version || 0);
    const eventSource = String(payload.event_source || '').trim();
    const rawPolicyMode = String(payload.policy_mode || '').trim() as OptionalSkillSelectionPolicyMode;
    const policyMode = normalizeOptionalSkillSelectionPolicyMode(rawPolicyMode) as OptionalSkillSelectionPolicyMode;
    const decision = String(payload.decision || '').trim() as OptionalSkillSelectionDecision;
    const expectedArtifactPath = getOptionalSkillSelectionArtifactPath(bundleRoot, payload.task_id);
    const validateAgainstCurrentHeadlines = options.validateAgainstCurrentHeadlines !== false;
    const validateAgainstCurrentInventory = options.validateAgainstCurrentInventory !== false;
    const allowedDecisions = new Set<OptionalSkillSelectionDecision>([
        'selected_installed_skills',
        'recommended_missing_packs',
        'as_is'
    ]);

    if (options.requireMaterializedArtifact === true && !pathExists(artifact.artifactPath)) {
        violations.push(
            `Optional skill selection artifact is missing for current task cycle: ${toPortableBundlePath(bundleRoot, artifact.artifactPath)}`
        );
    }

    if (path.resolve(artifact.artifactPath) !== path.resolve(expectedArtifactPath)) {
        violations.push(
            `Optional skill selection artifact path must match the canonical location '${toPortableBundlePath(bundleRoot, expectedArtifactPath)}'.`
        );
    }
    if (schemaVersion !== 1) {
        violations.push(`Optional skill selection artifact schema_version '${schemaVersion}' is invalid.`);
    }
    if (eventSource !== 'optional-skill-selection') {
        violations.push("Optional skill selection artifact event_source must equal 'optional-skill-selection'.");
    }

    if (!OPTIONAL_SKILL_SELECTION_POLICY_MODES.includes(rawPolicyMode)) {
        violations.push(`Optional skill selection policy mode '${rawPolicyMode}' is invalid.`);
    }
    const expectedPolicyMode = String(options.expectedPolicyMode || '').trim() as OptionalSkillSelectionPolicyMode;
    if (expectedPolicyMode && policyMode !== normalizeOptionalSkillSelectionPolicyMode(expectedPolicyMode)) {
        violations.push(`Optional skill selection artifact must match the current policy mode '${expectedPolicyMode}'.`);
    }
    if (!allowedDecisions.has(decision)) {
        violations.push(`Optional skill selection decision '${decision}' is invalid.`);
    }
    if (!String(payload.visible_summary_line || '').trim()) {
        violations.push('Optional skill selection artifact must include a compact visible_summary_line.');
    }

    const selectedSkills = Array.isArray(payload.selected_installed_skills) ? payload.selected_installed_skills : [];
    const recommendedMissingPacks = Array.isArray(payload.recommended_missing_packs)
        ? payload.recommended_missing_packs
        : [];
    const selectedSkillIds = selectedSkills
        .map((entry) => String(entry?.id || '').trim())
        .filter(Boolean);
    const recommendedPackIds = recommendedMissingPacks
        .map((entry) => String(entry?.id || '').trim())
        .filter(Boolean);
    const loadedHeadlines = (
        validateAgainstCurrentHeadlines
        || validateAgainstCurrentInventory
    )
        ? (options.loadedHeadlinesCache
            ? {
                headlinesPath: options.loadedHeadlinesCache.headlinesPath,
                headlinesSha256: options.loadedHeadlinesCache.headlinesSha256,
                materializationNeeded: options.loadedHeadlinesCache.materializationNeeded === true,
                payload: {
                    skills: options.loadedHeadlinesCache.skills,
                    optional_packs: options.loadedHeadlinesCache.optional_packs
                }
            }
            : artifact.loadedHeadlinesCache
                ? {
                    headlinesPath: artifact.loadedHeadlinesCache.headlinesPath,
                    headlinesSha256: artifact.loadedHeadlinesCache.headlinesSha256,
                    materializationNeeded: artifact.loadedHeadlinesCache.materializationNeeded === true,
                    payload: {
                        skills: artifact.loadedHeadlinesCache.skills,
                        optional_packs: artifact.loadedHeadlinesCache.optional_packs
                    }
                }
                : loadSkillsHeadlines(bundleRoot, policyMode))
        : null;
    const currentSelectableSkillsById = new Map<string, SkillsHeadlineSkillEntry>(
        (validateAgainstCurrentInventory ? (loadedHeadlines?.payload.skills || []) : [])
            .filter((skill) => (
                skill.review_binding === 'general_purpose'
                && (skill.source === 'installed_optional' || skill.source === 'custom_live')
                && skill.implemented !== false
            ))
            .map((skill) => [skill.id, skill])
    );
    const currentOptionalPacksById = new Map<string, SkillsHeadlinePackEntry>(
        (validateAgainstCurrentInventory ? (loadedHeadlines?.payload.optional_packs || []) : []).map((pack) => [pack.id, pack])
    );
    const currentInstalledPackIds = validateAgainstCurrentInventory
        ? new Set(readInstalledSkillPacks(bundleRoot).installedPackIds)
        : new Set<string>();
    if (loadedHeadlines && validateAgainstCurrentHeadlines) {
        const expectedHeadlinesPath = toPortableBundlePath(bundleRoot, loadedHeadlines.headlinesPath);
        if (String(payload.headlines_path || '').trim() !== expectedHeadlinesPath) {
            violations.push(
                `Optional skill selection artifact must bind to the current headlines surface '${expectedHeadlinesPath}'.`
            );
        }
        if (
            loadedHeadlines.headlinesSha256
            && String(payload.headlines_sha256 || '').trim()
            && String(payload.headlines_sha256 || '').trim() !== loadedHeadlines.headlinesSha256
        ) {
            violations.push('Optional skill selection artifact does not match the current skills-headlines surface hash.');
        }
    }

    const expectedPreflightPath = String(options.expectedPreflightPath || '').trim();
    if (expectedPreflightPath) {
        const expectedPortablePreflightPath = expectedPreflightPath.replace(/\\/g, '/');
        if (String(payload.preflight_path || '').trim() !== expectedPortablePreflightPath) {
            violations.push(
                `Optional skill selection artifact must bind to the current preflight artifact '${expectedPortablePreflightPath}'.`
            );
        }
    }

    const expectedPreflightSha256 = String(options.expectedPreflightSha256 || '').trim();
    if (expectedPreflightSha256 && String(payload.preflight_sha256 || '').trim() !== expectedPreflightSha256) {
        violations.push('Optional skill selection artifact does not match the current preflight artifact hash.');
    }
    const hasExpectedTaskTextBinding = Object.prototype.hasOwnProperty.call(options, 'expectedTaskTextSha256');
    const expectedTaskTextSha256 = String(options.expectedTaskTextSha256 || '').trim();
    const actualTaskTextSha256 = String(payload.task_text_sha256 || '').trim();
    if (hasExpectedTaskTextBinding) {
        if (!expectedTaskTextSha256) {
            if (payload.task_text_present === true || actualTaskTextSha256) {
                violations.push('Optional skill selection artifact does not match the current task summary hash.');
            }
        } else if (actualTaskTextSha256 !== expectedTaskTextSha256) {
            violations.push('Optional skill selection artifact does not match the current task summary hash.');
        }
    }

    const actualSelectionFingerprintSha256 = String(payload.selection_fingerprint_sha256 || '').trim();
    if (
        actualSelectionFingerprintSha256
        && actualSelectionFingerprintSha256 !== computeOptionalSkillSelectionFingerprint(payload)
    ) {
        violations.push('Optional skill selection artifact selection_fingerprint_sha256 does not match the selection payload.');
    }

    if (policyMode === 'off') {
        if (selectedSkills.length > 0) {
            violations.push("Policy mode 'off' must not include selected_installed_skills entries.");
        }
        if (recommendedMissingPacks.length > 0) {
            violations.push("Policy mode 'off' must not include recommended_missing_packs entries.");
        }
        if (decision !== 'as_is') {
            violations.push("Policy mode 'off' must emit decision 'as_is'.");
        }
        if (payload.as_is_reason !== 'policy_off') {
            violations.push("Policy mode 'off' must emit as_is_reason 'policy_off'.");
        }
        return violations;
    }

    if (selectedSkills.length > MAX_SELECTED_SKILLS) {
        violations.push(`Optional skill selection artifact exceeds the maximum selected_installed_skills count (${MAX_SELECTED_SKILLS}).`);
    }
    if (new Set(selectedSkillIds).size !== selectedSkillIds.length) {
        violations.push('Optional skill selection artifact must not contain duplicate selected_installed_skills entries.');
    }
    if (recommendedMissingPacks.length > MAX_RECOMMENDED_PACKS) {
        violations.push(`Optional skill selection artifact exceeds the maximum recommended_missing_packs count (${MAX_RECOMMENDED_PACKS}).`);
    }
    if (new Set(recommendedPackIds).size !== recommendedPackIds.length) {
        violations.push('Optional skill selection artifact must not contain duplicate recommended_missing_packs entries.');
    }

    if (decision === 'selected_installed_skills' && selectedSkills.length === 0) {
        violations.push("Decision 'selected_installed_skills' requires at least one selected skill.");
    }
    if (decision !== 'selected_installed_skills' && selectedSkills.length > 0) {
        violations.push(`Decision '${decision}' must not include selected_installed_skills entries.`);
    }
    if (decision === 'recommended_missing_packs' && recommendedMissingPacks.length === 0) {
        violations.push("Decision 'recommended_missing_packs' requires at least one recommended pack.");
    }
    if (decision !== 'recommended_missing_packs' && recommendedMissingPacks.length > 0) {
        violations.push(`Decision '${decision}' must not include recommended_missing_packs entries.`);
    }
    if (decision === 'as_is' && !payload.as_is_reason) {
        violations.push("Decision 'as_is' requires an explicit as_is_reason.");
    }
    if (options.enforceMandatorySelection === true && isMandatoryOptionalSkillSelectionPolicyMode(policyMode)) {
        if (decision !== 'selected_installed_skills') {
            violations.push("Policy mode 'mandatory' requires decision 'selected_installed_skills'.");
        }
        if (selectedSkills.length === 0) {
            violations.push("Policy mode 'mandatory' requires at least one selected installed optional skill.");
        }
    }
    if (validateAgainstCurrentInventory) {
        for (const recommendedPack of recommendedMissingPacks) {
            const currentPack = currentOptionalPacksById.get(String(recommendedPack.id || '').trim());
            if (!currentPack) {
                violations.push(
                    `Recommended missing pack '${recommendedPack.id}' is not present in the current optional skill pack inventory.`
                );
                continue;
            }
            if (currentInstalledPackIds.has(currentPack.id)) {
                violations.push(
                    `Recommended missing pack '${recommendedPack.id}' is already installed in the current optional skill pack inventory.`
                );
            }
        }
    }

    for (const selectedSkill of selectedSkills) {
        const portablePath = String(selectedSkill.allowed_skill_path || '').trim();
        if (!portablePath) {
            violations.push(`Selected skill '${selectedSkill.id}' is missing allowed_skill_path.`);
            continue;
        }
        if (!validateAgainstCurrentInventory) {
            continue;
        }

        const resolvedPath = resolvePortableRepoPath(bundleRoot, portablePath);
        if (!pathExists(resolvedPath)) {
            violations.push(
                `Selected skill '${selectedSkill.id}' points to a missing skill reference path '${portablePath}'.`
            );
            continue;
        }

        const currentSkill = currentSelectableSkillsById.get(String(selectedSkill.id || '').trim());
        if (!currentSkill) {
            violations.push(
                `Selected skill '${selectedSkill.id}' is not present in the current installed optional skill inventory.`
            );
            continue;
        }

        const currentPack = currentSkill.pack || null;
        if ((selectedSkill.pack || null) !== currentPack) {
            violations.push(
                `Selected skill '${selectedSkill.id}' must keep its current pack binding '${currentPack || 'null'}'.`
            );
        }
        if (selectedSkill.source === 'installed_optional' && currentPack && !currentInstalledPackIds.has(currentPack)) {
            violations.push(
                `Selected skill '${selectedSkill.id}' belongs to optional pack '${currentPack}', which is not currently installed.`
            );
        }

        const expectedSkillPath = toPortableBundlePath(
            bundleRoot,
            path.join(bundleRoot, 'live', 'skills', String(currentSkill.directory || currentSkill.id || '').trim(), 'SKILL.md')
        );
        if (portablePath !== expectedSkillPath) {
            violations.push(
                `Selected skill '${selectedSkill.id}' must reference its canonical skill path '${expectedSkillPath}'.`
            );
        }
    }

    return violations;
}

export function getOptionalSkillSelectionGateViolations(
    bundleRoot: string,
    taskId: string,
    options: {
        expectedPreflightPath?: string | null;
        expectedPreflightSha256?: string | null;
        expectedTaskTextSha256?: string | null;
        taskEventsPath?: string | null;
        timelineEvidence?: OptionalSkillSelectionTimelineEvidence | null;
        loadedHeadlinesCache?: OptionalSkillSelectionArtifactData['loadedHeadlinesCache'];
    } = {}
): string[] {
    if (!isOptionalSkillSelectionPolicyConfigured(bundleRoot)) {
        return [];
    }
    const policyConfig = readOptionalSkillSelectionPolicyConfig(bundleRoot);
    const requireMaterializedArtifact = isMandatoryOptionalSkillSelectionPolicyMode(policyConfig.mode);
    const artifact = readOptionalSkillSelectionArtifact(bundleRoot, taskId);
    if (!artifact) {
        if (!requireMaterializedArtifact) {
            return [];
        }
        const expectedArtifactPath = getOptionalSkillSelectionArtifactPath(bundleRoot, taskId);
        return [
            `Optional skill selection artifact is missing for current task cycle: ${toPortableBundlePath(bundleRoot, expectedArtifactPath)}`
        ];
    }
    const validationOptions: Parameters<typeof getOptionalSkillSelectionArtifactViolations>[2] = {
        requireMaterializedArtifact,
        expectedPreflightPath: options.expectedPreflightPath || null,
        expectedPreflightSha256: options.expectedPreflightSha256 || null,
        expectedPolicyMode: policyConfig.mode,
        enforceMandatorySelection: true,
        loadedHeadlinesCache: options.loadedHeadlinesCache || null
    };
    if (Object.prototype.hasOwnProperty.call(options, 'expectedTaskTextSha256')) {
        validationOptions.expectedTaskTextSha256 = options.expectedTaskTextSha256 ?? null;
    }
    const artifactViolations = getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact, validationOptions);
    if (artifactViolations.length > 0 && requireMaterializedArtifact) {
        return artifactViolations;
    }

    const fallbackAsIsReason = policyConfig.mode === 'off'
        ? 'policy_off'
        : artifact.payload.as_is_reason || 'generic_context_sufficient';
    const enforcementPayload: OptionalSkillSelectionArtifact = artifactViolations.length === 0
        ? artifact.payload
        : {
            ...artifact.payload,
            policy_mode: policyConfig.mode,
            decision: 'as_is',
            selected_installed_skills: [],
            recommended_missing_packs: [],
            as_is_reason: fallbackAsIsReason,
            visible_summary_line: buildVisibleSummaryLine({
                decision: 'as_is',
                selectedInstalledSkills: [],
                recommendedMissingPacks: [],
                asIsReason: fallbackAsIsReason
            })
        };
    const timelineEvidence = options.timelineEvidence
        || readOptionalSkillSelectionTimelineEvidence(bundleRoot, taskId, options.taskEventsPath || null);
    const mandatoryActivationViolations: string[] = [];
    if (isMandatoryOptionalSkillSelectionPolicyMode(policyConfig.mode)) {
        if (timelineEvidence.invalidJson) {
            mandatoryActivationViolations.push(
                'Mandatory optional skill selection requires readable current task timeline evidence before implementation.'
            );
        } else {
            const activationPointIndex = buildFreshCurrentCycleOptionalSkillActivationPointIndex(enforcementPayload, timelineEvidence);
            const implementationStart = getCurrentImplementationStartPoint(enforcementPayload, timelineEvidence);
            const selectedActivationSkillIds = (Array.isArray(enforcementPayload.selected_installed_skills)
                ? enforcementPayload.selected_installed_skills
                    .map((entry) => String(entry.id || '').trim())
                    .filter(Boolean)
                : []);
            const missingActivationSkillIds = selectedActivationSkillIds.filter((skillId) => !activationPointIndex.has(skillId));
            const lateActivationSkillIds = implementationStart
                ? selectedActivationSkillIds.filter((skillId) => {
                    const activation = activationPointIndex.get(skillId);
                    return activation ? didActivationOccurAfterImplementationStart(activation, implementationStart) : false;
                })
                : [];
            if (missingActivationSkillIds.length > 0) {
                mandatoryActivationViolations.push(
                    `Mandatory optional skill selection requires current-cycle activation evidence for selected optional skill(s): ${missingActivationSkillIds.join(', ')}.`
                );
            }
            if (lateActivationSkillIds.length > 0) {
                mandatoryActivationViolations.push(
                    `Mandatory optional skill selection requires selected optional skill activation before implementation starts; activation was recorded too late for selected optional skill(s): ${lateActivationSkillIds.join(', ')}.`
                );
            }
        }
    }

    return [
        ...mandatoryActivationViolations,
        ...collectOptionalSkillReferenceLoadViolations(
            bundleRoot,
            taskId,
            policyConfig.mode,
            enforcementPayload,
            options.taskEventsPath || null,
            timelineEvidence
        )
    ];
}

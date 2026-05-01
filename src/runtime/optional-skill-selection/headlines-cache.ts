import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ensureDirectory, pathExists } from '../../core/filesystem';
import { formatJson, writeJsonFile } from '../../core/json';

import {
    computeCurrentSkillsHeadlinesSourceState,
    computeCurrentSkillsHeadlinesValidationState,
    computeSkillsHeadlinesSelectionSurfaceSha256,
    ensureSkillsHeadlinesCurrent,
    getSkillsHeadlinesConfigPath,
    readSkillsHeadlinesIfPresent,
    type SkillsHeadlinesPayload
} from '../skill-headlines';

import {
    type OptionalSkillSelectionPolicyMode,
    type OptionalSkillSelectionArtifactData,
    type LoadSkillsHeadlinesOptions,
    type LoadedSkillsHeadlinesData,
    computeSkillsHeadlinesPayloadSha256
} from './types';

export function loadSkillsHeadlines(
    bundleRoot: string,
    policyMode: OptionalSkillSelectionPolicyMode,
    options: LoadSkillsHeadlinesOptions = {}
): LoadedSkillsHeadlinesData | null {
    const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);
    if (policyMode === 'off') {
        return null;
    }

    const persistedHeadlines = readSkillsHeadlinesIfPresent(bundleRoot);
    if (persistedHeadlines && options.preferPersistedSurface === true) {
        const currentSourceState = computeCurrentSkillsHeadlinesSourceState(bundleRoot);
        if (
            String(persistedHeadlines.payload.source_state_sha256 || '') === currentSourceState.sourceStateSha256
            && String(persistedHeadlines.payload.source_state_hint_sha256 || '') === currentSourceState.sourceStateHintSha256
        ) {
            return {
                headlinesPath: persistedHeadlines.headlinesPath,
                headlinesSha256: persistedHeadlines.sha256,
                materializationNeeded: false,
                skills: Array.isArray(persistedHeadlines.payload.skills) ? persistedHeadlines.payload.skills : [],
                optional_packs: Array.isArray(persistedHeadlines.payload.optional_packs)
                    ? persistedHeadlines.payload.optional_packs
                    : [],
                payload: persistedHeadlines.payload
            };
        }
    }
    const currentValidationState = computeCurrentSkillsHeadlinesValidationState(bundleRoot);
    if (
        persistedHeadlines
        && String(persistedHeadlines.payload.source_state_sha256 || '') === currentValidationState.sourceStateSha256
        && String(persistedHeadlines.payload.source_state_hint_sha256 || '') === currentValidationState.sourceStateHintSha256
        && computeSkillsHeadlinesSelectionSurfaceSha256(persistedHeadlines.payload) === currentValidationState.selectionSurfaceSha256
    ) {
        return {
            headlinesPath: persistedHeadlines.headlinesPath,
            headlinesSha256: persistedHeadlines.sha256,
            materializationNeeded: false,
            skills: Array.isArray(persistedHeadlines.payload.skills) ? persistedHeadlines.payload.skills : [],
            optional_packs: Array.isArray(persistedHeadlines.payload.optional_packs)
                ? persistedHeadlines.payload.optional_packs
                : [],
            payload: persistedHeadlines.payload
        };
    }
    return {
        headlinesPath,
        headlinesSha256: createHash('sha256').update(formatJson(currentValidationState.payload), 'utf8').digest('hex'),
        materializationNeeded: true,
        skills: Array.isArray(currentValidationState.payload.skills) ? currentValidationState.payload.skills : [],
        optional_packs: Array.isArray(currentValidationState.payload.optional_packs)
            ? currentValidationState.payload.optional_packs
            : [],
        payload: currentValidationState.payload
    };
}

export function loadOptionalSkillSelectionHeadlinesCache(
    bundleRoot: string,
    policyMode: OptionalSkillSelectionPolicyMode,
    options: LoadSkillsHeadlinesOptions = {}
): OptionalSkillSelectionArtifactData['loadedHeadlinesCache'] {
    const loadedHeadlines = loadSkillsHeadlines(bundleRoot, policyMode, options);
    if (!loadedHeadlines) {
        return null;
    }
    return {
        headlinesPath: loadedHeadlines.headlinesPath,
        headlinesSha256: loadedHeadlines.headlinesSha256,
        materializationNeeded: loadedHeadlines.materializationNeeded,
        skills: loadedHeadlines.skills,
        optional_packs: loadedHeadlines.optional_packs,
        payload: loadedHeadlines.payload
    };
}

export function materializeCurrentHeadlinesSurface(
    bundleRoot: string,
    loadedHeadlinesCache?: OptionalSkillSelectionArtifactData['loadedHeadlinesCache']
): { headlinesPath: string; headlinesSha256: string | null; payload: SkillsHeadlinesPayload } {
    if (loadedHeadlinesCache?.payload) {
        if (loadedHeadlinesCache.materializationNeeded || !pathExists(loadedHeadlinesCache.headlinesPath)) {
            ensureDirectory(path.dirname(loadedHeadlinesCache.headlinesPath));
            const serializedPayload = formatJson(loadedHeadlinesCache.payload);
            const existingSerializedPayload = pathExists(loadedHeadlinesCache.headlinesPath)
                ? fs.readFileSync(loadedHeadlinesCache.headlinesPath, 'utf8').trim()
                : null;
            if (existingSerializedPayload !== serializedPayload) {
                writeJsonFile(loadedHeadlinesCache.headlinesPath, loadedHeadlinesCache.payload);
            }
        }
        return {
            headlinesPath: loadedHeadlinesCache.headlinesPath,
            headlinesSha256: loadedHeadlinesCache.headlinesSha256 || computeSkillsHeadlinesPayloadSha256(loadedHeadlinesCache.payload),
            payload: loadedHeadlinesCache.payload
        };
    }

    const currentHeadlines = ensureSkillsHeadlinesCurrent(bundleRoot);
    return {
        headlinesPath: currentHeadlines.headlinesPath,
        headlinesSha256: currentHeadlines.sha256,
        payload: currentHeadlines.payload
    };
}

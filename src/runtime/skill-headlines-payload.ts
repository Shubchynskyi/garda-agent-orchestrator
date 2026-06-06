import * as fs from 'node:fs';
import * as path from 'node:path';

import { pathExists } from '../core/filesystem';
import {
    BASELINE_SKILL_DIRECTORIES,
    asObjectRecord,
    listBuiltinSkillPacks,
    type BuiltinSkillPackDefinition,
    type SkillManifestDefinition
} from './skill-manifest';
import { readJsonFile } from '../core/json';
import {
    computeSkillsHeadlinesSelectionSurfaceSha256
} from './skill-headlines-hashing';
import {
    getReviewBinding,
    parseBaselineSkillManifestSnapshot,
    parsePackManifestSnapshot,
    parseSkillManifestSnapshot,
    toOptionalPackEntry,
    tryBuildBaselineSkillEntry,
    tryBuildLiveSkillEntry
} from './skill-headlines-manifest';
import {
    computeSourceStateHintSha256FromSnapshots,
    computeSourceStateSha256FromSnapshots,
    getLiveSkillsRoot,
    getSkillPacksConfigPath,
    getSkillsHeadlinesConfigPath,
    getTemplateSkillPacksRoot,
    readJsonSourceFileSnapshot,
    sortDirectoryEntries
} from './skill-headlines-sources';
import {
    SKILLS_HEADLINES_VERSION,
    type CurrentSkillsHeadlinesState,
    type SkillsHeadlineSkillEntry,
    type SkillsHeadlinesPayload,
    type SkillsHeadlinesSourceFileSnapshot
} from './skill-headlines-types';

function normalizeInstalledPackIds(value: unknown): string[] {
    const items = Array.isArray(value) ? value : [];
    const normalized: string[] = [];
    for (const item of items) {
        const text = String(item || '').trim();
        if (!text || normalized.includes(text)) {
            continue;
        }
        normalized.push(text);
    }
    return normalized.sort();
}

function readInstalledPackIds(bundleRoot: string): string[] {
    const configPath = getSkillPacksConfigPath(bundleRoot);
    if (!pathExists(configPath)) {
        return [];
    }

    try {
        const payload = asObjectRecord(readJsonFile(configPath));
        return normalizeInstalledPackIds(payload.installed_packs);
    } catch {
        return [];
    }
}

export function collectCurrentSkillsHeadlinesState(bundleRoot: string): CurrentSkillsHeadlinesState {
    const snapshots: SkillsHeadlinesSourceFileSnapshot[] = [];
    const skillPacksConfigPath = getSkillPacksConfigPath(bundleRoot);
    const installedPackIds = pathExists(skillPacksConfigPath)
        ? (() => {
            const snapshot = readJsonSourceFileSnapshot(bundleRoot, skillPacksConfigPath);
            snapshots.push(snapshot);
            return normalizeInstalledPackIds(snapshot.parsed.installed_packs);
        })()
        : [];

    const templateSkillPacksRoot = getTemplateSkillPacksRoot(bundleRoot);
    const builtinPacks: BuiltinSkillPackDefinition[] = pathExists(templateSkillPacksRoot)
        ? sortDirectoryEntries(fs.readdirSync(templateSkillPacksRoot, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => buildBuiltinPackFromDirectory(bundleRoot, templateSkillPacksRoot, entry.name, snapshots))
            .filter((entry): entry is BuiltinSkillPackDefinition => entry !== null)
            .sort((left, right) => left.id.localeCompare(right.id))
        : [];

    const installedPackSet = new Set(installedPackIds);
    const installedOptionalSkillIds = builtinPacks
        .filter((pack) => installedPackSet.has(pack.id))
        .flatMap((pack) => pack.skillDirectories)
        .sort();
    const installedOptionalSkillSet = new Set(installedOptionalSkillIds);

    const liveSkillManifestSnapshotsByDirectory = collectLiveSkillManifestSnapshots(bundleRoot, snapshots);
    const liveSkillDirectories = collectLiveSkillDirectories(bundleRoot);
    const customSkillIds = liveSkillDirectories
        .filter((skillId) => !BASELINE_SKILL_DIRECTORIES.includes(skillId) && !installedOptionalSkillSet.has(skillId))
        .sort();

    const baselineSkills = buildBaselineSkillEntries(liveSkillManifestSnapshotsByDirectory);
    const installedOptionalSkills = buildLiveSkillEntries(liveSkillManifestSnapshotsByDirectory, installedOptionalSkillIds, 'installed_optional');
    const customSkills = buildLiveSkillEntries(liveSkillManifestSnapshotsByDirectory, customSkillIds, 'custom_live');

    return {
        headlinesPath: getSkillsHeadlinesConfigPath(bundleRoot),
        snapshots,
        installedPackIds: [...installedPackIds],
        installedOptionalSkillIds: [...installedOptionalSkillIds],
        customSkillIds: [...customSkillIds],
        skills: [
            ...baselineSkills,
            ...installedOptionalSkills,
            ...customSkills
        ].sort((left, right) => left.id.localeCompare(right.id)),
        optionalPacks: builtinPacks
            .map((pack) => toOptionalPackEntry(pack, installedPackIds))
            .sort((left, right) => left.id.localeCompare(right.id))
    };
}

function buildBuiltinPackFromDirectory(
    bundleRoot: string,
    templateSkillPacksRoot: string,
    directoryName: string,
    snapshots: SkillsHeadlinesSourceFileSnapshot[]
): BuiltinSkillPackDefinition | null {
    const packRoot = path.join(templateSkillPacksRoot, directoryName);
    const packManifestPath = path.join(packRoot, 'pack.json');
    if (!pathExists(packManifestPath)) {
        return null;
    }
    const packSnapshot = readJsonSourceFileSnapshot(bundleRoot, packManifestPath);
    snapshots.push(packSnapshot);
    const manifest = parsePackManifestSnapshot(packSnapshot);
    const skillsRoot = path.join(packRoot, 'skills');
    const skills = pathExists(skillsRoot)
        ? sortDirectoryEntries(fs.readdirSync(skillsRoot, { withFileTypes: true }))
            .filter((skillEntry) => skillEntry.isDirectory())
            .map((skillEntry) => {
                const skillManifestPath = path.join(skillsRoot, skillEntry.name, 'skill.json');
                if (!pathExists(skillManifestPath)) {
                    return null;
                }
                const skillSnapshot = readJsonSourceFileSnapshot(bundleRoot, skillManifestPath);
                snapshots.push(skillSnapshot);
                return parseSkillManifestSnapshot(skillSnapshot, manifest.id);
            })
            .filter((skill): skill is SkillManifestDefinition => skill !== null)
            .sort((left, right) => left.id.localeCompare(right.id))
        : [];
    const readySkills = skills.filter((skill) => skill.implemented !== false);
    const placeholderSkills = skills.filter((skill) => skill.implemented === false);
    return {
        ...manifest,
        skills,
        skillCount: skills.length,
        skillDirectories: skills.map((skill) => skill.id),
        readySkillCount: readySkills.length,
        readySkillDirectories: readySkills.map((skill) => skill.id),
        placeholderSkillCount: placeholderSkills.length,
        placeholderSkillDirectories: placeholderSkills.map((skill) => skill.id),
        implemented: readySkills.length > 0,
        collidesWithBaseline: BASELINE_SKILL_DIRECTORIES.includes(manifest.id)
    };
}

function collectLiveSkillManifestSnapshots(
    bundleRoot: string,
    snapshots: SkillsHeadlinesSourceFileSnapshot[]
): Map<string, SkillsHeadlinesSourceFileSnapshot> {
    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    const liveSkillManifestSnapshotsByDirectory = new Map<string, SkillsHeadlinesSourceFileSnapshot>();
    if (!pathExists(liveSkillsRoot)) {
        return liveSkillManifestSnapshotsByDirectory;
    }
    for (const entry of sortDirectoryEntries(fs.readdirSync(liveSkillsRoot, { withFileTypes: true }))) {
        if (!entry.isDirectory()) {
            continue;
        }
        const skillManifestPath = path.join(liveSkillsRoot, entry.name, 'skill.json');
        if (pathExists(skillManifestPath)) {
            const skillSnapshot = readJsonSourceFileSnapshot(bundleRoot, skillManifestPath);
            snapshots.push(skillSnapshot);
            liveSkillManifestSnapshotsByDirectory.set(entry.name, skillSnapshot);
        }
    }
    return liveSkillManifestSnapshotsByDirectory;
}

function collectLiveSkillDirectories(bundleRoot: string): string[] {
    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    if (!pathExists(liveSkillsRoot)) {
        return [];
    }

    return sortDirectoryEntries(fs.readdirSync(liveSkillsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

function buildBaselineSkillEntries(
    liveSkillManifestSnapshotsByDirectory: ReadonlyMap<string, SkillsHeadlinesSourceFileSnapshot>
): SkillsHeadlineSkillEntry[] {
    return BASELINE_SKILL_DIRECTORIES
        .map((skillId): SkillsHeadlineSkillEntry | null => {
            const snapshot = liveSkillManifestSnapshotsByDirectory.get(skillId);
            if (!snapshot) {
                return null;
            }
            const manifest = parseBaselineSkillManifestSnapshot(snapshot);
            return {
                id: manifest.id,
                directory: skillId,
                name: manifest.name,
                summary: manifest.summary,
                pack: null,
                source: 'baseline',
                implemented: true,
                review_binding: getReviewBinding({
                    id: manifest.id,
                    tags: manifest.tags
                }),
                aliases: [...manifest.aliases].sort(),
                task_signals: [],
                changed_path_signals: [],
                tags: [...manifest.tags].sort()
            };
        })
        .filter((entry): entry is SkillsHeadlineSkillEntry => entry !== null);
}

function buildLiveSkillEntries(
    liveSkillManifestSnapshotsByDirectory: ReadonlyMap<string, SkillsHeadlinesSourceFileSnapshot>,
    skillIds: readonly string[],
    source: 'installed_optional' | 'custom_live'
): SkillsHeadlineSkillEntry[] {
    return skillIds
        .map((skillId): SkillsHeadlineSkillEntry | null => {
            const snapshot = liveSkillManifestSnapshotsByDirectory.get(skillId);
            if (!snapshot) {
                return null;
            }
            const manifest = parseSkillManifestSnapshot(snapshot, source === 'custom_live' ? 'custom' : skillId);
            return {
                id: manifest.id,
                directory: skillId,
                name: manifest.name,
                summary: manifest.summary,
                pack: manifest.pack || null,
                source,
                implemented: manifest.implemented !== false,
                review_binding: getReviewBinding({
                    id: manifest.id,
                    tags: manifest.tags
                }),
                aliases: [...manifest.aliases].sort(),
                task_signals: [...manifest.taskSignals].sort(),
                changed_path_signals: [...manifest.changedPathSignals].sort(),
                tags: [...manifest.tags].sort()
            };
        })
        .filter((entry): entry is SkillsHeadlineSkillEntry => entry !== null);
}

export function buildSkillsHeadlinesPayloadFromCurrentState(
    currentState: CurrentSkillsHeadlinesState,
    sourceStateHintSha256?: string
): SkillsHeadlinesPayload {
    return {
        version: SKILLS_HEADLINES_VERSION,
        source_state_sha256: computeSourceStateSha256FromSnapshots(currentState.snapshots),
        source_state_hint_sha256: sourceStateHintSha256 || computeSourceStateHintSha256FromSnapshots(currentState.snapshots),
        installed_pack_ids: [...currentState.installedPackIds],
        baseline_skill_ids: [...BASELINE_SKILL_DIRECTORIES],
        installed_optional_skill_ids: [...currentState.installedOptionalSkillIds],
        custom_skill_ids: [...currentState.customSkillIds],
        skills: currentState.skills,
        optional_packs: currentState.optionalPacks
    };
}

export function computeCurrentSkillsHeadlinesValidationState(bundleRoot: string): {
    sourceStateSha256: string;
    sourceStateHintSha256: string;
    selectionSurfaceSha256: string;
    payload: SkillsHeadlinesPayload;
} {
    const currentState = collectCurrentSkillsHeadlinesState(bundleRoot);
    const payload = buildSkillsHeadlinesPayloadFromCurrentState(currentState);
    return {
        sourceStateSha256: String(payload.source_state_sha256 || ''),
        sourceStateHintSha256: String(payload.source_state_hint_sha256 || ''),
        selectionSurfaceSha256: computeSkillsHeadlinesSelectionSurfaceSha256(payload),
        payload
    };
}

export function computeCurrentSkillsHeadlinesSourceState(bundleRoot: string): {
    sourceStateSha256: string;
    sourceStateHintSha256: string;
} {
    const snapshots = collectOrderedSourceStateSnapshots(bundleRoot);
    return {
        sourceStateSha256: computeSourceStateSha256FromSnapshots(snapshots),
        sourceStateHintSha256: computeSourceStateHintSha256FromSnapshots(snapshots)
    };
}

function collectOrderedSourceStateSnapshots(bundleRoot: string): SkillsHeadlinesSourceFileSnapshot[] {
    const snapshots: SkillsHeadlinesSourceFileSnapshot[] = [];
    const skillPacksConfigPath = getSkillPacksConfigPath(bundleRoot);
    if (pathExists(skillPacksConfigPath)) {
        snapshots.push(readJsonSourceFileSnapshot(bundleRoot, skillPacksConfigPath));
    }

    const templateSkillPacksRoot = getTemplateSkillPacksRoot(bundleRoot);
    if (pathExists(templateSkillPacksRoot)) {
        for (const packEntry of sortDirectoryEntries(fs.readdirSync(templateSkillPacksRoot, { withFileTypes: true }))) {
            if (!packEntry.isDirectory()) {
                continue;
            }
            const packRoot = path.join(templateSkillPacksRoot, packEntry.name);
            const packManifestPath = path.join(packRoot, 'pack.json');
            if (!pathExists(packManifestPath)) {
                continue;
            }
            snapshots.push(readJsonSourceFileSnapshot(bundleRoot, packManifestPath));

            const skillsRoot = path.join(packRoot, 'skills');
            if (!pathExists(skillsRoot)) {
                continue;
            }
            for (const skillEntry of sortDirectoryEntries(fs.readdirSync(skillsRoot, { withFileTypes: true }))) {
                if (!skillEntry.isDirectory()) {
                    continue;
                }
                const skillManifestPath = path.join(skillsRoot, skillEntry.name, 'skill.json');
                if (pathExists(skillManifestPath)) {
                    snapshots.push(readJsonSourceFileSnapshot(bundleRoot, skillManifestPath));
                }
            }
        }
    }

    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    if (pathExists(liveSkillsRoot)) {
        for (const skillEntry of sortDirectoryEntries(fs.readdirSync(liveSkillsRoot, { withFileTypes: true }))) {
            if (!skillEntry.isDirectory()) {
                continue;
            }
            const skillManifestPath = path.join(liveSkillsRoot, skillEntry.name, 'skill.json');
            if (pathExists(skillManifestPath)) {
                snapshots.push(readJsonSourceFileSnapshot(bundleRoot, skillManifestPath));
            }
        }
    }

    return snapshots;
}

export function buildCurrentSkillsHeadlinesPayload(
    bundleRoot: string,
    sourceStateHintSha256?: string
): SkillsHeadlinesPayload {
    return buildSkillsHeadlinesPayloadFromCurrentState(
        collectCurrentSkillsHeadlinesState(bundleRoot),
        sourceStateHintSha256
    );
}

export function buildSkillsHeadlinesPayload(
    bundleRoot: string,
    sourceStateSha256?: string,
    sourceStateHintSha256?: string
): SkillsHeadlinesPayload {
    if (!sourceStateSha256 || !sourceStateHintSha256) {
        const payload = buildCurrentSkillsHeadlinesPayload(bundleRoot, sourceStateHintSha256);
        return {
            ...payload,
            source_state_sha256: sourceStateSha256 || payload.source_state_sha256,
            source_state_hint_sha256: sourceStateHintSha256 || payload.source_state_hint_sha256
        };
    }

    const builtinPacks = listBuiltinSkillPacks(bundleRoot);
    const installedPackIds = readInstalledPackIds(bundleRoot);
    const installedPackSet = new Set(installedPackIds);
    const installedOptionalSkillIds = builtinPacks
        .filter((pack) => installedPackSet.has(pack.id))
        .flatMap((pack) => pack.skillDirectories)
        .sort();
    const installedOptionalSkillSet = new Set(installedOptionalSkillIds);
    const liveSkillDirectories = collectLiveSkillDirectories(bundleRoot);
    const customSkillIds = liveSkillDirectories
        .filter((skillId) => !BASELINE_SKILL_DIRECTORIES.includes(skillId) && !installedOptionalSkillSet.has(skillId))
        .sort();

    return {
        version: SKILLS_HEADLINES_VERSION,
        source_state_sha256: sourceStateSha256,
        source_state_hint_sha256: sourceStateHintSha256,
        installed_pack_ids: [...installedPackIds],
        baseline_skill_ids: [...BASELINE_SKILL_DIRECTORIES],
        installed_optional_skill_ids: [...installedOptionalSkillIds],
        custom_skill_ids: [...customSkillIds],
        skills: [
            ...BASELINE_SKILL_DIRECTORIES
                .map((skillId) => tryBuildBaselineSkillEntry(bundleRoot, skillId))
                .filter((entry): entry is SkillsHeadlineSkillEntry => entry !== null),
            ...installedOptionalSkillIds
                .map((skillId) => tryBuildLiveSkillEntry(bundleRoot, skillId, 'installed_optional', skillId))
                .filter((entry): entry is SkillsHeadlineSkillEntry => entry !== null),
            ...customSkillIds
                .map((skillId) => tryBuildLiveSkillEntry(bundleRoot, skillId, 'custom_live', 'custom'))
                .filter((entry): entry is SkillsHeadlineSkillEntry => entry !== null)
        ].sort((left, right) => left.id.localeCompare(right.id)),
        optional_packs: builtinPacks
            .map((pack) => toOptionalPackEntry(pack, installedPackIds))
            .sort((left, right) => left.id.localeCompare(right.id))
    };
}

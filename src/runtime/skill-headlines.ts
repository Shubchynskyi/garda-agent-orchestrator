import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDirectory, pathExists } from '../core/fs';
import { readJsonFile, writeJsonFile } from '../core/json';
import {
    BASELINE_SKILL_DIRECTORIES,
    asObjectRecord,
    listBuiltinSkillPacks,
    readBaselineSkillManifest,
    readSkillManifest
} from './skill-manifest';

export interface SkillsHeadlineSkillEntry {
    id: string;
    name: string;
    summary: string;
    pack: string | null;
    source: 'baseline' | 'installed_optional' | 'custom_live';
    implemented: boolean;
    review_binding: 'review_bound' | 'general_purpose';
    aliases: string[];
    tags: string[];
}

export interface SkillsHeadlinePackEntry {
    id: string;
    label: string;
    description: string;
    installed: boolean;
    implemented: boolean;
    collides_with_baseline: boolean;
    ready_skill_ids: string[];
    placeholder_skill_ids: string[];
    recommended_for: string[];
    tags: string[];
}

export interface SkillsHeadlinesPayload {
    version: number;
    installed_pack_ids: string[];
    baseline_skill_ids: string[];
    installed_optional_skill_ids: string[];
    custom_skill_ids: string[];
    skills: SkillsHeadlineSkillEntry[];
    optional_packs: SkillsHeadlinePackEntry[];
}

export interface SkillsHeadlinesData {
    headlinesPath: string;
    payload: SkillsHeadlinesPayload;
}

export const SKILLS_HEADLINES_VERSION = 1;

const REVIEW_BOUND_SPECIAL_CASE_IDS = new Set<string>([
    'devops-k8s',
    'testing-strategy'
]);

function getLiveSkillsRoot(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'skills');
}

function getSkillPacksConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'skill-packs.json');
}

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

function listLiveSkillDirectories(bundleRoot: string): string[] {
    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    if (!pathExists(liveSkillsRoot)) {
        return [];
    }

    return fs.readdirSync(liveSkillsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

function getReviewBinding(skill: {
    id: string;
    tags: readonly string[];
}): 'review_bound' | 'general_purpose' {
    const normalizedSkillId = String(skill.id || '').trim().toLowerCase();
    const normalizedTags = skill.tags.map((tag) => String(tag || '').trim().toLowerCase());

    if (normalizedSkillId.endsWith('-review') || REVIEW_BOUND_SPECIAL_CASE_IDS.has(normalizedSkillId)) {
        return 'review_bound';
    }

    if (normalizedTags.includes('review') || normalizedTags.includes('reviews')) {
        return 'review_bound';
    }

    return 'general_purpose';
}

function toOptionalPackEntry(
    pack: ReturnType<typeof listBuiltinSkillPacks>[number],
    installedPackIds: readonly string[]
): SkillsHeadlinePackEntry {
    return {
        id: pack.id,
        label: pack.label,
        description: pack.description,
        installed: installedPackIds.includes(pack.id),
        implemented: pack.implemented !== false,
        collides_with_baseline: pack.collidesWithBaseline === true,
        ready_skill_ids: [...pack.readySkillDirectories].sort(),
        placeholder_skill_ids: [...pack.placeholderSkillDirectories].sort(),
        recommended_for: [...pack.recommendedFor].sort(),
        tags: [...pack.tags].sort()
    };
}

function tryBuildBaselineSkillEntry(bundleRoot: string, skillId: string): SkillsHeadlineSkillEntry | null {
    const skillRoot = path.join(getLiveSkillsRoot(bundleRoot), skillId);
    if (!pathExists(skillRoot)) {
        return null;
    }

    try {
        const manifest = readBaselineSkillManifest(skillRoot);
        return {
            id: manifest.id,
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
            tags: [...manifest.tags].sort()
        };
    } catch {
        return null;
    }
}

function tryBuildLiveSkillEntry(
    bundleRoot: string,
    skillId: string,
    source: 'installed_optional' | 'custom_live',
    fallbackPackId: string
): SkillsHeadlineSkillEntry | null {
    const skillRoot = path.join(getLiveSkillsRoot(bundleRoot), skillId);
    if (!pathExists(skillRoot)) {
        return null;
    }

    try {
        const manifest = readSkillManifest(skillRoot, fallbackPackId);
        return {
            id: manifest.id,
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
            tags: [...manifest.tags].sort()
        };
    } catch {
        return null;
    }
}

export function getSkillsHeadlinesConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'skills-headlines.json');
}

export function buildSkillsHeadlines(bundleRoot: string): SkillsHeadlinesPayload {
    const builtinPacks = listBuiltinSkillPacks(bundleRoot);
    const installedPackIds = readInstalledPackIds(bundleRoot);
    const installedPackSet = new Set(installedPackIds);
    const installedOptionalSkillIds = builtinPacks
        .filter((pack) => installedPackSet.has(pack.id))
        .flatMap((pack) => pack.skillDirectories)
        .sort();
    const installedOptionalSkillSet = new Set(installedOptionalSkillIds);
    const liveSkillDirectories = listLiveSkillDirectories(bundleRoot);
    const customSkillIds = liveSkillDirectories
        .filter((skillId) => !BASELINE_SKILL_DIRECTORIES.includes(skillId) && !installedOptionalSkillSet.has(skillId))
        .sort();

    const skills = [
        ...BASELINE_SKILL_DIRECTORIES
            .map((skillId) => tryBuildBaselineSkillEntry(bundleRoot, skillId))
            .filter((entry): entry is SkillsHeadlineSkillEntry => entry !== null),
        ...installedOptionalSkillIds
            .map((skillId) => tryBuildLiveSkillEntry(bundleRoot, skillId, 'installed_optional', skillId))
            .filter((entry): entry is SkillsHeadlineSkillEntry => entry !== null),
        ...customSkillIds
            .map((skillId) => tryBuildLiveSkillEntry(bundleRoot, skillId, 'custom_live', 'custom'))
            .filter((entry): entry is SkillsHeadlineSkillEntry => entry !== null)
    ].sort((left, right) => left.id.localeCompare(right.id));

    return {
        version: SKILLS_HEADLINES_VERSION,
        installed_pack_ids: [...installedPackIds],
        baseline_skill_ids: [...BASELINE_SKILL_DIRECTORIES],
        installed_optional_skill_ids: [...installedOptionalSkillIds],
        custom_skill_ids: [...customSkillIds],
        skills,
        optional_packs: builtinPacks
            .map((pack) => toOptionalPackEntry(pack, installedPackIds))
            .sort((left, right) => left.id.localeCompare(right.id))
    };
}

export function writeSkillsHeadlines(bundleRoot: string): string {
    const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);
    ensureDirectory(path.dirname(headlinesPath));
    writeJsonFile(headlinesPath, buildSkillsHeadlines(bundleRoot));
    return headlinesPath;
}

export function ensureSkillsHeadlinesCurrent(bundleRoot: string): SkillsHeadlinesData {
    const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);
    const expected = buildSkillsHeadlines(bundleRoot);

    if (!pathExists(headlinesPath)) {
        ensureDirectory(path.dirname(headlinesPath));
        writeJsonFile(headlinesPath, expected);
        return {
            headlinesPath,
            payload: expected
        };
    }

    try {
        const parsed = readJsonFile(headlinesPath);
        if (JSON.stringify(parsed) === JSON.stringify(expected)) {
            return {
                headlinesPath,
                payload: expected
            };
        }
    } catch {
        // Refresh malformed artifacts from the current live skill surface.
    }

    ensureDirectory(path.dirname(headlinesPath));
    writeJsonFile(headlinesPath, expected);
    return {
        headlinesPath,
        payload: expected
    };
}

export function readSkillsHeadlines(bundleRoot: string): SkillsHeadlinesData {
    const { headlinesPath, payload } = ensureSkillsHeadlinesCurrent(bundleRoot);
    const normalizedPayload = asObjectRecord(payload);
    if (!Array.isArray(normalizedPayload.skills) || !Array.isArray(normalizedPayload.optional_packs)) {
        throw new Error(`Skills headlines have an invalid shape: ${headlinesPath}`);
    }

    return {
        headlinesPath,
        payload: normalizedPayload as unknown as SkillsHeadlinesPayload
    };
}

export function validateSkillsHeadlines(bundleRoot: string) {
    const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);
    const issues: string[] = [];
    const expected = buildSkillsHeadlines(bundleRoot);

    if (!pathExists(headlinesPath)) {
        issues.push(`Skills headlines are missing: ${headlinesPath}`);
        return { headlinesPath, expected, issues, passed: false };
    }

    let parsed: unknown = null;
    try {
        parsed = readJsonFile(headlinesPath);
    } catch {
        issues.push(`Skills headlines are not valid JSON: ${headlinesPath}`);
        return { headlinesPath, expected, issues, passed: false };
    }

    const actualSerialized = JSON.stringify(parsed);
    const expectedSerialized = JSON.stringify(expected);
    if (actualSerialized !== expectedSerialized) {
        issues.push(`Skills headlines are stale: ${headlinesPath}. Re-run init/materialization to refresh them.`);
    }

    return {
        headlinesPath,
        expected,
        issues,
        passed: issues.length === 0
    };
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDirectory, pathExists } from '../core/fs';
import { readJsonFile, writeJsonFile } from '../core/json';

import {
    BASELINE_SKILL_DIRECTORIES,
    asObjectRecord,
    getPackTemplateRoot,
    getBuiltinSkillPackDefinition,
    listBuiltinSkillPacks,
    readBaselineSkillManifest,
    readSkillManifest,
    collectMissingReferenceIssues
} from './skill-manifest';

import {
    getSkillsIndexConfigPath,
    validateSkillsIndex
} from './skill-index';

type JsonObject = Record<string, unknown>;

const REVIEW_CAPABILITY_KEYS = Object.freeze([
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'test',
    'performance',
    'infra',
    'dependency'
] as const);

const OPTIONAL_REVIEW_CAPABILITY_KEYS = Object.freeze([
    'api',
    'test',
    'performance',
    'infra',
    'dependency'
] as const);

type ReviewCapabilityKey = (typeof REVIEW_CAPABILITY_KEYS)[number];
type OptionalReviewCapabilityKey = (typeof OPTIONAL_REVIEW_CAPABILITY_KEYS)[number];
type ReviewCapabilities = Record<ReviewCapabilityKey, boolean>;

interface InstalledSkillPacksPayload {
    version: number;
    installed_packs: string[];
}

interface ReadInstalledSkillPacksResult {
    configPath: string;
    installedPackIds: string[];
}

interface ListedBuiltinPack {
    id: string;
    label: string;
    description: string;
    tags: string[];
    recommendedFor: string[];
    skillCount: number;
    readySkillCount: number;
    readySkillDirectories: string[];
    placeholderSkillCount: number;
    placeholderSkillDirectories: string[];
    implemented: boolean;
    collidesWithBaseline: boolean;
    skillDirectories: string[];
    installed: boolean;
}

export interface SkillPackListing {
    configPath: string;
    indexPath: string;
    baselineSkillDirectories: string[];
    liveSkillDirectories: string[];
    installedPackIds: string[];
    installedOptionalSkillDirectories: string[];
    builtinPacks: ListedBuiltinPack[];
    customSkillDirectories: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INSTALLED_PACKS_PAYLOAD: Readonly<InstalledSkillPacksPayload> = Object.freeze({
    version: 1,
    installed_packs: []
});

const REVIEW_CAPABILITIES_DEFAULTS: Readonly<ReviewCapabilities> = Object.freeze({
    code: true,
    db: true,
    security: true,
    refactor: true,
    api: false,
    test: false,
    performance: false,
    infra: false,
    dependency: false
});

const OPTIONAL_REVIEW_SKILL_DIRECTORY_MAP: Readonly<Record<OptionalReviewCapabilityKey, readonly string[]>> = Object.freeze({
    api: ['api-review', 'api-contract-review'],
    test: ['test-review', 'testing-strategy'],
    performance: ['performance-review'],
    infra: ['infra-review', 'devops-k8s'],
    dependency: ['dependency-review']
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getSkillPacksConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'skill-packs.json');
}

export function getReviewCapabilitiesConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'review-capabilities.json');
}

function getLiveSkillsRoot(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'skills');
}

// ---------------------------------------------------------------------------
// Review capabilities
// ---------------------------------------------------------------------------

function normalizeReviewCapabilitiesConfig(raw: unknown): ReviewCapabilities {
    const normalized = {} as ReviewCapabilities;
    const source = asObjectRecord(raw);

    for (const key of REVIEW_CAPABILITY_KEYS) {
        normalized[key] = key in source ? Boolean(source[key]) : REVIEW_CAPABILITIES_DEFAULTS[key];
    }

    return normalized;
}

function readTemplateReviewCapabilities(bundleRoot: string): ReviewCapabilities {
    const templatePath = path.join(bundleRoot, 'template', 'config', 'review-capabilities.json');
    if (!pathExists(templatePath)) {
        return { ...REVIEW_CAPABILITIES_DEFAULTS };
    }

    try {
        return normalizeReviewCapabilitiesConfig(readJsonFile(templatePath));
    } catch {
        return { ...REVIEW_CAPABILITIES_DEFAULTS };
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

export function syncReviewCapabilities(bundleRoot: string): { configPath: string; capabilities: ReviewCapabilities } {
    const configPath = getReviewCapabilitiesConfigPath(bundleRoot);
    const capabilities = readTemplateReviewCapabilities(bundleRoot);
    const liveSkillDirectorySet = new Set(listLiveSkillDirectories(bundleRoot));

    for (const capabilityKey of OPTIONAL_REVIEW_CAPABILITY_KEYS) {
        const candidateDirectories = OPTIONAL_REVIEW_SKILL_DIRECTORY_MAP[capabilityKey];
        capabilities[capabilityKey] = candidateDirectories.some((candidate: string) => liveSkillDirectorySet.has(candidate));
    }

    ensureDirectory(path.dirname(configPath));
    writeJsonFile(configPath, capabilities);

    return {
        configPath,
        capabilities
    };
}

// ---------------------------------------------------------------------------
// Installed packs CRUD
// ---------------------------------------------------------------------------

function validateInstalledPackIds(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const normalized: string[] = [];
    for (const item of value) {
        const text = String(item || '').trim();
        if (!text || normalized.includes(text)) {
            continue;
        }
        normalized.push(text);
    }

    return normalized.sort();
}

export function readInstalledSkillPacks(bundleRoot: string): ReadInstalledSkillPacksResult {
    const configPath = getSkillPacksConfigPath(bundleRoot);
    if (!pathExists(configPath)) {
        return {
            configPath,
            installedPackIds: []
        };
    }

    const payload = asObjectRecord(readJsonFile(configPath));
    return {
        configPath,
        installedPackIds: validateInstalledPackIds(payload.installed_packs)
    };
}

export function writeInstalledSkillPacks(bundleRoot: string, installedPackIds: unknown): string {
    const configPath = getSkillPacksConfigPath(bundleRoot);
    writeJsonFile(configPath, {
        ...DEFAULT_INSTALLED_PACKS_PAYLOAD,
        installed_packs: validateInstalledPackIds(installedPackIds)
    });
    return configPath;
}

// ---------------------------------------------------------------------------
// Pack listing
// ---------------------------------------------------------------------------

export function listSkillPacks(bundleRoot: string): SkillPackListing {
    const installed = readInstalledSkillPacks(bundleRoot);
    const liveSkillDirectories = listLiveSkillDirectories(bundleRoot);
    const builtinPacks = listBuiltinSkillPacks(bundleRoot);
    const managedPackSkillDirs = new Set<string>();

    for (const packId of installed.installedPackIds) {
        const pack = builtinPacks.find((candidate) => candidate.id === packId);
        if (!pack) {
            continue;
        }
        for (const skillDir of pack.skillDirectories) {
            managedPackSkillDirs.add(skillDir);
        }
    }

    const customSkillDirectories = liveSkillDirectories.filter((skillDir: string) => {
        return !BASELINE_SKILL_DIRECTORIES.includes(skillDir) && !managedPackSkillDirs.has(skillDir);
    });
    const installedOptionalSkillDirectories = liveSkillDirectories.filter((skillDir: string) => managedPackSkillDirs.has(skillDir));

    return {
        configPath: installed.configPath,
        indexPath: getSkillsIndexConfigPath(bundleRoot),
        baselineSkillDirectories: [...BASELINE_SKILL_DIRECTORIES],
        liveSkillDirectories,
        installedPackIds: installed.installedPackIds,
        installedOptionalSkillDirectories,
        builtinPacks: builtinPacks.map((pack) => ({
            id: pack.id,
            label: pack.label,
            description: pack.description,
            tags: pack.tags,
            recommendedFor: pack.recommendedFor,
            skillCount: pack.skillCount,
            readySkillCount: pack.readySkillCount,
            readySkillDirectories: [...pack.readySkillDirectories],
            placeholderSkillCount: pack.placeholderSkillCount,
            placeholderSkillDirectories: [...pack.placeholderSkillDirectories],
            implemented: pack.implemented,
            collidesWithBaseline: pack.collidesWithBaseline,
            skillDirectories: [...pack.skillDirectories],
            installed: installed.installedPackIds.includes(pack.id)
        })),
        customSkillDirectories
    };
}

// ---------------------------------------------------------------------------
// Pack add / remove
// ---------------------------------------------------------------------------

function copyDirectoryRecursive(sourcePath: string, destinationPath: string): void {
    ensureDirectory(destinationPath);
    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
        const sourceEntryPath = path.join(sourcePath, entry.name);
        const destinationEntryPath = path.join(destinationPath, entry.name);
        if (entry.isDirectory()) {
            copyDirectoryRecursive(sourceEntryPath, destinationEntryPath);
        } else {
            ensureDirectory(path.dirname(destinationEntryPath));
            fs.copyFileSync(sourceEntryPath, destinationEntryPath);
        }
    }
}

export function addSkillPack(bundleRoot: string, packId: string) {
    const pack = getBuiltinSkillPackDefinition(bundleRoot, packId);
    if (!pack) {
        throw new Error(`Unknown skill pack '${packId}'.`);
    }

    const templateRoot = getPackTemplateRoot(bundleRoot, packId);
    if (!pathExists(templateRoot)) {
        throw new Error(`Skill pack template is missing: ${templateRoot}`);
    }

    const current = readInstalledSkillPacks(bundleRoot);
    if (current.installedPackIds.includes(packId)) {
        return {
            packId,
            changed: false,
            installedPackIds: current.installedPackIds,
            installedSkillDirectories: [...pack.skillDirectories],
            configPath: current.configPath
        };
    }

    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    ensureDirectory(liveSkillsRoot);

    for (const skillDir of pack.skillDirectories) {
        const sourceSkillDir = path.join(templateRoot, 'skills', skillDir);
        const destinationSkillDir = path.join(liveSkillsRoot, skillDir);
        if (!pathExists(sourceSkillDir)) {
            throw new Error(`Skill pack asset is missing: ${sourceSkillDir}`);
        }
        if (pathExists(destinationSkillDir)) {
            throw new Error(`Cannot install skill pack '${packId}' because '${destinationSkillDir}' already exists.`);
        }
        copyDirectoryRecursive(sourceSkillDir, destinationSkillDir);
    }

    const updatedPackIds = [...current.installedPackIds, packId].sort();
    const configPath = writeInstalledSkillPacks(bundleRoot, updatedPackIds);
    const reviewCapabilities = syncReviewCapabilities(bundleRoot);

    return {
        packId,
        changed: true,
        installedPackIds: updatedPackIds,
        installedSkillDirectories: [...pack.skillDirectories],
        configPath,
        reviewCapabilitiesPath: reviewCapabilities.configPath,
        reviewCapabilities: reviewCapabilities.capabilities
    };
}

export function removeSkillPack(bundleRoot: string, packId: string) {
    const pack = getBuiltinSkillPackDefinition(bundleRoot, packId);
    if (!pack) {
        throw new Error(`Unknown skill pack '${packId}'.`);
    }

    const current = readInstalledSkillPacks(bundleRoot);
    if (!current.installedPackIds.includes(packId)) {
        return {
            packId,
            changed: false,
            removedSkillDirectories: [],
            installedPackIds: current.installedPackIds,
            configPath: current.configPath
        };
    }

    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    const removedSkillDirectories: string[] = [];
    for (const skillDir of pack.skillDirectories) {
        const destinationSkillDir = path.join(liveSkillsRoot, skillDir);
        if (pathExists(destinationSkillDir)) {
            fs.rmSync(destinationSkillDir, { recursive: true, force: true });
            removedSkillDirectories.push(skillDir);
        }
    }

    const updatedPackIds = current.installedPackIds.filter((candidate: string) => candidate !== packId);
    const configPath = writeInstalledSkillPacks(bundleRoot, updatedPackIds);
    const reviewCapabilities = syncReviewCapabilities(bundleRoot);

    return {
        packId,
        changed: true,
        removedSkillDirectories,
        installedPackIds: updatedPackIds,
        configPath,
        reviewCapabilitiesPath: reviewCapabilities.configPath,
        reviewCapabilities: reviewCapabilities.capabilities
    };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function validateSkillPacks(bundleRoot: string) {
    const listing = listSkillPacks(bundleRoot);
    const issues: string[] = [];
    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    const liveSkillsReadmePath = path.join(liveSkillsRoot, 'README.md');

    if (!pathExists(liveSkillsReadmePath)) {
        issues.push(`Live skills README is missing: ${liveSkillsReadmePath}`);
    }

    for (const skillDir of BASELINE_SKILL_DIRECTORIES) {
        const skillRoot = path.join(liveSkillsRoot, skillDir);
        const skillPath = path.join(skillRoot, 'SKILL.md');
        const skillManifestPath = path.join(skillRoot, 'skill.json');

        if (!pathExists(skillRoot)) {
            issues.push(`Baseline skill directory is missing: ${skillRoot}`);
            continue;
        }

        if (!pathExists(skillManifestPath)) {
            issues.push(`Baseline skill '${skillDir}' is missing '${skillDir}/skill.json'.`);
        } else {
            try {
                const manifest = readBaselineSkillManifest(skillRoot);
                if (manifest.id !== skillDir) {
                    issues.push(`Baseline skill '${skillDir}' declares id '${manifest.id}' instead of '${skillDir}'.`);
                }
                issues.push(...collectMissingReferenceIssues(skillRoot, manifest, `Baseline skill '${skillDir}'`));
            } catch (error) {
                issues.push(`Baseline skill '${skillDir}' has an invalid manifest: ${getErrorMessage(error)}`);
            }
        }

        if (!pathExists(skillPath)) {
            issues.push(`Baseline skill '${skillDir}' is missing '${skillDir}/SKILL.md'.`);
        }
    }

    for (const pack of listing.builtinPacks) {
        if (pack.collidesWithBaseline) {
            issues.push(`Optional skill pack '${pack.id}' collides with baseline skill id '${pack.id}'. Optional packs must not duplicate baseline skills.`);
        }
        for (const skillDir of pack.skillDirectories) {
            if (BASELINE_SKILL_DIRECTORIES.includes(skillDir)) {
                issues.push(`Optional skill pack '${pack.id}' includes skill directory '${skillDir}' that duplicates a baseline skill.`);
            }
        }
    }

    for (const packId of listing.installedPackIds) {
        const pack = getBuiltinSkillPackDefinition(bundleRoot, packId);
        if (!pack) {
            issues.push(`Installed skill pack '${packId}' is not a known built-in pack.`);
            continue;
        }

        for (const skillDir of pack.skillDirectories) {
            const skillRoot = path.join(getLiveSkillsRoot(bundleRoot), skillDir);
            const skillPath = path.join(skillRoot, 'SKILL.md');
            const skillManifestPath = path.join(skillRoot, 'skill.json');

            if (!pathExists(skillRoot)) {
                issues.push(`Installed skill pack '${packId}' is missing live skill directory '${skillDir}'.`);
                continue;
            }

            if (!pathExists(skillManifestPath)) {
                issues.push(`Installed skill pack '${packId}' is missing '${skillDir}/skill.json'.`);
            } else {
                try {
                    const manifest = readSkillManifest(skillRoot, packId);
                    if (manifest.id !== skillDir) {
                        issues.push(`Installed skill '${skillDir}' declares id '${manifest.id}' instead of '${skillDir}'.`);
                    }
                    if (manifest.pack !== packId) {
                        issues.push(`Installed skill '${skillDir}' declares pack '${manifest.pack}' instead of '${packId}'.`);
                    }
                    issues.push(...collectMissingReferenceIssues(skillRoot, manifest, `Installed skill '${skillDir}'`));
                } catch (error) {
                    issues.push(`Installed skill '${skillDir}' has an invalid manifest: ${getErrorMessage(error)}`);
                }
            }

            if (!pathExists(skillPath)) {
                issues.push(`Installed skill pack '${packId}' is missing '${skillDir}/SKILL.md'.`);
            }
        }
    }

    const skillsIndexValidation = validateSkillsIndex(bundleRoot);
    issues.push(...skillsIndexValidation.issues);

    return {
        ...listing,
        issues,
        passed: issues.length === 0
    };
}

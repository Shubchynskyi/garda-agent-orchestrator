import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    BUILT_IN_REVIEW_TYPE_IDS,
    REVIEW_CATALOG_SCHEMA_VERSION,
    normalizeReviewCatalog
} from '../../../core/review-catalog';
import {
    normalizeReviewCapabilitiesConfigMap,
    type ReviewCapabilitiesConfigMap
} from '../../../core/review-capabilities';
import { compileReviewDependencyGraph } from '../../../core/review-dependency-graph';
import { analyzeProfileReviewCatalogPolicy } from '../../../policy/profile-review-catalog-policy';
import type { ProfileEntry, ProfilesData } from '../../../policy/profile-resolver';
import {
    validateProfilesConfig,
    validateReviewCapabilitiesConfig
} from '../../../schemas/config-artifacts';
import {
    assertProfileBundleRootOwnership,
    assertProfileBundleRootOwnershipCurrent,
    resolveBundleRoot
} from '../profile/profile-data';
import type { ParsedOptionsRecord } from '../profile/profile-types';
import {
    type ReviewCatalogCommandRoots,
    type ReviewCatalogConfigFile,
    type ReviewCatalogManagedState
} from './review-catalog-types';

const MAX_MANAGED_CONFIG_BYTES = 512 * 1024;
const STABLE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const REVIEW_SKILL_ENTRYPOINT_NAMES = Object.freeze(['SKILL.md', 'skill.json']);

export function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function serializeReviewCatalogManagedConfig(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

export function readReviewCatalogManagedConfigText(filePath: string, required: boolean): string | null {
    if (!fs.existsSync(filePath)) {
        if (required) throw new Error(`Managed review config not found: ${filePath}`);
        return null;
    }
    const identity = fs.lstatSync(filePath);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) {
        throw new Error(`Managed review config must be a unique regular file: ${filePath}`);
    }
    if (identity.size > MAX_MANAGED_CONFIG_BYTES) {
        throw new Error(`Managed review config exceeds ${MAX_MANAGED_CONFIG_BYTES} bytes: ${filePath}`);
    }
    const text = fs.readFileSync(filePath, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_MANAGED_CONFIG_BYTES) {
        throw new Error(`Managed review config exceeds ${MAX_MANAGED_CONFIG_BYTES} bytes: ${filePath}`);
    }
    return text;
}

function parseConfigText(text: string | null, fallback: unknown, label: string): unknown {
    if (text === null) return fallback;
    try {
        return JSON.parse(text);
    } catch (error: unknown) {
        throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function assertConfigDirectoryBoundary(bundleRoot: string, configDir: string): void {
    const liveDir = path.dirname(configDir);
    for (const [directoryPath, label] of [
        [bundleRoot, 'Review catalog bundle root'],
        [liveDir, 'Review catalog live directory'],
        [configDir, 'Review catalog config directory']
    ] as const) {
        const identity = fs.lstatSync(directoryPath);
        if (!identity.isDirectory() || identity.isSymbolicLink()) {
            throw new Error(`${label} must be a real directory.`);
        }
    }
    const realBundleRoot = fs.realpathSync.native(bundleRoot);
    const realConfigDir = fs.realpathSync.native(configDir);
    if (path.resolve(realConfigDir) !== path.resolve(path.join(realBundleRoot, 'live', 'config'))) {
        throw new Error('Review catalog config directory resolves outside the validated bundle.');
    }
}

export function resolveReviewCatalogRoots(options: ParsedOptionsRecord): ReviewCatalogCommandRoots {
    const roots = resolveBundleRoot(options);
    const ownership = assertProfileBundleRootOwnership(roots.targetRoot, roots.bundleRoot);
    assertProfileBundleRootOwnershipCurrent(ownership);
    const configDir = path.join(ownership.bundleRoot, 'live', 'config');
    assertConfigDirectoryBoundary(ownership.bundleRoot, configDir);
    return {
        repoRoot: ownership.repoRoot,
        bundleRoot: ownership.bundleRoot,
        configDir,
        catalogPath: path.join(configDir, 'review-catalog.json'),
        capabilitiesPath: path.join(configDir, 'review-capabilities.json'),
        profilesPath: path.join(configDir, 'profiles.json'),
        workflowConfigPath: path.join(configDir, 'workflow-config.json')
    };
}

export function listInstalledReviewSkillIds(bundleRoot: string): string[] {
    const skillsRoot = path.join(bundleRoot, 'live', 'skills');
    if (!fs.existsSync(skillsRoot)) return [];
    const skillsRootIdentity = fs.lstatSync(skillsRoot);
    if (!skillsRootIdentity.isDirectory() || skillsRootIdentity.isSymbolicLink()) {
        throw new Error('Review skills root must be a real directory.');
    }
    const realSkillsRoot = fs.realpathSync.native(skillsRoot);
    return fs.readdirSync(skillsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name)
        .filter((skillId) => STABLE_ID_PATTERN.test(skillId))
        .filter((skillId) => {
            const skillRoot = path.join(skillsRoot, skillId);
            const skillIdentity = fs.lstatSync(skillRoot);
            if (!skillIdentity.isDirectory() || skillIdentity.isSymbolicLink()) return false;
            const realSkillRoot = fs.realpathSync.native(skillRoot);
            if (path.dirname(realSkillRoot) !== realSkillsRoot) return false;
            return REVIEW_SKILL_ENTRYPOINT_NAMES.some((entrypointName) => {
                const entrypointPath = path.join(skillRoot, entrypointName);
                if (!fs.existsSync(entrypointPath)) return false;
                const entrypointIdentity = fs.lstatSync(entrypointPath);
                if (
                    !entrypointIdentity.isFile()
                    || entrypointIdentity.isSymbolicLink()
                    || entrypointIdentity.nlink !== 1
                ) {
                    return false;
                }
                return path.dirname(fs.realpathSync.native(entrypointPath)) === realSkillRoot;
            });
        })
        .sort((left, right) => left.localeCompare(right));
}

function getAllProfiles(data: ProfilesData): Array<[string, ProfileEntry]> {
    return [
        ...Object.entries(data.built_in_profiles),
        ...Object.entries(data.user_profiles)
    ];
}

export function validateReviewCatalogCombinedConfig(
    catalogConfig: ReviewCatalogConfigFile,
    capabilitiesInput: unknown,
    profilesInput: unknown,
    knownSkillIds: readonly string[]
): Pick<ReviewCatalogManagedState, 'catalog' | 'capabilitiesConfig' | 'capabilities' | 'profiles'> {
    const catalog = normalizeReviewCatalog(catalogConfig, { knownSkillIds });
    const capabilitiesConfig = validateReviewCapabilitiesConfig(capabilitiesInput) as ReviewCapabilitiesConfigMap;
    const capabilities = normalizeReviewCapabilitiesConfigMap(capabilitiesConfig) as ReviewCapabilitiesConfigMap;
    const catalogIds = new Set(catalog.review_types.map(({ id }) => id));
    const unknownCapabilities = Object.keys(capabilitiesConfig).filter((reviewId) => !catalogIds.has(reviewId));
    if (unknownCapabilities.length > 0) {
        throw new Error(`review-capabilities contains unknown catalog review ids: ${unknownCapabilities.join(', ')}.`);
    }
    for (const definition of catalog.review_types) {
        if (!definition.built_in && capabilities[definition.id] !== true) {
            capabilities[definition.id] = false;
        }
    }
    const profiles = validateProfilesConfig(profilesInput) as unknown as ProfilesData;
    const issues: string[] = [];
    for (const [profileName, profile] of getAllProfiles(profiles)) {
        const policy = analyzeProfileReviewCatalogPolicy(
            profileName,
            profile.review_policy,
            capabilities,
            catalog
        );
        issues.push(...policy.issues);
        if (!profile.review_dependency_graph || policy.issues.length > 0) continue;
        const activeLaneIds = policy.policy.lanes.filter(({ active }) => active).map(({ id }) => id);
        try {
            compileReviewDependencyGraph({
                catalogLaneIds: catalog.review_types.map(({ id }) => id),
                activeLaneIds,
                requiredReviewIds: activeLaneIds,
                mode: 'strict_sequential',
                declaration: profile.review_dependency_graph
            });
        } catch (error: unknown) {
            issues.push(`Profile '${profileName}' ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (issues.length > 0) throw new Error(issues.join(' '));
    return { catalog, capabilitiesConfig, capabilities, profiles };
}

export function computeReviewCatalogStateSha256(fileTexts: Readonly<Record<string, string | null>>): string {
    const entries = Object.entries(fileTexts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([filePath, text]) => ({ file_path: filePath.replace(/\\/gu, '/'), exists: text !== null, text_sha256: text === null ? null : sha256Text(text) }));
    return sha256Text(JSON.stringify(entries));
}

export function readReviewCatalogManagedState(roots: ReviewCatalogCommandRoots): ReviewCatalogManagedState {
    const catalogText = readReviewCatalogManagedConfigText(roots.catalogPath, false);
    const capabilitiesText = readReviewCatalogManagedConfigText(roots.capabilitiesPath, true);
    const profilesText = readReviewCatalogManagedConfigText(roots.profilesPath, true);
    const catalogConfig = parseConfigText(catalogText, {
        version: REVIEW_CATALOG_SCHEMA_VERSION,
        custom_review_types: []
    }, 'review-catalog') as ReviewCatalogConfigFile;
    const capabilitiesInput = parseConfigText(capabilitiesText, {}, 'review-capabilities');
    const profilesInput = parseConfigText(profilesText, {}, 'profiles');
    const knownSkillIds = listInstalledReviewSkillIds(roots.bundleRoot);
    const validated = validateReviewCatalogCombinedConfig(catalogConfig, capabilitiesInput, profilesInput, knownSkillIds);
    const fileTexts = {
        [roots.catalogPath]: catalogText,
        [roots.capabilitiesPath]: capabilitiesText,
        [roots.profilesPath]: profilesText
    };
    return {
        roots,
        knownSkillIds,
        catalogExists: catalogText !== null,
        capabilitiesExists: capabilitiesText !== null,
        catalogConfig,
        ...validated,
        fileTexts,
        stateSha256: computeReviewCatalogStateSha256(fileTexts)
    };
}

export function assertCustomReviewId(state: ReviewCatalogManagedState, reviewId: string): void {
    const definition = state.catalog.review_types.find(({ id }) => id === reviewId);
    if (!definition) throw new Error(`Unknown review catalog id '${reviewId}'.`);
    if (definition.built_in || BUILT_IN_REVIEW_TYPE_IDS.includes(reviewId as never)) {
        throw new Error(`Built-in review lane '${reviewId}' is immutable through review-catalog management.`);
    }
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../../core/constants';
import {
    getDefaultReviewCapabilities,
    getOptionalReviewCapabilityDefinitions,
    getOptionalReviewCapabilityKeys,
    hasSkillEntrypoint,
    isOptionalReviewCapabilityKey,
    listKnownReviewSkillDirectories,
    readReviewCapabilitiesConfigFile,
    type OptionalReviewCapabilityKey,
    type ReviewCapabilitiesConfigMap
} from '../../core/review-capabilities';
import { BASELINE_SKILL_DIRECTORIES } from '../../runtime/skill-manifest';
import { validateReviewCapabilitiesConfig } from '../../schemas/config-artifacts';
import {
    buildGuardedCommandHelpText,
    normalizePathValue,
    parseOptions,
    PackageJsonLike
} from './cli-helpers';

type ParsedOptionsRecord = Record<string, string | boolean | string[] | undefined>;

interface ReviewCapabilityRoots {
    targetRoot: string;
    bundleRoot: string;
    configPath: string;
}

interface ReviewCapabilityConfigState {
    config: ReviewCapabilitiesConfigMap;
    exists: boolean;
}

interface ReviewCapabilityStatus {
    capability: OptionalReviewCapabilityKey;
    label: string;
    enabled: boolean;
    candidate_skill_ids: string[];
    matching_live_skill_ids: string[];
    missing_live_skill_ids: string[];
    live_skill_present: boolean;
    github_bridge_relative_path: string;
    github_bridge_present: boolean;
    matching_live_skill_ready: boolean;
    launch_surface_note: string;
}

interface ReviewCapabilityInventory {
    readyLiveSkillDirectorySet: ReadonlySet<string>;
    manualOnlyLiveSkills: string[];
}

interface ReviewCapabilityCommandResultBase {
    scope: 'repo-local';
    target_root: string;
    bundle_root: string;
    config_path: string;
    config_exists: boolean;
    supported_optional_capabilities: OptionalReviewCapabilityKey[];
    enabled_capabilities: OptionalReviewCapabilityKey[];
    disabled_capabilities: OptionalReviewCapabilityKey[];
    available_live_skills: string[];
    manual_only_live_skills: string[];
    capabilities: ReviewCapabilityStatus[];
    visible_summary_line: string;
}

interface ReviewCapabilityShowResult extends ReviewCapabilityCommandResultBase {
    action: 'show';
}

interface ReviewCapabilityMutationResult extends ReviewCapabilityCommandResultBase {
    action: 'enable' | 'disable';
    status: 'CHANGED' | 'NO_CHANGE';
    changed: boolean;
    requested_capabilities: OptionalReviewCapabilityKey[];
    changed_capabilities: OptionalReviewCapabilityKey[];
}

const REVIEW_CAPABILITIES_SHARED_DEFINITIONS = {
    '--target-root': { key: 'targetRoot', type: 'string' },
    '--bundle-root': { key: 'bundleRoot', type: 'string' },
    '--json': { key: 'json', type: 'boolean' }
};

function getLiveSkillsRoot(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'skills');
}

function resolveReviewCapabilityRoots(options: ParsedOptionsRecord): ReviewCapabilityRoots {
    const explicitBundleRoot = typeof options.bundleRoot === 'string'
        ? normalizePathValue(options.bundleRoot)
        : null;
    const targetRoot = typeof options.targetRoot === 'string'
        ? normalizePathValue(options.targetRoot)
        : explicitBundleRoot
            ? path.dirname(explicitBundleRoot)
            : normalizePathValue('.');
    const bundleRoot = explicitBundleRoot ?? path.join(targetRoot, resolveBundleName());
    return {
        targetRoot,
        bundleRoot,
        configPath: path.join(bundleRoot, 'live', 'config', 'review-capabilities.json')
    };
}

function listLiveSkillDirectories(bundleRoot: string): string[] {
    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    if (!fs.existsSync(liveSkillsRoot) || !fs.statSync(liveSkillsRoot).isDirectory()) {
        return [];
    }

    return fs.readdirSync(liveSkillsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

function listBuiltinManagedSkillDirectories(bundleRoot: string): string[] {
    const managedSkillDirectories = new Set<string>(BASELINE_SKILL_DIRECTORIES);
    const templateSkillPacksRoot = path.join(bundleRoot, 'template', 'skill-packs');
    if (!fs.existsSync(templateSkillPacksRoot) || !fs.statSync(templateSkillPacksRoot).isDirectory()) {
        return [...managedSkillDirectories].sort();
    }

    for (const packEntry of fs.readdirSync(templateSkillPacksRoot, { withFileTypes: true })) {
        if (!packEntry.isDirectory()) {
            continue;
        }
        const skillsRoot = path.join(templateSkillPacksRoot, packEntry.name, 'skills');
        if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) {
            continue;
        }
        for (const skillEntry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
            if (skillEntry.isDirectory()) {
                managedSkillDirectories.add(skillEntry.name);
            }
        }
    }

    return [...managedSkillDirectories].sort();
}

function readReviewCapabilitiesState(configPath: string): ReviewCapabilityConfigState {
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
        return {
            config: getDefaultReviewCapabilities() as ReviewCapabilitiesConfigMap,
            exists: false
        };
    }

    return {
        config: readReviewCapabilitiesConfigFile(configPath),
        exists: true
    };
}

function buildVisibleSummaryLine(enabledCapabilities: OptionalReviewCapabilityKey[]): string {
    return `Enabled optional reviews: ${enabledCapabilities.length > 0 ? enabledCapabilities.join(', ') : 'none'}`;
}

function buildCapabilityStatuses(
    roots: ReviewCapabilityRoots,
    config: ReviewCapabilitiesConfigMap,
    inventory: ReviewCapabilityInventory
): ReviewCapabilityStatus[] {
    const definitions = getOptionalReviewCapabilityDefinitions();

    return getOptionalReviewCapabilityKeys().map((capability): ReviewCapabilityStatus => {
        const definition = definitions[capability];
        const matchingLiveSkillIds = definition.candidateSkillIds.filter((skillId) => inventory.readyLiveSkillDirectorySet.has(skillId));
        return {
            capability,
            label: definition.label,
            enabled: config[capability] === true,
            candidate_skill_ids: [...definition.candidateSkillIds],
            matching_live_skill_ids: [...matchingLiveSkillIds],
            missing_live_skill_ids: definition.candidateSkillIds.filter((skillId) => !inventory.readyLiveSkillDirectorySet.has(skillId)),
            live_skill_present: matchingLiveSkillIds.length > 0,
            github_bridge_relative_path: definition.githubBridgeRelativePath,
            github_bridge_present: fs.existsSync(path.join(roots.targetRoot, definition.githubBridgeRelativePath)),
            matching_live_skill_ready: matchingLiveSkillIds.length > 0,
            launch_surface_note: 'Matching live skill is the required enablement surface; a bare directory without SKILL.md or skill.json does not count, and bridge presence is reported separately for bridge-hosted providers.'
        };
    });
}

function buildManualOnlyLiveSkills(bundleRoot: string, readyLiveSkillDirectories: readonly string[]): string[] {
    const knownReviewSkills = new Set(listKnownReviewSkillDirectories());
    const builtinManagedSkills = new Set<string>(listBuiltinManagedSkillDirectories(bundleRoot));

    return readyLiveSkillDirectories.filter((skillId) => {
        return !knownReviewSkills.has(skillId) && !builtinManagedSkills.has(skillId);
    });
}

function buildReviewCapabilityInventory(
    roots: ReviewCapabilityRoots,
    liveSkillDirectories: string[]
): ReviewCapabilityInventory {
    const readyLiveSkillDirectories = liveSkillDirectories.filter((skillId) => {
        return hasSkillEntrypoint(path.join(getLiveSkillsRoot(roots.bundleRoot), skillId));
    });

    return {
        readyLiveSkillDirectorySet: new Set(readyLiveSkillDirectories),
        manualOnlyLiveSkills: buildManualOnlyLiveSkills(roots.bundleRoot, readyLiveSkillDirectories)
    };
}

function buildShowResult(
    roots: ReviewCapabilityRoots,
    state: ReviewCapabilityConfigState,
    liveSkillDirectories: string[],
    inventory = buildReviewCapabilityInventory(roots, liveSkillDirectories)
): ReviewCapabilityShowResult {
    const capabilityStatuses = buildCapabilityStatuses(roots, state.config, inventory);
    const enabledCapabilities = capabilityStatuses
        .filter((status) => status.enabled)
        .map((status) => status.capability);
    const disabledCapabilities = capabilityStatuses
        .filter((status) => !status.enabled)
        .map((status) => status.capability);

    return {
        action: 'show',
        scope: 'repo-local',
        target_root: roots.targetRoot,
        bundle_root: roots.bundleRoot,
        config_path: roots.configPath,
        config_exists: state.exists,
        supported_optional_capabilities: getOptionalReviewCapabilityKeys(),
        enabled_capabilities: enabledCapabilities,
        disabled_capabilities: disabledCapabilities,
        available_live_skills: [...liveSkillDirectories],
        manual_only_live_skills: [...inventory.manualOnlyLiveSkills],
        capabilities: capabilityStatuses,
        visible_summary_line: buildVisibleSummaryLine(enabledCapabilities)
    };
}

function formatReviewCapabilitiesOutput(
    result: ReviewCapabilityShowResult | ReviewCapabilityMutationResult,
    jsonMode: boolean
): string {
    if (jsonMode) {
        return JSON.stringify(result, null, 2);
    }

    const lines: string[] = [];
    lines.push('GARDA_REVIEW_CAPABILITIES');
    lines.push(`Action: ${result.action}`);
    lines.push(`Scope: ${result.scope}`);
    lines.push(`TargetRoot: ${result.target_root}`);
    lines.push(`Bundle: ${result.bundle_root}`);
    lines.push(`ConfigPath: ${result.config_path}`);
    lines.push(`ConfigExists: ${result.config_exists}`);
    lines.push(result.visible_summary_line);
    lines.push(`EnabledCapabilities: ${result.enabled_capabilities.length > 0 ? result.enabled_capabilities.join(', ') : 'none'}`);
    lines.push(`DisabledCapabilities: ${result.disabled_capabilities.length > 0 ? result.disabled_capabilities.join(', ') : 'none'}`);
    lines.push(`AvailableLiveSkills: ${result.available_live_skills.length > 0 ? result.available_live_skills.join(', ') : 'none'}`);
    lines.push(`ManualOnlyLiveSkills: ${result.manual_only_live_skills.length > 0 ? result.manual_only_live_skills.join(', ') : 'none'}`);
    lines.push('Capabilities');
    for (const capability of result.capabilities) {
        const liveSkillLabel = capability.matching_live_skill_ids.length > 0
            ? capability.matching_live_skill_ids.join('|')
            : `missing (${capability.candidate_skill_ids.join('|')})`;
        lines.push(
            `  ${capability.capability}: enabled=${capability.enabled} skill-ready=${capability.matching_live_skill_ready} `
            + `live-skill=${liveSkillLabel} github-bridge=${capability.github_bridge_relative_path} `
            + `[${capability.github_bridge_present ? 'present' : 'missing'}]`
        );
    }
    lines.push('Tip: run "review-capabilities enable <capability>" or "review-capabilities disable <capability>" to change the repo-local optional review mode.');

    if (result.action !== 'show') {
        lines.push(`Status: ${result.status}`);
        lines.push(`RequestedCapabilities: ${result.requested_capabilities.join(', ')}`);
        lines.push(`ChangedCapabilities: ${result.changed_capabilities.length > 0 ? result.changed_capabilities.join(', ') : 'none'}`);
    }

    return lines.join('\n');
}

function writeReviewCapabilitiesConfig(configPath: string, config: ReviewCapabilitiesConfigMap): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const validated = validateReviewCapabilitiesConfig(config);
    fs.writeFileSync(configPath, JSON.stringify(validated, null, 2) + '\n', 'utf8');
}

function parseRequestedCapabilities(
    positionals: string[],
    action: 'enable' | 'disable'
): OptionalReviewCapabilityKey[] {
    const normalized = new Set<OptionalReviewCapabilityKey>();

    for (const positional of positionals) {
        for (const token of String(positional || '').split(/[;,]/)) {
            const candidate = token.trim().toLowerCase();
            if (!candidate) {
                continue;
            }
            if (!isOptionalReviewCapabilityKey(candidate)) {
                throw new Error(
                    `Unsupported review capability '${candidate}' for '${action}'. Allowed values: ${getOptionalReviewCapabilityKeys().join(', ')}.`
                );
            }
            normalized.add(candidate);
        }
    }

    if (normalized.size === 0) {
        throw new Error(
            `Review capability names are required for 'review-capabilities ${action}'. `
            + `Allowed values: ${getOptionalReviewCapabilityKeys().join(', ')}.`
        );
    }

    return getOptionalReviewCapabilityKeys().filter((capability) => normalized.has(capability));
}

function handleShow(options: ParsedOptionsRecord): ReviewCapabilityShowResult {
    const roots = resolveReviewCapabilityRoots(options);
    const state = readReviewCapabilitiesState(roots.configPath);
    const liveSkillDirectories = listLiveSkillDirectories(roots.bundleRoot);
    const inventory = buildReviewCapabilityInventory(roots, liveSkillDirectories);
    const result = buildShowResult(roots, state, liveSkillDirectories, inventory);
    console.log(formatReviewCapabilitiesOutput(result, options.json === true));
    return result;
}

function handleMutation(
    action: 'enable' | 'disable',
    options: ParsedOptionsRecord,
    requestedCapabilities: OptionalReviewCapabilityKey[]
): ReviewCapabilityMutationResult {
    const roots = resolveReviewCapabilityRoots(options);
    const state = readReviewCapabilitiesState(roots.configPath);
    const liveSkillDirectories = listLiveSkillDirectories(roots.bundleRoot);
    const inventory = buildReviewCapabilityInventory(roots, liveSkillDirectories);
    const currentCapabilityStatuses = buildCapabilityStatuses(roots, state.config, inventory);
    const nextConfig = { ...state.config };
    const changedCapabilities: OptionalReviewCapabilityKey[] = [];

    if (action === 'enable') {
        for (const capability of requestedCapabilities) {
            const status = currentCapabilityStatuses.find((candidate) => candidate.capability === capability);
            if (!status || !status.matching_live_skill_ready) {
                const expectedSkills = status ? status.candidate_skill_ids.join(', ') : 'n/a';
                throw new Error(
                    `Cannot enable review capability '${capability}' because no matching live skill is installed. `
                    + `Expected one of: ${expectedSkills}. `
                    + 'A bare directory without SKILL.md or skill.json does not count. '
                    + 'Bridge presence is reported separately because root-entrypoint providers execute the live skill directly.'
                );
            }
        }
    }

    for (const capability of requestedCapabilities) {
        const nextValue = action === 'enable';
        if (nextConfig[capability] !== nextValue) {
            nextConfig[capability] = nextValue;
            changedCapabilities.push(capability);
        }
    }

    const currentSerialized = JSON.stringify(validateReviewCapabilitiesConfig(state.config), null, 2) + '\n';
    const nextSerialized = JSON.stringify(validateReviewCapabilitiesConfig(nextConfig), null, 2) + '\n';
    const changed = !state.exists || nextSerialized !== currentSerialized;

    if (changed) {
        writeReviewCapabilitiesConfig(roots.configPath, nextConfig);
    }

    const nextState: ReviewCapabilityConfigState = {
        config: nextConfig,
        exists: state.exists || changed
    };
    const result: ReviewCapabilityMutationResult = {
        ...buildShowResult(roots, nextState, liveSkillDirectories, inventory),
        action,
        status: changed ? 'CHANGED' : 'NO_CHANGE',
        changed,
        requested_capabilities: requestedCapabilities,
        changed_capabilities: changedCapabilities
    };
    console.log(formatReviewCapabilitiesOutput(result, options.json === true));
    return result;
}

export function handleReviewCapabilities(
    commandArgv: string[],
    packageJson: PackageJsonLike
): ReviewCapabilityShowResult | ReviewCapabilityMutationResult | null {
    const firstArg = String(commandArgv[0] || '').trim();
    const hasExplicitSubcommand = firstArg.length > 0 && !firstArg.startsWith('-');
    const requestedSubcommand = hasExplicitSubcommand ? firstArg : 'show';
    const subcommand = requestedSubcommand === 'list' ? 'show' : requestedSubcommand;
    const subcommandArgv = hasExplicitSubcommand ? commandArgv.slice(1) : commandArgv;
    const { options, positionals } = parseOptions(subcommandArgv, REVIEW_CAPABILITIES_SHARED_DEFINITIONS, {
        allowPositionals: subcommand === 'enable' || subcommand === 'disable',
        maxPositionals: 16
    });

    if (options.help) { console.log(buildGuardedCommandHelpText('review-capabilities')); return null; }
    if (options.version) { console.log(packageJson.version); return null; }

    switch (subcommand) {
        case 'show':
            return handleShow(options as ParsedOptionsRecord);
        case 'enable':
            return handleMutation('enable', options as ParsedOptionsRecord, parseRequestedCapabilities(positionals, 'enable'));
        case 'disable':
            return handleMutation('disable', options as ParsedOptionsRecord, parseRequestedCapabilities(positionals, 'disable'));
        default:
            throw new Error('Unknown review-capabilities action: '
                + `${requestedSubcommand}. Allowed values: show, list, enable, disable.`);
    }
}

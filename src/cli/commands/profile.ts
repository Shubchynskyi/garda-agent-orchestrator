import * as fs from 'node:fs';
import * as path from 'node:path';
import { PRIMARY_CLI_NAME, resolveBundleName } from '../../core/constants';
import { validateProfilesConfig } from '../../schemas/config-artifacts';
import {
    normalizePathValue,
    padRight,
    parseOptions,
    PackageJsonLike,
    printHelp,
    promptSingleSelect,
    promptTextInput,
    supportsInteractivePrompts
} from './cli-helpers';

type ParsedOptionsRecord = Record<string, string | boolean | string[] | undefined>;
type MaybePromise<T> = T | Promise<T>;

function isPromiseLike<T>(value: MaybePromise<T> | void): value is Promise<T> {
    return Boolean(value) && typeof (value as Promise<T>).then === 'function';
}

interface ProfileEntry {
    description: string;
    depth: number;
    review_policy: Record<string, boolean | 'auto'>;
    token_economy: Record<string, boolean>;
    skills: Record<string, boolean>;
}

interface ProfilesData {
    version: number;
    active_profile: string;
    built_in_profiles: Record<string, ProfileEntry>;
    user_profiles: Record<string, ProfileEntry>;
}

const PROFILE_SHARED_DEFINITIONS = {
    '--target-root': { key: 'targetRoot', type: 'string' },
    '--bundle-root': { key: 'bundleRoot', type: 'string' },
    '--json': { key: 'json', type: 'boolean' }
};

const PROFILE_CREATE_DEFINITIONS = {
    ...PROFILE_SHARED_DEFINITIONS,
    '--description': { key: 'description', type: 'string' },
    '--depth': { key: 'depth', type: 'string' },
    '--copy-from': { key: 'copyFrom', type: 'string' }
};

const KNOWN_REVIEW_TYPES = Object.freeze([
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'test',
    'performance',
    'infra',
    'dependency'
]);

const TOKEN_ECONOMY_FIELDS = Object.freeze([
    'enabled',
    'strip_examples',
    'strip_code_blocks',
    'scoped_diffs',
    'compact_reviewer_output'
]);

function resolveBundleRoot(options: ParsedOptionsRecord): { targetRoot: string; bundleRoot: string } {
    const targetRoot = normalizePathValue(typeof options.targetRoot === 'string' ? options.targetRoot : '.');
    const bundleRoot = typeof options.bundleRoot === 'string'
        ? normalizePathValue(options.bundleRoot)
        : path.join(targetRoot, resolveBundleName());
    return { targetRoot, bundleRoot };
}

function resolveProfilesPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'profiles.json');
}

function readProfilesData(profilesPath: string): ProfilesData {
    if (!fs.existsSync(profilesPath)) {
        throw new Error(`Profiles config not found: ${profilesPath}`);
    }
    const raw = fs.readFileSync(profilesPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const validated = validateProfilesConfig(parsed) as unknown as ProfilesData;
    return validated;
}

function writeProfilesData(profilesPath: string, data: ProfilesData): void {
    fs.writeFileSync(profilesPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function isBuiltInProfile(data: ProfilesData, name: string): boolean {
    return Object.hasOwn(data.built_in_profiles, name);
}

function getAllProfileNames(data: ProfilesData): string[] {
    return [
        ...Object.keys(data.built_in_profiles),
        ...Object.keys(data.user_profiles)
    ];
}

function getProfileEntry(data: ProfilesData, name: string): ProfileEntry | null {
    if (Object.hasOwn(data.built_in_profiles, name)) return data.built_in_profiles[name];
    if (Object.hasOwn(data.user_profiles, name)) return data.user_profiles[name];
    return null;
}

// ---------------------------------------------------------------------------
// Output builders
// ---------------------------------------------------------------------------

export function buildProfileListOutput(data: ProfilesData, bundleRoot: string, jsonMode: boolean): string {
    if (jsonMode) {
        return JSON.stringify({
            active_profile: data.active_profile,
            built_in_profiles: Object.keys(data.built_in_profiles),
            user_profiles: Object.keys(data.user_profiles),
            config_path: resolveProfilesPath(bundleRoot)
        }, null, 2);
    }
    const lines: string[] = [];
    lines.push('GARDA_PROFILES');
    lines.push('Action: list');
    lines.push(`Bundle: ${bundleRoot}`);
    lines.push(`ConfigPath: ${resolveProfilesPath(bundleRoot)}`);
    lines.push(`ActiveProfile: ${data.active_profile}`);
    lines.push('');
    lines.push('Built-in Profiles');
    for (const [name, entry] of Object.entries(data.built_in_profiles)) {
        const marker = name === data.active_profile ? '(*) ' : '    ';
        lines.push(`  ${marker}${padRight(name, 16)} depth=${entry.depth} ${entry.description}`);
    }
    const userNames = Object.keys(data.user_profiles);
    if (userNames.length > 0) {
        lines.push('');
        lines.push('User Profiles');
        for (const [name, entry] of Object.entries(data.user_profiles)) {
            const marker = name === data.active_profile ? '(*) ' : '    ';
            lines.push(`  ${marker}${padRight(name, 16)} depth=${entry.depth} ${entry.description}`);
        }
    }
    return lines.join('\n');
}

export function buildProfileCurrentOutput(data: ProfilesData, bundleRoot: string, jsonMode: boolean): string {
    const entry = getProfileEntry(data, data.active_profile);
    if (jsonMode) {
        return JSON.stringify({
            active_profile: data.active_profile,
            is_built_in: isBuiltInProfile(data, data.active_profile),
            entry: entry,
            config_path: resolveProfilesPath(bundleRoot)
        }, null, 2);
    }
    const lines: string[] = [];
    lines.push('GARDA_PROFILES');
    lines.push('Action: current');
    lines.push(`ActiveProfile: ${data.active_profile}`);
    lines.push(`Type: ${isBuiltInProfile(data, data.active_profile) ? 'built-in' : 'user'}`);
    if (entry) {
        lines.push(`Description: ${entry.description}`);
        lines.push(`Depth: ${entry.depth}`);
        lines.push(`ReviewPolicy: ${formatReviewPolicy(entry.review_policy)}`);
        lines.push(`TokenEconomy: ${formatTokenEconomy(entry.token_economy)}`);
        lines.push(`Skills: ${formatSkills(entry.skills)}`);
    }
    return lines.join('\n');
}

export function buildProfileUseOutput(name: string, previous: string, jsonMode: boolean): string {
    if (jsonMode) {
        return JSON.stringify({ action: 'use', previous_profile: previous, active_profile: name, changed: previous !== name }, null, 2);
    }
    const lines: string[] = [];
    lines.push('GARDA_PROFILES');
    lines.push('Action: use');
    lines.push(`PreviousProfile: ${previous}`);
    lines.push(`ActiveProfile: ${name}`);
    lines.push(`Status: ${previous !== name ? 'CHANGED' : 'NO_CHANGE'}`);
    return lines.join('\n');
}

export function buildProfileCreateOutput(name: string, configPath: string, jsonMode: boolean): string {
    if (jsonMode) {
        return JSON.stringify({ action: 'create', profile: name, config_path: configPath }, null, 2);
    }
    const lines: string[] = [];
    lines.push('GARDA_PROFILES');
    lines.push('Action: create');
    lines.push(`Profile: ${name}`);
    lines.push(`ConfigPath: ${configPath}`);
    lines.push('Status: CREATED');
    return lines.join('\n');
}

export function buildProfileDeleteOutput(name: string, configPath: string, jsonMode: boolean): string {
    if (jsonMode) {
        return JSON.stringify({ action: 'delete', profile: name, config_path: configPath }, null, 2);
    }
    const lines: string[] = [];
    lines.push('GARDA_PROFILES');
    lines.push('Action: delete');
    lines.push(`Profile: ${name}`);
    lines.push(`ConfigPath: ${configPath}`);
    lines.push('Status: DELETED');
    return lines.join('\n');
}

export function buildProfileValidateOutput(data: ProfilesData, issues: string[], configPath: string, jsonMode: boolean): string {
    if (jsonMode) {
        return JSON.stringify({
            action: 'validate',
            config_path: configPath,
            profile_count: getAllProfileNames(data).length,
            issue_count: issues.length,
            validation: issues.length === 0 ? 'PASS' : 'FAIL',
            issues
        }, null, 2);
    }
    const lines: string[] = [];
    lines.push('GARDA_PROFILES');
    lines.push('Action: validate');
    lines.push(`ConfigPath: ${configPath}`);
    lines.push(`ProfileCount: ${getAllProfileNames(data).length}`);
    lines.push(`IssueCount: ${issues.length}`);
    lines.push(`Validation: ${issues.length === 0 ? 'PASS' : 'FAIL'}`);
    if (issues.length > 0) {
        lines.push('');
        for (const issue of issues) {
            lines.push(`- ${issue}`);
        }
    }
    return lines.join('\n');
}

function formatReviewPolicy(policy: Record<string, boolean | 'auto'>): string {
    return Object.entries(policy)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ');
}

function formatTokenEconomy(economy: Record<string, boolean>): string {
    return Object.entries(economy)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ');
}

function formatSkills(skills: Record<string, boolean>): string {
    return Object.entries(skills)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ');
}

// ---------------------------------------------------------------------------
// Validation logic
// ---------------------------------------------------------------------------

function validateProfilesIntegrity(data: ProfilesData): string[] {
    const issues: string[] = [];
    const allNames = getAllProfileNames(data);
    if (allNames.length === 0) {
        issues.push('No profiles defined.');
    }
    if (!getProfileEntry(data, data.active_profile)) {
        issues.push(`Active profile '${data.active_profile}' does not match any defined profile.`);
    }
    if (Object.keys(data.built_in_profiles).length === 0) {
        issues.push('At least one built-in profile is required.');
    }
    for (const name of Object.keys(data.user_profiles)) {
        if (Object.hasOwn(data.built_in_profiles, name)) {
            issues.push(`User profile '${name}' conflicts with a built-in profile name.`);
        }
    }
    for (const name of allNames) {
        const entry = getProfileEntry(data, name)!;
        if (entry.depth < 1 || entry.depth > 3) {
            issues.push(`Profile '${name}' has invalid depth ${entry.depth}; must be 1–3.`);
        }
    }
    return issues;
}

// ---------------------------------------------------------------------------
// Profile name validation
// ---------------------------------------------------------------------------

const PROFILE_NAME_PATTERN = /^[a-z](?:[a-z0-9\-]*[a-z0-9])?$/;

function assertValidProfileName(name: string): void {
    if (!PROFILE_NAME_PATTERN.test(name) || name.length > 64) {
        throw new Error(
            `Invalid profile name '${name}'. ` +
            'Profile names must start with a lowercase letter, contain only lowercase letters, digits, and hyphens, ' +
            'must not end with a hyphen, and be 1–64 characters.'
        );
    }
}

function parseStrictDepth(value: string): number {
    if (!/^[123]$/.test(value.trim())) {
        throw new Error('--depth must be 1, 2, or 3.');
    }
    return Number(value.trim());
}

function normalizeReviewPromptValue(value: boolean | 'auto' | undefined): boolean | 'auto' {
    return value === true || value === false ? value : 'auto';
}

function cloneProfileEntry(entry: ProfileEntry): ProfileEntry {
    return JSON.parse(JSON.stringify(entry)) as ProfileEntry;
}

// ---------------------------------------------------------------------------
// Default profile entry
// ---------------------------------------------------------------------------

function buildDefaultProfileEntry(description: string, depth: number): ProfileEntry {
    return {
        description,
        depth,
        review_policy: {
            code: true,
            db: 'auto',
            security: 'auto',
            refactor: 'auto',
            api: 'auto',
            test: 'auto',
            performance: 'auto',
            infra: 'auto',
            dependency: 'auto'
        },
        token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true },
        skills: { auto_suggest: true }
    };
}

function buildPromptReadyProfileEntry(entry: ProfileEntry): ProfileEntry {
    const baseline = buildDefaultProfileEntry(entry.description, entry.depth);
    return {
        description: entry.description,
        depth: entry.depth,
        review_policy: {
            ...baseline.review_policy,
            ...entry.review_policy
        },
        token_economy: {
            ...baseline.token_economy,
            ...entry.token_economy
        },
        skills: {
            ...baseline.skills,
            ...entry.skills
        }
    };
}

function buildSuggestedProfileName(data: ProfilesData): string {
    const base = 'custom-profile';
    let candidate = base;
    let suffix = 2;
    while (getProfileEntry(data, candidate)) {
        candidate = `${base}-${suffix}`;
        suffix += 1;
    }
    return candidate;
}

async function promptBooleanChoice(title: string, currentValue: boolean, trueLabel = 'Yes', falseLabel = 'No'): Promise<boolean> {
    const selected = await promptSingleSelect({
        title,
        defaultLabel: currentValue ? trueLabel : falseLabel,
        options: [
            { label: trueLabel, value: 'true' },
            { label: falseLabel, value: 'false' }
        ],
        defaultValue: currentValue ? 'true' : 'false'
    });
    return selected === 'true';
}

async function promptReviewPolicyChoice(reviewType: string, currentValue: boolean | 'auto'): Promise<boolean | 'auto'> {
    const selected = await promptSingleSelect({
        title: `Review policy: ${reviewType}`,
        defaultLabel: String(currentValue),
        options: [
            { label: 'Auto', value: 'auto' },
            { label: 'Enabled', value: 'true' },
            { label: 'Disabled', value: 'false' }
        ],
        defaultValue: currentValue === 'auto' ? 'auto' : String(currentValue)
    });
    if (selected === 'auto') {
        return 'auto';
    }
    return selected === 'true';
}

async function promptForProfileName(data: ProfilesData): Promise<string> {
    let defaultName = buildSuggestedProfileName(data);
    for (;;) {
        const candidate = await promptTextInput('Enter profile name', defaultName);
        try {
            assertValidProfileName(candidate);
        } catch (error: unknown) {
            console.log(error instanceof Error ? error.message : String(error));
            defaultName = candidate || defaultName;
            continue;
        }
        if (getProfileEntry(data, candidate)) {
            console.log(`Profile '${candidate}' already exists. Choose a different name.`);
            defaultName = buildSuggestedProfileName(data);
            continue;
        }
        return candidate;
    }
}

async function promptForCopyFrom(data: ProfilesData): Promise<string> {
    return promptSingleSelect({
        title: 'Choose base profile',
        defaultLabel: 'Start from default template',
        options: [
            { label: 'Start from default template', value: '' },
            ...getAllProfileNames(data).map((name) => ({
                label: `Copy from ${name}`,
                value: name
            }))
        ],
        defaultValue: ''
    });
}

async function promptForDepth(defaultDepth: number): Promise<number> {
    const selected = await promptSingleSelect({
        title: 'Select profile depth',
        defaultLabel: `Depth ${defaultDepth}`,
        options: [
            { label: '1 - shallow', value: '1' },
            { label: '2 - balanced', value: '2' },
            { label: '3 - strict', value: '3' }
        ],
        defaultValue: String(defaultDepth)
    });
    return parseStrictDepth(selected);
}

async function resolveInteractiveCreateInput(
    data: ProfilesData,
    options: ParsedOptionsRecord
): Promise<{ name: string; entry: ProfileEntry }> {
    const name = await promptForProfileName(data);

    let copyFrom: string | null = null;
    if (typeof options.copyFrom === 'string' && options.copyFrom.trim()) {
        const sourceName = options.copyFrom.trim();
        if (!getProfileEntry(data, sourceName)) {
            throw new Error(`Source profile '${options.copyFrom}' not found for --copy-from.`);
        }
        copyFrom = sourceName;
    } else {
        const selected = await promptForCopyFrom(data);
        copyFrom = selected || null;
    }

    const sourceEntry = copyFrom
        ? buildPromptReadyProfileEntry(cloneProfileEntry(getProfileEntry(data, copyFrom)!))
        : buildDefaultProfileEntry(`User profile: ${name}`, 2);

    let description = typeof options.description === 'string'
        ? options.description.trim()
        : await promptTextInput(
            'Enter profile description',
            copyFrom ? `Copy of ${copyFrom}` : `User profile: ${name}`
        );
    description = description.trim();
    if (!description) {
        throw new Error('--description must not be empty.');
    }

    const depth = typeof options.depth === 'string'
        ? parseStrictDepth(options.depth)
        : await promptForDepth(sourceEntry.depth);

    const entry = buildPromptReadyProfileEntry({
        ...sourceEntry,
        description,
        depth
    });

    const customizeReviewPolicy = await promptBooleanChoice('Customize review policy', true, 'Customize', 'Keep base values');
    if (customizeReviewPolicy) {
        for (const reviewType of KNOWN_REVIEW_TYPES) {
            entry.review_policy[reviewType] = await promptReviewPolicyChoice(
                reviewType,
                normalizeReviewPromptValue(entry.review_policy[reviewType])
            );
        }
    }

    const customizeTokenEconomy = await promptBooleanChoice('Customize token economy', true, 'Customize', 'Keep base values');
    if (customizeTokenEconomy) {
        for (const field of TOKEN_ECONOMY_FIELDS) {
            entry.token_economy[field] = await promptBooleanChoice(
                `Token economy: ${field}`,
                entry.token_economy[field] !== false,
                'Enabled',
                'Disabled'
            );
        }
    }

    const customizeSkills = await promptBooleanChoice('Customize skill behavior', true, 'Customize', 'Keep base values');
    if (customizeSkills) {
        entry.skills.auto_suggest = await promptBooleanChoice(
            'Skills: auto_suggest',
            entry.skills.auto_suggest !== false,
            'Enabled',
            'Disabled'
        );
    }

    return { name, entry };
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

function handleList(options: ParsedOptionsRecord, bundleRoot: string): void {
    const profilesPath = resolveProfilesPath(bundleRoot);
    const data = readProfilesData(profilesPath);
    console.log(buildProfileListOutput(data, bundleRoot, options.json === true));
}

function handleCurrent(options: ParsedOptionsRecord, bundleRoot: string): void {
    const profilesPath = resolveProfilesPath(bundleRoot);
    const data = readProfilesData(profilesPath);
    console.log(buildProfileCurrentOutput(data, bundleRoot, options.json === true));
}

function handleUse(positionals: string[], options: ParsedOptionsRecord, bundleRoot: string): void {
    const name = String(positionals[0] || '').trim();
    if (!name) {
        throw new Error(`Profile name is required for 'profile use'. Usage: ${PRIMARY_CLI_NAME} profile use <name>`);
    }
    const profilesPath = resolveProfilesPath(bundleRoot);
    const data = readProfilesData(profilesPath);
    if (!getProfileEntry(data, name)) {
        throw new Error(
            `Profile '${name}' not found. Available profiles: ${getAllProfileNames(data).join(', ')}`
        );
    }
    const previous = data.active_profile;
    data.active_profile = name;
    writeProfilesData(profilesPath, data);
    console.log(buildProfileUseOutput(name, previous, options.json === true));
}

function handleCreate(positionals: string[], options: ParsedOptionsRecord, bundleRoot: string): MaybePromise<void> {
    const profilesPath = resolveProfilesPath(bundleRoot);
    const data = readProfilesData(profilesPath);

    const name = String(positionals[0] || '').trim();
    if (!name) {
        if (options.json === true) {
            throw new Error('--json is not supported with interactive profile creation. Pass an explicit profile name and flags instead.');
        }
        if (!supportsInteractivePrompts()) {
            throw new Error(
                `Profile name is required for 'profile create'. ` +
                `Run '${PRIMARY_CLI_NAME} profile create' in a TTY terminal for interactive prompts, ` +
                `or pass ${PRIMARY_CLI_NAME} profile create <name> --description "..." [--depth N] [--copy-from <existing>].`
            );
        }
        return (async () => {
            const interactiveInput = await resolveInteractiveCreateInput(data, options);
            data.user_profiles[interactiveInput.name] = interactiveInput.entry;
            writeProfilesData(profilesPath, data);
            console.log(buildProfileCreateOutput(interactiveInput.name, profilesPath, false));
        })();
    }
    assertValidProfileName(name);

    if (getProfileEntry(data, name)) {
        throw new Error(`Profile '${name}' already exists. Use a different name or delete the existing profile first.`);
    }

    let entry: ProfileEntry;
    if (typeof options.copyFrom === 'string') {
        const source = getProfileEntry(data, options.copyFrom);
        if (!source) {
            throw new Error(`Source profile '${options.copyFrom}' not found for --copy-from.`);
        }
        entry = buildPromptReadyProfileEntry(cloneProfileEntry(source));
        if (typeof options.description === 'string') {
            if (!options.description.trim()) {
                throw new Error('--description must not be empty.');
            }
            entry.description = options.description.trim();
        } else {
            entry.description = `Copy of ${options.copyFrom}`;
        }
        if (typeof options.depth === 'string') {
            entry.depth = parseStrictDepth(options.depth);
        }
    } else {
        if (typeof options.description === 'string' && !options.description.trim()) {
            throw new Error('--description must not be empty.');
        }
        const description = typeof options.description === 'string'
            ? options.description.trim()
            : `User profile: ${name}`;
        let depth = 2;
        if (typeof options.depth === 'string') {
            depth = parseStrictDepth(options.depth);
        }
        entry = buildDefaultProfileEntry(description, depth);
    }

    data.user_profiles[name] = entry;
    writeProfilesData(profilesPath, data);
    console.log(buildProfileCreateOutput(name, profilesPath, options.json === true));
}

function handleDelete(positionals: string[], options: ParsedOptionsRecord, bundleRoot: string): void {
    const name = String(positionals[0] || '').trim();
    if (!name) {
        throw new Error(`Profile name is required for 'profile delete'. Usage: ${PRIMARY_CLI_NAME} profile delete <name>`);
    }
    const profilesPath = resolveProfilesPath(bundleRoot);
    const data = readProfilesData(profilesPath);

    if (isBuiltInProfile(data, name)) {
        throw new Error(`Cannot delete built-in profile '${name}'. Built-in profiles are protected from deletion.`);
    }

    if (!Object.hasOwn(data.user_profiles, name)) {
        throw new Error(
            `User profile '${name}' not found. Available user profiles: ${Object.keys(data.user_profiles).join(', ') || 'none'}`
        );
    }

    if (data.active_profile === name) {
        data.active_profile = Object.keys(data.built_in_profiles)[0];
    }

    delete data.user_profiles[name];
    writeProfilesData(profilesPath, data);
    console.log(buildProfileDeleteOutput(name, profilesPath, options.json === true));
}

function handleValidate(options: ParsedOptionsRecord, bundleRoot: string): ProfileValidateResult {
    const profilesPath = resolveProfilesPath(bundleRoot);
    if (!fs.existsSync(profilesPath)) {
        const issues = [`Profiles config not found: ${profilesPath}`];
        const emptyData = { version: 0, active_profile: '', built_in_profiles: {}, user_profiles: {} } as ProfilesData;
        console.log(buildProfileValidateOutput(emptyData, issues, profilesPath, options.json === true));
        return { passed: false, issues };
    }
    let data: ProfilesData;
    try {
        data = readProfilesData(profilesPath);
    } catch (err: unknown) {
        const issues = [err instanceof Error ? err.message : String(err)];
        const emptyData = { version: 0, active_profile: '', built_in_profiles: {}, user_profiles: {} } as ProfilesData;
        console.log(buildProfileValidateOutput(emptyData, issues, profilesPath, options.json === true));
        return { passed: false, issues };
    }
    const issues = validateProfilesIntegrity(data);
    console.log(buildProfileValidateOutput(data, issues, profilesPath, options.json === true));
    return { passed: issues.length === 0, issues };
}

interface ProfileValidateResult {
    passed: boolean;
    issues: string[];
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export function handleProfile(commandArgv: string[], packageJson: PackageJsonLike): MaybePromise<ProfileValidateResult | null> {
    const firstArg = String(commandArgv[0] || '').trim();
    const hasExplicitSubcommand = firstArg.length > 0 && !firstArg.startsWith('-');
    const subcommand = hasExplicitSubcommand ? firstArg : 'list';
    const subcommandArgv = hasExplicitSubcommand ? commandArgv.slice(1) : commandArgv;

    const needsPositional = subcommand === 'use' || subcommand === 'create' || subcommand === 'delete';
    const optionDefinitions = subcommand === 'create'
        ? PROFILE_CREATE_DEFINITIONS
        : PROFILE_SHARED_DEFINITIONS;
    const { options: rawOptions, positionals } = parseOptions(subcommandArgv, optionDefinitions, {
        allowPositionals: needsPositional,
        maxPositionals: 1
    });
    const options = rawOptions as ParsedOptionsRecord;

    if (options.help) { printHelp(packageJson); return null; }
    if (options.version) { console.log(packageJson.version); return null; }

    const { bundleRoot } = resolveBundleRoot(options);

    switch (subcommand) {
        case 'list':
            handleList(options, bundleRoot);
            return null;
        case 'current':
            handleCurrent(options, bundleRoot);
            return null;
        case 'use':
            handleUse(positionals, options, bundleRoot);
            return null;
        case 'create': {
            const createResult = handleCreate(positionals, options, bundleRoot);
            if (isPromiseLike(createResult)) {
                return createResult.then(() => null);
            }
            return null;
        }
        case 'delete':
            handleDelete(positionals, options, bundleRoot);
            return null;
        case 'validate':
            return handleValidate(options, bundleRoot);
        default:
            throw new Error(
                `Unknown profile action: ${subcommand}. Allowed values: list, current, use, create, delete, validate.`
            );
    }
}

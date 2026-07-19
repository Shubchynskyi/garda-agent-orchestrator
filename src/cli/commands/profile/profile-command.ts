import * as fs from 'node:fs';
import * as path from 'node:path';
import { PRIMARY_CLI_NAME } from '../../../core/constants';
import {
    buildGuardedCommandHelpText,
    parseOptions,
    PackageJsonLike,
    supportsInteractivePrompts
} from '../cli-helpers';
import {
    getAllProfileNames,
    getProfileEntry,
    isBuiltInProfile,
    readProfilesData,
    resolveBundleRoot,
    resolveProfilesPath,
    withProfilesDataLock,
    writeProfilesDataUnlocked
} from './profile-data';
import { resolveInteractiveCreateInput } from './profile-interactive';
import {
    assertValidProfileName,
    buildDefaultProfileEntry,
    buildPromptReadyProfileEntry,
    cloneProfileEntry,
    parseStrictDepth,
    validateProfilesIntegrity
} from './profile-model';
import {
    buildProfileCreateOutput,
    buildProfileCurrentOutput,
    buildProfileDeleteOutput,
    buildProfileListOutput,
    buildProfileUseOutput,
    buildProfileValidateOutput
} from './profile-output';
import {
    formatProfileFindingPolicyCommandOutput,
    recoverPendingProfileFindingPolicyAudits,
    runProfileFindingPolicyCommand
} from './profile-finding-policy-mutation';
import { MaybePromise, ParsedOptionsRecord, ProfileEntry, ProfileValidateResult, ProfilesData } from './profile-types';

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

const PROFILE_POLICY_DEFINITIONS = {
    ...PROFILE_SHARED_DEFINITIONS,
    '--preset': { key: 'preset', type: 'string' },
    '--copy-from': { key: 'copyFrom', type: 'string' },
    '--reset': { key: 'reset', type: 'boolean' },
    '--critical': { key: 'critical', type: 'string' },
    '--high': { key: 'high', type: 'string' },
    '--medium': { key: 'medium', type: 'string' },
    '--low': { key: 'low', type: 'string' },
    '--residual-risk': { key: 'residualRisk', type: 'string' },
    '--expected-policy-sha256': { key: 'expectedPolicySha256', type: 'string' },
    '--expected-plan-sha256': { key: 'expectedPlanSha256', type: 'string' },
    '--expected-config-sha256': { key: 'expectedConfigSha256', type: 'string' },
    '--operator-confirmed': { key: 'operatorConfirmed', type: 'string' },
    '--operator-confirmed-at-utc': { key: 'operatorConfirmedAtUtc', type: 'string' }
};

const PROFILE_POLICY_APPLY_ONLY_OPTIONS: Array<{ key: string; flag: string }> = [
    { key: 'expectedPolicySha256', flag: '--expected-policy-sha256' },
    { key: 'expectedPlanSha256', flag: '--expected-plan-sha256' },
    { key: 'expectedConfigSha256', flag: '--expected-config-sha256' },
    { key: 'operatorConfirmed', flag: '--operator-confirmed' },
    { key: 'operatorConfirmedAtUtc', flag: '--operator-confirmed-at-utc' }
];

function isPromiseLike<T>(value: MaybePromise<T> | void): value is Promise<T> {
    return Boolean(value) && typeof (value as Promise<T>).then === 'function';
}

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
    const previous = withProfilesDataLock(profilesPath, () => {
        const data = readProfilesData(profilesPath);
        recoverPendingProfileFindingPolicyAudits(bundleRoot, data);
        if (!getProfileEntry(data, name)) {
            throw new Error(
                `Profile '${name}' not found. Available profiles: ${getAllProfileNames(data).join(', ')}`
            );
        }
        const priorActiveProfile = data.active_profile;
        data.active_profile = name;
        writeProfilesDataUnlocked(profilesPath, data);
        return priorActiveProfile;
    });
    console.log(buildProfileUseOutput(name, previous, options.json === true));
}

function handleCreate(positionals: string[], options: ParsedOptionsRecord, bundleRoot: string): MaybePromise<void> {
    const profilesPath = resolveProfilesPath(bundleRoot);
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
        const promptData = readProfilesData(profilesPath);
        return (async () => {
            const interactiveInput = await resolveInteractiveCreateInput(promptData, options);
            withProfilesDataLock(profilesPath, () => {
                const currentData = readProfilesData(profilesPath);
                recoverPendingProfileFindingPolicyAudits(bundleRoot, currentData);
                if (getProfileEntry(currentData, interactiveInput.name)) {
                    throw new Error(
                        `Profile '${interactiveInput.name}' already exists. ` +
                        'The profiles config changed while interactive input was collected; choose a different name.'
                    );
                }
                if (JSON.stringify(currentData) !== JSON.stringify(promptData)) {
                    throw new Error(
                        'The profiles config changed while interactive input was collected; ' +
                        'restart profile creation so inherited values come from the current source profile.'
                    );
                }
                currentData.user_profiles[interactiveInput.name] = interactiveInput.entry;
                writeProfilesDataUnlocked(profilesPath, currentData);
            });
            console.log(buildProfileCreateOutput(interactiveInput.name, profilesPath, false));
        })();
    }
    withProfilesDataLock(profilesPath, () => {
        const data = readProfilesData(profilesPath);
        recoverPendingProfileFindingPolicyAudits(bundleRoot, data);
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
        writeProfilesDataUnlocked(profilesPath, data);
    });
    console.log(buildProfileCreateOutput(name, profilesPath, options.json === true));
}

function handleDelete(positionals: string[], options: ParsedOptionsRecord, bundleRoot: string): void {
    const name = String(positionals[0] || '').trim();
    if (!name) {
        throw new Error(`Profile name is required for 'profile delete'. Usage: ${PRIMARY_CLI_NAME} profile delete <name>`);
    }
    const profilesPath = resolveProfilesPath(bundleRoot);
    withProfilesDataLock(profilesPath, () => {
        const data = readProfilesData(profilesPath);
        recoverPendingProfileFindingPolicyAudits(bundleRoot, data);
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
        writeProfilesDataUnlocked(profilesPath, data);
    });
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

function handlePolicy(commandArgv: string[]): void {
    if (commandArgv.some((argument) => argument === '--help' || argument === '-h')) {
        console.log(buildGuardedCommandHelpText('profile'));
        return;
    }
    const mode = String(commandArgv[0] || '').trim();
    if (mode !== 'preview' && mode !== 'apply') {
        throw new Error("Profile policy action must be 'preview' or 'apply'.");
    }
    const { options: rawOptions, positionals } = parseOptions(commandArgv.slice(1), PROFILE_POLICY_DEFINITIONS, {
        allowPositionals: true,
        maxPositionals: 1
    });
    const options = rawOptions as ParsedOptionsRecord;
    if (mode === 'preview') {
        const invalidFlags = PROFILE_POLICY_APPLY_ONLY_OPTIONS
            .filter(({ key }) => options[key] !== undefined)
            .map(({ flag }) => flag);
        if (invalidFlags.length > 0) {
            throw new Error(`profile policy preview does not accept apply-only options: ${invalidFlags.join(', ')}.`);
        }
    }
    const targetProfile = String(positionals[0] || '').trim();
    if (!targetProfile) {
        throw new Error(`Profile name is required for 'profile policy ${mode}'.`);
    }
    const { targetRoot, bundleRoot } = resolveBundleRoot(options);
    if (
        typeof options.targetRoot === 'string'
        && typeof options.bundleRoot === 'string'
        && !areEquivalentPaths(path.resolve(targetRoot), path.dirname(path.resolve(bundleRoot)))
    ) {
        throw new Error("Profile policy requires --target-root to be the parent directory of --bundle-root.");
    }
    const payload = runProfileFindingPolicyCommand({
        mode,
        targetProfile,
        parsedOptions: options,
        repoRoot: targetRoot,
        bundleRoot
    });
    console.log(formatProfileFindingPolicyCommandOutput(payload, options.json === true));
}

function areEquivalentPaths(left: string, right: string): boolean {
    if (process.platform !== 'win32') return left === right;
    return left.toLowerCase() === right.toLowerCase();
}

export function handleProfile(commandArgv: string[], packageJson: PackageJsonLike): MaybePromise<ProfileValidateResult | null> {
    const firstArg = String(commandArgv[0] || '').trim();
    const hasExplicitSubcommand = firstArg.length > 0 && !firstArg.startsWith('-');
    const subcommand = hasExplicitSubcommand ? firstArg : 'current';
    const subcommandArgv = hasExplicitSubcommand ? commandArgv.slice(1) : commandArgv;

    if (subcommand === 'policy') {
        handlePolicy(subcommandArgv);
        return null;
    }

    const needsPositional = subcommand === 'use' || subcommand === 'create' || subcommand === 'delete';
    const optionDefinitions = subcommand === 'create'
        ? PROFILE_CREATE_DEFINITIONS
        : PROFILE_SHARED_DEFINITIONS;
    const { options: rawOptions, positionals } = parseOptions(subcommandArgv, optionDefinitions, {
        allowPositionals: needsPositional,
        maxPositionals: 1
    });
    const options = rawOptions as ParsedOptionsRecord;

    if (options.help) { console.log(buildGuardedCommandHelpText('profile')); return null; }
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
                `Unknown profile action: ${subcommand}. Allowed values: list, current, use, create, delete, validate, policy.`
            );
    }
}

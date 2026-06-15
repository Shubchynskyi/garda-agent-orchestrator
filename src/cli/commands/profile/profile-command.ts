import * as fs from 'node:fs';
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
    writeProfilesData
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

export function handleProfile(commandArgv: string[], packageJson: PackageJsonLike): MaybePromise<ProfileValidateResult | null> {
    const firstArg = String(commandArgv[0] || '').trim();
    const hasExplicitSubcommand = firstArg.length > 0 && !firstArg.startsWith('-');
    const subcommand = hasExplicitSubcommand ? firstArg : 'current';
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
                `Unknown profile action: ${subcommand}. Allowed values: list, current, use, create, delete, validate.`
            );
    }
}

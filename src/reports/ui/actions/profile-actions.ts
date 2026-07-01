import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as http from 'node:http';
import {
    assertValidProfileName,
    buildPromptReadyProfileEntry,
    cloneProfileEntry,
    KNOWN_REVIEW_TYPES,
    parseStrictDepth,
    validateProfilesIntegrity
} from '../../../cli/commands/profile/profile-model';
import {
    getProfileEntry,
    isBuiltInProfile,
    readProfilesData,
    resolveProfilesPath,
    writeProfilesData
} from '../../../cli/commands/profile/profile-data';
import type { ProfileEntry, ProfilesData } from '../../../cli/commands/profile/profile-types';
import { joinOrchestratorPath } from '../../../gates/shared/helpers';
import { buildProfilesTab } from '../../report-data-contract';
import { appendUiActionAudit, resolveBundleRoot } from './action-common';
import {
    isValidActionRequestBoundary,
    readJsonBody,
    sendApiError,
    sendJson,
    type LocalUiServerRuntimeOptions
} from './http/action-http-common';

const PROFILE_CONFIRMATION_PHRASE = 'APPLY PROFILE CHANGE';

type ProfileOperation = 'create' | 'select' | 'save' | 'reset' | 'delete';

interface UiProfileRequest {
    operation?: unknown;
    mode?: unknown;
    confirmation?: unknown;
    profile_name?: unknown;
    copy_from?: unknown;
    description?: unknown;
    depth?: unknown;
    review_policy?: unknown;
}

interface ProfileActionPlan {
    operation: ProfileOperation;
    profileName: string;
    changedKeys: string[];
    beforeActiveProfile: string;
    proposedActiveProfile: string;
    command: string;
    apply: () => ProfilesData;
    proposedValue: Record<string, unknown>;
}

function normalizeProfileRequest(payload: unknown): UiProfileRequest {
    return payload && typeof payload === 'object' ? payload as UiProfileRequest : {};
}

function profilesPath(repoRoot: string): string {
    return resolveProfilesPath(resolveBundleRoot(repoRoot));
}

function shippedProfilesPath(repoRoot: string): string {
    return joinOrchestratorPath(path.resolve(repoRoot), path.join('template', 'config', 'profiles.json'));
}

function cloneProfilesData(data: ProfilesData): ProfilesData {
    return JSON.parse(JSON.stringify(data)) as ProfilesData;
}

function normalizeProfileName(value: unknown, fieldName = 'profile_name'): string {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) {
        throw new Error(`${fieldName} is required.`);
    }
    return name;
}

function normalizeDescription(value: unknown, fallback: string): string {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || fallback;
}

function normalizeDepth(value: unknown, fallback: number): number {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    return parseStrictDepth(String(value));
}

function normalizeReviewPolicy(value: unknown, fallback: Record<string, boolean | 'auto'>): Record<string, boolean | 'auto'> {
    const raw = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const normalized: Record<string, boolean | 'auto'> = { ...fallback };
    for (const reviewType of KNOWN_REVIEW_TYPES) {
        const candidate = raw[reviewType] ?? fallback[reviewType] ?? 'auto';
        if (candidate === true || candidate === false || candidate === 'auto') {
            normalized[reviewType] = candidate;
            continue;
        }
        if (candidate === 'true' || candidate === 'required') {
            normalized[reviewType] = true;
            continue;
        }
        if (candidate === 'false' || candidate === 'disabled') {
            normalized[reviewType] = false;
            continue;
        }
        throw new Error(`review_policy.${reviewType} must be required, auto, or disabled.`);
    }
    return normalized;
}

function loadShippedProfiles(repoRoot: string): ProfilesData | null {
    const templatePath = shippedProfilesPath(repoRoot);
    if (!fs.existsSync(templatePath) || !fs.statSync(templatePath).isFile()) {
        return null;
    }
    return readProfilesData(templatePath);
}

function assertProfilesValid(data: ProfilesData): void {
    const issues = validateProfilesIntegrity(data);
    if (issues.length > 0) {
        throw new Error(issues.join(' '));
    }
}

function buildDisplayCommand(plan: Pick<ProfileActionPlan, 'operation' | 'profileName'>): string {
    if (plan.operation === 'select') {
        return `garda profile use ${plan.profileName} --target-root "."`;
    }
    if (plan.operation === 'create') {
        return `garda ui profile create ${plan.profileName}`;
    }
    if (plan.operation === 'delete') {
        return `garda profile delete ${plan.profileName} --target-root "."`;
    }
    if (plan.operation === 'reset') {
        return `garda ui profile reset ${plan.profileName}`;
    }
    return `garda ui profile save ${plan.profileName}`;
}

function buildProfileEntryFromPayload(
    payload: UiProfileRequest,
    sourceEntry: ProfileEntry,
    fallbackDescription: string
): ProfileEntry {
    const prepared = buildPromptReadyProfileEntry(cloneProfileEntry(sourceEntry));
    return {
        ...prepared,
        description: normalizeDescription(payload.description, fallbackDescription || prepared.description),
        depth: normalizeDepth(payload.depth, prepared.depth),
        review_policy: normalizeReviewPolicy(payload.review_policy, prepared.review_policy)
    };
}

function buildCreatePlan(data: ProfilesData, payload: UiProfileRequest): ProfileActionPlan {
    const name = normalizeProfileName(payload.profile_name);
    assertValidProfileName(name);
    if (getProfileEntry(data, name)) {
        throw new Error(`Profile '${name}' already exists.`);
    }
    const copyFrom = typeof payload.copy_from === 'string' && payload.copy_from.trim()
        ? payload.copy_from.trim()
        : data.active_profile;
    const source = getProfileEntry(data, copyFrom);
    if (!source) {
        throw new Error(`Source profile '${copyFrom}' not found.`);
    }
    const entry = buildProfileEntryFromPayload(payload, source, `User profile: ${name}`);
    const proposed = cloneProfilesData(data);
    proposed.user_profiles[name] = entry;
    assertProfilesValid(proposed);
    return {
        operation: 'create',
        profileName: name,
        changedKeys: [`user_profiles.${name}`],
        beforeActiveProfile: data.active_profile,
        proposedActiveProfile: proposed.active_profile,
        command: buildDisplayCommand({ operation: 'create', profileName: name }),
        proposedValue: { name, source: 'user', profile: entry },
        apply: () => proposed
    };
}

function buildSelectPlan(data: ProfilesData, payload: UiProfileRequest): ProfileActionPlan {
    const name = normalizeProfileName(payload.profile_name);
    if (!getProfileEntry(data, name)) {
        throw new Error(`Profile '${name}' not found.`);
    }
    const proposed = cloneProfilesData(data);
    proposed.active_profile = name;
    assertProfilesValid(proposed);
    return {
        operation: 'select',
        profileName: name,
        changedKeys: ['active_profile'],
        beforeActiveProfile: data.active_profile,
        proposedActiveProfile: name,
        command: buildDisplayCommand({ operation: 'select', profileName: name }),
        proposedValue: { active_profile: name },
        apply: () => proposed
    };
}

function buildSavePlan(data: ProfilesData, payload: UiProfileRequest): ProfileActionPlan {
    const name = normalizeProfileName(payload.profile_name);
    const current = getProfileEntry(data, name);
    if (!current) {
        throw new Error(`Profile '${name}' not found.`);
    }
    const sourceKey = isBuiltInProfile(data, name) ? 'built_in_profiles' : 'user_profiles';
    const source = sourceKey === 'built_in_profiles' ? 'built_in' : 'user';
    const entry = buildProfileEntryFromPayload(payload, current, current.description);
    const proposed = cloneProfilesData(data);
    proposed[sourceKey][name] = entry;
    assertProfilesValid(proposed);
    return {
        operation: 'save',
        profileName: name,
        changedKeys: [`${sourceKey}.${name}`],
        beforeActiveProfile: data.active_profile,
        proposedActiveProfile: proposed.active_profile,
        command: buildDisplayCommand({ operation: 'save', profileName: name }),
        proposedValue: { name, source, profile: entry },
        apply: () => proposed
    };
}

function buildResetPlan(repoRoot: string, data: ProfilesData, payload: UiProfileRequest): ProfileActionPlan {
    const name = normalizeProfileName(payload.profile_name);
    if (!isBuiltInProfile(data, name)) {
        throw new Error(`Only built-in profiles can be reset.`);
    }
    const shippedProfiles = loadShippedProfiles(repoRoot);
    const shipped = shippedProfiles?.built_in_profiles[name];
    if (!shipped) {
        throw new Error(`Shipped profile '${name}' not found.`);
    }
    const proposed = cloneProfilesData(data);
    proposed.built_in_profiles[name] = cloneProfileEntry(shipped);
    assertProfilesValid(proposed);
    return {
        operation: 'reset',
        profileName: name,
        changedKeys: [`built_in_profiles.${name}`],
        beforeActiveProfile: data.active_profile,
        proposedActiveProfile: proposed.active_profile,
        command: buildDisplayCommand({ operation: 'reset', profileName: name }),
        proposedValue: { name, source: 'built_in', profile: proposed.built_in_profiles[name] },
        apply: () => proposed
    };
}

function buildDeletePlan(data: ProfilesData, payload: UiProfileRequest): ProfileActionPlan {
    const name = normalizeProfileName(payload.profile_name);
    if (isBuiltInProfile(data, name)) {
        throw new Error(`Built-in profile '${name}' cannot be deleted.`);
    }
    if (!Object.hasOwn(data.user_profiles, name)) {
        throw new Error(`User profile '${name}' not found.`);
    }
    const proposed = cloneProfilesData(data);
    delete proposed.user_profiles[name];
    if (proposed.active_profile === name) {
        proposed.active_profile = Object.keys(proposed.built_in_profiles)[0];
    }
    assertProfilesValid(proposed);
    return {
        operation: 'delete',
        profileName: name,
        changedKeys: ['user_profiles', ...(data.active_profile === name ? ['active_profile'] : [])],
        beforeActiveProfile: data.active_profile,
        proposedActiveProfile: proposed.active_profile,
        command: buildDisplayCommand({ operation: 'delete', profileName: name }),
        proposedValue: { name },
        apply: () => proposed
    };
}

function buildProfileActionPlan(repoRoot: string, payload: UiProfileRequest): ProfileActionPlan {
    const operation = typeof payload.operation === 'string' ? payload.operation.trim() as ProfileOperation : 'save';
    if (!['create', 'select', 'save', 'reset', 'delete'].includes(operation)) {
        throw new Error('Profile operation must be create, select, save, reset, or delete.');
    }
    const data = readProfilesData(profilesPath(repoRoot));
    if (operation === 'create') return buildCreatePlan(data, payload);
    if (operation === 'select') return buildSelectPlan(data, payload);
    if (operation === 'reset') return buildResetPlan(repoRoot, data, payload);
    if (operation === 'delete') return buildDeletePlan(data, payload);
    return buildSavePlan(data, payload);
}

function buildProfileResponsePayload(
    plan: ProfileActionPlan,
    mode: 'preview' | 'execute',
    status: string,
    extras: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        operation: plan.operation,
        profile_name: plan.profileName,
        mode,
        status,
        current_active_profile: plan.beforeActiveProfile,
        proposed_active_profile: plan.proposedActiveProfile,
        proposed_value: plan.proposedValue,
        changed_keys: plan.changedKeys,
        command: plan.command,
        ...extras
    };
}

export function buildUiProfilesPayload(repoRoot: string, actionsEnabled: boolean): Record<string, unknown> {
    return {
        enabled: actionsEnabled,
        ...buildProfilesTab(repoRoot)
    };
}

export async function handleUiProfileRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    if (!options.actionsEnabled) {
        sendApiError(response, 403, 'Profile edits are disabled. Restart with --actions to enable guarded profile changes.', 'profiles_disabled');
        return;
    }
    if (!isValidActionRequestBoundary(request, options)) {
        sendApiError(response, 403, 'Profile request failed origin, token, or content-type validation.', 'action_boundary_rejected');
        return;
    }
    const payload = normalizeProfileRequest(await readJsonBody(request));
    let plan: ProfileActionPlan;
    try {
        plan = buildProfileActionPlan(repoRoot, payload);
    } catch (error) {
        sendApiError(response, 400, error instanceof Error ? error.message : String(error), 'invalid_profile_request');
        return;
    }
    const mode = payload.mode === 'execute' ? 'execute' : 'preview';
    const timestampUtc = new Date().toISOString();
    if (mode === 'preview') {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: timestampUtc,
            action_id: `profile:${plan.operation}:${plan.profileName}`,
            mode,
            status: 'previewed',
            command: plan.command
        });
        sendJson(response, 200, buildProfileResponsePayload(plan, mode, 'previewed', {
            requires_confirmation: true,
            confirmation_phrase: PROFILE_CONFIRMATION_PHRASE,
            audit_path: auditPath
        }));
        return;
    }
    if (payload.confirmation !== PROFILE_CONFIRMATION_PHRASE) {
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: timestampUtc,
            action_id: `profile:${plan.operation}:${plan.profileName}`,
            mode,
            status: 'confirmation_required',
            command: plan.command
        });
        sendJson(response, 409, buildProfileResponsePayload(plan, mode, 'confirmation_required', {
            requires_confirmation: true,
            confirmation_phrase: PROFILE_CONFIRMATION_PHRASE,
            audit_path: auditPath
        }));
        return;
    }

    try {
        writeProfilesData(profilesPath(repoRoot), plan.apply());
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: timestampUtc,
            action_id: `profile:${plan.operation}:${plan.profileName}`,
            mode,
            status: 'executed',
            command: plan.command
        });
        sendJson(response, 200, buildProfileResponsePayload(plan, mode, 'executed', {
            audit_path: auditPath
        }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: timestampUtc,
            action_id: `profile:${plan.operation}:${plan.profileName}`,
            mode,
            status: 'failed_to_apply',
            command: plan.command,
            error: message
        });
        sendJson(response, 500, buildProfileResponsePayload(plan, mode, 'failed_to_apply', {
            error: message,
            audit_path: auditPath
        }));
    }
}

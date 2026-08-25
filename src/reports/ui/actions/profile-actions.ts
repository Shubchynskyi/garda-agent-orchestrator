import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as path from 'node:path';
import {
    assertValidProfileName,
    buildPromptReadyProfileEntry,
    cloneProfileEntry,
    KNOWN_REVIEW_TYPES,
    parseStrictDepth,
    validateProfilesIntegrity
} from '../../../cli/commands/profile/profile-model';
import {
    getCompletedProfilesOperationResult,
    getProfileEntry,
    isBuiltInProfile,
    readProfilesData,
    resolveProfilesPath,
    withProfilesDataLock,
    writeProfilesDataUnlocked
} from '../../../cli/commands/profile/profile-data';
import { recoverPendingProfileFindingPolicyAudits } from '../../../cli/commands/profile/profile-finding-policy-mutation';
import {
    buildProfileFindingPolicyPlan,
    hashProfilesData,
    type ProfileFindingPolicyMutationRequest
} from '../../../cli/commands/profile/profile-finding-policy';
import type { ProfileEntry, ProfilesData } from '../../../cli/commands/profile/profile-types';
import { joinOrchestratorPath } from '../../../gates/shared/helpers';
import {
    REVIEW_FINDING_POLICY_PRESETS,
    resolveReviewFollowUpPolicy,
    type ReviewFollowUpPolicy
} from '../../../policy/profile-resolver';
import {
    buildDefaultReviewRemediationModePolicy,
    validateReviewRemediationModePolicy,
    type ReviewRemediationModePolicy
} from '../../../policy/review-remediation-mode-policy';
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

type ProfileOperation = 'create' | 'select' | 'save' | 'reset' | 'delete' | 'policy';

interface UiProfileRequest {
    operation?: unknown;
    mode?: unknown;
    confirmation?: unknown;
    profile_name?: unknown;
    copy_from?: unknown;
    description?: unknown;
    depth?: unknown;
    task_decomposition?: unknown;
    review_policy?: unknown;
    review_follow_up_policy?: unknown;
    review_remediation_mode_policy?: unknown;
    policy_preset?: unknown;
    policy_copy_from?: unknown;
    policy_reset?: unknown;
    policy_actions?: unknown;
    preview_sha256?: unknown;
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

class ProfileStateConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ProfileStateConflictError';
    }
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

function normalizeTaskDecomposition(
    value: unknown,
    fallback: ProfileEntry['task_decomposition']
): ProfileEntry['task_decomposition'] {
    if (value === undefined) {
        return fallback ? { ...fallback } : undefined;
    }
    if (
        !value
        || typeof value !== 'object'
        || Array.isArray(value)
        || Object.keys(value).length !== 1
        || !Object.hasOwn(value, 'enabled')
        || typeof (value as Record<string, unknown>).enabled !== 'boolean'
    ) {
        throw new Error('task_decomposition must be exactly { "enabled": boolean }.');
    }
    return { enabled: (value as Record<string, unknown>).enabled as boolean };
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

function normalizeReviewFollowUpPolicy(value: unknown, fallback: ReviewFollowUpPolicy): ReviewFollowUpPolicy {
    if (value === undefined) {
        return {
            ...fallback,
            task_profile: { ...fallback.task_profile }
        };
    }
    const resolved = resolveReviewFollowUpPolicy(value, 'local-ui-profile-edit');
    if (resolved.diagnostics.some((diagnostic) => /invalid|malformed/u.test(diagnostic))) {
        throw new Error(resolved.diagnostics.join(' '));
    }
    return {
        ...resolved.policy,
        task_profile: { ...resolved.policy.task_profile }
    };
}

function normalizeReviewRemediationModePolicy(
    value: unknown,
    fallback: ProfileEntry['review_remediation_mode_policy']
): ReviewRemediationModePolicy | undefined {
    if (value === undefined) {
        return fallback
            ? validateReviewRemediationModePolicy(fallback, { allowedReviewTypeIds: KNOWN_REVIEW_TYPES })
            : undefined;
    }
    if (
        !value
        || typeof value !== 'object'
        || Array.isArray(value)
        || Object.keys(value).length !== 1
        || !Object.hasOwn(value, 'delta_eligible_review_types')
    ) {
        throw new Error(
            'review_remediation_mode_policy must be exactly { "delta_eligible_review_types": string[] }.'
        );
    }
    const rawEligibleReviewTypes = (value as Record<string, unknown>).delta_eligible_review_types;
    if (!Array.isArray(rawEligibleReviewTypes) || rawEligibleReviewTypes.some((entry) => typeof entry !== 'string')) {
        throw new Error('review_remediation_mode_policy.delta_eligible_review_types must be a string array.');
    }
    const eligibleReviewTypes = rawEligibleReviewTypes.map((entry) => entry.trim().toLowerCase());
    if (eligibleReviewTypes.some((entry) => !entry)) {
        throw new Error('review_remediation_mode_policy.delta_eligible_review_types cannot contain empty values.');
    }
    const unsupportedReviewTypes = [...new Set(eligibleReviewTypes)]
        .filter((entry) => !KNOWN_REVIEW_TYPES.includes(entry))
        .sort();
    if (unsupportedReviewTypes.length > 0) {
        throw new Error(
            'review_remediation_mode_policy.delta_eligible_review_types contains unsupported review lanes: ' +
            `${unsupportedReviewTypes.join(', ')}.`
        );
    }
    const basePolicy = fallback
        ? validateReviewRemediationModePolicy(fallback, { allowedReviewTypeIds: KNOWN_REVIEW_TYPES })
        : buildDefaultReviewRemediationModePolicy({ allowedReviewTypeIds: KNOWN_REVIEW_TYPES });
    return validateReviewRemediationModePolicy({
        ...basePolicy,
        schema_version: 2,
        delta_eligible_review_types: [...new Set(eligibleReviewTypes)].sort()
    }, { allowedReviewTypeIds: KNOWN_REVIEW_TYPES });
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
    if (plan.operation === 'policy') {
        return `garda profile policy ${plan.profileName} preview --target-root "."`;
    }
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

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function buildFindingPolicyRequest(payload: UiProfileRequest): ProfileFindingPolicyMutationRequest {
    const actions = payload.policy_actions && typeof payload.policy_actions === 'object' && !Array.isArray(payload.policy_actions)
        ? payload.policy_actions as Record<string, unknown>
        : {};
    return {
        targetProfile: normalizeProfileName(payload.profile_name),
        preset: optionalString(payload.policy_preset),
        copyFrom: optionalString(payload.policy_copy_from),
        reset: payload.policy_reset === true,
        critical: optionalString(actions.critical),
        high: optionalString(actions.high),
        medium: optionalString(actions.medium),
        low: optionalString(actions.low),
        residualRisk: optionalString(actions.residual_risk)
    };
}

function buildFindingPolicyPlan(repoRoot: string, data: ProfilesData, payload: UiProfileRequest): ProfileActionPlan {
    const request = buildFindingPolicyRequest(payload);
    const policyPlan = buildProfileFindingPolicyPlan(
        data,
        request,
        request.reset ? loadShippedProfiles(repoRoot) : null
    );
    const sourceKey = isBuiltInProfile(data, request.targetProfile) ? 'built_in_profiles' : 'user_profiles';
    return {
        operation: 'policy',
        profileName: request.targetProfile,
        changedKeys: [`${sourceKey}.${request.targetProfile}.review_finding_policy`],
        beforeActiveProfile: data.active_profile,
        proposedActiveProfile: data.active_profile,
        command: buildDisplayCommand({ operation: 'policy', profileName: request.targetProfile }),
        proposedValue: {
            policy: policyPlan.policy,
            policy_sha256: policyPlan.policy_sha256,
            plan_sha256: policyPlan.plan_sha256,
            source_profile: policyPlan.source_profile,
            changed: policyPlan.changed,
            migration: policyPlan.migration,
            task_effect: {
                scope: 'future_tasks_only',
                active_task_snapshots_changed: false
            }
        },
        apply: () => policyPlan.proposed_data
    };
}

function buildProfileEntryFromPayload(
    payload: UiProfileRequest,
    sourceEntry: ProfileEntry,
    fallbackDescription: string
): ProfileEntry {
    const prepared = buildPromptReadyProfileEntry(cloneProfileEntry(sourceEntry));
    const taskDecomposition = normalizeTaskDecomposition(
        payload.task_decomposition,
        prepared.task_decomposition
    );
    const reviewRemediationModePolicy = normalizeReviewRemediationModePolicy(
        payload.review_remediation_mode_policy,
        prepared.review_remediation_mode_policy
    );
    return {
        ...prepared,
        description: normalizeDescription(payload.description, fallbackDescription || prepared.description),
        depth: normalizeDepth(payload.depth, prepared.depth),
        ...(taskDecomposition ? { task_decomposition: taskDecomposition } : {}),
        review_policy: normalizeReviewPolicy(payload.review_policy, prepared.review_policy),
        review_follow_up_policy: normalizeReviewFollowUpPolicy(
            payload.review_follow_up_policy,
            prepared.review_follow_up_policy || resolveReviewFollowUpPolicy(undefined, 'local-ui-profile-edit').policy
        ),
        ...(reviewRemediationModePolicy
            ? { review_remediation_mode_policy: reviewRemediationModePolicy }
            : {})
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
    if (!['create', 'select', 'save', 'reset', 'delete', 'policy'].includes(operation)) {
        throw new Error('Profile operation must be create, select, save, reset, delete, or policy.');
    }
    const data = readProfilesData(profilesPath(repoRoot));
    if (operation === 'policy') return buildFindingPolicyPlan(repoRoot, data, payload);
    if (operation === 'create') return buildCreatePlan(data, payload);
    if (operation === 'select') return buildSelectPlan(data, payload);
    if (operation === 'reset') return buildResetPlan(repoRoot, data, payload);
    if (operation === 'delete') return buildDeletePlan(data, payload);
    return buildSavePlan(data, payload);
}

function buildProfilePreviewSha256(plan: ProfileActionPlan): string {
    return createHash('sha256').update(JSON.stringify({
        schema_version: 1,
        operation: plan.operation,
        profile_name: plan.profileName,
        proposed_config_sha256: hashProfilesData(plan.apply())
    }), 'utf8').digest('hex');
}

function requirePreviewSha256(value: unknown): string {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!/^[a-f0-9]{64}$/u.test(normalized)) {
        throw new Error('preview_sha256 must be a 64-character SHA-256 hex string from profile preview.');
    }
    return normalized;
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
        finding_policy_presets: REVIEW_FINDING_POLICY_PRESETS,
        finding_policy_actions: ['fix_now', 'create_follow_up', 'ignore'],
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
        const previewSha256 = buildProfilePreviewSha256(plan);
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: timestampUtc,
            action_id: `profile:${plan.operation}:${plan.profileName}`,
            mode,
            status: 'previewed',
            command: plan.command
        });
        sendJson(response, 200, buildProfileResponsePayload(plan, mode, 'previewed', {
            preview_sha256: previewSha256,
            requires_confirmation: true,
            confirmation_phrase: PROFILE_CONFIRMATION_PHRASE,
            audit_path: auditPath
        }));
        return;
    }
    let expectedPreviewSha256: string;
    try {
        expectedPreviewSha256 = requirePreviewSha256(payload.preview_sha256);
    } catch (error) {
        sendApiError(response, 400, error instanceof Error ? error.message : String(error), 'invalid_profile_request');
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
        const bundleRoot = resolveBundleRoot(repoRoot);
        const targetProfilesPath = resolveProfilesPath(bundleRoot);
        let lockReleaseWarning: string | null = null;
        try {
            plan = withProfilesDataLock(targetProfilesPath, () => {
                recoverPendingProfileFindingPolicyAudits(bundleRoot, readProfilesData(targetProfilesPath));
                let lockedPlan: ProfileActionPlan;
                try {
                    lockedPlan = buildProfileActionPlan(repoRoot, payload);
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    throw new ProfileStateConflictError(
                        `Profile state changed after preview; refresh the preview before executing. ${reason}`
                    );
                }
                if (buildProfilePreviewSha256(lockedPlan) !== expectedPreviewSha256) {
                    throw new ProfileStateConflictError('Profile state changed after preview; refresh the preview before executing.');
                }
                writeProfilesDataUnlocked(targetProfilesPath, lockedPlan.apply());
                return lockedPlan;
            });
        } catch (error: unknown) {
            const completed = getCompletedProfilesOperationResult<ProfileActionPlan>(error);
            if (!completed) throw error;
            plan = completed.result;
            lockReleaseWarning = error instanceof Error ? error.message : String(error);
        }
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: timestampUtc,
            action_id: `profile:${plan.operation}:${plan.profileName}`,
            mode,
            status: 'executed',
            command: plan.command,
            ...(lockReleaseWarning ? { warning: lockReleaseWarning } : {})
        });
        sendJson(response, 200, buildProfileResponsePayload(plan, mode, 'executed', {
            audit_path: auditPath,
            ...(lockReleaseWarning ? { warning: lockReleaseWarning } : {})
        }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stateConflict = error instanceof ProfileStateConflictError;
        const auditPath = appendUiActionAudit(repoRoot, {
            timestamp_utc: timestampUtc,
            action_id: `profile:${plan.operation}:${plan.profileName}`,
            mode,
            status: stateConflict ? 'state_conflict' : 'failed_to_apply',
            command: plan.command,
            error: message
        });
        sendJson(response, stateConflict ? 409 : 500, buildProfileResponsePayload(
            plan,
            mode,
            stateConflict ? 'state_conflict' : 'failed_to_apply',
            {
                ...(stateConflict ? { code: 'state_conflict' } : {}),
                error: message,
                audit_path: auditPath
            }
        ));
    }
}

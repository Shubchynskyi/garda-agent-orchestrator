import { createHash } from 'node:crypto';

import {
    isCriticalReviewFindingDispositionAction,
    isReviewFindingDispositionAction,
    isReviewFindingPolicyId,
    resolveReviewFindingPolicy,
    REVIEW_FINDING_POLICY_PRESETS,
    type ReviewFindingDispositionAction,
    type ReviewFindingPolicy
} from '../../../policy/profile-resolver';
import { validateProfilesConfig } from '../../../schemas/config-artifacts';
import { getProfileEntry, isBuiltInProfile } from './profile-data';
import type { ProfileEntry, ProfilesData } from './profile-types';

export type ProfileFindingPolicyOperation = 'inspect' | 'migrate' | 'set' | 'copy' | 'reset';

export interface ProfileFindingPolicyMutationRequest {
    targetProfile: string;
    preset?: string;
    copyFrom?: string;
    reset?: boolean;
    critical?: string;
    high?: string;
    medium?: string;
    low?: string;
    residualRisk?: string;
}

export interface ProfileFindingPolicyMigration {
    required: boolean;
    reason: string;
    target_policy_id: ReviewFindingPolicy['policy_id'];
}

export interface ProfileFindingPolicyProjection {
    policy: ReviewFindingPolicy;
    policy_sha256: string;
    migration: ProfileFindingPolicyMigration;
    diagnostics: string[];
}

export interface ProfileFindingPolicyPlan extends ProfileFindingPolicyProjection {
    operation: ProfileFindingPolicyOperation;
    target_profile: string;
    source_profile: string | null;
    plan_sha256: string;
    before_policy_sha256: string;
    before_config_sha256: string;
    after_config_sha256: string;
    changed: boolean;
    proposed_data: ProfilesData;
}

function sha256Text(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function clonePolicy(policy: ReviewFindingPolicy): ReviewFindingPolicy {
    return {
        schema_version: 1,
        policy_id: policy.policy_id,
        findings: {
            critical: policy.findings.critical,
            high: policy.findings.high,
            medium: policy.findings.medium,
            low: policy.findings.low
        },
        residual_risk: policy.residual_risk
    };
}

function cloneProfilesData(data: ProfilesData): ProfilesData {
    return JSON.parse(JSON.stringify(data)) as ProfilesData;
}

function normalizeProfilesData(data: ProfilesData): ProfilesData {
    return validateProfilesConfig(data) as unknown as ProfilesData;
}

export function hashProfilesData(data: ProfilesData): string {
    return sha256Text(JSON.stringify(normalizeProfilesData(data)));
}

export function hashReviewFindingPolicy(policy: ReviewFindingPolicy): string {
    return sha256Text(JSON.stringify(clonePolicy(policy)));
}

export function buildProfileFindingPolicyProjection(
    profileName: string,
    entry: ProfileEntry
): ProfileFindingPolicyProjection {
    const resolution = resolveReviewFindingPolicy(entry.review_finding_policy, profileName);
    const policy = clonePolicy(resolution.policy);
    const required = entry.review_finding_policy === undefined;
    return {
        policy,
        policy_sha256: hashReviewFindingPolicy(policy),
        migration: {
            required,
            reason: required
                ? resolution.diagnostics.join(' ')
                : 'Persisted review_finding_policy is current.',
            target_policy_id: policy.policy_id
        },
        diagnostics: [...resolution.diagnostics]
    };
}

function normalizeAction(value: string | undefined, flagName: string): ReviewFindingDispositionAction {
    const action = String(value || '').trim();
    if (!isReviewFindingDispositionAction(action)) {
        throw new Error(`${flagName} must be one of: fix_now, create_follow_up, ignore.`);
    }
    return action;
}

function buildPresetPolicy(request: ProfileFindingPolicyMutationRequest): ReviewFindingPolicy {
    const policyId = String(request.preset || '').trim();
    if (!isReviewFindingPolicyId(policyId)) {
        throw new Error('--preset must be one of: soft, balanced, strict, custom.');
    }
    const customValuesPresent = [
        request.critical,
        request.high,
        request.medium,
        request.low,
        request.residualRisk
    ].some((value) => value !== undefined);
    if (policyId !== 'custom') {
        if (customValuesPresent) {
            throw new Error('Finding action flags are allowed only with --preset custom.');
        }
        return clonePolicy(REVIEW_FINDING_POLICY_PRESETS[policyId]);
    }
    const critical = normalizeAction(request.critical, '--critical');
    if (!isCriticalReviewFindingDispositionAction(critical)) {
        throw new Error('--critical is immutable and must be fix_now.');
    }
    return {
        schema_version: 1,
        policy_id: 'custom',
        findings: {
            critical,
            high: normalizeAction(request.high, '--high'),
            medium: normalizeAction(request.medium, '--medium'),
            low: normalizeAction(request.low, '--low')
        },
        residual_risk: normalizeAction(request.residualRisk, '--residual-risk')
    };
}

function resolveResetSource(
    data: ProfilesData,
    shippedData: ProfilesData | null,
    targetProfile: string
): { profileName: string; entry: ProfileEntry } {
    if (isBuiltInProfile(data, targetProfile)) {
        const shippedTarget = shippedData?.built_in_profiles[targetProfile];
        if (!shippedTarget) {
            throw new Error(`Shipped profile '${targetProfile}' not found for --reset.`);
        }
        return { profileName: targetProfile, entry: shippedTarget };
    }
    const shippedBalanced = shippedData?.built_in_profiles.balanced;
    if (!shippedBalanced) {
        throw new Error("Shipped profile 'balanced' not found for deterministic user-profile reset.");
    }
    return { profileName: 'balanced', entry: shippedBalanced };
}

function selectCandidatePolicy(
    data: ProfilesData,
    shippedData: ProfilesData | null,
    request: ProfileFindingPolicyMutationRequest,
    current: ProfileFindingPolicyProjection
): {
    operation: ProfileFindingPolicyOperation;
    sourceProfile: string | null;
    policy: ReviewFindingPolicy;
    sourceDiagnostics: string[];
} {
    const hasActionFlags = [request.critical, request.high, request.medium, request.low, request.residualRisk]
        .some((value) => value !== undefined);
    const mutationSelectors = [
        request.reset === true,
        Boolean(String(request.copyFrom || '').trim()),
        Boolean(String(request.preset || '').trim()) || hasActionFlags
    ].filter(Boolean).length;
    if (mutationSelectors > 1) {
        throw new Error('Use exactly one policy source: --preset, --copy-from, or --reset.');
    }
    if (request.reset === true) {
        const source = resolveResetSource(data, shippedData, request.targetProfile);
        const sourceProjection = buildProfileFindingPolicyProjection(source.profileName, source.entry);
        return {
            operation: 'reset',
            sourceProfile: source.profileName,
            policy: sourceProjection.policy,
            sourceDiagnostics: sourceProjection.diagnostics
        };
    }
    const copyFrom = String(request.copyFrom || '').trim();
    if (copyFrom) {
        const source = getProfileEntry(data, copyFrom);
        if (!source) {
            throw new Error(`Source profile '${copyFrom}' not found for --copy-from.`);
        }
        const sourceProjection = buildProfileFindingPolicyProjection(copyFrom, source);
        return {
            operation: 'copy',
            sourceProfile: copyFrom,
            policy: sourceProjection.policy,
            sourceDiagnostics: sourceProjection.diagnostics
        };
    }
    if (request.preset || hasActionFlags) {
        return { operation: 'set', sourceProfile: null, policy: buildPresetPolicy(request), sourceDiagnostics: [] };
    }
    return {
        operation: current.migration.required ? 'migrate' : 'inspect',
        sourceProfile: null,
        policy: current.policy,
        sourceDiagnostics: []
    };
}

export function buildProfileFindingPolicyPlan(
    dataInput: ProfilesData,
    request: ProfileFindingPolicyMutationRequest,
    shippedDataInput: ProfilesData | null = null
): ProfileFindingPolicyPlan {
    const data = normalizeProfilesData(dataInput);
    const shippedData = shippedDataInput ? normalizeProfilesData(shippedDataInput) : null;
    const targetProfile = String(request.targetProfile || '').trim();
    const target = getProfileEntry(data, targetProfile);
    if (!target) {
        throw new Error(`Profile '${targetProfile}' not found.`);
    }
    const current = buildProfileFindingPolicyProjection(targetProfile, target);
    const selection = selectCandidatePolicy(data, shippedData, { ...request, targetProfile }, current);
    const proposed = cloneProfilesData(data);
    const profileCollection = isBuiltInProfile(data, targetProfile)
        ? proposed.built_in_profiles
        : proposed.user_profiles;
    profileCollection[targetProfile].review_finding_policy = clonePolicy(selection.policy);
    const normalizedProposed = normalizeProfilesData(proposed);
    const policy = clonePolicy(selection.policy);
    const beforeConfigSha256 = hashProfilesData(data);
    const afterConfigSha256 = hashProfilesData(normalizedProposed);
    const planSha256 = sha256Text(JSON.stringify({
        schema_version: 1,
        target_profile: targetProfile,
        operation: selection.operation,
        source_profile: selection.sourceProfile,
        policy,
        after_config_sha256: afterConfigSha256
    }));
    return {
        operation: selection.operation,
        target_profile: targetProfile,
        source_profile: selection.sourceProfile,
        plan_sha256: planSha256,
        policy,
        policy_sha256: hashReviewFindingPolicy(policy),
        before_policy_sha256: current.policy_sha256,
        before_config_sha256: beforeConfigSha256,
        after_config_sha256: afterConfigSha256,
        changed: beforeConfigSha256 !== afterConfigSha256,
        migration: current.migration,
        diagnostics: [...new Set([...current.diagnostics, ...selection.sourceDiagnostics])],
        proposed_data: normalizedProposed
    };
}

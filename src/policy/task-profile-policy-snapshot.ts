import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    LEGACY_REVIEW_EXECUTION_POLICY_MODE,
    REVIEW_EXECUTION_POLICY_MODES,
    buildReviewExecutionPolicySummaryLine,
    type EffectiveReviewExecutionPolicyMode
} from '../core/review-execution-policy';
import { REVIEW_CAPABILITY_KEYS } from '../core/review-capabilities';
import {
    applyProfileGuardrails,
    getProfileEntry,
    loadProfilesData,
    loadReviewCapabilities,
    mergeReviewPolicy,
    resolveConfigPaths,
    type EffectivePolicy,
    type EffectiveReviewPolicy,
    type PathsConfig,
    type ProfileGuardrailOptions,
    type ProfileReviewPolicy,
    type ProfileSkills,
    type ReviewCapabilities,
    type TokenEconomyConfig
} from './profile-resolver';
import {
    resolveTaskProfileSelection,
    type ResolvedTaskProfileSelection,
    type TaskProfileSelectionSummary
} from './task-profile-selection';

export const TASK_PROFILE_POLICY_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface TaskProfileFindingPolicySnapshot {
    schema_version: 1;
    policy_id: 'legacy_strict_review_findings_v1';
    active_findings: {
        critical: 'block_until_resolved';
        high: 'block_until_resolved';
        medium: 'block_until_resolved';
        low: 'block_until_resolved';
    };
    residual_risks: 'block_unless_deferred_with_justification';
    deferred_findings: 'allowed_only_with_justification';
}

export interface TaskProfileRemediationPolicySnapshot {
    schema_version: 1;
    policy_id: 'current_cycle_review_remediation_v1';
    failed_review_requires_rework: true;
    active_findings_require_fix_before_pass: true;
    review_restarts_retain_profile_snapshot: true;
    remediation_restarts_retain_profile_snapshot: true;
}

export interface TaskProfilePolicySnapshotReviewLaneSelection {
    profile_review_policy: ProfileReviewPolicy;
    review_capabilities: ReviewCapabilities;
    effective_review_policy: EffectiveReviewPolicy;
    safety_floors_applied: string[];
}

export interface TaskProfilePolicySnapshotReviewExecutionPolicy {
    mode: EffectiveReviewExecutionPolicyMode;
    configured: boolean;
    visible_summary_line: string;
}

export interface TaskProfilePolicySnapshot {
    schema_version: typeof TASK_PROFILE_POLICY_SNAPSHOT_SCHEMA_VERSION;
    lock_timestamp_utc: string;
    source: TaskProfileSelectionSummary;
    depth: number;
    review_lane_selection: TaskProfilePolicySnapshotReviewLaneSelection;
    review_execution_policy: TaskProfilePolicySnapshotReviewExecutionPolicy;
    finding_policy: TaskProfileFindingPolicySnapshot;
    remediation_policy: TaskProfileRemediationPolicySnapshot;
    token_economy: TokenEconomyConfig;
    skills: ProfileSkills;
    installed_packs: string[];
    paths: PathsConfig;
    resolution_sources: EffectivePolicy['resolution_sources'] & {
        workflow_config: string;
    };
    config_hashes: Record<string, string | null>;
    config_hash: string;
    snapshot_hash: string;
}

export interface BuildTaskProfilePolicySnapshotOptions {
    reviewExecutionPolicyMode: EffectiveReviewExecutionPolicyMode;
    reviewExecutionPolicyConfigured: boolean;
    lockTimestampUtc?: string;
}

export interface TaskProfilePolicySnapshotValidationResult {
    status: 'PASS' | 'MISSING' | 'INVALID' | 'HASH_MISMATCH';
    snapshot: TaskProfilePolicySnapshot | null;
    violations: string[];
}

export interface TaskProfilePolicySnapshotSummary {
    schema_version: typeof TASK_PROFILE_POLICY_SNAPSHOT_SCHEMA_VERSION;
    lock_timestamp_utc: string;
    source: TaskProfileSelectionSummary;
    review_lane_selection: {
        effective_review_policy: EffectiveReviewPolicy;
        safety_floors_applied: string[];
    };
    review_execution_policy: TaskProfilePolicySnapshotReviewExecutionPolicy;
    finding_policy: TaskProfileFindingPolicySnapshot;
    remediation_policy: TaskProfileRemediationPolicySnapshot;
    config_hash: string;
    snapshot_hash: string;
}

const DEFAULT_FINDING_POLICY = {
    schema_version: 1,
    policy_id: 'legacy_strict_review_findings_v1',
    active_findings: {
        critical: 'block_until_resolved',
        high: 'block_until_resolved',
        medium: 'block_until_resolved',
        low: 'block_until_resolved'
    },
    residual_risks: 'block_unless_deferred_with_justification',
    deferred_findings: 'allowed_only_with_justification'
} as const satisfies TaskProfileFindingPolicySnapshot;

const DEFAULT_REMEDIATION_POLICY = {
    schema_version: 1,
    policy_id: 'current_cycle_review_remediation_v1',
    failed_review_requires_rework: true,
    active_findings_require_fix_before_pass: true,
    review_restarts_retain_profile_snapshot: true,
    remediation_restarts_retain_profile_snapshot: true
} as const satisfies TaskProfileRemediationPolicySnapshot;

const FINDING_POLICY_KEYS = [
    'schema_version',
    'policy_id',
    'active_findings',
    'residual_risks',
    'deferred_findings'
] as const;

const ACTIVE_FINDING_SEVERITY_KEYS = ['critical', 'high', 'medium', 'low'] as const;

const REMEDIATION_POLICY_KEYS = [
    'schema_version',
    'policy_id',
    'failed_review_requires_rework',
    'active_findings_require_fix_before_pass',
    'review_restarts_retain_profile_snapshot',
    'remediation_restarts_retain_profile_snapshot'
] as const;

const REVIEW_LANE_SELECTION_KEYS = [
    'profile_review_policy',
    'review_capabilities',
    'effective_review_policy',
    'safety_floors_applied'
] as const;

const REVIEW_EXECUTION_POLICY_KEYS = [
    'mode',
    'configured',
    'visible_summary_line'
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex').toLowerCase();
}

function fileSha256OrNull(filePath: string): string | null {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return null;
        }
        return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toLowerCase();
    } catch {
        return null;
    }
}

function canonicalJsonValue(value: unknown): unknown {
    if (value == null) {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(canonicalJsonValue);
    }
    if (typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            result[key] = canonicalJsonValue((value as Record<string, unknown>)[key]);
        }
        return result;
    }
    if (typeof value === 'string' && value.includes('\\')) {
        return value.replace(/\\/g, '/');
    }
    return value;
}

function canonicalJsonSha256(value: unknown): string {
    return sha256Text(JSON.stringify(canonicalJsonValue(value)));
}

function withoutSnapshotHash(snapshot: TaskProfilePolicySnapshot): Omit<TaskProfilePolicySnapshot, 'snapshot_hash'> {
    const { snapshot_hash: _snapshotHash, ...snapshotBody } = snapshot;
    return snapshotBody;
}

function validateExactKeys(
    value: Record<string, unknown>,
    expectedKeys: readonly string[],
    pathLabel: string,
    violations: string[]
): void {
    for (const key of expectedKeys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            violations.push(`Task profile policy snapshot ${pathLabel}.${key} is required.`);
        }
    }
    for (const key of Object.keys(value)) {
        if (!expectedKeys.includes(key)) {
            violations.push(`Task profile policy snapshot ${pathLabel}.${key} is not allowed by schema version 1.`);
        }
    }
}

function validateLiteral(
    value: unknown,
    expected: string | number | boolean,
    pathLabel: string,
    violations: string[]
): void {
    if (value !== expected) {
        violations.push(`Task profile policy snapshot ${pathLabel} must be ${JSON.stringify(expected)}.`);
    }
}

function isReviewPolicyValue(value: unknown): value is boolean | 'auto' {
    return typeof value === 'boolean' || value === 'auto';
}

function normalizeEffectiveReviewPolicyForSnapshot(policy: EffectiveReviewPolicy): EffectiveReviewPolicy {
    const normalized: EffectiveReviewPolicy = { ...policy };
    for (const [key, value] of Object.entries(normalized)) {
        if (value === 'auto') {
            normalized[key] = false;
        }
    }
    return normalized;
}

function collectExpectedReviewCapabilityKeys(reviewCapabilities: Record<string, unknown>): string[] {
    return [...new Set([
        ...REVIEW_CAPABILITY_KEYS,
        ...Object.keys(reviewCapabilities)
    ])];
}

function validateProfileReviewPolicySnapshot(
    value: unknown,
    expectedReviewCapabilityKeys: readonly string[],
    violations: string[]
): void {
    if (!isPlainRecord(value)) {
        violations.push('Task profile policy snapshot review_lane_selection.profile_review_policy must be a JSON object.');
        return;
    }
    for (const key of expectedReviewCapabilityKeys) {
        if (!isReviewPolicyValue(value[key])) {
            violations.push(
                `Task profile policy snapshot review_lane_selection.profile_review_policy.${key} must be boolean or "auto".`
            );
        }
    }
    for (const [key, policyValue] of Object.entries(value)) {
        if ((REVIEW_CAPABILITY_KEYS as readonly string[]).includes(key)) {
            continue;
        }
        if (!isReviewPolicyValue(policyValue)) {
            violations.push(
                `Task profile policy snapshot review_lane_selection.profile_review_policy.${key} must be boolean or "auto".`
            );
        }
    }
}

function validateReviewCapabilitiesSnapshot(value: unknown, violations: string[]): void {
    if (!isPlainRecord(value)) {
        violations.push('Task profile policy snapshot review_lane_selection.review_capabilities must be a JSON object.');
        return;
    }
    for (const key of REVIEW_CAPABILITY_KEYS) {
        if (typeof value[key] !== 'boolean') {
            violations.push(
                `Task profile policy snapshot review_lane_selection.review_capabilities.${key} must be boolean.`
            );
        }
    }
    for (const [key, capabilityValue] of Object.entries(value)) {
        if ((REVIEW_CAPABILITY_KEYS as readonly string[]).includes(key)) {
            continue;
        }
        if (typeof capabilityValue !== 'boolean') {
            violations.push(
                `Task profile policy snapshot review_lane_selection.review_capabilities.${key} must be boolean.`
            );
        }
    }
}

function validateEffectiveReviewPolicySnapshot(
    value: unknown,
    expectedReviewCapabilityKeys: readonly string[],
    violations: string[]
): void {
    if (!isPlainRecord(value)) {
        violations.push('Task profile policy snapshot review_lane_selection.effective_review_policy must be a JSON object.');
        return;
    }
    for (const key of expectedReviewCapabilityKeys) {
        if (typeof value[key] !== 'boolean') {
            violations.push(
                `Task profile policy snapshot review_lane_selection.effective_review_policy.${key} must be boolean.`
            );
        }
    }
    for (const [key, policyValue] of Object.entries(value)) {
        if ((REVIEW_CAPABILITY_KEYS as readonly string[]).includes(key)) {
            continue;
        }
        if (typeof policyValue !== 'boolean') {
            violations.push(
                `Task profile policy snapshot review_lane_selection.effective_review_policy.${key} must be boolean.`
            );
        }
    }
}

function validateReviewLaneSelectionConsistency(
    profileReviewPolicy: Record<string, unknown>,
    reviewCapabilities: Record<string, unknown>,
    effectiveReviewPolicy: Record<string, unknown>,
    safetyFloorsApplied: unknown,
    violations: string[]
): void {
    const recomputed = mergeReviewPolicy(
        profileReviewPolicy as unknown as ProfileReviewPolicy,
        reviewCapabilities as unknown as ReviewCapabilities,
        true
    );
    const expectedEffectiveReviewPolicy = normalizeEffectiveReviewPolicyForSnapshot(recomputed.merged);
    const reviewKeys = new Set([
        ...Object.keys(expectedEffectiveReviewPolicy),
        ...Object.keys(effectiveReviewPolicy)
    ]);
    for (const key of reviewKeys) {
        if (effectiveReviewPolicy[key] !== expectedEffectiveReviewPolicy[key]) {
            violations.push(
                `Task profile policy snapshot review_lane_selection.effective_review_policy.${key} must match recomputed profile policy.`
            );
        }
    }
    if (Array.isArray(safetyFloorsApplied)) {
        const actualFloors = safetyFloorsApplied.filter((entry): entry is string => typeof entry === 'string');
        if (actualFloors.length === safetyFloorsApplied.length) {
            const expectedJson = JSON.stringify([...recomputed.floorsApplied].sort());
            const actualJson = JSON.stringify([...actualFloors].sort());
            if (actualJson !== expectedJson) {
                violations.push(
                    'Task profile policy snapshot review_lane_selection.safety_floors_applied must match recomputed profile policy.'
                );
            }
        }
    }
}

function validateStringArray(value: unknown, pathLabel: string, violations: string[]): void {
    if (!Array.isArray(value)) {
        violations.push(`Task profile policy snapshot ${pathLabel} must be an array.`);
        return;
    }
    for (let index = 0; index < value.length; index += 1) {
        if (typeof value[index] !== 'string') {
            violations.push(`Task profile policy snapshot ${pathLabel}[${index}] must be a string.`);
        }
    }
}

function validateReviewLaneSelectionSnapshot(value: unknown, violations: string[]): void {
    if (!isPlainRecord(value)) {
        violations.push('Task profile policy snapshot review_lane_selection must be a JSON object.');
        return;
    }
    validateExactKeys(value, REVIEW_LANE_SELECTION_KEYS, 'review_lane_selection', violations);
    validateReviewCapabilitiesSnapshot(value.review_capabilities, violations);
    const expectedReviewCapabilityKeys = isPlainRecord(value.review_capabilities)
        ? collectExpectedReviewCapabilityKeys(value.review_capabilities)
        : REVIEW_CAPABILITY_KEYS;
    validateProfileReviewPolicySnapshot(value.profile_review_policy, expectedReviewCapabilityKeys, violations);
    validateEffectiveReviewPolicySnapshot(value.effective_review_policy, expectedReviewCapabilityKeys, violations);
    validateStringArray(value.safety_floors_applied, 'review_lane_selection.safety_floors_applied', violations);
    if (
        isPlainRecord(value.profile_review_policy)
        && isPlainRecord(value.review_capabilities)
        && isPlainRecord(value.effective_review_policy)
    ) {
        validateReviewLaneSelectionConsistency(
            value.profile_review_policy,
            value.review_capabilities,
            value.effective_review_policy,
            value.safety_floors_applied,
            violations
        );
    }
}

function isReviewExecutionPolicyMode(value: unknown): value is EffectiveReviewExecutionPolicyMode {
    return typeof value === 'string' && (
        (REVIEW_EXECUTION_POLICY_MODES as readonly string[]).includes(value)
        || value === LEGACY_REVIEW_EXECUTION_POLICY_MODE
    );
}

function validateReviewExecutionPolicySnapshot(value: unknown, violations: string[]): void {
    if (!isPlainRecord(value)) {
        violations.push('Task profile policy snapshot review_execution_policy must be a JSON object.');
        return;
    }
    validateExactKeys(value, REVIEW_EXECUTION_POLICY_KEYS, 'review_execution_policy', violations);
    if (!isReviewExecutionPolicyMode(value.mode)) {
        violations.push(
            `Task profile policy snapshot review_execution_policy.mode must be one of ${[
                ...REVIEW_EXECUTION_POLICY_MODES,
                LEGACY_REVIEW_EXECUTION_POLICY_MODE
            ].join(', ')}.`
        );
    }
    if (typeof value.configured !== 'boolean') {
        violations.push('Task profile policy snapshot review_execution_policy.configured must be boolean.');
    }
    if (typeof value.visible_summary_line !== 'string') {
        violations.push('Task profile policy snapshot review_execution_policy.visible_summary_line must be a string.');
    } else if (isReviewExecutionPolicyMode(value.mode)) {
        validateLiteral(
            value.visible_summary_line,
            buildReviewExecutionPolicySummaryLine(value.mode),
            'review_execution_policy.visible_summary_line',
            violations
        );
    }
}

function normalizeProfileReviewPolicyForSnapshot(
    profilePolicy: ProfileReviewPolicy,
    capabilities: ReviewCapabilities
): ProfileReviewPolicy {
    const normalized: ProfileReviewPolicy = { ...profilePolicy };
    for (const key of Object.keys(capabilities)) {
        if (!Object.prototype.hasOwnProperty.call(normalized, key)) {
            normalized[key] = 'auto';
        }
    }
    return normalized;
}

function validateFindingPolicySnapshot(value: unknown, violations: string[]): void {
    if (!isPlainRecord(value)) {
        violations.push('Task profile policy snapshot finding_policy must be a JSON object.');
        return;
    }
    validateExactKeys(value, FINDING_POLICY_KEYS, 'finding_policy', violations);
    validateLiteral(value.schema_version, DEFAULT_FINDING_POLICY.schema_version, 'finding_policy.schema_version', violations);
    validateLiteral(value.policy_id, DEFAULT_FINDING_POLICY.policy_id, 'finding_policy.policy_id', violations);
    if (!isPlainRecord(value.active_findings)) {
        violations.push('Task profile policy snapshot finding_policy.active_findings must be a JSON object.');
    } else {
        validateExactKeys(
            value.active_findings,
            ACTIVE_FINDING_SEVERITY_KEYS,
            'finding_policy.active_findings',
            violations
        );
        for (const severity of ACTIVE_FINDING_SEVERITY_KEYS) {
            validateLiteral(
                value.active_findings[severity],
                DEFAULT_FINDING_POLICY.active_findings[severity],
                `finding_policy.active_findings.${severity}`,
                violations
            );
        }
    }
    validateLiteral(value.residual_risks, DEFAULT_FINDING_POLICY.residual_risks, 'finding_policy.residual_risks', violations);
    validateLiteral(value.deferred_findings, DEFAULT_FINDING_POLICY.deferred_findings, 'finding_policy.deferred_findings', violations);
}

function validateRemediationPolicySnapshot(value: unknown, violations: string[]): void {
    if (!isPlainRecord(value)) {
        violations.push('Task profile policy snapshot remediation_policy must be a JSON object.');
        return;
    }
    validateExactKeys(value, REMEDIATION_POLICY_KEYS, 'remediation_policy', violations);
    validateLiteral(value.schema_version, DEFAULT_REMEDIATION_POLICY.schema_version, 'remediation_policy.schema_version', violations);
    validateLiteral(value.policy_id, DEFAULT_REMEDIATION_POLICY.policy_id, 'remediation_policy.policy_id', violations);
    validateLiteral(
        value.failed_review_requires_rework,
        DEFAULT_REMEDIATION_POLICY.failed_review_requires_rework,
        'remediation_policy.failed_review_requires_rework',
        violations
    );
    validateLiteral(
        value.active_findings_require_fix_before_pass,
        DEFAULT_REMEDIATION_POLICY.active_findings_require_fix_before_pass,
        'remediation_policy.active_findings_require_fix_before_pass',
        violations
    );
    validateLiteral(
        value.review_restarts_retain_profile_snapshot,
        DEFAULT_REMEDIATION_POLICY.review_restarts_retain_profile_snapshot,
        'remediation_policy.review_restarts_retain_profile_snapshot',
        violations
    );
    validateLiteral(
        value.remediation_restarts_retain_profile_snapshot,
        DEFAULT_REMEDIATION_POLICY.remediation_restarts_retain_profile_snapshot,
        'remediation_policy.remediation_restarts_retain_profile_snapshot',
        violations
    );
}

function computeConfigHashes(bundleRoot: string, resolutionSources: EffectivePolicy['resolution_sources']): Record<string, string | null> {
    const workflowConfig = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    return {
        profiles: fileSha256OrNull(resolutionSources.profiles),
        review_capabilities: fileSha256OrNull(resolutionSources.review_capabilities),
        token_economy: fileSha256OrNull(resolutionSources.token_economy),
        skill_packs: fileSha256OrNull(resolutionSources.skill_packs),
        paths: fileSha256OrNull(resolutionSources.paths),
        workflow_config: fileSha256OrNull(workflowConfig)
    };
}

export function computeTaskProfilePolicySnapshotHash(snapshot: TaskProfilePolicySnapshot): string {
    return canonicalJsonSha256(withoutSnapshotHash(snapshot));
}

export function buildTaskProfilePolicySnapshot(
    bundleRoot: string,
    taskProfile: unknown,
    options: BuildTaskProfilePolicySnapshotOptions
): TaskProfilePolicySnapshot {
    const resolvedProfile = resolveTaskProfileSelection(bundleRoot, taskProfile);
    const profileConfigPaths = resolveConfigPaths(bundleRoot);
    const profilesData = loadProfilesData(profileConfigPaths.profiles);
    const profileEntry = getProfileEntry(profilesData, resolvedProfile.selection.effective_profile);
    if (!profileEntry) {
        throw new Error(`Profile '${resolvedProfile.selection.effective_profile}' not found while building task profile policy snapshot.`);
    }

    const reviewCapabilities = loadReviewCapabilities(profileConfigPaths.reviewCapabilities);
    const normalizedProfileReviewPolicy = normalizeProfileReviewPolicyForSnapshot(
        profileEntry.review_policy,
        reviewCapabilities
    );
    const snapshotEffectiveReviewPolicy = normalizeEffectiveReviewPolicyForSnapshot(
        resolvedProfile.effective_policy.review_policy
    );
    const configHashes = computeConfigHashes(bundleRoot, resolvedProfile.effective_policy.resolution_sources);
    const configHash = canonicalJsonSha256(configHashes);
    const body: Omit<TaskProfilePolicySnapshot, 'snapshot_hash'> = {
        schema_version: TASK_PROFILE_POLICY_SNAPSHOT_SCHEMA_VERSION,
        lock_timestamp_utc: options.lockTimestampUtc || new Date().toISOString(),
        source: resolvedProfile.selection,
        depth: resolvedProfile.effective_policy.depth,
        review_lane_selection: {
            profile_review_policy: normalizedProfileReviewPolicy,
            review_capabilities: reviewCapabilities,
            effective_review_policy: snapshotEffectiveReviewPolicy,
            safety_floors_applied: resolvedProfile.effective_policy.safety_floors_applied
        },
        review_execution_policy: {
            mode: options.reviewExecutionPolicyMode,
            configured: options.reviewExecutionPolicyConfigured,
            visible_summary_line: buildReviewExecutionPolicySummaryLine(options.reviewExecutionPolicyMode)
        },
        finding_policy: { ...DEFAULT_FINDING_POLICY, active_findings: { ...DEFAULT_FINDING_POLICY.active_findings } },
        remediation_policy: { ...DEFAULT_REMEDIATION_POLICY },
        token_economy: resolvedProfile.effective_policy.token_economy,
        skills: resolvedProfile.effective_policy.skills,
        installed_packs: resolvedProfile.effective_policy.installed_packs,
        paths: resolvedProfile.effective_policy.paths,
        resolution_sources: {
            ...resolvedProfile.effective_policy.resolution_sources,
            workflow_config: path.join(bundleRoot, 'live', 'config', 'workflow-config.json')
        },
        config_hashes: configHashes,
        config_hash: configHash
    };
    const snapshot = {
        ...body,
        snapshot_hash: ''
    };
    return {
        ...body,
        snapshot_hash: computeTaskProfilePolicySnapshotHash(snapshot)
    };
}

export function validateTaskProfilePolicySnapshot(value: unknown): TaskProfilePolicySnapshotValidationResult {
    if (value == null) {
        return {
            status: 'MISSING',
            snapshot: null,
            violations: ['Task profile policy snapshot is missing.']
        };
    }
    const violations: string[] = [];
    if (!isPlainRecord(value)) {
        return {
            status: 'INVALID',
            snapshot: null,
            violations: ['Task profile policy snapshot must be a JSON object.']
        };
    }
    if (value.schema_version !== TASK_PROFILE_POLICY_SNAPSHOT_SCHEMA_VERSION) {
        violations.push(`Task profile policy snapshot schema_version must be ${TASK_PROFILE_POLICY_SNAPSHOT_SCHEMA_VERSION}.`);
    }
    if (!isSha256(value.snapshot_hash)) {
        violations.push('Task profile policy snapshot snapshot_hash must be a SHA-256 hex string.');
    }
    if (!isSha256(value.config_hash)) {
        violations.push('Task profile policy snapshot config_hash must be a SHA-256 hex string.');
    }
    if (!isPlainRecord(value.source)) {
        violations.push('Task profile policy snapshot source must be a JSON object.');
    }
    validateReviewLaneSelectionSnapshot(value.review_lane_selection, violations);
    validateReviewExecutionPolicySnapshot(value.review_execution_policy, violations);
    validateFindingPolicySnapshot(value.finding_policy, violations);
    validateRemediationPolicySnapshot(value.remediation_policy, violations);
    if (!isPlainRecord(value.config_hashes)) {
        violations.push('Task profile policy snapshot config_hashes must be a JSON object.');
    }
    if (!isPlainRecord(value.resolution_sources)) {
        violations.push('Task profile policy snapshot resolution_sources must be a JSON object.');
    }
    const lockTimestamp = String(value.lock_timestamp_utc || '').trim();
    if (!lockTimestamp || Number.isNaN(Date.parse(lockTimestamp))) {
        violations.push('Task profile policy snapshot lock_timestamp_utc must be a valid timestamp.');
    }
    if (violations.length > 0) {
        return {
            status: 'INVALID',
            snapshot: null,
            violations
        };
    }

    const snapshot = value as unknown as TaskProfilePolicySnapshot;
    const expectedConfigHash = canonicalJsonSha256(snapshot.config_hashes);
    if (snapshot.config_hash !== expectedConfigHash) {
        return {
            status: 'HASH_MISMATCH',
            snapshot: null,
            violations: [
                `Task profile policy snapshot config_hash mismatch. Expected ${expectedConfigHash}, got ${snapshot.config_hash}.`
            ]
        };
    }
    const expectedSnapshotHash = computeTaskProfilePolicySnapshotHash(snapshot);
    if (snapshot.snapshot_hash !== expectedSnapshotHash) {
        return {
            status: 'HASH_MISMATCH',
            snapshot: null,
            violations: [
                `Task profile policy snapshot hash mismatch. Expected ${expectedSnapshotHash}, got ${snapshot.snapshot_hash}.`
            ]
        };
    }
    return {
        status: 'PASS',
        snapshot,
        violations: []
    };
}

export function resolveTaskProfileSelectionFromSnapshot(
    snapshot: TaskProfilePolicySnapshot,
    scopeCategory: string | null = null,
    options: ProfileGuardrailOptions = {}
): ResolvedTaskProfileSelection {
    const guardrailDiagnostics = scopeCategory
        ? applyProfileGuardrails(
            snapshot.review_lane_selection.profile_review_policy,
            snapshot.review_lane_selection.review_capabilities,
            scopeCategory,
            snapshot.source.effective_profile,
            options
        )
        : null;
    const reviewPolicy: EffectiveReviewPolicy = { ...snapshot.review_lane_selection.effective_review_policy };
    if (guardrailDiagnostics) {
        for (const decision of guardrailDiagnostics.decisions) {
            reviewPolicy[decision.review_type] = decision.effective_value;
        }
    }

    return {
        selection: { ...snapshot.source },
        effective_policy: {
            profile_name: snapshot.source.effective_profile,
            profile_source: snapshot.source.effective_profile_source,
            depth: snapshot.depth,
            review_policy: reviewPolicy,
            token_economy: snapshot.token_economy,
            skills: snapshot.skills,
            installed_packs: snapshot.installed_packs,
            paths: snapshot.paths,
            safety_floors_applied: guardrailDiagnostics
                ? guardrailDiagnostics.safety_floors_applied
                : snapshot.review_lane_selection.safety_floors_applied,
            scope_category: scopeCategory,
            guardrail_diagnostics: guardrailDiagnostics,
            resolution_sources: {
                profiles: snapshot.resolution_sources.profiles,
                review_capabilities: snapshot.resolution_sources.review_capabilities,
                token_economy: snapshot.resolution_sources.token_economy,
                skill_packs: snapshot.resolution_sources.skill_packs,
                paths: snapshot.resolution_sources.paths
            }
        }
    };
}

export function summarizeTaskProfilePolicySnapshot(
    snapshot: TaskProfilePolicySnapshot
): TaskProfilePolicySnapshotSummary {
    return {
        schema_version: snapshot.schema_version,
        lock_timestamp_utc: snapshot.lock_timestamp_utc,
        source: snapshot.source,
        review_lane_selection: {
            effective_review_policy: snapshot.review_lane_selection.effective_review_policy,
            safety_floors_applied: snapshot.review_lane_selection.safety_floors_applied
        },
        review_execution_policy: snapshot.review_execution_policy,
        finding_policy: snapshot.finding_policy,
        remediation_policy: snapshot.remediation_policy,
        config_hash: snapshot.config_hash,
        snapshot_hash: snapshot.snapshot_hash
    };
}

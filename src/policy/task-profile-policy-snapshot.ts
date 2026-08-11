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
    normalizeReviewDependencyGraphDeclaration,
    type ReviewDependencyGraphDeclaration
} from '../core/review-dependency-graph';
import {
    FULL_SUITE_VALIDATION_PLACEMENTS,
    type FullSuiteValidationPlacement
} from '../core/workflow-config';
import {
    applyProfileGuardrails,
    getProfileEntry,
    loadProfilesData,
    loadReviewCapabilities,
    mergeReviewPolicy,
    DEFAULT_REVIEW_FOLLOW_UP_POLICY,
    REVIEW_FINDING_POLICY_PRESETS,
    resolveReviewFollowUpTaskProfileAssignment,
    resolveConfigPaths,
    type EffectivePolicy,
    type EffectiveReviewPolicy,
    type PathsConfig,
    type ProfileGuardrailOptions,
    type ProfileReviewPolicy,
    type ProfileSkills,
    type ReviewFindingPolicy,
    type ReviewFollowUpPolicy,
    type ReviewFollowUpTaskProfileAssignment,
    type ReviewCapabilities,
    type TokenEconomyConfig
} from './profile-resolver';
import {
    resolveTaskProfileSelection,
    type ResolvedTaskProfileSelection,
    type TaskProfileSelectionSummary
} from './task-profile-selection';
import {
    normalizeReviewTriggerPolicyFromPaths,
    validateReviewTriggerPolicy,
    type ReviewTriggerPolicy
} from './review-trigger-policy';
import {
    buildDefaultReviewRemediationRerunPolicy,
    getReviewRemediationRerunPolicyViolations,
    resolveReviewRemediationRerunPolicyFromSnapshot,
    type ReviewRemediationRerunPolicy
} from './review-remediation-rerun-policy';

export const TASK_PROFILE_POLICY_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type TaskProfileActiveFindingDisposition = 'block_until_resolved' | 'create_follow_up' | 'ignore';
export type TaskProfileResidualRiskDisposition = 'block_unless_deferred_with_justification' | 'create_follow_up' | 'ignore';

export interface TaskProfileFindingPolicySnapshot {
    schema_version: 1;
    policy_id: 'profile_review_finding_dispositions_v1';
    active_findings: {
        critical: 'block_until_resolved';
        high: TaskProfileActiveFindingDisposition;
        medium: TaskProfileActiveFindingDisposition;
        low: TaskProfileActiveFindingDisposition;
    };
    residual_risks: TaskProfileResidualRiskDisposition;
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
    review_dependency_graph?: ReviewDependencyGraphDeclaration | null;
    full_suite_validation?: {
        enabled: boolean;
        placement: FullSuiteValidationPlacement;
    };
}

export interface TaskProfilePolicySnapshot {
    schema_version: typeof TASK_PROFILE_POLICY_SNAPSHOT_SCHEMA_VERSION;
    lock_timestamp_utc: string;
    source: TaskProfileSelectionSummary;
    depth: number;
    review_lane_selection: TaskProfilePolicySnapshotReviewLaneSelection;
    review_execution_policy: TaskProfilePolicySnapshotReviewExecutionPolicy;
    review_finding_policy: ReviewFindingPolicy;
    review_finding_policy_diagnostics: string[];
    review_follow_up_policy?: ReviewFollowUpPolicy;
    review_follow_up_policy_diagnostics?: string[];
    review_follow_up_task_profile_assignment?: ReviewFollowUpTaskProfileAssignment;
    review_remediation_rerun_policy?: ReviewRemediationRerunPolicy;
    review_remediation_rerun_policy_diagnostics?: string[];
    finding_policy: TaskProfileFindingPolicySnapshot;
    remediation_policy: TaskProfileRemediationPolicySnapshot;
    token_economy: TokenEconomyConfig;
    skills: ProfileSkills;
    installed_packs: string[];
    paths: PathsConfig;
    review_trigger_policy?: ReviewTriggerPolicy;
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
    fullSuiteValidationEnabled?: boolean;
    fullSuiteValidationPlacement?: FullSuiteValidationPlacement;
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
    review_finding_policy: ReviewFindingPolicy;
    review_finding_policy_diagnostics: string[];
    review_follow_up_policy: ReviewFollowUpPolicy;
    review_follow_up_policy_diagnostics: string[];
    review_follow_up_task_profile_assignment: ReviewFollowUpTaskProfileAssignment;
    review_remediation_rerun_policy: ReviewRemediationRerunPolicy;
    review_remediation_rerun_policy_diagnostics: string[];
    finding_policy: TaskProfileFindingPolicySnapshot;
    remediation_policy: TaskProfileRemediationPolicySnapshot;
    review_trigger_policy: ReviewTriggerPolicy;
    config_hash: string;
    snapshot_hash: string;
}

const DEFAULT_FINDING_POLICY = {
    schema_version: 1,
    policy_id: 'profile_review_finding_dispositions_v1',
    active_findings: {
        critical: 'block_until_resolved',
        high: 'block_until_resolved',
        medium: 'block_until_resolved',
        low: 'block_until_resolved'
    },
    residual_risks: 'block_unless_deferred_with_justification',
    deferred_findings: 'allowed_only_with_justification'
} as const satisfies TaskProfileFindingPolicySnapshot;

const LEGACY_STRICT_FINDING_POLICY_ID = 'legacy_strict_review_findings_v1';
const LEGACY_REVIEW_FINDING_POLICY_DIAGNOSTIC =
    'Legacy task profile policy snapshot missing review_finding_policy; resolved fail-closed to strict.';
const REVIEW_REMEDIATION_RERUN_POLICY_DIAGNOSTIC =
    'Snapshotted baseline-bound remediation rerun policy with deterministic affected-review lane selection.';

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

const REVIEW_FINDING_POLICY_KEYS = [
    'schema_version',
    'policy_id',
    'findings',
    'residual_risk'
] as const;

const REVIEW_FINDING_POLICY_IDS = ['soft', 'balanced', 'strict', 'custom'] as const;
const REVIEW_FINDING_POLICY_ACTIONS = ['fix_now', 'create_follow_up', 'ignore'] as const;
const REVIEW_FOLLOW_UP_MATERIALIZATION_MODES = ['per_finding', 'grouped_by_parent'] as const;
const ACTIVE_FINDING_DISPOSITIONS = ['block_until_resolved', 'create_follow_up', 'ignore'] as const;
const RESIDUAL_RISK_DISPOSITIONS = ['block_unless_deferred_with_justification', 'create_follow_up', 'ignore'] as const;

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

const CURRENT_REVIEW_EXECUTION_POLICY_KEYS = [
    ...REVIEW_EXECUTION_POLICY_KEYS,
    'review_dependency_graph',
    'full_suite_validation'
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

function withoutSnapshotHash(snapshot: Record<string, unknown>): Omit<Record<string, unknown>, 'snapshot_hash'> {
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
    for (const reviewType of Object.keys(recomputed.merged)) {
        if (!(REVIEW_CAPABILITY_KEYS as readonly string[]).includes(reviewType)) {
            // Custom catalog lanes remain compatibility-inactive in task mode;
            // their task/scope selection is resolved and frozen by preflight.
            recomputed.merged[reviewType] = false;
        }
    }
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
    const hasCurrentGraphContract = Object.prototype.hasOwnProperty.call(value, 'review_dependency_graph')
        || Object.prototype.hasOwnProperty.call(value, 'full_suite_validation');
    validateExactKeys(
        value,
        hasCurrentGraphContract ? CURRENT_REVIEW_EXECUTION_POLICY_KEYS : REVIEW_EXECUTION_POLICY_KEYS,
        'review_execution_policy',
        violations
    );
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
    if (hasCurrentGraphContract) {
        if (value.review_dependency_graph !== null) {
            try {
                normalizeReviewDependencyGraphDeclaration(
                    value.review_dependency_graph,
                    'review_execution_policy.review_dependency_graph'
                );
            } catch (error) {
                violations.push(error instanceof Error ? error.message : String(error));
            }
        }
        if (!isPlainRecord(value.full_suite_validation)) {
            violations.push('Task profile policy snapshot review_execution_policy.full_suite_validation must be a JSON object.');
        } else {
            validateExactKeys(
                value.full_suite_validation,
                ['enabled', 'placement'],
                'review_execution_policy.full_suite_validation',
                violations
            );
            if (typeof value.full_suite_validation.enabled !== 'boolean') {
                violations.push(
                    'Task profile policy snapshot review_execution_policy.full_suite_validation.enabled must be boolean.'
                );
            }
            if (!FULL_SUITE_VALIDATION_PLACEMENTS.includes(
                value.full_suite_validation.placement as FullSuiteValidationPlacement
            )) {
                violations.push(
                    'Task profile policy snapshot review_execution_policy.full_suite_validation.placement is invalid.'
                );
            }
        }
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

function mapReviewFindingActionToActiveFindingDisposition(
    action: ReviewFindingPolicy['residual_risk']
): TaskProfileActiveFindingDisposition {
    return action === 'fix_now' ? 'block_until_resolved' : action;
}

function mapReviewFindingActionToResidualRiskDisposition(
    action: ReviewFindingPolicy['residual_risk']
): TaskProfileResidualRiskDisposition {
    return action === 'fix_now' ? 'block_unless_deferred_with_justification' : action;
}

export function buildTaskProfileFindingPolicySnapshot(
    reviewFindingPolicy: ReviewFindingPolicy
): TaskProfileFindingPolicySnapshot {
    // The action matrix is snapshot-owned once its hash is recorded. A named preset
    // may evolve for future tasks without retroactively invalidating active tasks.
    return {
        schema_version: DEFAULT_FINDING_POLICY.schema_version,
        policy_id: DEFAULT_FINDING_POLICY.policy_id,
        active_findings: {
            critical: 'block_until_resolved',
            high: mapReviewFindingActionToActiveFindingDisposition(reviewFindingPolicy.findings.high),
            medium: mapReviewFindingActionToActiveFindingDisposition(reviewFindingPolicy.findings.medium),
            low: mapReviewFindingActionToActiveFindingDisposition(reviewFindingPolicy.findings.low)
        },
        residual_risks: mapReviewFindingActionToResidualRiskDisposition(reviewFindingPolicy.residual_risk),
        deferred_findings: DEFAULT_FINDING_POLICY.deferred_findings
    };
}

function isActiveFindingDisposition(value: unknown): value is TaskProfileActiveFindingDisposition {
    return typeof value === 'string'
        && (ACTIVE_FINDING_DISPOSITIONS as readonly string[]).includes(value);
}

function isResidualRiskDisposition(value: unknown): value is TaskProfileResidualRiskDisposition {
    return typeof value === 'string'
        && (RESIDUAL_RISK_DISPOSITIONS as readonly string[]).includes(value);
}

function parseReviewFindingPolicySnapshot(value: unknown): ReviewFindingPolicy | null {
    if (!isPlainRecord(value) || value.schema_version !== 1) {
        return null;
    }
    if (
        typeof value.policy_id !== 'string'
        || !(REVIEW_FINDING_POLICY_IDS as readonly string[]).includes(value.policy_id)
        || !isPlainRecord(value.findings)
        || !isReviewFindingPolicyAction(value.residual_risk)
    ) {
        return null;
    }
    const findings: ReviewFindingPolicy['findings'] = {
        critical: 'fix_now',
        high: 'fix_now',
        medium: 'fix_now',
        low: 'fix_now'
    };
    for (const severity of ACTIVE_FINDING_SEVERITY_KEYS) {
        if (!isReviewFindingPolicyAction(value.findings[severity])) {
            return null;
        }
        if (severity === 'critical') {
            if (value.findings[severity] !== 'fix_now') {
                return null;
            }
            findings.critical = value.findings[severity];
            continue;
        }
        findings[severity] = value.findings[severity];
    }
    return {
        schema_version: 1,
        policy_id: value.policy_id as ReviewFindingPolicy['policy_id'],
        findings,
        residual_risk: value.residual_risk
    };
}

function validateFindingPolicySnapshot(
    value: unknown,
    reviewFindingPolicy: ReviewFindingPolicy | null,
    violations: string[]
): void {
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
            if (!isActiveFindingDisposition(value.active_findings[severity])) {
                violations.push(
                    `Task profile policy snapshot finding_policy.active_findings.${severity} must be one of ${ACTIVE_FINDING_DISPOSITIONS.join(', ')}.`
                );
            }
        }
        validateLiteral(value.active_findings.critical, 'block_until_resolved', 'finding_policy.active_findings.critical', violations);
    }
    if (!isResidualRiskDisposition(value.residual_risks)) {
        violations.push(
            `Task profile policy snapshot finding_policy.residual_risks must be one of ${RESIDUAL_RISK_DISPOSITIONS.join(', ')}.`
        );
    }
    validateLiteral(value.deferred_findings, DEFAULT_FINDING_POLICY.deferred_findings, 'finding_policy.deferred_findings', violations);
    if (reviewFindingPolicy && isPlainRecord(value.active_findings)) {
        const expected = buildTaskProfileFindingPolicySnapshot(reviewFindingPolicy);
        for (const severity of ACTIVE_FINDING_SEVERITY_KEYS) {
            validateLiteral(
                value.active_findings[severity],
                expected.active_findings[severity],
                `finding_policy.active_findings.${severity}`,
                violations
            );
        }
        validateLiteral(value.residual_risks, expected.residual_risks, 'finding_policy.residual_risks', violations);
    }
}

function isLegacyStrictFindingPolicySnapshot(value: unknown): value is Record<string, unknown> {
    if (!isPlainRecord(value) || !isPlainRecord(value.active_findings)) {
        return false;
    }
    return value.schema_version === DEFAULT_FINDING_POLICY.schema_version
        && value.policy_id === LEGACY_STRICT_FINDING_POLICY_ID
        && value.active_findings.critical === 'block_until_resolved'
        && value.active_findings.high === 'block_until_resolved'
        && value.active_findings.medium === 'block_until_resolved'
        && value.active_findings.low === 'block_until_resolved'
        && value.residual_risks === 'block_unless_deferred_with_justification'
        && value.deferred_findings === 'allowed_only_with_justification';
}

function validateLegacyStrictFindingPolicySnapshot(value: unknown, violations: string[]): void {
    if (!isPlainRecord(value)) {
        violations.push('Task profile policy snapshot finding_policy must be a JSON object.');
        return;
    }
    validateExactKeys(value, FINDING_POLICY_KEYS, 'finding_policy', violations);
    validateLiteral(value.schema_version, DEFAULT_FINDING_POLICY.schema_version, 'finding_policy.schema_version', violations);
    validateLiteral(value.policy_id, LEGACY_STRICT_FINDING_POLICY_ID, 'finding_policy.policy_id', violations);
    if (!isPlainRecord(value.active_findings)) {
        violations.push('Task profile policy snapshot finding_policy.active_findings must be a JSON object.');
        return;
    }
    validateExactKeys(
        value.active_findings,
        ACTIVE_FINDING_SEVERITY_KEYS,
        'finding_policy.active_findings',
        violations
    );
    for (const severity of ACTIVE_FINDING_SEVERITY_KEYS) {
        validateLiteral(
            value.active_findings[severity],
            'block_until_resolved',
            `finding_policy.active_findings.${severity}`,
            violations
        );
    }
    validateLiteral(
        value.residual_risks,
        'block_unless_deferred_with_justification',
        'finding_policy.residual_risks',
        violations
    );
    validateLiteral(
        value.deferred_findings,
        'allowed_only_with_justification',
        'finding_policy.deferred_findings',
        violations
    );
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

function isReviewFindingPolicyAction(value: unknown): value is ReviewFindingPolicy['residual_risk'] {
    return typeof value === 'string'
        && (REVIEW_FINDING_POLICY_ACTIONS as readonly string[]).includes(value);
}

function validateReviewFindingPolicySnapshot(value: unknown, violations: string[]): void {
    if (!isPlainRecord(value)) {
        violations.push('Task profile policy snapshot review_finding_policy must be a JSON object.');
        return;
    }
    validateExactKeys(value, REVIEW_FINDING_POLICY_KEYS, 'review_finding_policy', violations);
    validateLiteral(value.schema_version, 1, 'review_finding_policy.schema_version', violations);
    if (
        typeof value.policy_id !== 'string'
        || !(REVIEW_FINDING_POLICY_IDS as readonly string[]).includes(value.policy_id)
    ) {
        violations.push(
            `Task profile policy snapshot review_finding_policy.policy_id must be one of ${REVIEW_FINDING_POLICY_IDS.join(', ')}.`
        );
    }
    if (!isPlainRecord(value.findings)) {
        violations.push('Task profile policy snapshot review_finding_policy.findings must be a JSON object.');
    } else {
        validateExactKeys(
            value.findings,
            ACTIVE_FINDING_SEVERITY_KEYS,
            'review_finding_policy.findings',
            violations
        );
        for (const severity of ACTIVE_FINDING_SEVERITY_KEYS) {
            if (!isReviewFindingPolicyAction(value.findings[severity])) {
                violations.push(
                    `Task profile policy snapshot review_finding_policy.findings.${severity} must be one of ${REVIEW_FINDING_POLICY_ACTIONS.join(', ')}.`
                );
            }
        }
        validateLiteral(value.findings.critical, 'fix_now', 'review_finding_policy.findings.critical', violations);
    }
    if (!isReviewFindingPolicyAction(value.residual_risk)) {
        violations.push(
            `Task profile policy snapshot review_finding_policy.residual_risk must be one of ${REVIEW_FINDING_POLICY_ACTIONS.join(', ')}.`
        );
    }
    // Do not compare a snapshot-owned matrix with today's named preset. The profile
    // config validator enforces current presets before a new snapshot is created.
}

function isLegacyStrictReviewFindingPolicySnapshot(value: Record<string, unknown>): boolean {
    return value.review_finding_policy == null
        && value.review_finding_policy_diagnostics == null
        && isLegacyStrictFindingPolicySnapshot(value.finding_policy);
}

function cloneReviewFindingPolicy(policy: ReviewFindingPolicy): ReviewFindingPolicy {
    return {
        ...policy,
        findings: { ...policy.findings }
    };
}

function resolveSnapshotReviewFindingPolicy(snapshot: TaskProfilePolicySnapshot): ReviewFindingPolicy {
    if (isLegacyStrictReviewFindingPolicySnapshot(snapshot as unknown as Record<string, unknown>)) {
        return cloneReviewFindingPolicy(REVIEW_FINDING_POLICY_PRESETS.strict);
    }
    return {
        ...snapshot.review_finding_policy,
        findings: { ...snapshot.review_finding_policy.findings }
    };
}

function resolveSnapshotReviewFindingPolicyDiagnostics(snapshot: TaskProfilePolicySnapshot): string[] {
    if (isLegacyStrictReviewFindingPolicySnapshot(snapshot as unknown as Record<string, unknown>)) {
        return [LEGACY_REVIEW_FINDING_POLICY_DIAGNOSTIC];
    }
    return [...snapshot.review_finding_policy_diagnostics];
}

function resolveSnapshotReviewFollowUpPolicy(snapshot: TaskProfilePolicySnapshot): ReviewFollowUpPolicy {
    const policy = snapshot.review_follow_up_policy;
    if (!policy) {
        return {
            ...DEFAULT_REVIEW_FOLLOW_UP_POLICY,
            task_profile: { ...DEFAULT_REVIEW_FOLLOW_UP_POLICY.task_profile }
        };
    }
    return {
        ...policy,
        task_profile: policy.task_profile
            ? { ...policy.task_profile }
            : { ...DEFAULT_REVIEW_FOLLOW_UP_POLICY.task_profile }
    };
}

function resolveSnapshotReviewFollowUpPolicyDiagnostics(snapshot: TaskProfilePolicySnapshot): string[] {
    return snapshot.review_follow_up_policy_diagnostics
        ? [...snapshot.review_follow_up_policy_diagnostics]
        : ['Legacy task profile policy snapshot missing review_follow_up_policy; defaulted compatibly to per_finding.'];
}

function resolveSnapshotReviewRemediationRerunPolicy(snapshot: TaskProfilePolicySnapshot): ReviewRemediationRerunPolicy {
    return resolveReviewRemediationRerunPolicyFromSnapshot(snapshot).policy;
}

function resolveSnapshotReviewRemediationRerunPolicyDiagnostics(snapshot: TaskProfilePolicySnapshot): string[] {
    return resolveReviewRemediationRerunPolicyFromSnapshot(snapshot).diagnostics;
}

function validateReviewFollowUpPolicySnapshot(value: unknown, violations: string[]): void {
    if (!isPlainRecord(value)) {
        violations.push('Task profile policy snapshot review_follow_up_policy must be a JSON object.');
        return;
    }
    for (const requiredKey of ['schema_version', 'materialization_mode']) {
        if (!Object.prototype.hasOwnProperty.call(value, requiredKey)) {
            violations.push(`Task profile policy snapshot review_follow_up_policy.${requiredKey} is required.`);
        }
    }
    for (const key of Object.keys(value)) {
        if (!['schema_version', 'materialization_mode', 'task_profile'].includes(key)) {
            violations.push(
                `Task profile policy snapshot review_follow_up_policy.${key} is not allowed by schema version 1.`
            );
        }
    }
    validateLiteral(value.schema_version, 1, 'review_follow_up_policy.schema_version', violations);
    if (!REVIEW_FOLLOW_UP_MATERIALIZATION_MODES.includes(value.materialization_mode as typeof REVIEW_FOLLOW_UP_MATERIALIZATION_MODES[number])) {
        violations.push('Task profile policy snapshot review_follow_up_policy.materialization_mode must be one of per_finding, grouped_by_parent.');
    }
    if (value.task_profile !== undefined) {
        if (!isPlainRecord(value.task_profile)) {
            violations.push('Task profile policy snapshot review_follow_up_policy.task_profile must be a JSON object.');
        } else {
            validateExactKeys(
                value.task_profile,
                ['mode', 'fixed_profile'],
                'review_follow_up_policy.task_profile',
                violations
            );
            if (!['one_level_lighter', 'inherit_parent', 'fixed_profile'].includes(String(value.task_profile.mode || ''))) {
                violations.push(
                    'Task profile policy snapshot review_follow_up_policy.task_profile.mode must be one of ' +
                    'one_level_lighter, inherit_parent, fixed_profile.'
                );
            }
            const fixedProfile = value.task_profile.fixed_profile;
            if (value.task_profile.mode === 'fixed_profile' && (typeof fixedProfile !== 'string' || !fixedProfile.trim())) {
                violations.push(
                    'Task profile policy snapshot review_follow_up_policy.task_profile.fixed_profile is required for fixed_profile mode.'
                );
            }
            if (value.task_profile.mode !== 'fixed_profile' && fixedProfile !== null) {
                violations.push(
                    'Task profile policy snapshot review_follow_up_policy.task_profile.fixed_profile must be null unless mode is fixed_profile.'
                );
            }
        }
    }
}

function validateReviewFollowUpTaskProfileAssignment(value: unknown, violations: string[]): void {
    if (!isPlainRecord(value)) {
        violations.push('Task profile policy snapshot review_follow_up_task_profile_assignment must be a JSON object.');
        return;
    }
    validateExactKeys(
        value,
        ['parent_profile', 'profile', 'source', 'configured_mode', 'diagnostics'],
        'review_follow_up_task_profile_assignment',
        violations
    );
    for (const key of ['parent_profile', 'profile'] as const) {
        if (typeof value[key] !== 'string' || !value[key].trim()) {
            violations.push(`Task profile policy snapshot review_follow_up_task_profile_assignment.${key} must be non-empty.`);
        }
    }
    if (!['one_level_lighter', 'inherit_parent', 'fixed_profile', 'safe_inherit_parent'].includes(String(value.source || ''))) {
        violations.push('Task profile policy snapshot review_follow_up_task_profile_assignment.source is invalid.');
    }
    if (!['one_level_lighter', 'inherit_parent', 'fixed_profile'].includes(String(value.configured_mode || ''))) {
        violations.push('Task profile policy snapshot review_follow_up_task_profile_assignment.configured_mode is invalid.');
    }
    validateStringArray(value.diagnostics, 'review_follow_up_task_profile_assignment.diagnostics', violations);
}

export function resolveSnapshotReviewFollowUpTaskProfileAssignment(
    snapshot: TaskProfilePolicySnapshot
): ReviewFollowUpTaskProfileAssignment {
    if (snapshot.review_follow_up_task_profile_assignment) {
        return {
            ...snapshot.review_follow_up_task_profile_assignment,
            diagnostics: [...snapshot.review_follow_up_task_profile_assignment.diagnostics]
        };
    }
    const parentProfile = snapshot.source.effective_profile;
    return {
        parent_profile: parentProfile,
        profile: parentProfile,
        source: 'safe_inherit_parent',
        configured_mode: 'inherit_parent',
        diagnostics: ['Legacy task profile snapshot inherited the parent profile for follow-up tasks.']
    };
}

function resolveSnapshotFindingPolicy(snapshot: TaskProfilePolicySnapshot): TaskProfileFindingPolicySnapshot {
    if (isLegacyStrictReviewFindingPolicySnapshot(snapshot as unknown as Record<string, unknown>)) {
        return buildTaskProfileFindingPolicySnapshot(REVIEW_FINDING_POLICY_PRESETS.strict);
    }
    return snapshot.finding_policy;
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
    return canonicalJsonSha256(withoutSnapshotHash(snapshot as unknown as Record<string, unknown>));
}

function computeRawTaskProfilePolicySnapshotHash(snapshot: Record<string, unknown>): string {
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
    const followUpTaskProfileAssignment = resolveReviewFollowUpTaskProfileAssignment(
        resolvedProfile.effective_policy.review_follow_up_policy,
        resolvedProfile.selection.effective_profile,
        [
            ...Object.keys(profilesData.built_in_profiles),
            ...Object.keys(profilesData.user_profiles)
        ]
    );
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
            visible_summary_line: buildReviewExecutionPolicySummaryLine(options.reviewExecutionPolicyMode),
            review_dependency_graph: profileEntry.review_dependency_graph === undefined
                ? null
                : normalizeReviewDependencyGraphDeclaration(
                    profileEntry.review_dependency_graph,
                    `profiles.${resolvedProfile.selection.effective_profile}.review_dependency_graph`
                ),
            full_suite_validation: {
                enabled: options.fullSuiteValidationEnabled === true,
                placement: options.fullSuiteValidationPlacement || 'after_compile_before_reviews'
            }
        },
        review_finding_policy: {
            ...resolvedProfile.effective_policy.review_finding_policy,
            findings: { ...resolvedProfile.effective_policy.review_finding_policy.findings }
        },
        review_finding_policy_diagnostics: [...resolvedProfile.effective_policy.review_finding_policy_diagnostics],
        review_follow_up_policy: {
            ...resolvedProfile.effective_policy.review_follow_up_policy,
            task_profile: { ...resolvedProfile.effective_policy.review_follow_up_policy.task_profile }
        },
        review_follow_up_policy_diagnostics: [...resolvedProfile.effective_policy.review_follow_up_policy_diagnostics],
        review_follow_up_task_profile_assignment: followUpTaskProfileAssignment,
        review_remediation_rerun_policy: buildDefaultReviewRemediationRerunPolicy(),
        review_remediation_rerun_policy_diagnostics: [REVIEW_REMEDIATION_RERUN_POLICY_DIAGNOSTIC],
        finding_policy: buildTaskProfileFindingPolicySnapshot(resolvedProfile.effective_policy.review_finding_policy),
        remediation_policy: { ...DEFAULT_REMEDIATION_POLICY },
        token_economy: resolvedProfile.effective_policy.token_economy,
        skills: resolvedProfile.effective_policy.skills,
        installed_packs: resolvedProfile.effective_policy.installed_packs,
        paths: resolvedProfile.effective_policy.paths,
        review_trigger_policy: resolvedProfile.effective_policy.review_trigger_policy,
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
    const legacyStrictReviewFindingPolicySnapshot = isLegacyStrictReviewFindingPolicySnapshot(value);
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
    if (legacyStrictReviewFindingPolicySnapshot) {
        validateLegacyStrictFindingPolicySnapshot(value.finding_policy, violations);
    } else {
        validateReviewFindingPolicySnapshot(value.review_finding_policy, violations);
        validateStringArray(value.review_finding_policy_diagnostics, 'review_finding_policy_diagnostics', violations);
        validateFindingPolicySnapshot(value.finding_policy, parseReviewFindingPolicySnapshot(value.review_finding_policy), violations);
    }
    if (value.review_follow_up_policy !== undefined || value.review_follow_up_policy_diagnostics !== undefined) {
        validateReviewFollowUpPolicySnapshot(value.review_follow_up_policy, violations);
        validateStringArray(value.review_follow_up_policy_diagnostics, 'review_follow_up_policy_diagnostics', violations);
    }
    if (value.review_follow_up_task_profile_assignment !== undefined) {
        validateReviewFollowUpTaskProfileAssignment(value.review_follow_up_task_profile_assignment, violations);
    }
    if (
        value.review_remediation_rerun_policy !== undefined
        || value.review_remediation_rerun_policy_diagnostics !== undefined
    ) {
        violations.push(...getReviewRemediationRerunPolicyViolations(
            value.review_remediation_rerun_policy
        ).map((violation) => `Task profile policy snapshot ${violation}`));
        validateStringArray(
            value.review_remediation_rerun_policy_diagnostics,
            'review_remediation_rerun_policy_diagnostics',
            violations
        );
    }
    validateRemediationPolicySnapshot(value.remediation_policy, violations);
    if (value.review_trigger_policy !== undefined) {
        try {
            validateReviewTriggerPolicy(value.review_trigger_policy);
        } catch (error: unknown) {
            violations.push(error instanceof Error ? error.message : String(error));
        }
    }
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

    const snapshotRecord = value as Record<string, unknown>;
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
    const expectedSnapshotHash = legacyStrictReviewFindingPolicySnapshot
        ? computeRawTaskProfilePolicySnapshotHash(snapshotRecord)
        : computeTaskProfilePolicySnapshotHash(snapshot);
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
    const reviewFindingPolicy = resolveSnapshotReviewFindingPolicy(snapshot);
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
            review_finding_policy: reviewFindingPolicy,
            review_finding_policy_diagnostics: resolveSnapshotReviewFindingPolicyDiagnostics(snapshot),
            review_follow_up_policy: resolveSnapshotReviewFollowUpPolicy(snapshot),
            review_follow_up_policy_diagnostics: resolveSnapshotReviewFollowUpPolicyDiagnostics(snapshot),
            token_economy: snapshot.token_economy,
            skills: snapshot.skills,
            installed_packs: snapshot.installed_packs,
            paths: snapshot.paths,
            review_trigger_policy: resolveTaskProfileReviewTriggerPolicy(snapshot),
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
        review_finding_policy: resolveSnapshotReviewFindingPolicy(snapshot),
        review_finding_policy_diagnostics: resolveSnapshotReviewFindingPolicyDiagnostics(snapshot),
        review_follow_up_policy: resolveSnapshotReviewFollowUpPolicy(snapshot),
        review_follow_up_policy_diagnostics: resolveSnapshotReviewFollowUpPolicyDiagnostics(snapshot),
        review_follow_up_task_profile_assignment: resolveSnapshotReviewFollowUpTaskProfileAssignment(snapshot),
        review_remediation_rerun_policy: resolveSnapshotReviewRemediationRerunPolicy(snapshot),
        review_remediation_rerun_policy_diagnostics:
            resolveSnapshotReviewRemediationRerunPolicyDiagnostics(snapshot),
        finding_policy: resolveSnapshotFindingPolicy(snapshot),
        remediation_policy: snapshot.remediation_policy,
        review_trigger_policy: resolveTaskProfileReviewTriggerPolicy(snapshot),
        config_hash: snapshot.config_hash,
        snapshot_hash: snapshot.snapshot_hash
    };
}

export function resolveTaskProfileReviewTriggerPolicy(
    snapshot: TaskProfilePolicySnapshot
): ReviewTriggerPolicy {
    return snapshot.review_trigger_policy
        ? validateReviewTriggerPolicy(snapshot.review_trigger_policy)
        : normalizeReviewTriggerPolicyFromPaths(snapshot.paths);
}

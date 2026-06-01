import * as fs from 'node:fs';
import {
    PROJECT_MEMORY_MAINTENANCE_MODES,
    type ProjectMemoryMaintenanceMode
} from '../core/workflow-config';
import { isPlainObject } from '../core/config-merge';
import {
    type ProjectMemoryChangedFilesSource,
    type ProjectMemoryImpactArtifact,
    type ProjectMemoryImpactEvidenceStatus,
    type ProjectMemoryImpactStatus,
    type ProjectMemoryUpdateEvidenceStatus
} from './project-memory-impact-types';

function sameJsonValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function compareImpactArtifactToExpected(
    actual: ProjectMemoryImpactArtifact,
    expected: ProjectMemoryImpactArtifact
): string[] {
    const checks: Array<{ field: string; actual: unknown; expected: unknown }> = [
        { field: 'schema_version', actual: actual.schema_version, expected: expected.schema_version },
        { field: 'task_id', actual: actual.task_id, expected: expected.task_id },
        { field: 'mode', actual: actual.mode, expected: expected.mode },
        { field: 'configured_mode', actual: actual.configured_mode, expected: expected.configured_mode },
        { field: 'enabled', actual: actual.enabled, expected: expected.enabled },
        { field: 'status', actual: actual.status, expected: expected.status },
        { field: 'outcome', actual: actual.outcome, expected: expected.outcome },
        { field: 'update_needed', actual: actual.update_needed, expected: expected.update_needed },
        { field: 'writes_allowed', actual: actual.writes_allowed, expected: expected.writes_allowed },
        {
            field: 'require_user_approval_for_writes',
            actual: actual.require_user_approval_for_writes,
            expected: expected.require_user_approval_for_writes
        },
        { field: 'changed_files_source', actual: actual.changed_files_source, expected: expected.changed_files_source },
        { field: 'preflight_path', actual: actual.preflight_path, expected: expected.preflight_path },
        { field: 'preflight_hash_sha256', actual: actual.preflight_hash_sha256, expected: expected.preflight_hash_sha256 },
        { field: 'changed_files', actual: actual.changed_files, expected: expected.changed_files },
        { field: 'affected_memory_files', actual: actual.affected_memory_files, expected: expected.affected_memory_files },
        { field: 'affected_memory_file_names', actual: actual.affected_memory_file_names, expected: expected.affected_memory_file_names },
        { field: 'reasons', actual: actual.reasons, expected: expected.reasons },
        { field: 'validation', actual: actual.validation, expected: expected.validation },
        { field: 'compact', actual: actual.compact, expected: expected.compact },
        { field: 'update_evidence', actual: actual.update_evidence, expected: expected.update_evidence },
        { field: 'impact_fingerprint_sha256', actual: actual.impact_fingerprint_sha256, expected: expected.impact_fingerprint_sha256 },
        { field: 'next_step', actual: actual.next_step, expected: expected.next_step },
        { field: 'violations', actual: actual.violations, expected: expected.violations }
    ];
    const violations: string[] = [];
    for (const check of checks) {
        if (!sameJsonValue(check.actual, check.expected)) {
            violations.push(`Project memory impact artifact field '${check.field}' is stale or does not match current evidence.`);
        }
    }
    return violations;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}

function isProjectMemoryMode(value: unknown): value is ProjectMemoryMaintenanceMode {
    return PROJECT_MEMORY_MAINTENANCE_MODES.includes(value as ProjectMemoryMaintenanceMode);
}

function isImpactStatus(value: unknown): value is ProjectMemoryImpactStatus {
    return ['OFF', 'NO_UPDATE_NEEDED', 'UPDATE_NEEDED', 'UPDATED', 'BLOCKED'].includes(String(value || ''));
}

function isImpactOutcome(value: unknown): value is 'PASS' | 'FAIL' {
    return value === 'PASS' || value === 'FAIL';
}

function isCompactStatus(value: unknown): value is 'OK' | 'MISSING' | 'OVERFLOW' {
    return value === 'OK' || value === 'MISSING' || value === 'OVERFLOW';
}

function isUpdateEvidenceStatus(value: unknown): value is ProjectMemoryUpdateEvidenceStatus {
    return ['NOT_REQUIRED', 'MISSING', 'VALID', 'STALE', 'TAMPERED', 'INVALID'].includes(String(value || ''));
}

function isChangedFilesSource(value: unknown): value is ProjectMemoryChangedFilesSource {
    return value === 'preflight' || value === 'explicit';
}

function validateImpactArtifactShape(parsed: Record<string, unknown>): string[] {
    const violations: string[] = [];
    const require = (condition: boolean, field: string, expected: string): void => {
        if (!condition) {
            violations.push(`Project memory impact artifact field '${field}' must be ${expected}.`);
        }
    };

    require(parsed.schema_version === 1, 'schema_version', '1');
    require(typeof parsed.timestamp_utc === 'string', 'timestamp_utc', 'a string');
    require(typeof parsed.task_id === 'string', 'task_id', 'a string');
    require(isProjectMemoryMode(parsed.mode), 'mode', `one of: ${PROJECT_MEMORY_MAINTENANCE_MODES.join(', ')}`);
    require(isProjectMemoryMode(parsed.configured_mode), 'configured_mode', `one of: ${PROJECT_MEMORY_MAINTENANCE_MODES.join(', ')}`);
    require(typeof parsed.enabled === 'boolean', 'enabled', 'a boolean');
    require(isImpactStatus(parsed.status), 'status', 'a valid project-memory impact status');
    require(isImpactOutcome(parsed.outcome), 'outcome', 'PASS or FAIL');
    require(typeof parsed.update_needed === 'boolean', 'update_needed', 'a boolean');
    require(typeof parsed.writes_allowed === 'boolean', 'writes_allowed', 'a boolean');
    require(typeof parsed.require_user_approval_for_writes === 'boolean', 'require_user_approval_for_writes', 'a boolean');
    require(isChangedFilesSource(parsed.changed_files_source), 'changed_files_source', 'preflight or explicit');
    require(isNullableString(parsed.preflight_path), 'preflight_path', 'a string or null');
    require(isNullableString(parsed.preflight_hash_sha256), 'preflight_hash_sha256', 'a string or null');
    require(isStringArray(parsed.changed_files), 'changed_files', 'an array of strings');
    require(isStringArray(parsed.affected_memory_files), 'affected_memory_files', 'an array of strings');
    require(isStringArray(parsed.affected_memory_file_names), 'affected_memory_file_names', 'an array of strings');
    require(Array.isArray(parsed.reasons), 'reasons', 'an array');
    require(isPlainObject(parsed.validation), 'validation', 'an object');

    const compact = isPlainObject(parsed.compact) ? parsed.compact : null;
    require(compact !== null, 'compact', 'an object');
    if (compact) {
        require(typeof compact.path === 'string', 'compact.path', 'a string');
        require(typeof compact.exists === 'boolean', 'compact.exists', 'a boolean');
        require(compact.char_count === null || typeof compact.char_count === 'number', 'compact.char_count', 'a number or null');
        require(typeof compact.max_chars === 'number', 'compact.max_chars', 'a number');
        require(isNullableString(compact.sha256), 'compact.sha256', 'a string or null');
        require(isCompactStatus(compact.status), 'compact.status', 'OK, MISSING, or OVERFLOW');
    }

    const updateEvidence = isPlainObject(parsed.update_evidence) ? parsed.update_evidence : null;
    require(updateEvidence !== null, 'update_evidence', 'an object');
    if (updateEvidence) {
        require(isUpdateEvidenceStatus(updateEvidence.status), 'update_evidence.status', 'a valid update evidence status');
        require(typeof updateEvidence.path === 'string', 'update_evidence.path', 'a string');
        require(isStringArray(updateEvidence.updated_memory_files), 'update_evidence.updated_memory_files', 'an array of strings');
        require(isStringArray(updateEvidence.missing_updated_memory_files), 'update_evidence.missing_updated_memory_files', 'an array of strings');
        require(isStringArray(updateEvidence.invalid_reasons), 'update_evidence.invalid_reasons', 'an array of strings');
    }

    require(typeof parsed.impact_fingerprint_sha256 === 'string', 'impact_fingerprint_sha256', 'a string');
    require(typeof parsed.next_step === 'string', 'next_step', 'a string');
    require(isStringArray(parsed.violations), 'violations', 'an array of strings');
    return violations;
}

export function readImpactArtifact(artifactPath: string): {
    artifact: ProjectMemoryImpactArtifact | null;
    exists: boolean;
    invalidReasons: string[];
} {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return { artifact: null, exists: false, invalidReasons: [] };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    } catch (error: unknown) {
        return {
            artifact: null,
            exists: true,
            invalidReasons: [
                `Project memory impact artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`
            ]
        };
    }

    if (!isPlainObject(parsed)) {
        return {
            artifact: null,
            exists: true,
            invalidReasons: ['Project memory impact artifact must be a JSON object.']
        };
    }

    const invalidReasons = validateImpactArtifactShape(parsed);
    return {
        artifact: invalidReasons.length === 0 ? parsed as unknown as ProjectMemoryImpactArtifact : null,
        exists: true,
        invalidReasons
    };
}

export function buildProjectMemoryVisibleSummary(input: {
    required: boolean;
    enabled: boolean;
    mode: ProjectMemoryMaintenanceMode;
    evidenceStatus: ProjectMemoryImpactEvidenceStatus;
    status: ProjectMemoryImpactStatus | null;
    updateNeeded: boolean | null;
    updatedMemoryFiles: readonly string[];
    compactStatus: string | null;
    compactRefreshed: boolean | null;
}): string {
    const statusText = input.status || input.evidenceStatus;
    const parts = [
        `Project memory: ${input.enabled ? 'enabled' : 'disabled'}`,
        `mode=${input.mode}`,
        `required=${input.required}`,
        `evidence=${input.evidenceStatus}`,
        `status=${statusText}`,
        `update_needed=${input.updateNeeded == null ? 'unknown' : input.updateNeeded}`,
        `updated_files=${input.updatedMemoryFiles.length}`,
        `compact=${input.compactStatus || 'unknown'}`,
        `compact_refreshed=${input.compactRefreshed == null ? 'unknown' : input.compactRefreshed}`
    ];
    return parts.join('; ');
}

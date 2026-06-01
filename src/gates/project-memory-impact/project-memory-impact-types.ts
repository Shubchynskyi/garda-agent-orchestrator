import type { ProjectMemoryMaintenanceMode } from '../../core/workflow-config';
import type { ProjectMemoryValidationResult } from '../../validators/project-memory';

export type ProjectMemoryImpactStatus = 'OFF' | 'NO_UPDATE_NEEDED' | 'UPDATE_NEEDED' | 'UPDATED' | 'BLOCKED';
export type ProjectMemoryUpdateEvidenceStatus = 'NOT_REQUIRED' | 'MISSING' | 'VALID' | 'STALE' | 'TAMPERED' | 'INVALID';
export type ProjectMemoryImpactEvidenceStatus = 'NOT_REQUIRED' | 'MISSING' | 'CURRENT' | 'STALE' | 'BLOCKED' | 'INVALID';
export type ProjectMemoryChangedFilesSource = 'preflight' | 'explicit';

export const PROJECT_MEMORY_IMPACT_ASSESSED_EVENT = 'PROJECT_MEMORY_IMPACT_ASSESSED';
export const PROJECT_MEMORY_IMPACT_BLOCKED_EVENT = 'PROJECT_MEMORY_IMPACT_BLOCKED';

export interface ProjectMemoryImpactReason {
    changed_file: string;
    reason: string;
    suggested_memory_files: string[];
}

export interface ProjectMemoryImpactOptions {
    repoRoot: string;
    taskId: string;
    preflightPath?: string | null;
    changedFiles?: string[];
    confirmUpdated?: boolean;
    updatedMemoryFiles?: string[];
    modeOverride?: ProjectMemoryMaintenanceMode | null;
    artifactPath?: string | null;
    updateArtifactPath?: string | null;
}

export interface ProjectMemoryUpdateEvidence {
    schema_version: 1;
    timestamp_utc: string;
    task_id: string;
    status: 'UPDATED';
    impact_fingerprint_sha256: string;
    updated_memory_files: string[];
    updated_file_hashes: Record<string, string>;
    compact_refreshed: boolean;
    compact_sha256: string | null;
}

export interface ProjectMemoryImpactArtifact {
    schema_version: 1;
    timestamp_utc: string;
    task_id: string;
    mode: ProjectMemoryMaintenanceMode;
    configured_mode: ProjectMemoryMaintenanceMode;
    enabled: boolean;
    status: ProjectMemoryImpactStatus;
    outcome: 'PASS' | 'FAIL';
    update_needed: boolean;
    writes_allowed: false;
    require_user_approval_for_writes: boolean;
    changed_files_source: ProjectMemoryChangedFilesSource;
    preflight_path: string | null;
    preflight_hash_sha256: string | null;
    changed_files: string[];
    affected_memory_files: string[];
    affected_memory_file_names: string[];
    reasons: ProjectMemoryImpactReason[];
    validation: ProjectMemoryValidationResult;
    compact: {
        path: string;
        exists: boolean;
        char_count: number | null;
        max_chars: number;
        sha256: string | null;
        status: 'OK' | 'MISSING' | 'OVERFLOW';
    };
    update_evidence: {
        status: ProjectMemoryUpdateEvidenceStatus;
        path: string;
        updated_memory_files: string[];
        missing_updated_memory_files: string[];
        invalid_reasons: string[];
    };
    impact_fingerprint_sha256: string;
    next_step: string;
    violations: string[];
}

export interface ProjectMemoryImpactLifecycleEvidence {
    required: boolean;
    enabled: boolean;
    mode: ProjectMemoryMaintenanceMode;
    configured_mode: ProjectMemoryMaintenanceMode;
    run_before_final_closeout: boolean;
    artifact_path: string;
    update_artifact_path: string;
    status: ProjectMemoryImpactStatus | null;
    outcome: 'PASS' | 'FAIL' | null;
    evidence_status: ProjectMemoryImpactEvidenceStatus;
    update_needed: boolean | null;
    affected_memory_files: string[];
    updated_memory_files: string[];
    compact_status: 'OK' | 'MISSING' | 'OVERFLOW' | null;
    compact_refreshed: boolean | null;
    visible_summary_line: string;
    violations: string[];
}

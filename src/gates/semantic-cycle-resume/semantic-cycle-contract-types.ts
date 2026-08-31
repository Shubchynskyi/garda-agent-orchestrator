export const SEMANTIC_CYCLE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const SEMANTIC_CYCLE_CONTRACT_ID = 'semantic_cycle_snapshot_v1' as const;

export const SEMANTIC_CYCLE_BASE_BINDING_KEYS = [
    'task_contract',
    'profile_policy',
    'workflow_config',
    'rule_pack',
    'review_catalog',
    'trust_boundary_analysis',
    'authorized_scope',
    'source_content',
    'tree_state',
    'compile_evidence',
    'full_suite_evidence'
] as const;

export const SEMANTIC_CYCLE_REVIEW_BINDING_KEYS = [
    'review_contexts',
    'findings_dispositions',
    'review_receipts',
    'reviewer_dependencies'
] as const;

export const SEMANTIC_CYCLE_BINDING_KEYS = [
    ...SEMANTIC_CYCLE_BASE_BINDING_KEYS,
    ...SEMANTIC_CYCLE_REVIEW_BINDING_KEYS
] as const;

export type SemanticCycleBaseBindingKey = typeof SEMANTIC_CYCLE_BASE_BINDING_KEYS[number];
export type SemanticCycleReviewBindingKey = typeof SEMANTIC_CYCLE_REVIEW_BINDING_KEYS[number];
export type SemanticCycleBindingKey = typeof SEMANTIC_CYCLE_BINDING_KEYS[number];

export interface SemanticCycleRuntimeIdentity {
    cli_version: string;
    task_event_schema_version: number;
    snapshot_schema_version: number;
}

export interface SemanticCycleLifecyclePosition {
    cycle_sha256: string;
    task_event_sequence: number;
}

export interface SemanticCycleReviewLaneBinding {
    review_type: string;
    context_sha256: string;
    findings_disposition_sha256: string;
    receipt_sha256: string;
    dependency_state_sha256: string;
    accepted_receipt: boolean;
}

export interface SemanticCycleSnapshot {
    schema_version: typeof SEMANTIC_CYCLE_SNAPSHOT_SCHEMA_VERSION;
    contract_id: typeof SEMANTIC_CYCLE_CONTRACT_ID;
    task_id: string;
    runtime: SemanticCycleRuntimeIdentity;
    lifecycle_position: SemanticCycleLifecyclePosition;
    bindings: Record<SemanticCycleBindingKey, string>;
    review_lanes: SemanticCycleReviewLaneBinding[];
    snapshot_sha256: string;
}

export interface SemanticCycleSnapshotInput {
    task_id: string;
    runtime: SemanticCycleRuntimeIdentity;
    lifecycle_position: SemanticCycleLifecyclePosition;
    bindings: Record<SemanticCycleBaseBindingKey, string>;
    review_lanes: readonly SemanticCycleReviewLaneBinding[];
}

export interface SemanticCycleSnapshotValidationResult {
    status: 'VALID' | 'INVALID';
    snapshot: SemanticCycleSnapshot | null;
    violations: string[];
}

export const SEMANTIC_CYCLE_BINDING_MISMATCH_CODES: Record<SemanticCycleBindingKey, SemanticCycleMismatchCode> = {
    task_contract: 'TASK_CONTRACT_MISMATCH',
    profile_policy: 'PROFILE_POLICY_MISMATCH',
    workflow_config: 'WORKFLOW_CONFIG_MISMATCH',
    rule_pack: 'RULE_PACK_MISMATCH',
    review_catalog: 'REVIEW_CATALOG_MISMATCH',
    trust_boundary_analysis: 'TRUST_BOUNDARY_ANALYSIS_MISMATCH',
    authorized_scope: 'AUTHORIZED_SCOPE_MISMATCH',
    source_content: 'SOURCE_CONTENT_MISMATCH',
    tree_state: 'TREE_STATE_MISMATCH',
    compile_evidence: 'COMPILE_EVIDENCE_MISMATCH',
    full_suite_evidence: 'FULL_SUITE_EVIDENCE_MISMATCH',
    review_contexts: 'REVIEW_CONTEXTS_MISMATCH',
    findings_dispositions: 'FINDINGS_DISPOSITIONS_MISMATCH',
    review_receipts: 'REVIEW_RECEIPTS_MISMATCH',
    reviewer_dependencies: 'REVIEWER_DEPENDENCIES_MISMATCH'
};

export type SemanticCycleMismatchCode =
    | 'AUTHORITATIVE_SNAPSHOT_INVALID'
    | 'CANDIDATE_SNAPSHOT_INVALID'
    | 'SNAPSHOT_SCHEMA_UNSUPPORTED'
    | 'RUNTIME_CLI_MISMATCH'
    | 'TASK_EVENT_SCHEMA_MISMATCH'
    | 'TASK_ID_MISMATCH'
    | 'TASK_CONTRACT_MISMATCH'
    | 'PROFILE_POLICY_MISMATCH'
    | 'WORKFLOW_CONFIG_MISMATCH'
    | 'RULE_PACK_MISMATCH'
    | 'REVIEW_CATALOG_MISMATCH'
    | 'TRUST_BOUNDARY_ANALYSIS_MISMATCH'
    | 'AUTHORIZED_SCOPE_MISMATCH'
    | 'SOURCE_CONTENT_MISMATCH'
    | 'TREE_STATE_MISMATCH'
    | 'COMPILE_EVIDENCE_MISMATCH'
    | 'FULL_SUITE_EVIDENCE_MISMATCH'
    | 'REVIEW_CONTEXTS_MISMATCH'
    | 'FINDINGS_DISPOSITIONS_MISMATCH'
    | 'REVIEW_RECEIPTS_MISMATCH'
    | 'REVIEWER_DEPENDENCIES_MISMATCH'
    | 'REVIEW_LANE_SET_MISMATCH'
    | 'REVIEW_LANE_CONTEXT_MISMATCH'
    | 'REVIEW_LANE_FINDINGS_MISMATCH'
    | 'REVIEW_LANE_RECEIPT_MISMATCH'
    | 'REVIEW_LANE_DEPENDENCY_MISMATCH'
    | 'REVIEW_LANE_ACCEPTANCE_MISMATCH';

export interface SemanticCycleMismatch {
    code: SemanticCycleMismatchCode;
    artifact: string;
    expected: string | number | boolean | null;
    actual: string | number | boolean | null;
    message: string;
}

export interface SemanticCycleRuntimeCompatibilityResult {
    status: 'COMPATIBLE' | 'INCOMPATIBLE';
    mutation_allowed: boolean;
    mismatches: SemanticCycleMismatch[];
    remediation: string | null;
}

export interface SemanticCycleComparisonResult {
    schema_version: 1;
    status: 'REUSABLE' | 'RECOVERY_REQUIRED' | 'RUNTIME_INCOMPATIBLE';
    task_id: string | null;
    authoritative_snapshot_sha256: string | null;
    candidate_snapshot_sha256: string | null;
    mutation_allowed: boolean;
    route: 'semantic_rebind' | 'existing_recovery' | 'runtime_upgrade_required';
    mismatches: SemanticCycleMismatch[];
    decision_sha256: string;
}

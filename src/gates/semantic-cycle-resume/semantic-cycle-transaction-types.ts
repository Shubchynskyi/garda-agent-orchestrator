import type {
    SemanticCycleComparisonResult,
    SemanticCycleLifecyclePosition,
    SemanticCycleRuntimeIdentity,
    SemanticCycleSnapshot
} from './semantic-cycle-contract-types';

export type { SemanticCycleLifecyclePosition } from './semantic-cycle-contract-types';

export const SEMANTIC_CYCLE_REBIND_TRANSACTION_SCHEMA_VERSION = 1 as const;
export const SEMANTIC_CYCLE_REBIND_TRANSACTION_CONTRACT_ID =
    'semantic_cycle_rebind_transaction_v1' as const;

export const SEMANTIC_CYCLE_REBIND_ARTIFACT_CLASSES = [
    'compile',
    'full_suite',
    'review_context',
    'findings_disposition',
    'review_receipt',
    'reviewer_dependency'
] as const;

export type SemanticCycleRebindArtifactClass =
    typeof SEMANTIC_CYCLE_REBIND_ARTIFACT_CLASSES[number];

export interface SemanticCycleRebindArtifactInput {
    artifact_class: SemanticCycleRebindArtifactClass;
    review_type: string | null;
    source_path: string;
    source_sha256: string;
    accepted: boolean;
}

export interface SemanticCycleReboundArtifact extends SemanticCycleRebindArtifactInput {
    rebound_cycle_sha256: string;
    rebound_task_event_sequence: number;
}

export type SemanticCycleRebindInvalidationCode =
    | 'COMPARISON_BINDING_INVALID'
    | 'COMPARISON_NOT_REUSABLE'
    | 'LIFECYCLE_POSITION_INVALID'
    | 'ARTIFACT_COVERAGE_INVALID'
    | 'ARTIFACT_HASH_MISMATCH'
    | 'CONCURRENT_DRIFT'
    | 'IMMUTABLE_OUTPUT_CONFLICT'
    | 'PERSISTENCE_FAILED'
    | 'POST_COMMIT_VALIDATION_FAILED';

export interface SemanticCycleRebindAudit {
    event: 'SEMANTIC_CYCLE_REBIND_COMMITTED' | 'SEMANTIC_CYCLE_REBIND_INVALIDATED';
    outcome: 'REUSED' | 'INVALIDATED';
    route: SemanticCycleComparisonResult['route'];
    mutation_allowed: boolean;
    comparison_decision_sha256: string;
    authoritative_snapshot_sha256: string | null;
    candidate_snapshot_sha256: string | null;
    lifecycle_authority_sha256: string | null;
    request_sha256: string;
    verified_artifact_count: number;
    artifact_class_counts: Record<SemanticCycleRebindArtifactClass, number>;
    invalidation_codes: SemanticCycleRebindInvalidationCode[];
    violations: string[];
    rollback_performed: boolean;
    rollback_completed: boolean;
}

export interface SemanticCycleRebindManifestPayload {
    schema_version: typeof SEMANTIC_CYCLE_REBIND_TRANSACTION_SCHEMA_VERSION;
    contract_id: typeof SEMANTIC_CYCLE_REBIND_TRANSACTION_CONTRACT_ID;
    transaction_id: string;
    request_sha256: string;
    status: 'COMMITTED' | 'INVALIDATED';
    task_id: string | null;
    created_at_utc: string;
    source_position: SemanticCycleLifecyclePosition;
    target_position: SemanticCycleLifecyclePosition;
    comparison_decision_sha256: string;
    authoritative_snapshot_sha256: string | null;
    candidate_snapshot_sha256: string | null;
    lifecycle_authority_sha256: string | null;
    artifacts: SemanticCycleReboundArtifact[];
    audit: SemanticCycleRebindAudit;
}

export interface SemanticCycleRebindManifest extends SemanticCycleRebindManifestPayload {
    transaction_sha256: string;
}

export interface SemanticCycleRebindManifestValidationResult {
    status: 'VALID' | 'INVALID';
    manifest: SemanticCycleRebindManifest | null;
    violations: string[];
}

export interface SemanticCycleRebindTestHooks {
    now_utc?: () => string;
    after_initial_validation_before_lock?: () => void;
    before_final_validation?: () => void;
    before_persist?: () => void;
    after_write_before_persisted_validation?: (outputPath: string) => void;
    after_persist_before_verification?: () => void;
    rollback_remove_output?: (outputPath: string) => void;
}

export interface SemanticCycleRebindTransactionOptions {
    repo_root: string;
    output_path: string;
    task_events_path: string;
    comparison: SemanticCycleComparisonResult;
    authoritative_snapshot: SemanticCycleSnapshot;
    candidate_snapshot: SemanticCycleSnapshot;
    current_runtime: SemanticCycleRuntimeIdentity;
    source_position: SemanticCycleLifecyclePosition;
    target_position: SemanticCycleLifecyclePosition;
    artifacts: readonly SemanticCycleRebindArtifactInput[];
    _testHooks?: SemanticCycleRebindTestHooks;
}

export interface SemanticCycleRebindTransactionResult {
    status: 'COMMITTED' | 'IDEMPOTENT' | 'INVALIDATED' | 'INTERRUPTED';
    mutation_allowed: boolean;
    route: SemanticCycleComparisonResult['route'];
    artifact_path: string | null;
    manifest: SemanticCycleRebindManifest | null;
    audit: SemanticCycleRebindAudit;
    violations: string[];
}

export const RULE_PACK_STAGE_LABELS = Object.freeze([
    'TASK_ENTRY',
    'POST_PREFLIGHT'
] as const);

export type RulePackStageLabel = (typeof RULE_PACK_STAGE_LABELS)[number];

export const RULE_PACK_STAGE_KEYS = Object.freeze({
    TASK_ENTRY: 'task_entry',
    POST_PREFLIGHT: 'post_preflight'
} satisfies Record<RulePackStageLabel, 'task_entry' | 'post_preflight'>);

export const RULE_PACK_ENTRY_FILE_NAMES = Object.freeze([
    '00-core.md',
    '15-project-memory.md',
    '40-commands.md',
    '80-task-workflow.md',
    '90-skill-catalog.md'
]);

export interface RulePackStageArtifact {
    timestamp_utc: string;
    stage: RulePackStageLabel;
    status: 'PASSED' | 'FAILED';
    outcome: 'PASS' | 'FAIL';
    actor: string;
    required_rule_files: string[];
    loaded_rule_files: string[];
    missing_rule_files: string[];
    extra_rule_files: string[];
    required_rule_hashes: Record<string, string | null>;
    loaded_rule_hashes: Record<string, string | null>;
    required_rule_count: number;
    loaded_rule_count: number;
    effective_depth: number | null;
    preflight_path: string | null;
    preflight_hash_sha256: string | null;
    preflight_rule_pack_binding_sha256: string | null;
    preflight_event_sequence: number | null;
    required_reviews: Record<string, boolean> | null;
    violations: string[];
}

export interface RulePackArtifact {
    timestamp_utc: string;
    event_source: 'load-rule-pack';
    task_id: string;
    status: 'PASSED' | 'FAILED';
    outcome: 'PASS' | 'FAIL';
    latest_stage: RulePackStageLabel;
    stages: {
        task_entry?: RulePackStageArtifact;
        post_preflight?: RulePackStageArtifact;
    };
}

export interface BuildRulePackArtifactOptions {
    repoRoot: string;
    taskId: string;
    stage: RulePackStageLabel;
    loadedRuleFiles: string[];
    preflightPath?: string;
    taskModePath?: string;
    actor?: string;
    artifactPath?: string;
}

export interface RulePackEvidenceResult {
    task_id: string | null;
    stage: RulePackStageLabel;
    evidence_path: string | null;
    timeline_artifact_path: string | null;
    evidence_hash: string | null;
    evidence_status: string;
    evidence_outcome: string | null;
    evidence_task_id: string | null;
    evidence_source: string | null;
    evidence_stage: string | null;
    evidence_preflight_path: string | null;
    evidence_preflight_hash: string | null;
    evidence_preflight_rule_pack_binding_sha256: string | null;
    binding_equivalent_to_current_preflight: boolean;
    effective_depth: number | null;
    required_rule_files: string[];
    loaded_rule_files: string[];
    missing_rule_files: string[];
    stale_loaded_rule_file: string | null;
}

export interface TimelineEventEntry {
    event_type: string;
    sequence: number;
    details: Record<string, unknown> | null;
}

export interface PostPreflightSequenceEvidence {
    timeline_path: string;
    latest_preflight_sequence: number | null;
    latest_preflight_path: string | null;
    latest_post_preflight_rule_pack_sequence: number | null;
    latest_post_preflight_rule_pack_path: string | null;
    current_preflight_rule_pack_binding_sha256: string | null;
    latest_post_preflight_rule_pack_binding_sha256: string | null;
    binding_equivalent_to_current_preflight: boolean;
    violations: string[];
}

export interface PostPreflightRulePackRebindDecision {
    can_bind: boolean;
    reason: string;
    loaded_rule_files: string[];
    required_rule_files: string[];
    previous_preflight_path: string | null;
    previous_rule_pack_sequence: number | null;
}

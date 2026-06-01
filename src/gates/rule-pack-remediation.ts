import { normalizePath } from './helpers';
import { type RulePackEvidenceResult } from './rule-pack-types';

export function getRulePackEvidenceViolations(result: RulePackEvidenceResult): string[] {
    const evidencePath = result.evidence_path || '<missing>';
    switch (result.evidence_status) {
        case 'PASS':
            return [];
        case 'TASK_ID_MISSING':
            return ['Rule-pack evidence cannot be verified: task id is missing.'];
        case 'EVIDENCE_FILE_MISSING':
            return [
                `Rule-pack evidence missing: file not found at '${evidencePath}'. Run load-rule-pack before continuing task execution.`
            ];
        case 'EVIDENCE_INVALID_JSON':
            return [`Rule-pack evidence is invalid JSON at '${evidencePath}'. Re-run load-rule-pack.`];
        case 'EVIDENCE_TASK_MISMATCH':
            return [`Rule-pack evidence task mismatch. Expected '${result.task_id}', got '${result.evidence_task_id}'.`];
        case 'EVIDENCE_SOURCE_INVALID':
            return [`Rule-pack evidence source is invalid. Expected 'load-rule-pack', got '${result.evidence_source}'.`];
        case 'EVIDENCE_STAGE_MISSING':
            return [`Rule-pack evidence is missing required stage '${result.stage}' in '${evidencePath}'.`];
        case 'EVIDENCE_STAGE_INVALID':
            return [`Rule-pack evidence stage is invalid. Expected '${result.stage}', got '${result.evidence_stage}'.`];
        case 'EVIDENCE_ARTIFACT_PATH_MISMATCH':
            return [
                `Rule-pack evidence artifact path mismatch. Timeline recorded '${result.timeline_artifact_path}', ` +
                `but current evidence path is '${evidencePath}'. Re-run downstream gates with the rule-pack artifact path recorded by RULE_PACK_LOADED.`
            ];
        case 'EVIDENCE_PREFLIGHT_REQUIRED':
            return ['Rule-pack evidence for POST_PREFLIGHT requires the current preflight artifact path.'];
        case 'EVIDENCE_PREFLIGHT_PATH_MISMATCH':
            return [
                `Rule-pack evidence preflight path mismatch. Evidence path='${result.evidence_preflight_path}'. ` +
                'Refresh the current task cycle sequentially: classify-change -> load-rule-pack --stage POST_PREFLIGHT -> compile-gate.'
            ];
        case 'EVIDENCE_PREFLIGHT_HASH_MISMATCH':
            return [
                'Rule-pack evidence preflight hash mismatch. Re-run load-rule-pack --stage POST_PREFLIGHT for the current preflight artifact, ' +
                'then rerun compile-gate. Do not parallelize classify-change, POST_PREFLIGHT load-rule-pack, and compile-gate for the same task cycle.'
            ];
        case 'EVIDENCE_TASK_MODE_INVALID':
            return ['Rule-pack evidence cannot be verified because task-mode evidence is missing or invalid for the same task.'];
        case 'EVIDENCE_RULE_SET_INVALID':
            return [`Rule-pack evidence does not match the required downstream rule set for stage '${result.stage}'. Re-run load-rule-pack.`];
        case 'EVIDENCE_REQUIRED_RULES_MISSING':
            return [
                `Rule-pack evidence is missing required downstream rule files for stage '${result.stage}': ${result.missing_rule_files.join(', ')}.`
            ];
        case 'EVIDENCE_LOADED_RULE_STALE':
            return [
                `Rule-pack evidence loaded rule file '${normalizePath(result.stale_loaded_rule_file || '<unknown>')}' changed or cannot be hashed. Re-run load-rule-pack.`
            ];
        case 'EVIDENCE_NOT_PASS':
            return [
                `Rule-pack evidence must be PASSED/PASS, got status='${result.evidence_status}', outcome='${result.evidence_outcome}'.`
            ];
        default:
            return ['Rule-pack evidence is missing or invalid. Re-run load-rule-pack.'];
    }
}

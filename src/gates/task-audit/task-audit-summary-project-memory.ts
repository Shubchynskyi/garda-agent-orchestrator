import { type ProjectMemoryImpactLifecycleEvidence } from '../project-memory-impact';
import { type FinalCloseoutProjectMemorySummary } from './task-audit-summary';

export function buildFinalCloseoutProjectMemorySummary(
    evidence: ProjectMemoryImpactLifecycleEvidence
): FinalCloseoutProjectMemorySummary {
    return {
        enabled: evidence.enabled,
        required: evidence.required,
        mode: evidence.mode,
        evidence_status: evidence.evidence_status,
        status: evidence.status,
        update_needed: evidence.update_needed,
        affected_memory_files: [...evidence.affected_memory_files],
        updated_memory_files: [...evidence.updated_memory_files],
        compact_status: evidence.compact_status,
        compact_refreshed: evidence.compact_refreshed,
        artifact_path: evidence.artifact_path,
        update_artifact_path: evidence.update_artifact_path,
        visible_summary_line: evidence.visible_summary_line
    };
}



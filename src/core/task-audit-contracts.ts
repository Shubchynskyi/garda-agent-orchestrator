/**
 * Dependency-safe structural contracts consumed by runtime ledgers.
 *
 * Gate-owned audit result types are intentionally richer and remain assignable to
 * these contracts without making gate-runtime depend on the gates layer.
 */
export interface EvidenceArtifactContract {
    kind: string;
    path: string;
    exists: boolean;
    sha256: string | null;
}

export interface TaskAuditSummaryContract {
    task_id: string;
    generated_utc: string;
    status: 'PASS' | 'BLOCKED' | 'INCOMPLETE';
    first_event_utc: string | null;
    last_event_utc: string | null;
    integrity_status: string;
    gates: Array<{
        gate: string;
        status: 'PASS' | 'FAIL' | 'MISSING';
        timestamp_utc?: string | null;
    }>;
    changed_files: string[];
    changed_files_count: number;
    changed_lines_total: number;
    required_reviews: Record<string, boolean>;
    scope_category: string | null;
    evidence: EvidenceArtifactContract[];
    blockers: Array<{ gate: string; reason: string }>;
    point_in_time_snapshot: { status: string };
    review_attempt_summary?: {
        total_attempts: number;
        review_types: Array<{ reused_count: number }>;
    } | null;
    final_report_contract: { status: 'READY' | 'NOT_READY' };
    final_closeout: {
        artifact_paths: {
            json: string;
            markdown: string;
        };
        implementation_summary: {
            path_mode: string | null;
            changed_files_sha256?: string | null;
            scope_content_sha256?: string | null;
            scope_sha256?: string | null;
            review_verdicts: Record<string, string>;
        };
        review_trust?: { status: string } | null;
        review_integrity_attestation?: { status: string } | null;
        docs: {
            decision: string | null;
            behavior_changed: boolean;
            changelog_updated: boolean;
            docs_updated: string[];
        };
        project_memory?: {
            enabled: boolean;
            required: boolean;
            mode: string;
            evidence_status: string;
            status: string | null;
            update_needed: boolean | null;
            updated_memory_files: string[];
        } | null;
        workflow?: {
            mandatory_full_suite_enabled: boolean;
            visible_summary_line: string;
        } | null;
    };
}

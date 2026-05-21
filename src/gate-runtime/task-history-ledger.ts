import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TaskAuditSummaryResult } from '../gates/task-audit-summary';
import type { EvidenceArtifact } from '../gates/task-audit-summary-collectors';
import { fileSha256, toPosix } from '../gates/helpers';
import {
    buildRuntimeRetentionPreview,
    type RuntimeRetentionHealthState,
    type RuntimeRetentionTier
} from '../lifecycle/runtime-retention-policy';

export type TaskHistoryLedgerVerificationStatus = 'VERIFIED' | 'INCOMPLETE' | 'CONTRADICTORY';
export type TaskHistoryLedgerScanStatus = TaskHistoryLedgerVerificationStatus | 'MISSING' | 'INVALID';

export interface TaskHistoryLedgerArtifactRef {
    path: string;
    exists: boolean;
    sha256: string | null;
}

export interface TaskHistoryLedgerArtifact {
    schema_version: 1;
    event_source: 'task-history-ledger';
    task_id: string;
    generated_utc: string;
    audit_status: TaskAuditSummaryResult['status'];
    verification: {
        status: TaskHistoryLedgerVerificationStatus;
        issues: string[];
    };
    lifecycle: {
        queue_status: string | null;
        health_state: RuntimeRetentionHealthState | null;
        retention_tier: RuntimeRetentionTier | null;
        integrity_status: string;
        point_in_time_status: string;
        blocker_count: number;
    };
    timing: {
        first_event_utc: string | null;
        last_event_utc: string | null;
        compile_gate_timestamp: string | null;
    };
    scope: {
        path_mode: string | null;
        scope_category: string | null;
        changed_files: string[];
        changed_files_count: number;
        changed_lines_total: number;
        changed_files_sha256: string | null;
        scope_content_sha256: string | null;
        scope_sha256: string | null;
    };
    reviews: {
        required_review_types: string[];
        verdicts: Record<string, string>;
        trust_status: string | null;
        integrity_status: string | null;
        total_attempts: number | null;
        reused_attempts: number | null;
    };
    validations: {
        docs: {
            decision: string | null;
            behavior_changed: boolean;
            changelog_updated: boolean;
            docs_updated: string[];
        };
        project_memory: {
            enabled: boolean;
            required: boolean;
            mode: string | null;
            evidence_status: string | null;
            status: string | null;
            update_needed: boolean | null;
            updated_memory_files: string[];
        } | null;
        full_suite: {
            required: boolean;
            status: string | null;
            required_summary_line: string | null;
        };
    };
    artifact_refs: {
        task_events: TaskHistoryLedgerArtifactRef;
        preflight: TaskHistoryLedgerArtifactRef;
        compile_gate: TaskHistoryLedgerArtifactRef;
        review_gate: TaskHistoryLedgerArtifactRef;
        doc_impact: TaskHistoryLedgerArtifactRef;
        full_suite_validation: TaskHistoryLedgerArtifactRef;
        project_memory_impact: TaskHistoryLedgerArtifactRef;
        final_closeout_json: TaskHistoryLedgerArtifactRef;
        final_closeout_markdown: TaskHistoryLedgerArtifactRef;
    };
}

export interface TaskHistoryLedgerScanSummary {
    root_path: string;
    file_count: number;
    verified_count: number;
    incomplete_count: number;
    contradictory_count: number;
    invalid_count: number;
}

function inferBundleRootFromArtifactPath(artifactPath: string): string {
    return path.dirname(path.dirname(path.dirname(path.resolve(artifactPath))));
}

function buildArtifactRef(artifactPath: string): TaskHistoryLedgerArtifactRef {
    const resolvedPath = path.resolve(artifactPath);
    const exists = fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile();
    return {
        path: toPosix(resolvedPath),
        exists,
        sha256: exists ? fileSha256(resolvedPath) : null
    };
}

function findEvidenceArtifact(evidence: EvidenceArtifact[], kind: string): EvidenceArtifact | null {
    return evidence.find((artifact) => artifact.kind === kind) || null;
}

function resolveEvidencePath(summary: TaskAuditSummaryResult, kind: string, fallbackPath: string): string {
    const artifact = findEvidenceArtifact(summary.evidence, kind);
    return artifact ? path.resolve(artifact.path) : path.resolve(fallbackPath);
}

function readArtifactJson(artifactPath: string): Record<string, unknown> | null {
    try {
        if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
            return null;
        }
        return JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function normalizeCompileGateTimestamp(summary: TaskAuditSummaryResult): string | null {
    const compileGate = summary.gates.find((gate) => gate.gate === 'compile-gate' && gate.status === 'PASS');
    return compileGate?.timestamp_utc || null;
}

function summarizeReusedAttempts(summary: TaskAuditSummaryResult): number | null {
    const reviewTypes = summary.review_attempt_summary?.review_types || [];
    if (reviewTypes.length === 0) {
        return null;
    }
    return reviewTypes.reduce((total, item) => total + item.reused_count, 0);
}

function determineVerificationStatus(
    summary: TaskAuditSummaryResult,
    refs: TaskHistoryLedgerArtifact['artifact_refs'],
    requiredReviewTypes: string[],
    fullSuiteRequired: boolean
): { status: TaskHistoryLedgerVerificationStatus; issues: string[] } {
    const issues: string[] = [];
    let contradictory = false;

    if (!refs.task_events.exists) {
        issues.push('Task events artifact is missing.');
        contradictory = true;
    }
    if (!refs.preflight.exists) {
        issues.push('Preflight artifact is missing.');
    }
    if (summary.gates.some((gate) => gate.gate === 'compile-gate' && gate.status === 'PASS') && !refs.compile_gate.exists) {
        issues.push('Compile gate passed but compile artifact is missing.');
        contradictory = true;
    }
    if (summary.gates.some((gate) => gate.gate === 'required-reviews-check' && gate.status === 'PASS') && !refs.review_gate.exists) {
        issues.push('Review gate passed but review gate artifact is missing.');
        contradictory = true;
    }
    if (summary.gates.some((gate) => gate.gate === 'doc-impact-gate' && gate.status === 'PASS') && !refs.doc_impact.exists) {
        issues.push('Doc-impact gate passed but doc-impact artifact is missing.');
        contradictory = true;
    }
    if (fullSuiteRequired && summary.gates.some((gate) => gate.gate === 'full-suite-validation' && gate.status === 'PASS') && !refs.full_suite_validation.exists) {
        issues.push('Full-suite validation passed but full-suite artifact is missing.');
        contradictory = true;
    }
    if (summary.final_closeout.project_memory?.required && summary.final_closeout.project_memory.evidence_status !== 'NOT_REQUIRED' && !refs.project_memory_impact.exists) {
        issues.push('Project-memory evidence is required but project-memory artifact is missing.');
    }
    for (const reviewType of requiredReviewTypes) {
        if (!summary.final_closeout.implementation_summary.review_verdicts[reviewType]) {
            issues.push(`Required review verdict '${reviewType}' is missing from final closeout.`);
        }
    }
    if (summary.status === 'PASS' && summary.final_report_contract.status !== 'READY') {
        issues.push('Audit status is PASS but final report contract is not READY.');
        contradictory = true;
    }

    if (contradictory) {
        return {
            status: 'CONTRADICTORY',
            issues
        };
    }
    if (issues.length > 0) {
        return {
            status: 'INCOMPLETE',
            issues
        };
    }
    return {
        status: 'VERIFIED',
        issues: []
    };
}

export function resolveTaskHistoryLedgerRoot(bundleRoot: string): string {
    return path.join(bundleRoot, 'runtime', 'task-ledger');
}

export function resolveTaskHistoryLedgerPath(bundleRoot: string, taskId: string): string {
    return path.join(resolveTaskHistoryLedgerRoot(bundleRoot), `${taskId}.json`);
}

export function readTaskHistoryLedgerScanStatus(bundleRoot: string, taskId: string): TaskHistoryLedgerScanStatus {
    const ledgerPath = resolveTaskHistoryLedgerPath(bundleRoot, taskId);
    if (!fs.existsSync(ledgerPath) || !fs.statSync(ledgerPath).isFile()) {
        return 'MISSING';
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as Record<string, unknown>;
        if (parsed.schema_version !== 1 || parsed.event_source !== 'task-history-ledger' || parsed.task_id !== taskId) {
            return 'INVALID';
        }
        const verification = parsed.verification;
        if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
            return 'INVALID';
        }
        const status = String((verification as Record<string, unknown>).status || '').trim().toUpperCase();
        if (status === 'VERIFIED' || status === 'INCOMPLETE' || status === 'CONTRADICTORY') {
            return status as TaskHistoryLedgerScanStatus;
        }
        return 'INVALID';
    } catch {
        return 'INVALID';
    }
}

export function scanTaskHistoryLedgerRoot(bundleRoot: string): TaskHistoryLedgerScanSummary {
    const rootPath = resolveTaskHistoryLedgerRoot(bundleRoot);
    const summary: TaskHistoryLedgerScanSummary = {
        root_path: toPosix(rootPath),
        file_count: 0,
        verified_count: 0,
        incomplete_count: 0,
        contradictory_count: 0,
        invalid_count: 0
    };

    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
        return summary;
    }

    for (const entry of fs.readdirSync(rootPath)) {
        if (!entry.endsWith('.json')) {
            continue;
        }
        summary.file_count += 1;
        const status = readTaskHistoryLedgerScanStatus(bundleRoot, entry.slice(0, -'.json'.length));
        switch (status) {
            case 'VERIFIED':
                summary.verified_count += 1;
                break;
            case 'INCOMPLETE':
                summary.incomplete_count += 1;
                break;
            case 'CONTRADICTORY':
                summary.contradictory_count += 1;
                break;
            case 'INVALID':
                summary.invalid_count += 1;
                break;
            default:
                break;
        }
    }

    return summary;
}

export function buildTaskHistoryLedger(summary: TaskAuditSummaryResult, repoRoot: string): TaskHistoryLedgerArtifact {
    const finalCloseoutJsonPath = path.resolve(summary.final_closeout.artifact_paths.json);
    const bundleRoot = inferBundleRootFromArtifactPath(finalCloseoutJsonPath);
    const reviewsRoot = path.dirname(finalCloseoutJsonPath);
    const taskEventPath = resolveEvidencePath(
        summary,
        'task-events',
        path.join(bundleRoot, 'runtime', 'task-events', `${summary.task_id}.jsonl`)
    );
    const preflightPath = resolveEvidencePath(summary, 'preflight', path.join(reviewsRoot, `${summary.task_id}-preflight.json`));
    const compileGatePath = resolveEvidencePath(summary, 'compile-gate', path.join(reviewsRoot, `${summary.task_id}-compile-gate.json`));
    const reviewGatePath = resolveEvidencePath(summary, 'review-gate', path.join(reviewsRoot, `${summary.task_id}-review-gate.json`));
    const docImpactPath = resolveEvidencePath(summary, 'doc-impact', path.join(reviewsRoot, `${summary.task_id}-doc-impact.json`));
    const fullSuiteValidationPath = resolveEvidencePath(summary, 'full-suite-validation', path.join(reviewsRoot, `${summary.task_id}-full-suite-validation.json`));
    const projectMemoryImpactPath = path.join(bundleRoot, 'runtime', 'project-memory', `${summary.task_id}-impact.json`);

    const artifactRefs: TaskHistoryLedgerArtifact['artifact_refs'] = {
        task_events: buildArtifactRef(taskEventPath),
        preflight: buildArtifactRef(preflightPath),
        compile_gate: buildArtifactRef(compileGatePath),
        review_gate: buildArtifactRef(reviewGatePath),
        doc_impact: buildArtifactRef(docImpactPath),
        full_suite_validation: buildArtifactRef(fullSuiteValidationPath),
        project_memory_impact: buildArtifactRef(projectMemoryImpactPath),
        final_closeout_json: buildArtifactRef(finalCloseoutJsonPath),
        final_closeout_markdown: buildArtifactRef(summary.final_closeout.artifact_paths.markdown)
    };

    const retentionPreview = buildRuntimeRetentionPreview(
        repoRoot,
        bundleRoot,
        summary.evidence
            .filter((artifact) => artifact.kind === 'task-events' || artifact.path.includes('/runtime/reviews/') || artifact.path.includes('\\runtime\\reviews\\'))
            .map((artifact) => ({
                path: artifact.path,
                category: artifact.kind === 'task-events' ? 'task-events' : 'reviews'
            }))
    );
    const retentionTask = retentionPreview.tasks.find((task) => task.task_id === summary.task_id) || null;
    const docImpact = readArtifactJson(docImpactPath);
    const requiredReviewTypes = Object.entries(summary.required_reviews)
        .filter(([, required]) => required)
        .map(([reviewType]) => reviewType)
        .sort();
    const fullSuiteRequired = summary.final_closeout.workflow?.mandatory_full_suite_enabled === true;
    const verification = determineVerificationStatus(summary, artifactRefs, requiredReviewTypes, fullSuiteRequired);

    return {
        schema_version: 1,
        event_source: 'task-history-ledger',
        task_id: summary.task_id,
        generated_utc: summary.generated_utc,
        audit_status: summary.status,
        verification,
        lifecycle: {
            queue_status: retentionTask?.queue_status || null,
            health_state: retentionTask?.health_state || null,
            retention_tier: retentionTask?.retention_tier || null,
            integrity_status: summary.integrity_status,
            point_in_time_status: summary.point_in_time_snapshot.status,
            blocker_count: summary.blockers.length
        },
        timing: {
            first_event_utc: summary.first_event_utc,
            last_event_utc: summary.last_event_utc,
            compile_gate_timestamp: normalizeCompileGateTimestamp(summary)
        },
        scope: {
            path_mode: summary.final_closeout.implementation_summary.path_mode,
            scope_category: summary.scope_category,
            changed_files: summary.changed_files,
            changed_files_count: summary.changed_files_count,
            changed_lines_total: summary.changed_lines_total,
            changed_files_sha256: summary.final_closeout.implementation_summary.changed_files_sha256 || null,
            scope_content_sha256: summary.final_closeout.implementation_summary.scope_content_sha256 || null,
            scope_sha256: summary.final_closeout.implementation_summary.scope_sha256 || null
        },
        reviews: {
            required_review_types: requiredReviewTypes,
            verdicts: summary.final_closeout.implementation_summary.review_verdicts,
            trust_status: summary.final_closeout.review_trust?.status || null,
            integrity_status: summary.final_closeout.review_integrity_attestation?.status || null,
            total_attempts: summary.review_attempt_summary?.total_attempts || null,
            reused_attempts: summarizeReusedAttempts(summary)
        },
        validations: {
            docs: {
                decision: typeof docImpact?.decision === 'string' ? docImpact.decision : summary.final_closeout.docs.decision,
                behavior_changed: Boolean(docImpact?.behavior_changed ?? summary.final_closeout.docs.behavior_changed),
                changelog_updated: Boolean(docImpact?.changelog_updated ?? summary.final_closeout.docs.changelog_updated),
                docs_updated: Array.isArray(docImpact?.docs_updated)
                    ? (docImpact!.docs_updated as unknown[]).map((item) => String(item))
                    : summary.final_closeout.docs.docs_updated
            },
            project_memory: summary.final_closeout.project_memory
                ? {
                    enabled: summary.final_closeout.project_memory.enabled,
                    required: summary.final_closeout.project_memory.required,
                    mode: summary.final_closeout.project_memory.mode,
                    evidence_status: summary.final_closeout.project_memory.evidence_status,
                    status: summary.final_closeout.project_memory.status,
                    update_needed: summary.final_closeout.project_memory.update_needed,
                    updated_memory_files: summary.final_closeout.project_memory.updated_memory_files
                }
                : null,
            full_suite: {
                required: fullSuiteRequired,
                status: summary.gates.find((gate) => gate.gate === 'full-suite-validation')?.status || null,
                required_summary_line: summary.final_closeout.workflow?.visible_summary_line || null
            }
        },
        artifact_refs: artifactRefs
    };
}

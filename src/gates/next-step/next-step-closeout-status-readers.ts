import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import {
    getCycleBindingSnapshotFromPayload
} from '../task-events-summary/task-events-summary';
import {
    formatFinalCloseoutMarkdown,
    formatFinalUserReport,
    type TaskAuditSummaryResult
} from '../task-audit/task-audit-summary';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import {
    normalizePath
} from '../shared/helpers';
import {
    describePathList,
    getDocImpactDeclaredDocsUpdated,
    readPreflightWorkspaceReadiness
} from './next-step-compile-full-suite-readiness';
import {
    toRepoDisplayPath
} from './next-step-command-formatters';
import {
    getWorkspaceSnapshotCached,
    type WorkspaceSnapshot
} from '../workspace/workspace-snapshot-cache';
import {
    evaluateStagedPostDoneAuditedScope
} from '../task-audit/task-audit-summary-drift';

export interface NextStepFinalReportSummary {
    closeout_json_path: string;
    closeout_markdown_path: string;
    final_user_report_path: string;
    final_user_report_body: string;
    final_user_report_sha256: string;
    required_order: string[];
    commit_command_suggestion: string;
    commit_question: string;
}

export interface PostDoneWorkspaceDriftDecision {
    blocked: boolean;
    reason: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function getPreflightChangedFiles(preflight: Record<string, unknown> | null): string[] {
    return Array.isArray(preflight?.changed_files)
        ? [...new Set(preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
}

function getPostDoneAuditedChangedFiles(
    preflight: Record<string, unknown> | null,
    docImpactPath: string
): string[] {
    return [
        ...new Set([
            ...getPreflightChangedFiles(preflight),
            ...getDocImpactDeclaredDocsUpdated(docImpactPath).map((entry) => normalizePath(entry)).filter(Boolean)
        ])
    ].sort();
}

function isFinalReportCommitCommandSuggestion(value: string): boolean {
    const text = String(value || '').trim();
    return /^git commit -m /u.test(text)
        || /\bgarda(?:\.js)?\s+gate\s+human-commit\b/u.test(text)
        || /\bhuman-commit\s+--operator-confirmed\s+yes\b/u.test(text);
}

export function buildFinalReportOrder(summary: TaskAuditSummaryResult): string[] {
    const contractOrder = summary.final_report_contract.required_order.length > 0
        ? summary.final_report_contract.required_order
        : [
            'short agent-authored summary of what changed',
            'verbatim Garda final user report'
        ];
    const reportOrder = contractOrder
        .map((entry) => entry === 'implementation summary' ? 'short agent-authored summary of what changed' : entry)
        .filter((entry) => !isFinalReportCommitCommandSuggestion(entry))
        .filter((entry) => entry !== 'Do you want me to commit now? (yes/no)' && entry !== 'No commit confirmation required.')
        .filter((entry) => String(entry || '').trim().length > 0);
    if (
        isFinalReportCommitCommandSuggestion(summary.final_report_contract.commit_command_suggestion || '') &&
        summary.final_report_contract.commit_question === 'Do you want me to commit now? (yes/no)'
    ) {
        reportOrder.push(summary.final_report_contract.commit_command_suggestion);
        reportOrder.push(summary.final_report_contract.commit_question);
    }
    return reportOrder;
}

function finalCloseoutMatchesCurrentCycle(
    expected: TaskAuditSummaryResult['final_closeout']['cycle_binding'] | null | undefined,
    actualPayload: Record<string, unknown>,
    repoRoot: string
): boolean {
    const expectedBinding = expected || null;
    const actualBinding = getCycleBindingSnapshotFromPayload(actualPayload, repoRoot);
    if (!expectedBinding?.compile_gate_timestamp || !actualBinding?.compile_gate_timestamp) {
        return false;
    }
    if (actualBinding.compile_gate_timestamp !== expectedBinding.compile_gate_timestamp) {
        return false;
    }
    if (expectedBinding.preflight_sha256 && actualBinding.preflight_sha256 !== expectedBinding.preflight_sha256) {
        return false;
    }
    return !(expectedBinding.preflight_path && actualBinding.preflight_path !== expectedBinding.preflight_path);
}

export function readReadyFinalReportSummary(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    summary: TaskAuditSummaryResult
): NextStepFinalReportSummary | null {
    const closeoutJsonPath = path.join(reviewsRoot, `${taskId}-final-closeout.json`);
    const closeoutMarkdownPath = path.join(reviewsRoot, `${taskId}-final-closeout.md`);
    const finalUserReportPath = path.join(reviewsRoot, `${taskId}-final-user-report.md`);
    if (!fileExists(closeoutJsonPath) || !fileExists(closeoutMarkdownPath) || !fileExists(finalUserReportPath)) {
        return null;
    }

    const closeout = safeReadJson(closeoutJsonPath);
    if (!isPlainRecord(closeout)) {
        return null;
    }
    if (String(closeout.task_id || '').trim() !== taskId) {
        return null;
    }
    if (String(closeout.status || '').trim().toUpperCase() !== 'READY') {
        return null;
    }
    if (!finalCloseoutMatchesCurrentCycle(summary.final_closeout.cycle_binding, closeout, repoRoot)) {
        return null;
    }
    const generatedUtc = typeof closeout.generated_utc === 'string' ? closeout.generated_utc : '';
    const expectedCloseout = { ...summary.final_closeout, generated_utc: generatedUtc, artifact_state: 'MATERIALIZED' as const };
    const expectedAttestation = expectedCloseout.review_integrity_attestation;
    const expectedJson = `${JSON.stringify(expectedCloseout, null, 2)}\n`;
    if (!generatedUtc || !expectedAttestation || expectedAttestation.completion_allowed !== true || fs.readFileSync(closeoutJsonPath, 'utf8') !== expectedJson) {
        return null;
    }
    const expectedMarkdown = `${formatFinalCloseoutMarkdown(expectedCloseout)}\n`;
    if (fs.readFileSync(closeoutMarkdownPath, 'utf8') !== expectedMarkdown) {
        return null;
    }
    const expectedFinalUserReport = `${formatFinalUserReport(expectedCloseout)}\n`;
    const actualFinalUserReport = fs.readFileSync(finalUserReportPath, 'utf8');
    if (actualFinalUserReport !== expectedFinalUserReport) {
        return null;
    }

    return {
        closeout_json_path: toRepoDisplayPath(repoRoot, closeoutJsonPath),
        closeout_markdown_path: toRepoDisplayPath(repoRoot, closeoutMarkdownPath),
        final_user_report_path: toRepoDisplayPath(repoRoot, finalUserReportPath),
        final_user_report_body: actualFinalUserReport,
        final_user_report_sha256: sha256Text(actualFinalUserReport),
        required_order: buildFinalReportOrder(summary),
        commit_command_suggestion: summary.final_report_contract.commit_command_suggestion,
        commit_question: summary.final_report_contract.commit_question
    };
}

export function readPostDoneWorkspaceDriftDecision(
    repoRoot: string,
    preflight: Record<string, unknown> | null,
    docImpactPath: string,
    finalCloseoutJsonPath: string
): PostDoneWorkspaceDriftDecision {
    if (!preflight) {
        return { blocked: false, reason: 'No preflight is available for post-DONE drift comparison.' };
    }

    const normalizedDetectionSource = String(preflight.detection_source || 'git_auto').trim().toLowerCase();
    const includeUntracked = normalizedDetectionSource === 'git_staged_only'
        ? false
        : (typeof preflight.include_untracked === 'boolean' ? preflight.include_untracked : true);
    let currentSnapshot: WorkspaceSnapshot & { cache_hit: boolean };
    try {
        currentSnapshot = getWorkspaceSnapshotCached(repoRoot, 'git_auto', includeUntracked, [], {
            noCache: true,
            readOnly: true
        });
    } catch (error) {
        const gitMetadataPath = path.join(repoRoot, '.git');
        if (!fs.existsSync(gitMetadataPath)) {
            return { blocked: false, reason: 'Workspace inspection is unavailable outside a git worktree.' };
        }
        return {
            blocked: true,
            reason:
                'Unable to inspect tracked post-DONE workspace drift for the completed task closeout: ' +
                `${error instanceof Error ? error.message : String(error)}. ` +
                'Do not report the task as DONE until workspace drift can be inspected or the task is explicitly reopened/reset.'
        };
    }
    const auditedChangedFiles = getPostDoneAuditedChangedFiles(preflight, docImpactPath);
    const auditedSet = new Set(auditedChangedFiles);
    const currentChangedFiles = currentSnapshot.changed_files.map((entry) => normalizePath(entry)).filter(Boolean);
    const unexpectedFiles = currentChangedFiles.filter((entry) => !auditedSet.has(entry));
    if (unexpectedFiles.length > 0) {
        return {
            blocked: true,
            reason:
                `Tracked post-DONE workspace drift detected outside completed scope ${describePathList(auditedChangedFiles)}: ` +
                `${describePathList(unexpectedFiles)}. ` +
                'Do not reopen stale lifecycle gates automatically. Commit or isolate the already-completed task diff, or explicitly reopen/reset the task before running classify, compile, review, full-suite, or completion gates again.'
        };
    }
    const stagedScopeDecision = evaluateStagedPostDoneAuditedScope({
        repoRoot,
        auditedFiles: auditedChangedFiles,
        currentChangedFiles,
        finalCloseoutJsonPath
    });
    if (stagedScopeDecision) {
        return stagedScopeDecision.blocked
            ? { blocked: true, reason: stagedScopeDecision.reason }
            : { blocked: false, reason: stagedScopeDecision.reason };
    }
    const closeout = safeReadJson(finalCloseoutJsonPath);
    const implementationSummary = isPlainRecord(closeout?.implementation_summary) ? closeout.implementation_summary : null;
    const expectedAuditedScopeContentSha256 = typeof implementationSummary?.scope_content_sha256 === 'string'
        ? implementationSummary.scope_content_sha256.trim().toLowerCase()
        : '';
    const expectedAuditedChangedFilesSha256 = typeof implementationSummary?.changed_files_sha256 === 'string'
        ? implementationSummary.changed_files_sha256.trim().toLowerCase()
        : '';
    if ((expectedAuditedScopeContentSha256 || expectedAuditedChangedFilesSha256) && auditedChangedFiles.length > 0) {
        let currentAuditedScope: WorkspaceSnapshot & { cache_hit: boolean };
        try {
            currentAuditedScope = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', includeUntracked, auditedChangedFiles, {
                noCache: true,
                readOnly: true
            });
        } catch (error) {
            return {
                blocked: true,
                reason:
                    'Unable to inspect audited post-DONE closeout content: ' +
                    `${error instanceof Error ? error.message : String(error)}. ` +
                    'Do not report the task as DONE until workspace drift can be inspected or the task is explicitly reopened/reset.'
            };
        }
        const auditedViolations = [
            expectedAuditedScopeContentSha256 && currentAuditedScope.scope_content_sha256 !== expectedAuditedScopeContentSha256
                ? `audited scope_content_sha256=${expectedAuditedScopeContentSha256} differs from current audited scope_content_sha256=${currentAuditedScope.scope_content_sha256}`
                : '',
            expectedAuditedChangedFilesSha256 && currentAuditedScope.changed_files_sha256 !== expectedAuditedChangedFilesSha256
                ? `audited changed_files_sha256=${expectedAuditedChangedFilesSha256} differs from current audited changed_files_sha256=${currentAuditedScope.changed_files_sha256}`
                : ''
        ].filter(Boolean);
        if (auditedViolations.length === 0) {
            return { blocked: false, reason: 'Audited final closeout scope still matches the current workspace after DONE.' };
        }
        return {
            blocked: true,
            reason:
                `Tracked post-DONE workspace drift detected in audited completed scope ${describePathList(auditedChangedFiles)}: ` +
                `${auditedViolations.join('; ')}. ` +
                'Do not reopen stale lifecycle gates automatically. Commit or isolate the already-completed task diff, or explicitly reopen/reset the task before running classify, compile, review, full-suite, or completion gates again.'
        };
    }

    if (currentSnapshot.changed_files.length === 0) {
        return { blocked: false, reason: 'Workspace is clean after DONE.' };
    }

    const readiness = readPreflightWorkspaceReadiness(repoRoot, preflight, {
        docImpactPath,
        allowDocsOnlyDelta: false
    });
    if (readiness.ready) {
        return { blocked: false, reason: readiness.reason };
    }

    return {
        blocked: true,
        reason:
            `Tracked post-DONE workspace drift detected in completed scope ${describePathList(getPreflightChangedFiles(preflight))}: ${readiness.reason} ` +
            'Do not reopen stale lifecycle gates automatically. Commit or isolate the already-completed task diff, or explicitly reopen/reset the task before running classify, compile, review, full-suite, or completion gates again.'
    };
}

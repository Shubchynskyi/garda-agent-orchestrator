import * as fs from 'node:fs';
import * as path from 'node:path';
import { getClassificationConfig, isSafeOrdinaryDocumentationPath } from '../preflight/classify-change';
import { getWorkspaceSnapshotCached } from '../workspace/workspace-snapshot-cache';
import { toPosix } from '../shared/helpers';
import {
    type BlockerEntry,
    type FinalCloseoutDocsSummary,
    safeReadJson
} from './task-audit-summary-collectors';

export function buildAuditedChangedFiles(
    repoRoot: string,
    preflightChangedFiles: string[],
    docsSummary: FinalCloseoutDocsSummary
): { changedFiles: string[]; violations: string[] } {
    const changedFiles: string[] = [];
    const seen = new Set<string>();
    const preflightPathSet = new Set(preflightChangedFiles.map((entry) => toPosix(String(entry || '').trim())).filter(Boolean));
    const classificationConfig = getClassificationConfig(repoRoot);
    const violations: string[] = [];
    const appendPath = (value: unknown): void => {
        const normalized = toPosix(String(value || '').trim());
        if (!normalized || seen.has(normalized)) {
            return;
        }
        seen.add(normalized);
        changedFiles.push(normalized);
    };

    for (const changedFile of preflightChangedFiles) {
        appendPath(changedFile);
    }
    if (docsSummary.decision === 'DOCS_UPDATED') {
        for (const docsUpdatedPath of docsSummary.docs_updated) {
            const normalized = toPosix(String(docsUpdatedPath || '').trim());
            if (!normalized || preflightPathSet.has(normalized)) {
                appendPath(normalized);
                continue;
            }
            const isAcceptedDocPath = isSafeOrdinaryDocumentationPath(normalized, classificationConfig);
            if (isAcceptedDocPath) {
                appendPath(normalized);
                continue;
            }
            if (isInternalCloseoutEvidencePath(normalized)) {
                appendPath(normalized);
                continue;
            }
            violations.push(
                `Doc impact docs_updated contains non-documentation path '${normalized}' that is not in preflight changed_files. ` +
                'Refresh preflight for implementation drift or remove the path from docs_updated.'
            );
        }
    }
    return { changedFiles, violations };
}

function isInternalCloseoutEvidencePath(normalizedPath: string): boolean {
    return normalizedPath === 'garda-agent-orchestrator/live/docs/changes/CHANGELOG.md'
        || normalizedPath.startsWith('garda-agent-orchestrator/live/docs/project-memory/');
}

export function buildPostDoneWorkspaceDriftBlocker(
    repoRoot: string,
    auditedChangedFiles: string[],
    preflightChangedFiles: string[],
    preflight: Record<string, unknown> | null,
    finalCloseoutJsonPath: string
): BlockerEntry | null {
    let currentChangedFiles: string[];
    try {
        currentChangedFiles = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, [], {
            noCache: true,
            readOnly: true
        }).changed_files.map((entry) => toPosix(entry)).filter(Boolean);
    } catch (error) {
        const gitMetadataPath = path.join(repoRoot, '.git');
        if (!fs.existsSync(gitMetadataPath)) {
            return null;
        }
        return {
            gate: 'post-done-drift',
            reason:
                'Unable to inspect tracked post-DONE workspace drift for the completed task closeout: ' +
                `${error instanceof Error ? error.message : String(error)}. ` +
                'Do not report final closeout as ready until workspace drift can be inspected or the task is explicitly reopened/reset.'
        };
    }
    const auditedSet = new Set(auditedChangedFiles.map((entry) => toPosix(entry)).filter(Boolean));
    const auditedScopeBlocker = buildPostDoneAuditedScopeDriftBlocker(
        repoRoot,
        [...auditedSet].sort(),
        finalCloseoutJsonPath
    );
    if (auditedScopeBlocker) {
        return auditedScopeBlocker;
    }
    if (currentChangedFiles.length === 0) {
        return null;
    }

    const unexpectedFiles = [...new Set(currentChangedFiles.filter((entry) => !auditedSet.has(entry)))].sort();
    if (unexpectedFiles.length === 0) {
        return buildPostDoneSameScopeDriftBlocker(
            repoRoot,
            auditedChangedFiles,
            preflightChangedFiles,
            preflight,
            finalCloseoutJsonPath
        );
    }

    return {
        gate: 'post-done-drift',
        reason:
            'Tracked post-DONE workspace drift exists outside the completed task closeout scope: ' +
            `${unexpectedFiles.join(', ')}. ` +
            'Do not reopen classify, compile, review, full-suite, or completion gates automatically; isolate or explicitly reopen/reset the task before continuing.'
    };
}

function buildPostDoneSameScopeDriftBlocker(
    repoRoot: string,
    auditedChangedFiles: string[],
    preflightChangedFiles: string[],
    preflight: Record<string, unknown> | null,
    finalCloseoutJsonPath: string
): BlockerEntry | null {
    const implementationFiles = [...new Set(preflightChangedFiles.map((entry) => toPosix(entry)).filter(Boolean))].sort();
    const auditedFiles = [...new Set(auditedChangedFiles.map((entry) => toPosix(entry)).filter(Boolean))].sort();
    if (implementationFiles.length === 0) {
        return buildPostDoneAuditedScopeDriftBlocker(repoRoot, auditedFiles, finalCloseoutJsonPath);
    }
    if (!preflight || typeof preflight !== 'object') {
        return null;
    }
    const metrics = preflight.metrics && typeof preflight.metrics === 'object'
        ? preflight.metrics as Record<string, unknown>
        : null;
    const expectedScopeContentSha256 = typeof metrics?.scope_content_sha256 === 'string'
        ? metrics.scope_content_sha256.trim().toLowerCase()
        : '';
    const expectedChangedLinesTotal = typeof metrics?.changed_lines_total === 'number'
        ? metrics.changed_lines_total
        : Number(metrics?.changed_lines_total);
    if (!expectedScopeContentSha256 && !Number.isFinite(expectedChangedLinesTotal)) {
        return null;
    }

    let currentImplementationSnapshot: ReturnType<typeof getWorkspaceSnapshotCached>;
    try {
        currentImplementationSnapshot = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', true, implementationFiles, {
            noCache: true,
            readOnly: true
        });
    } catch (error) {
        const gitMetadataPath = path.join(repoRoot, '.git');
        if (!fs.existsSync(gitMetadataPath)) {
            return null;
        }
        return {
            gate: 'post-done-drift',
            reason:
                'Unable to inspect audited post-DONE implementation content for the completed task closeout: ' +
                `${error instanceof Error ? error.message : String(error)}. ` +
                'Do not report final closeout as ready until workspace drift can be inspected or the task is explicitly reopened/reset.'
        };
    }

    const currentScopeContentSha256 = typeof currentImplementationSnapshot.scope_content_sha256 === 'string'
        ? currentImplementationSnapshot.scope_content_sha256.trim().toLowerCase()
        : '';
    const contentChanged = !!expectedScopeContentSha256
        && !!currentScopeContentSha256
        && currentScopeContentSha256 !== expectedScopeContentSha256;
    const lineCountChanged = Number.isFinite(expectedChangedLinesTotal)
        && currentImplementationSnapshot.changed_lines_total !== expectedChangedLinesTotal;
    if (!contentChanged && !lineCountChanged) {
        return buildPostDoneAuditedScopeDriftBlocker(repoRoot, auditedFiles, finalCloseoutJsonPath);
    }

    const details = [
        contentChanged ? 'scope_content_sha256 differs from completed preflight' : '',
        lineCountChanged ? `changed_lines_total ${currentImplementationSnapshot.changed_lines_total} differs from completed preflight ${expectedChangedLinesTotal}` : ''
    ].filter(Boolean).join('; ');
    return {
        gate: 'post-done-drift',
        reason:
            'Tracked post-DONE workspace drift changed audited implementation content: ' +
            `${implementationFiles.join(', ')} (${details}). ` +
            'Do not reopen classify, compile, review, full-suite, or completion gates automatically; isolate or explicitly reopen/reset the task before continuing.'
    };
}

function buildPostDoneAuditedScopeDriftBlocker(
    repoRoot: string,
    auditedFiles: string[],
    finalCloseoutJsonPath: string
): BlockerEntry | null {
    if (auditedFiles.length === 0) {
        return null;
    }
    const closeout = safeReadJson(finalCloseoutJsonPath);
    const implementationSummary = closeout && typeof closeout.implementation_summary === 'object'
        ? closeout.implementation_summary as Record<string, unknown>
        : null;
    const expectedScopeContentSha256 = typeof implementationSummary?.scope_content_sha256 === 'string'
        ? implementationSummary.scope_content_sha256.trim().toLowerCase()
        : '';
    const expectedChangedFilesSha256 = typeof implementationSummary?.changed_files_sha256 === 'string'
        ? implementationSummary.changed_files_sha256.trim().toLowerCase()
        : '';
    if (!expectedScopeContentSha256 && !expectedChangedFilesSha256) {
        return null;
    }

    let currentAuditedSnapshot: ReturnType<typeof getWorkspaceSnapshotCached>;
    try {
        currentAuditedSnapshot = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', true, auditedFiles, {
            noCache: true,
            readOnly: true
        });
    } catch (error) {
        const gitMetadataPath = path.join(repoRoot, '.git');
        if (!fs.existsSync(gitMetadataPath)) {
            return null;
        }
        return {
            gate: 'post-done-drift',
            reason:
                'Unable to inspect audited post-DONE closeout content: ' +
                `${error instanceof Error ? error.message : String(error)}. ` +
                'Do not report final closeout as ready until workspace drift can be inspected or the task is explicitly reopened/reset.'
        };
    }

    const contentChanged = !!expectedScopeContentSha256
        && currentAuditedSnapshot.scope_content_sha256 !== expectedScopeContentSha256;
    const fileSetChanged = !!expectedChangedFilesSha256
        && currentAuditedSnapshot.changed_files_sha256 !== expectedChangedFilesSha256;
    if (!contentChanged && !fileSetChanged) {
        return null;
    }

    const details = [
        contentChanged ? 'audited scope_content_sha256 differs from materialized final closeout' : '',
        fileSetChanged ? 'audited changed_files_sha256 differs from materialized final closeout' : ''
    ].filter(Boolean).join('; ');
    return {
        gate: 'post-done-drift',
        reason:
            'Tracked post-DONE workspace drift changed audited closeout content: ' +
            `${auditedFiles.join(', ')} (${details}). ` +
            'Do not reopen classify, compile, review, full-suite, or completion gates automatically; isolate or explicitly reopen/reset the task before continuing.'
    };
}


export function isLocalControlPlaneCommitPath(filePath: string): boolean {
    const normalized = toPosix(String(filePath || '').trim()).replace(/^\.\//, '');
    if (!normalized) {
        return false;
    }
    return normalized === 'TASK.md'
        || normalized.startsWith('garda-agent-orchestrator/runtime/')
        || normalized.startsWith('garda-agent-orchestrator/live/')
        || normalized === 'garda-agent-orchestrator/live/docs/changes/CHANGELOG.md';
}

export function resolveCommittableChangedFiles(repoRoot: string): string[] | null {
    try {
        const currentWorkspaceSnapshot = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, [], {
            noCache: true,
            readOnly: true
        });
        const changedFiles = Array.isArray(currentWorkspaceSnapshot.changed_files)
            ? currentWorkspaceSnapshot.changed_files
            : [];
        return changedFiles
            .map((changedFile) => toPosix(String(changedFile || '').trim()))
            .filter((changedFile) => changedFile && !isLocalControlPlaneCommitPath(changedFile))
            .sort((left, right) => left.localeCompare(right));
    } catch {
        return null;
    }
}

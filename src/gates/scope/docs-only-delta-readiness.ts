import { createHash } from 'node:crypto';
import * as path from 'node:path';

import {
    getClassificationConfig,
    isSafeOrdinaryDocumentationPath,
    type ResolvedClassificationConfig
} from '../preflight/classify-change';
import {
    buildDomainScopeFingerprints,
    normalizeDomainScopeFingerprints
} from './domain-scope-fingerprints';
import {
    isReviewReuseNeutralCloseoutEvidencePath
} from './closeout-evidence-paths';
import {
    normalizePath
} from '../shared/helpers';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import {
    getWorkspaceSnapshotCached,
    type WorkspaceSnapshot
} from '../workspace/workspace-snapshot-cache';

export interface DocsOnlyDeltaReadiness {
    ready: boolean;
    reason: string;
    currentChangedFiles?: string[];
    acceptedDocsOnlyDeltaFiles?: string[];
    acceptedCloseoutOnlyDeltaFiles?: string[];
    awaitingMaterializedPlannedScope?: boolean;
}

export function buildCompileEvidenceDocsOnlyExtensionReadiness(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    currentPreflight: Record<string, unknown>
): DocsOnlyDeltaReadiness | null {
    const compileEvidence = safeReadJson(path.join(reviewsRoot, `${taskId}-compile-gate.json`));
    if (!isPlainRecord(compileEvidence)) {
        return null;
    }
    return buildCompileEvidenceDocsOnlyExtensionReadinessFromEvidence(
        repoRoot,
        compileEvidence,
        currentPreflight
    );
}

export function buildCompileEvidenceDocsOnlyExtensionReadinessFromEvidence(
    repoRoot: string,
    compileEvidence: Record<string, unknown>,
    currentPreflight: Record<string, unknown>
): DocsOnlyDeltaReadiness | null {
    const evidenceStatus = String(compileEvidence.status || '').trim().toUpperCase();
    const evidenceOutcome = String(compileEvidence.outcome || '').trim().toUpperCase();
    if (evidenceStatus !== 'PASSED' || evidenceOutcome !== 'PASS') {
        return null;
    }
    const compileChangedFiles = Array.isArray(compileEvidence.scope_changed_files)
        ? [...new Set(compileEvidence.scope_changed_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
    const currentChangedFiles = Array.isArray(currentPreflight.changed_files)
        ? [...new Set(currentPreflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
    if (compileChangedFiles.length === 0 || currentChangedFiles.length === 0) {
        return null;
    }
    const compileFileSet = new Set(compileChangedFiles);
    const addedFiles = currentChangedFiles.filter((entry) => !compileFileSet.has(entry));
    const removedFiles = compileChangedFiles.filter((entry) => !currentChangedFiles.includes(entry));
    if (addedFiles.length === 0 || removedFiles.length > 0) {
        return null;
    }

    const detectionSource = String(
        compileEvidence.scope_detection_source || currentPreflight.detection_source || 'git_auto'
    ).trim() || 'git_auto';
    const includeUntracked = compileEvidence.scope_include_untracked == null
        ? true
        : !!compileEvidence.scope_include_untracked;
    const changedLinesTotal = Number(compileEvidence.scope_changed_lines_total);
    if (!Number.isFinite(changedLinesTotal) || changedLinesTotal < 0) {
        return null;
    }
    const changedFilesSha256 = String(compileEvidence.scope_changed_files_sha256 || '').trim().toLowerCase()
        || stringSha256(compileChangedFiles.join('\n'));
    const scopeContentSha256 = String(compileEvidence.scope_content_sha256 || '').trim().toLowerCase();
    const compiledDomainScopeFingerprints = normalizeDomainScopeFingerprints(
        isPlainRecord(compileEvidence.domain_scope_fingerprints)
            ? compileEvidence.domain_scope_fingerprints
            : null
    ) || buildDomainScopeFingerprints({
        repoRoot,
        detectionSource,
        includeUntracked,
        changedFiles: compileChangedFiles
    });

    return buildDocsOnlyDeltaReadiness(
        repoRoot,
        currentChangedFiles,
        compileChangedFiles,
        changedLinesTotal,
        includeUntracked,
        detectionSource,
        changedFilesSha256,
        scopeContentSha256,
        [],
        compiledDomainScopeFingerprints
    );
}

export function getDocImpactDeclaredDocsUpdated(docImpactPath: string | null | undefined): string[] {
    if (!docImpactPath) {
        return [];
    }
    const docImpact = safeReadJson(docImpactPath);
    if (!docImpact || String(docImpact.decision || '').trim().toUpperCase() !== 'DOCS_UPDATED') {
        return [];
    }
    return Array.isArray(docImpact.docs_updated)
        ? [...new Set(docImpact.docs_updated.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
}

export function buildDocsOnlyDeltaReadiness(
    repoRoot: string,
    currentChangedFiles: string[],
    preflightChangedFiles: string[],
    expectedChangedLinesTotal: number,
    includeUntracked: boolean,
    detectionSource: string,
    expectedChangedFilesSha256: string,
    expectedScopeContentSha256: string,
    declaredDocsUpdated: string[],
    expectedDomainScopeFingerprints: ReturnType<typeof normalizeDomainScopeFingerprints>
): DocsOnlyDeltaReadiness | null {
    if (!isReviewScopeDetectionSourceSupportedForDocImpactExemption(detectionSource)) {
        return null;
    }

    const classificationConfig = getClassificationConfig(repoRoot);

    const preflightSet = new Set(preflightChangedFiles);
    const currentFiles = [...new Set(currentChangedFiles.map((entry) => normalizePath(entry)).filter(Boolean))].sort();
    const missingPreflightFiles = preflightChangedFiles.filter((entry) => !currentFiles.includes(entry));
    const docsOnlyDeltaFiles = currentFiles.filter((entry) => !preflightSet.has(entry));
    if (missingPreflightFiles.length > 0 || docsOnlyDeltaFiles.length === 0) {
        return null;
    }

    const declaredDocsSet = declaredDocsUpdated.length > 0
        ? new Set(declaredDocsUpdated.map((entry) => normalizePath(entry)).filter(Boolean))
        : null;
    const currentDomainScopeFingerprints = buildDomainScopeFingerprints({
        repoRoot,
        detectionSource,
        includeUntracked,
        changedFiles: currentFiles
    });
    const acceptedDocsDeltaFiles = docsOnlyDeltaFiles.filter((filePath) => {
        const normalizedPath = normalizePath(filePath);
        return currentDomainScopeFingerprints.domains.docs.changed_files.includes(normalizedPath);
    });
    const acceptedCloseoutDeltaFiles = docsOnlyDeltaFiles.filter((filePath) => {
        const normalizedPath = normalizePath(filePath);
        return currentDomainScopeFingerprints.domains.closeout.changed_files.includes(normalizedPath)
            && isReviewReuseNeutralCloseoutEvidencePath(normalizedPath);
    });
    const acceptedDeltaFiles = [...acceptedDocsDeltaFiles, ...acceptedCloseoutDeltaFiles].sort();
    if (acceptedDeltaFiles.length !== docsOnlyDeltaFiles.length) {
        return null;
    }
    if (declaredDocsSet) {
        const undeclaredDocs = acceptedDocsDeltaFiles.filter((entry) => !declaredDocsSet.has(entry));
        if (undeclaredDocs.length > 0) {
            return null;
        }
    }
    if (expectedDomainScopeFingerprints) {
        const protectedDomains = ['implementation', 'test', 'config'] as const;
        const staleDomains = protectedDomains.filter((domain) => (
            expectedDomainScopeFingerprints.domains[domain].scope_sha256
            && currentDomainScopeFingerprints.domains[domain].scope_sha256
            && expectedDomainScopeFingerprints.domains[domain].scope_sha256
                !== currentDomainScopeFingerprints.domains[domain].scope_sha256
        ));
        if (staleDomains.length > 0) {
            return null;
        }
        return {
            ready: true,
            reason:
                'Preflight implementation/test/config domains still match the current workspace after accepting docs/closeout updates. ' +
                `Docs: ${describePathList(acceptedDocsDeltaFiles)}; closeout: ${describePathList(acceptedCloseoutDeltaFiles)}.`,
            currentChangedFiles: currentFiles,
            acceptedDocsOnlyDeltaFiles: acceptedDocsDeltaFiles,
            acceptedCloseoutOnlyDeltaFiles: acceptedCloseoutDeltaFiles
        };
    }

    if (isStagedReviewScopeDetectionSource(detectionSource)) {
        return null;
    }

    const nonOrdinaryDocs = docsOnlyDeltaFiles.filter((filePath) => !isOrdinaryDocumentationDeltaPath(filePath, classificationConfig));
    if (nonOrdinaryDocs.length > 0) {
        return null;
    }

    const currentReviewScope = getWorkspaceSnapshotCached(
        repoRoot,
        'explicit_changed_files',
        includeUntracked,
        preflightChangedFiles,
        { noCache: true, readOnly: true }
    );
    const reviewScopeViolations: string[] = [];
    if (currentReviewScope.changed_files_sha256 !== expectedChangedFilesSha256) {
        reviewScopeViolations.push('preflight changed_files differ from the current non-doc workspace snapshot');
    }
    if (currentReviewScope.changed_lines_total !== expectedChangedLinesTotal) {
        reviewScopeViolations.push(
            `preflight changed_lines_total=${expectedChangedLinesTotal} differs from current non-doc changed_lines_total=${currentReviewScope.changed_lines_total}`
        );
    }
    if (
        expectedScopeContentSha256
        && currentReviewScope.scope_content_sha256 !== expectedScopeContentSha256
    ) {
        reviewScopeViolations.push(
            `preflight scope_content_sha256=${expectedScopeContentSha256} differs from current non-doc scope_content_sha256=${currentReviewScope.scope_content_sha256}`
        );
    }
    if (reviewScopeViolations.length > 0) {
        return null;
    }

    return {
        ready: true,
        reason:
            'Preflight implementation scope still matches the current workspace after accepting ordinary docs-only updates for doc-impact: ' +
            `${describePathList(docsOnlyDeltaFiles)}.`,
        currentChangedFiles: currentFiles,
        acceptedDocsOnlyDeltaFiles: docsOnlyDeltaFiles
    };
}

export function stringSha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function describePathList(paths: readonly string[], limit = 8): string {
    const normalized = [...new Set(paths.map((entry) => normalizePath(entry)).filter(Boolean))].sort();
    if (normalized.length === 0) {
        return '[]';
    }
    const visible = normalized.slice(0, limit);
    const suffix = normalized.length > visible.length ? `, ... +${normalized.length - visible.length} more` : '';
    return `[${visible.join(', ')}${suffix}]`;
}

export function readCurrentGitWorkspaceSnapshot(
    repoRoot: string,
    includeUntracked: boolean
): (WorkspaceSnapshot & { cache_hit: boolean }) | null {
    try {
        return getWorkspaceSnapshotCached(repoRoot, 'git_auto', includeUntracked, [], {
            noCache: true,
            readOnly: true
        });
    } catch {
        return null;
    }
}

function isReviewScopeDetectionSourceSupportedForDocImpactExemption(detectionSource: string): boolean {
    const normalized = String(detectionSource || '').trim().toLowerCase();
    return normalized === 'git_auto'
        || normalized === 'explicit_changed_files'
        || normalized === 'git_staged_only'
        || normalized === 'git_staged_plus_untracked';
}

function isStagedReviewScopeDetectionSource(detectionSource: string): boolean {
    const normalized = String(detectionSource || '').trim().toLowerCase();
    return normalized === 'git_staged_only' || normalized === 'git_staged_plus_untracked';
}

function isOrdinaryDocumentationDeltaPath(
    filePath: string,
    classificationConfig: ResolvedClassificationConfig
): boolean {
    return isSafeOrdinaryDocumentationPath(filePath, classificationConfig);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

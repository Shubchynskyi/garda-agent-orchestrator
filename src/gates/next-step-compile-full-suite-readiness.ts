import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    collectOrderedTimelineEvents
} from './completion-evidence';
import {
    formatCompileInfraRecoveryHintLine
} from './compile-infra-recovery-hints';
import {
    getClassificationConfig,
    isSafeOrdinaryDocumentationPath,
    type ResolvedClassificationConfig
} from './classify-change';
import {
    buildDomainScopeFingerprints,
    normalizeDomainScopeFingerprints
} from './domain-scope-fingerprints';
import {
    fileSha256,
    normalizePath
} from './helpers';
import {
    findLatestTimelineEvent
} from './next-step-timeline-readers';
import {
    safeReadJson
} from './task-audit-summary-collectors';
import {
    getWorkspaceSnapshotCached,
    type WorkspaceSnapshot
} from './workspace-snapshot-cache';

export interface CompileReadiness {
    ready: boolean;
    reason: string;
    recoveryGate?: 'classify-change';
}

export interface PreflightWorkspaceReadiness {
    ready: boolean;
    reason: string;
    currentChangedFiles?: string[];
    acceptedDocsOnlyDeltaFiles?: string[];
    acceptedCloseoutOnlyDeltaFiles?: string[];
    awaitingMaterializedPlannedScope?: boolean;
}

export interface PreflightWorkspaceReadinessOptions {
    failedReviewType?: string | null;
    failedReviewVerdict?: string | null;
    docImpactPath?: string | null;
    allowDocsOnlyDelta?: boolean;
    plannedChangedFiles?: string[];
}

export function readCompileReadiness(
    repoRoot: string,
    reviewsRoot: string,
    eventsRoot: string,
    taskId: string,
    preflightPath: string
): CompileReadiness {
    const compilePath = path.join(reviewsRoot, `${taskId}-compile-gate.json`);
    if (!fileExists(compilePath)) {
        return {
            ready: false,
            reason: `Compile gate evidence missing: ${normalizePath(compilePath)}.`
        };
    }
    const evidence = safeReadJson(compilePath);
    if (!evidence) {
        return {
            ready: false,
            reason: 'Compile gate evidence is invalid JSON; rerun compile-gate.'
        };
    }
    const expectedPreflightHash = fileSha256(preflightPath);
    const evidenceStatus = String(evidence.status || '').trim().toUpperCase();
    const evidenceOutcome = String(evidence.outcome || '').trim().toUpperCase();
    if (evidence.task_id !== taskId) {
        return {
            ready: false,
            reason: `Compile gate evidence belongs to task '${String(evidence.task_id || '')}'.`
        };
    }
    if (String(evidence.event_source || '').trim() !== 'compile-gate') {
        return {
            ready: false,
            reason: 'Compile gate evidence source is invalid; rerun compile-gate.'
        };
    }
    if (evidenceStatus !== 'PASSED' || evidenceOutcome !== 'PASS') {
        const evidenceError = String(evidence.error || '').trim();
        if (/\bPreflight scope drift detected\b/i.test(evidenceError)) {
            const staleFailureReason = getStaleCompileScopeDriftFailureReason({
                repoRoot,
                eventsRoot,
                taskId,
                evidence,
                preflightPath,
                expectedPreflightHash
            });
            if (staleFailureReason) {
                return {
                    ready: false,
                    reason: staleFailureReason
                };
            }
            return {
                ready: false,
                reason:
                    `Compile gate failed because the preflight scope is stale. ${evidenceError} ` +
                    'Refresh classify-change for the current scope before rerunning compile-gate.',
                recoveryGate: 'classify-change'
            };
        }
        const infraRecoveryHintLine = formatCompileInfraRecoveryHintLine(evidence.infra_recovery_hint);
        const infraRecoverySuffix = infraRecoveryHintLine
            ? ` ${infraRecoveryHintLine}`
            : '';
        return {
            ready: false,
            reason:
                `Compile gate did not pass. Evidence status='${evidenceStatus || 'UNKNOWN'}', ` +
                `outcome='${evidenceOutcome || 'UNKNOWN'}'.${infraRecoverySuffix}`
        };
    }
    const evidencePreflightHash = String(evidence.preflight_hash_sha256 || '').trim().toLowerCase();
    if (!expectedPreflightHash || evidencePreflightHash !== expectedPreflightHash) {
        const preflightEvidence = safeReadJson(preflightPath);
        const docsOnlyExtensionReadiness = isPlainRecord(preflightEvidence)
            ? buildCompileEvidenceDocsOnlyExtensionReadiness(repoRoot, reviewsRoot, taskId, preflightEvidence)
            : null;
        if (docsOnlyExtensionReadiness) {
            return {
                ready: true,
                reason:
                    'Compile gate evidence is current for the implementation/test/config scope after a refreshed docs-only extension preflight. ' +
                    docsOnlyExtensionReadiness.reason
            };
        }
        return {
            ready: false,
            reason: 'Compile gate evidence preflight hash does not match the current preflight; rerun compile-gate.'
        };
    }
    const detectionSource = String(evidence.scope_detection_source || '').trim();
    const changedFiles = Array.isArray(evidence.scope_changed_files)
        ? evidence.scope_changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const scopeSha256 = String(evidence.scope_sha256 || '').trim();
    const scopeContentSha256 = String(evidence.scope_content_sha256 || '').trim().toLowerCase();
    const changedFilesSha256 = String(evidence.scope_changed_files_sha256 || '').trim();
    const changedLinesTotal = Number.parseInt(String(evidence.scope_changed_lines_total || 0), 10) || 0;
    const preflightEvidence = safeReadJson(preflightPath);
    const preflightMetrics = isPlainRecord(preflightEvidence?.metrics) ? preflightEvidence.metrics : {};
    const expectedDomainScopeFingerprints = normalizeDomainScopeFingerprints(
        isPlainRecord(evidence.domain_scope_fingerprints)
            ? evidence.domain_scope_fingerprints
            : (isPlainRecord(preflightMetrics.domain_scope_fingerprints) ? preflightMetrics.domain_scope_fingerprints : null)
    );
    if (!detectionSource || !scopeSha256 || !changedFilesSha256) {
        return {
            ready: false,
            reason: 'Compile gate evidence is missing scope snapshot fields; rerun compile-gate.'
        };
    }
    const currentScope = getWorkspaceSnapshotCached(
        repoRoot,
        detectionSource,
        evidence.scope_include_untracked == null ? true : !!evidence.scope_include_untracked,
        changedFiles,
        { noCache: true, readOnly: true }
    );
    if (
        currentScope.scope_sha256 !== scopeSha256
        || currentScope.changed_files_sha256 !== changedFilesSha256
        || currentScope.changed_lines_total !== changedLinesTotal
    ) {
        const includeUntracked = evidence.scope_include_untracked == null ? true : !!evidence.scope_include_untracked;
        const currentGitSnapshot = readCurrentGitWorkspaceSnapshot(repoRoot, includeUntracked);
        const docsOnlyDeltaReadiness = currentGitSnapshot
            ? buildDocsOnlyDeltaReadiness(
                repoRoot,
                currentGitSnapshot.changed_files,
                changedFiles,
                changedLinesTotal,
                includeUntracked,
                detectionSource,
                changedFilesSha256,
                scopeContentSha256,
                getDocImpactDeclaredDocsUpdated(path.join(reviewsRoot, `${taskId}-doc-impact.json`)),
                expectedDomainScopeFingerprints
            )
            : null;
        if (docsOnlyDeltaReadiness) {
            return {
                ready: true,
                reason: `Compile gate evidence is current after accepting ordinary docs-only updates for doc-impact. ${docsOnlyDeltaReadiness.reason}`
            };
        }
        return {
            ready: false,
            reason: 'Workspace changed after compile gate; rerun compile-gate before review preparation.'
        };
    }
    return {
        ready: true,
        reason: 'Compile gate evidence is current.'
    };
}

export function buildCompileEvidenceDocsOnlyExtensionReadiness(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    currentPreflight: Record<string, unknown>
): PreflightWorkspaceReadiness | null {
    const compileEvidence = safeReadJson(path.join(reviewsRoot, `${taskId}-compile-gate.json`));
    if (!isPlainRecord(compileEvidence)) {
        return null;
    }
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
): PreflightWorkspaceReadiness | null {
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
        return currentDomainScopeFingerprints.domains.closeout.changed_files.includes(normalizedPath);
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

export function readPreflightWorkspaceReadiness(
    repoRoot: string,
    preflight: Record<string, unknown>,
    options: PreflightWorkspaceReadinessOptions = {}
): PreflightWorkspaceReadiness {
    const metrics = isPlainRecord(preflight.metrics) ? preflight.metrics : {};
    const expectedChangedLinesTotal = typeof metrics.changed_lines_total === 'number'
        ? metrics.changed_lines_total
        : Number(metrics.changed_lines_total);
    if (!Number.isFinite(expectedChangedLinesTotal) || expectedChangedLinesTotal < 0) {
        return {
            ready: true,
            reason: 'Preflight workspace freshness cannot be checked because metrics.changed_lines_total is missing.'
        };
    }

    const detectionSource = String(preflight.detection_source || 'git_auto').trim() || 'git_auto';
    const normalizedDetectionSource = detectionSource.toLowerCase();
    const includeUntracked = normalizedDetectionSource === 'git_staged_only'
        ? false
        : (typeof preflight.include_untracked === 'boolean' ? preflight.include_untracked : true);
    const changedFiles = Array.isArray(preflight.changed_files)
        ? [...new Set(preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
    const plannedChangedFiles = Array.isArray(options.plannedChangedFiles)
        ? [...new Set(options.plannedChangedFiles.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
    const expectedChangedFilesSha256 = stringSha256(changedFiles.join('\n'));
    const expectedScopeContentSha256 = typeof metrics.scope_content_sha256 === 'string'
        ? metrics.scope_content_sha256.trim().toLowerCase()
        : '';
    const expectedDomainScopeFingerprints = normalizeDomainScopeFingerprints(
        isPlainRecord(metrics.domain_scope_fingerprints) ? metrics.domain_scope_fingerprints : null
    );
    const currentScope = getWorkspaceSnapshotCached(
        repoRoot,
        detectionSource,
        includeUntracked,
        changedFiles,
        { noCache: true, readOnly: true }
    );
    const violations: string[] = [];
    if (currentScope.changed_files_sha256 !== expectedChangedFilesSha256) {
        const currentScopeFiles = Array.isArray(currentScope.changed_files)
            ? currentScope.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
            : [];
        const expectedSet = new Set(changedFiles);
        const currentSet = new Set(currentScopeFiles);
        const missingFromPreflight = currentScopeFiles.filter((entry) => !expectedSet.has(entry));
        const noLongerCurrent = changedFiles.filter((entry) => !currentSet.has(entry));
        violations.push(
            `stale preflight file set ${describePathList(changedFiles)} differs from current workspace snapshot ${describePathList(currentScopeFiles)}` +
            `; missing from preflight: ${describePathList(missingFromPreflight)}` +
            `; no longer current: ${describePathList(noLongerCurrent)}`
        );
    }
    if (currentScope.changed_lines_total !== expectedChangedLinesTotal) {
        violations.push(
            `preflight changed_lines_total=${expectedChangedLinesTotal} differs from current changed_lines_total=${currentScope.changed_lines_total}`
        );
    }
    if (expectedScopeContentSha256 && currentScope.scope_content_sha256 !== expectedScopeContentSha256) {
        violations.push(
            `preflight scope_content_sha256=${expectedScopeContentSha256} differs from current scope_content_sha256=${currentScope.scope_content_sha256}`
        );
    }
    const expectedScopeSha256 = typeof metrics.scope_sha256 === 'string'
        ? metrics.scope_sha256.trim().toLowerCase()
        : '';
    if (expectedScopeSha256 && currentScope.scope_sha256 !== expectedScopeSha256) {
        violations.push(
            `preflight scope_sha256=${expectedScopeSha256} differs from current scope_sha256=${currentScope.scope_sha256}`
        );
    }
    let currentChangedFiles: string[] | undefined;
    const allowDocsOnlyDelta = options.allowDocsOnlyDelta !== false;
    if (normalizedDetectionSource === 'explicit_changed_files') {
        const currentGitSnapshot = readCurrentGitWorkspaceSnapshot(repoRoot, includeUntracked);
        if (currentGitSnapshot) {
            const unchangedProtectedFiles = getUnchangedProtectedDirtyWorkspaceFiles(repoRoot, preflight);
            const currentGitSnapshotFiles = currentGitSnapshot.changed_files
                .map((entry) => normalizePath(entry))
                .filter(Boolean);
            const preflightSet = new Set(changedFiles);
            const changedWorkflowConfigFiles = getTriggerPathList(preflight, 'changed_workflow_config_files');
            const uncoveredDirtyBaselineFiles = currentGitSnapshotFiles.filter((entry) => (
                unchangedProtectedFiles.has(entry) && !preflightSet.has(entry)
            ));
            if (changedWorkflowConfigFiles.length > 0 && uncoveredDirtyBaselineFiles.length > 0) {
                return {
                    ready: false,
                    reason:
                        'Protected workflow-config preflight is underscoped: current workspace still contains dirty-baseline files outside the preflight file set ' +
                        `${describePathList(uncoveredDirtyBaselineFiles)} while workflow-config files ${describePathList(changedWorkflowConfigFiles)} are in scope. ` +
                        'Refresh classify-change with the full current workspace diff before compile/review so source, test, docs, and workflow-config changes share one audited preflight.',
                    currentChangedFiles: currentGitSnapshotFiles
                };
            }
            const currentGitChangedFiles = currentGitSnapshotFiles.filter((entry) => (
                !unchangedProtectedFiles.has(entry)
            ));
            currentChangedFiles = currentGitChangedFiles;
            const plannedSet = new Set(plannedChangedFiles);
            const preflightUsesOnlyPlannedScope = plannedSet.size > 0
                && changedFiles.length > 0
                && changedFiles.every((entry) => plannedSet.has(entry));
            if (preflightUsesOnlyPlannedScope && currentGitChangedFiles.length === 0) {
                return {
                    ready: false,
                    reason:
                        `Preflight was classified from planned --changed-file hints ${describePathList(changedFiles)}, ` +
                        'but the current git workspace has no materialized diff for that planned scope. ' +
                        'Implement or create the planned files first, then rerun next-step so it can refresh classify-change for the real workspace diff before compile/review.',
                    currentChangedFiles,
                    awaitingMaterializedPlannedScope: true
                };
            }
            if (allowDocsOnlyDelta) {
                const docsOnlyDeltaReadiness = buildDocsOnlyDeltaReadiness(
                    repoRoot,
                    currentGitChangedFiles,
                    changedFiles,
                    expectedChangedLinesTotal,
                    includeUntracked,
                    detectionSource,
                    expectedChangedFilesSha256,
                    expectedScopeContentSha256,
                    getDocImpactDeclaredDocsUpdated(options.docImpactPath),
                    expectedDomainScopeFingerprints
                );
                if (docsOnlyDeltaReadiness) {
                    return docsOnlyDeltaReadiness;
                }
            }
            const currentFileSetHash = stringSha256(currentGitChangedFiles.join('\n'));
            if (currentFileSetHash !== expectedChangedFilesSha256) {
                const expectedSet = new Set(changedFiles);
                const currentSet = new Set(currentGitChangedFiles);
                const missingFromPreflight = currentGitChangedFiles.filter((entry) => !expectedSet.has(entry));
                const noLongerCurrent = changedFiles.filter((entry) => !currentSet.has(entry));
                const ignoredProtectedNote = unchangedProtectedFiles.size > 0
                    ? `; ignored unchanged dirty-baseline files: ${describePathList([...unchangedProtectedFiles])}`
                    : '';
                violations.push(
                    `stale preflight file set ${describePathList(changedFiles)} differs from current git snapshot ${describePathList(currentGitChangedFiles)}` +
                    `; missing from preflight: ${describePathList(missingFromPreflight)}` +
                    `; no longer current: ${describePathList(noLongerCurrent)}${ignoredProtectedNote}`
                );
            }
        }
    }

    if (allowDocsOnlyDelta) {
        const docsOnlyDeltaReadiness = buildDocsOnlyDeltaReadiness(
            repoRoot,
            currentScope.changed_files,
            changedFiles,
            expectedChangedLinesTotal,
            includeUntracked,
            detectionSource,
            expectedChangedFilesSha256,
            expectedScopeContentSha256,
            getDocImpactDeclaredDocsUpdated(options.docImpactPath),
            expectedDomainScopeFingerprints
        );
        if (docsOnlyDeltaReadiness) {
            return docsOnlyDeltaReadiness;
        }
    }

    if (violations.length === 0) {
        return {
            ready: true,
            reason: 'Preflight scope still matches the current workspace.',
            currentChangedFiles
        };
    }
    const failedReviewType = String(options.failedReviewType || '').trim();
    const failedReviewNote = failedReviewType
        ? ` Stale failed review detected: '${failedReviewType}' previously recorded '${String(options.failedReviewVerdict || 'FAILED').trim() || 'FAILED'}', but the workspace hash changed after that review.`
        : '';
    return {
        ready: false,
        reason: `Preflight scope is stale before compile (${violations.join('; ')}).${failedReviewNote} Refresh classify-change for the current scope first.`,
        currentChangedFiles
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

function normalizeCompileEvidencePath(repoRoot: string, candidatePath: unknown): string {
    const rawPath = String(candidatePath || '').trim();
    if (!rawPath) {
        return '';
    }
    return normalizePath(path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(repoRoot, rawPath));
}

function getStaleCompileScopeDriftFailureReason(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    evidence: Record<string, unknown>;
    preflightPath: string;
    expectedPreflightHash: string | null;
}): string | null {
    const staleReasons: string[] = [];
    const evidencePreflightHash = String(params.evidence.preflight_hash_sha256 || '').trim().toLowerCase();
    const expectedPreflightHash = String(params.expectedPreflightHash || '').trim().toLowerCase();
    if (evidencePreflightHash && expectedPreflightHash && evidencePreflightHash !== expectedPreflightHash) {
        staleReasons.push('compile failure preflight hash differs from the latest preflight hash');
    }

    const evidencePreflightPath = normalizeCompileEvidencePath(params.repoRoot, params.evidence.preflight_path);
    const currentPreflightPath = normalizePath(path.resolve(params.preflightPath));
    if (evidencePreflightPath && evidencePreflightPath !== currentPreflightPath) {
        staleReasons.push('compile failure preflight path differs from the latest preflight path');
    }

    const timelineErrors: string[] = [];
    const timeline = collectOrderedTimelineEvents(path.join(params.eventsRoot, `${params.taskId}.jsonl`), timelineErrors);
    const latestCompileFailure = findLatestTimelineEvent(
        timeline,
        (entry) => entry.event_type === 'COMPILE_GATE_FAILED'
    );
    const latestPreflight = findLatestTimelineEvent(
        timeline,
        (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED'
    );
    if (latestCompileFailure && latestPreflight && latestCompileFailure.sequence < latestPreflight.sequence) {
        staleReasons.push(
            `compile failure seq ${latestCompileFailure.sequence} predates latest preflight seq ${latestPreflight.sequence}`
        );
    }

    if (staleReasons.length === 0) {
        return null;
    }
    return (
        `Compile gate failed because an older preflight scope was stale, but that failed compile evidence is no longer current ` +
        `(${staleReasons.join('; ')}). Rerun compile-gate against the refreshed preflight before continuing.`
    );
}

function getUnchangedProtectedDirtyWorkspaceFiles(
    repoRoot: string,
    preflight: Record<string, unknown>
): Set<string> {
    const triggers = getPreflightTriggers(preflight);
    const protectedFiles = Array.isArray(triggers.dirty_workspace_protected_files)
        ? [...new Set(triggers.dirty_workspace_protected_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
    const protectedHashes = isPlainRecord(triggers.dirty_workspace_protected_file_hashes)
        ? triggers.dirty_workspace_protected_file_hashes
        : {};
    const unchanged = new Set<string>();
    for (const protectedFile of protectedFiles) {
        const expectedHash = String(protectedHashes[protectedFile] || '').trim().toLowerCase();
        if (!expectedHash) {
            continue;
        }
        const currentHash = fileSha256(path.join(repoRoot, protectedFile));
        if (currentHash && currentHash === expectedHash) {
            unchanged.add(protectedFile);
        }
    }
    return unchanged;
}

function getPreflightTriggers(preflight: Record<string, unknown> | null): Record<string, unknown> {
    return isPlainRecord(preflight?.triggers) ? preflight.triggers : {};
}

function getTriggerPathList(preflight: Record<string, unknown>, fieldName: string): string[] {
    const triggers = getPreflightTriggers(preflight);
    return Array.isArray(triggers[fieldName])
        ? [...new Set(triggers[fieldName].map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
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

function fileExists(filePath: string): boolean {
    try {
        return fs.existsSync(filePath);
    } catch {
        return false;
    }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

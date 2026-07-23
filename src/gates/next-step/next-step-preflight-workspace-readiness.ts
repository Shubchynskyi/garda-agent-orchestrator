import * as path from 'node:path';

import {
    normalizeDomainScopeFingerprints,
    type DomainScopeFingerprintEntry,
    type DomainScopeFingerprints
} from '../scope/domain-scope-fingerprints';
import {
    fileSha256,
    normalizePath
} from '../shared/helpers';
import {
    getWorkspaceSnapshotCached,
} from '../workspace/workspace-snapshot-cache';
import {
    normalizeWorkspaceRelativePath,
    normalizeWorkspaceRelativePaths
} from '../workspace/dirty-worktree-protection';
import {
    isSourceCheckoutGeneratedRuntimeArtifactPath
} from '../shared/generated-runtime-artifacts';
import {
    isWorkflowConfigControlPlanePath,
    isOrchestratorSourceCheckout
} from '../protected-control-plane/protected-control-plane';
import {
    mergeTaskOwnedMetadataRefreshFiles
} from './next-step-task-owned-metadata';
import {
    isDependencyManifestLockfileRelatedToAny
} from '../scope/dependency-manifest-lockfile-scope';
import {
    buildScopeContentFingerprint
} from '../compile/compile-gate';
import {
    buildDocsOnlyDeltaReadiness,
    describePathList,
    getDocImpactDeclaredDocsUpdated,
    readCurrentGitWorkspaceSnapshot,
    stringSha256
} from '../scope/docs-only-delta-readiness';
import {
    buildCurrentDomainScopeFingerprints,
    onlyNeutralCloseoutDomainChanged
} from './next-step-readiness-domain-scope';
import { isPlainRecord } from '../../core/records';

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
    dirtyWorkspaceBaselineChangedFiles?: string[];
    dirtyWorkspaceBaselineFileHashes?: Record<string, string>;
}

function isDistRuntimeOutputRelatedToPlannedSource(changedFile: string, plannedChangedFiles: readonly string[]): boolean {
    const normalizedChangedFile = normalizePath(changedFile);
    if (!normalizedChangedFile.startsWith('dist/src/') || !normalizedChangedFile.endsWith('.js')) {
        return false;
    }
    const sourceCandidate = `src/${normalizedChangedFile.slice('dist/src/'.length).replace(/\.js$/u, '.ts')}`;
    return plannedChangedFiles.some((plannedFile) => normalizePath(plannedFile) === sourceCandidate);
}

function sameSortedStringList(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((entry, index) => entry === sortedRight[index]);
}

function isRelatedToPlannedScope(changedFile: string, plannedChangedFiles: readonly string[]): boolean {
    if (isDependencyManifestLockfileRelatedToAny(changedFile, plannedChangedFiles)) {
        return true;
    }
    if (isDistRuntimeOutputRelatedToPlannedSource(changedFile, plannedChangedFiles)) {
        return true;
    }
    const normalizedChangedFile = normalizePath(changedFile);
    const [changedTopLevel] = normalizedChangedFile.split('/');
    if (!changedTopLevel || normalizedChangedFile === changedTopLevel) {
        return false;
    }
    return plannedChangedFiles.some((plannedFile) => {
        const normalizedPlannedFile = normalizePath(plannedFile);
        const [plannedTopLevel] = normalizedPlannedFile.split('/');
        const plannedDirectory = normalizedPlannedFile.split('/').slice(1, -1).join('/');
        if (
            changedTopLevel === 'tests'
            && plannedTopLevel === 'src'
            && plannedDirectory
            && normalizedChangedFile.includes(`/${plannedDirectory}/`)
        ) {
            return true;
        }
        return Boolean(plannedTopLevel)
            && normalizedPlannedFile !== plannedTopLevel
            && plannedTopLevel === changedTopLevel;
    });
}

function filterSourceCheckoutGeneratedRuntimeArtifacts(repoRoot: string, changedFiles: readonly string[]): string[] {
    const isSourceCheckout = isOrchestratorSourceCheckout(repoRoot);
    return [...new Set(
        changedFiles
            .map((entry) => normalizePath(entry))
            .filter((entry) => entry && !isSourceCheckoutGeneratedRuntimeArtifactPath(entry, isSourceCheckout))
    )].sort();
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
    const authorizedFiles = Array.isArray(preflight.authorized_files)
        ? [...new Set(preflight.authorized_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : changedFiles;
    const plannedChangedFiles = Array.isArray(options.plannedChangedFiles)
        ? filterSourceCheckoutGeneratedRuntimeArtifacts(repoRoot, options.plannedChangedFiles)
        : [];
    const dirtyWorkspaceBaselineChangedFiles = normalizeWorkspaceRelativePaths(
        repoRoot,
        options.dirtyWorkspaceBaselineChangedFiles
    );
    const dirtyWorkspaceBaselineFileHashes = options.dirtyWorkspaceBaselineFileHashes || {};
    const failedReviewType = String(options.failedReviewType || '').trim();
    const hasActualChangedFiles = Array.isArray(metrics.actual_changed_files);
    const expectedActualChangedFiles = hasActualChangedFiles
        ? [...new Set((metrics.actual_changed_files as unknown[])
            .map((entry) => normalizePath(String(entry || '')))
            .filter(Boolean))].sort()
        : changedFiles;
    const expectedActualChangedFilesSha256 = typeof metrics.actual_changed_files_sha256 === 'string'
        ? metrics.actual_changed_files_sha256.trim().toLowerCase()
        : stringSha256(expectedActualChangedFiles.join('\n'));
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
        authorizedFiles,
        { noCache: true, readOnly: true }
    );
    const currentScopeFiles = Array.isArray(currentScope.changed_files)
        ? currentScope.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
    const currentScopeFileSet = new Set(currentScopeFiles);
    const ignoredWorkflowConfigPreflightFiles = changedFiles.filter((entry) => (
        isWorkflowConfigControlPlanePath(entry) && !currentScopeFileSet.has(entry)
    ));
    const comparableChangedFiles = changedFiles.filter((entry) => (
        !ignoredWorkflowConfigPreflightFiles.includes(entry)
    ));
    const ignoredWorkflowConfigOnlyWorkspaceDelta = ignoredWorkflowConfigPreflightFiles.length > 0
        && sameSortedStringList(comparableChangedFiles, currentScopeFiles);
    const workflowConfigFileHashes = getWorkflowConfigFileHashes(repoRoot, preflight);
    const expectedComparableChangedFilesSha256 = ignoredWorkflowConfigOnlyWorkspaceDelta
        ? stringSha256(comparableChangedFiles.join('\n'))
        : expectedActualChangedFilesSha256;
    const expectedComparableChangedLinesTotal = ignoredWorkflowConfigOnlyWorkspaceDelta
        ? currentScope.changed_lines_total
        : expectedChangedLinesTotal;
    const violations: string[] = [];
    if (currentScope.changed_files_sha256 !== expectedComparableChangedFilesSha256) {
        const expectedSet = new Set(expectedActualChangedFiles);
        const currentSet = new Set(currentScopeFiles);
        const missingFromPreflight = currentScopeFiles.filter((entry) => !expectedSet.has(entry));
        const noLongerCurrent = expectedActualChangedFiles
            .filter((entry) => !currentSet.has(entry));
        const ignoredWorkflowConfigNote = ignoredWorkflowConfigOnlyWorkspaceDelta
            ? `; ignored workflow-config-only local baseline files: ${describePathList(ignoredWorkflowConfigPreflightFiles)}`
            : '';
        violations.push(
            `stale preflight actual-diff file set ${describePathList(expectedActualChangedFiles)} differs from current workspace snapshot ${describePathList(currentScopeFiles)}` +
            `; missing from preflight: ${describePathList(missingFromPreflight)}` +
            `; no longer current: ${describePathList(noLongerCurrent)}${ignoredWorkflowConfigNote}`
        );
    }
    if (currentScope.changed_lines_total !== expectedComparableChangedLinesTotal) {
        violations.push(
            `preflight changed_lines_total=${expectedChangedLinesTotal} differs from current changed_lines_total=${currentScope.changed_lines_total}`
        );
    }
    if (
        !ignoredWorkflowConfigOnlyWorkspaceDelta
        && expectedScopeContentSha256
        && currentScope.scope_content_sha256 !== expectedScopeContentSha256
    ) {
        violations.push(
            `preflight scope_content_sha256=${expectedScopeContentSha256} differs from current scope_content_sha256=${currentScope.scope_content_sha256}`
        );
    }
    if (ignoredWorkflowConfigOnlyWorkspaceDelta && expectedDomainScopeFingerprints) {
        const currentDomainScopeFingerprints = buildCurrentDomainScopeFingerprints({
            repoRoot,
            detectionSource,
            includeUntracked,
            changedFiles: currentScope.changed_files
        });
        const domainViolations = getComparableNonConfigDomainViolations(
            expectedDomainScopeFingerprints,
            currentDomainScopeFingerprints
        );
        violations.push(...domainViolations.map((violation) => (
            `preflight non-config domain scope differs: ${violation} ` +
            'while ignored workflow-config local baseline is absent from git snapshot'
        )));
    }
    if (ignoredWorkflowConfigOnlyWorkspaceDelta && expectedScopeContentSha256 && !expectedDomainScopeFingerprints) {
        const currentFullScopeContentSha256 = buildScopeContentFingerprint(repoRoot, detectionSource, changedFiles);
        if (currentFullScopeContentSha256 !== expectedScopeContentSha256) {
            violations.push(
                `preflight scope_content_sha256=${expectedScopeContentSha256} differs from current full scope_content_sha256=${currentFullScopeContentSha256}` +
                ' while ignored workflow-config local baseline is absent from git snapshot'
            );
        }
    }
    if (ignoredWorkflowConfigOnlyWorkspaceDelta) {
        const hashViolations = getWorkflowConfigHashViolations(
            repoRoot,
            ignoredWorkflowConfigPreflightFiles,
            workflowConfigFileHashes
        );
        violations.push(...hashViolations.map((violation) => (
            `preflight workflow-config hash baseline differs: ${violation} ` +
            'while ignored workflow-config local baseline is absent from git snapshot'
        )));
    }
    const expectedScopeSha256 = typeof metrics.scope_sha256 === 'string'
        ? metrics.scope_sha256.trim().toLowerCase()
        : '';
    if (!ignoredWorkflowConfigOnlyWorkspaceDelta && expectedScopeSha256 && currentScope.scope_sha256 !== expectedScopeSha256) {
        violations.push(
            `preflight scope_sha256=${expectedScopeSha256} differs from current scope_sha256=${currentScope.scope_sha256}`
        );
    }
    let currentChangedFiles: string[] | undefined = Array.isArray(currentScope.changed_files)
        ? [...new Set([
            ...currentScope.changed_files.map((entry) => normalizePath(entry)).filter(Boolean),
            ...plannedChangedFiles
        ])].sort()
        : undefined;
    const allowDocsOnlyDelta = options.allowDocsOnlyDelta !== false;
    if (normalizedDetectionSource === 'explicit_changed_files') {
        const currentGitSnapshot = readCurrentGitWorkspaceSnapshot(repoRoot, includeUntracked);
        if (currentGitSnapshot) {
            const unchangedProtectedFiles = getUnchangedProtectedDirtyWorkspaceFiles(repoRoot, preflight);
            const currentGitSnapshotFiles = currentGitSnapshot.changed_files
                .map((entry) => normalizePath(entry))
                .filter((entry) => entry && !isSourceCheckoutGeneratedRuntimeArtifactPath(entry, isOrchestratorSourceCheckout(repoRoot)));
            const preflightSet = new Set(authorizedFiles);
            const changedWorkflowConfigFiles = getTriggerPathList(repoRoot, preflight, 'changed_workflow_config_files');
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
            const plannedSet = new Set(plannedChangedFiles);
            const preflightUsesOnlyPlannedScope = plannedSet.size > 0
                && authorizedFiles.length > 0
                && authorizedFiles.every((entry) => (
                    plannedSet.has(entry) || isRelatedToPlannedScope(entry, plannedChangedFiles)
                ));
            const dirtyBaselineSet = new Set([
                ...dirtyWorkspaceBaselineChangedFiles,
                ...getTriggerPathList(repoRoot, preflight, 'dirty_workspace_baseline_changed_files')
            ]);
            const unchangedDirtyBaselineSet = new Set(
                [...dirtyBaselineSet].filter((entry) => (
                    dirtyBaselineFileMatchesCurrent(repoRoot, entry, dirtyWorkspaceBaselineFileHashes)
                ))
            );
            const currentGitSnapshotFilesWithMetadata = mergeTaskOwnedMetadataRefreshFiles(
                currentGitSnapshotFiles,
                [
                    ...currentScope.changed_files,
                    ...[...dirtyBaselineSet].filter((entry) => !unchangedDirtyBaselineSet.has(entry))
                ]
            );
            const currentGitChangedFilesWithoutProtectedBaseline = currentGitSnapshotFilesWithMetadata.filter((entry) => (
                !unchangedProtectedFiles.has(entry)
            ));
            const currentPlannedScopeGitFiles = currentGitChangedFilesWithoutProtectedBaseline.filter((entry) => plannedSet.has(entry));
            const currentRelatedPlannedScopeGitFiles = currentGitChangedFilesWithoutProtectedBaseline.filter((entry) => (
                !plannedSet.has(entry)
                    && !dirtyBaselineSet.has(entry)
                    && isRelatedToPlannedScope(entry, plannedChangedFiles)
            ));
            const includeFullFailedReviewRemediationScope = Boolean(failedReviewType);
            const compareOnlyPlannedScope = !includeFullFailedReviewRemediationScope
                && preflightUsesOnlyPlannedScope
                && (currentPlannedScopeGitFiles.length > 0 || currentRelatedPlannedScopeGitFiles.length > 0);
            const currentGitChangedFiles = currentGitSnapshotFilesWithMetadata.filter((entry) => (
                !unchangedProtectedFiles.has(entry)
                    && (!includeFullFailedReviewRemediationScope || !unchangedDirtyBaselineSet.has(entry))
                    && (!compareOnlyPlannedScope
                        || plannedSet.has(entry)
                        || (dirtyBaselineSet.has(entry) && !unchangedDirtyBaselineSet.has(entry))
                        || isRelatedToPlannedScope(entry, plannedChangedFiles))
            ));
            const currentGitChangedSet = new Set(currentGitChangedFiles);
            const comparablePlannedChangedFiles = plannedChangedFiles.filter((entry) => (
                !dirtyBaselineSet.has(entry)
                    || currentGitChangedSet.has(entry)
                    || isWorkflowConfigControlPlanePath(entry)
            ));
            currentChangedFiles = [...new Set([
                ...currentGitChangedFiles,
                ...(hasActualChangedFiles ? [] : comparablePlannedChangedFiles)
            ])].sort();
            const currentComparableChangedFiles = preflightUsesOnlyPlannedScope
                ? currentChangedFiles
                : currentGitChangedFiles;
            if (
                !hasActualChangedFiles
                && preflightUsesOnlyPlannedScope
                && currentPlannedScopeGitFiles.length === 0
                && currentRelatedPlannedScopeGitFiles.length === 0
                && dirtyBaselineSet.size === 0
            ) {
                return {
                    ready: false,
                    reason:
                        `Preflight was classified from planned --changed-file hints ${describePathList(authorizedFiles)}, ` +
                        'but the current git workspace has no materialized diff for that planned scope. ' +
                        'Implement or create the planned files first, then rerun next-step so it can refresh classify-change for the real workspace diff before compile/review.',
                    currentChangedFiles,
                    awaitingMaterializedPlannedScope: true
                };
            }
            if (allowDocsOnlyDelta) {
                const docsOnlyDeltaReadiness = buildDocsOnlyDeltaReadiness(
                    repoRoot,
                    currentComparableChangedFiles,
                    changedFiles,
                    expectedComparableChangedLinesTotal,
                    includeUntracked,
                    detectionSource,
                    expectedComparableChangedFilesSha256,
                    expectedScopeContentSha256,
                    getDocImpactDeclaredDocsUpdated(options.docImpactPath),
                    expectedDomainScopeFingerprints
                );
                if (docsOnlyDeltaReadiness) {
                    return docsOnlyDeltaReadiness;
                }
            }
            const currentComparableChangedFileSet = new Set(currentComparableChangedFiles);
            const expectedGitScopeFiles = hasActualChangedFiles ? expectedActualChangedFiles : authorizedFiles;
            const expectedGitScopeFileSet = new Set(expectedGitScopeFiles);
            const ignoredWorkflowConfigGitFiles = expectedGitScopeFiles.filter((entry) => (
                isWorkflowConfigControlPlanePath(entry) && !currentComparableChangedFileSet.has(entry)
            ));
            const gitComparableChangedFiles = expectedGitScopeFiles.filter((entry) => (
                !ignoredWorkflowConfigGitFiles.includes(entry)
            ));
            const ignoredWorkflowConfigOnlyGitDelta = ignoredWorkflowConfigGitFiles.length > 0
                && sameSortedStringList(gitComparableChangedFiles, currentComparableChangedFiles);
            const currentFileSetHash = stringSha256(currentComparableChangedFiles.join('\n'));
            const expectedGitComparableChangedFilesSha256 = ignoredWorkflowConfigOnlyGitDelta
                ? stringSha256(gitComparableChangedFiles.join('\n'))
                : stringSha256(expectedGitScopeFiles.join('\n'));
            if (ignoredWorkflowConfigOnlyGitDelta && expectedDomainScopeFingerprints) {
                const currentDomainScopeFingerprints = buildCurrentDomainScopeFingerprints({
                    repoRoot,
                    detectionSource,
                    includeUntracked,
                    changedFiles: currentComparableChangedFiles
                });
                const domainViolations = getComparableNonConfigDomainViolations(
                    expectedDomainScopeFingerprints,
                    currentDomainScopeFingerprints
                );
                violations.push(...domainViolations.map((violation) => (
                    `preflight non-config domain scope differs: ${violation} ` +
                    'while ignored workflow-config local baseline is absent from git snapshot'
                )));
            }
            if (ignoredWorkflowConfigOnlyGitDelta) {
                const hashViolations = getWorkflowConfigHashViolations(
                    repoRoot,
                    ignoredWorkflowConfigGitFiles,
                    workflowConfigFileHashes
                );
                violations.push(...hashViolations.map((violation) => (
                    `preflight workflow-config hash baseline differs: ${violation} ` +
                    'while ignored workflow-config local baseline is absent from git snapshot'
                )));
            }
            if (currentFileSetHash !== expectedGitComparableChangedFilesSha256) {
                const currentSet = new Set(currentComparableChangedFiles);
                const missingFromPreflight = currentComparableChangedFiles.filter((entry) => !expectedGitScopeFileSet.has(entry));
                const noLongerCurrent = (ignoredWorkflowConfigOnlyGitDelta ? gitComparableChangedFiles : expectedGitScopeFiles)
                    .filter((entry) => !currentSet.has(entry));
                const ignoredProtectedNote = unchangedProtectedFiles.size > 0
                    ? `; ignored unchanged dirty-baseline files: ${describePathList([...unchangedProtectedFiles])}`
                    : '';
                const ignoredWorkflowConfigNote = ignoredWorkflowConfigOnlyGitDelta
                    ? `; ignored workflow-config-only local baseline files: ${describePathList(ignoredWorkflowConfigGitFiles)}`
                    : '';
                violations.push(
                    `stale preflight ${hasActualChangedFiles ? 'actual-diff' : 'authorized'} file set ${describePathList(expectedGitScopeFiles)} differs from current git snapshot ${describePathList(currentComparableChangedFiles)}` +
                    `; missing from preflight: ${describePathList(missingFromPreflight)}` +
                    `; no longer current: ${describePathList(noLongerCurrent)}${ignoredProtectedNote}${ignoredWorkflowConfigNote}`
                );
            }
        }
    }

    if (allowDocsOnlyDelta) {
        const docsOnlyDeltaReadiness = buildDocsOnlyDeltaReadiness(
            repoRoot,
            currentScope.changed_files,
            changedFiles,
            expectedComparableChangedLinesTotal,
            includeUntracked,
            detectionSource,
            expectedComparableChangedFilesSha256,
            expectedScopeContentSha256,
            getDocImpactDeclaredDocsUpdated(options.docImpactPath),
            expectedDomainScopeFingerprints
        );
        if (docsOnlyDeltaReadiness) {
            return docsOnlyDeltaReadiness;
        }
    }

    if (violations.length > 0 && expectedDomainScopeFingerprints) {
        const currentDomainScopeFingerprints = buildCurrentDomainScopeFingerprints({
            repoRoot,
            detectionSource,
            includeUntracked,
            changedFiles: currentScope.changed_files
        });
        if (onlyNeutralCloseoutDomainChanged(expectedDomainScopeFingerprints, currentDomainScopeFingerprints)) {
            return {
                ready: true,
                reason: 'Preflight scope is current for implementation, test, docs, and config; only neutral closeout evidence changed.',
                currentChangedFiles,
                acceptedCloseoutOnlyDeltaFiles: [
                    ...new Set([
                        ...expectedDomainScopeFingerprints.domains.closeout.changed_files,
                        ...currentDomainScopeFingerprints.domains.closeout.changed_files
                    ])
                ].sort()
            };
        }
    }

    if (violations.length === 0) {
        return {
            ready: true,
            reason: 'Preflight scope still matches the current workspace.',
            currentChangedFiles
        };
    }
    const failedReviewNote = failedReviewType
        ? ` Stale failed review detected: '${failedReviewType}' previously recorded '${String(options.failedReviewVerdict || 'FAILED').trim() || 'FAILED'}', but the workspace hash changed after that review.`
        : '';
    return {
        ready: false,
        reason: `Preflight scope is stale before compile (${violations.join('; ')}).${failedReviewNote} Refresh classify-change for the current scope first.`,
        currentChangedFiles
    };
}

function getUnchangedProtectedDirtyWorkspaceFiles(
    repoRoot: string,
    preflight: Record<string, unknown>
): Set<string> {
    const triggers = getPreflightTriggers(preflight);
    const protectedFiles = normalizeWorkspaceRelativePaths(repoRoot, triggers.dirty_workspace_protected_files);
    const protectedHashes = isPlainRecord(triggers.dirty_workspace_protected_file_hashes)
        ? triggers.dirty_workspace_protected_file_hashes
        : {};
    const unchanged = new Set<string>();
    for (const protectedFile of protectedFiles) {
        const expectedHash = String(protectedHashes[protectedFile] || '').trim().toLowerCase();
        if (!expectedHash) {
            continue;
        }
        const currentHash = fileSha256(path.resolve(repoRoot, protectedFile));
        if (currentHash && currentHash === expectedHash) {
            unchanged.add(protectedFile);
        }
    }
    return unchanged;
}

function getPreflightTriggers(preflight: Record<string, unknown> | null): Record<string, unknown> {
    return isPlainRecord(preflight?.triggers) ? preflight.triggers : {};
}

function formatDomainValue(value: string | null): string {
    return value || 'null';
}

function getDomainScopeEntryViolations(
    domainName: 'implementation' | 'test' | 'docs',
    expected: DomainScopeFingerprintEntry,
    current: DomainScopeFingerprintEntry
): string[] {
    const violations: string[] = [];
    for (const fieldName of ['changed_files_sha256', 'scope_content_sha256', 'scope_sha256'] as const) {
        if (expected[fieldName] !== current[fieldName]) {
            violations.push(
                `${domainName} domain ${fieldName} expected=${formatDomainValue(expected[fieldName])}` +
                ` current=${formatDomainValue(current[fieldName])}` +
                ` expected_files=${describePathList(expected.changed_files)}` +
                ` current_files=${describePathList(current.changed_files)}`
            );
        }
    }
    return violations;
}

function getComparableNonConfigDomainViolations(
    expected: DomainScopeFingerprints,
    current: DomainScopeFingerprints
): string[] {
    const violations: string[] = [];
    for (const domainName of ['implementation', 'test', 'docs'] as const) {
        const expectedDomain = expected.domains[domainName];
        const currentDomain = current.domains[domainName];
        violations.push(...getDomainScopeEntryViolations(domainName, expectedDomain, currentDomain));
    }
    return violations;
}

type WorkflowConfigFileHashes = Record<string, string | null>;

function getWorkflowConfigFileHashes(repoRoot: string, preflight: Record<string, unknown>): WorkflowConfigFileHashes {
    const triggers = getPreflightTriggers(preflight);
    const rawHashes = isPlainRecord(triggers.workflow_config_file_hashes)
        ? triggers.workflow_config_file_hashes
        : {};
    const hashes: WorkflowConfigFileHashes = {};
    for (const [rawPath, rawHash] of Object.entries(rawHashes)) {
        const normalizedPath = normalizeWorkspaceRelativePath(repoRoot, rawPath);
        if (!normalizedPath) {
            continue;
        }
        hashes[normalizedPath] = typeof rawHash === 'string'
            ? rawHash.trim().toLowerCase() || null
            : null;
    }
    return hashes;
}

function getWorkflowConfigHashViolations(
    repoRoot: string,
    workflowConfigFiles: readonly string[],
    workflowConfigFileHashes: WorkflowConfigFileHashes
): string[] {
    const violations: string[] = [];
    for (const entry of workflowConfigFiles) {
        const normalizedPath = normalizeWorkspaceRelativePath(repoRoot, entry);
        if (!normalizedPath) {
            violations.push(`invalid workflow-config path '${entry}'`);
            continue;
        }
        const hasBaseline = Object.prototype.hasOwnProperty.call(workflowConfigFileHashes, normalizedPath);
        const expectedHash = hasBaseline ? workflowConfigFileHashes[normalizedPath] : null;
        if (!expectedHash) {
            violations.push(`missing workflow_config_file_hashes baseline for ${normalizedPath}`);
            continue;
        }
        const currentHash = fileSha256(path.resolve(repoRoot, normalizedPath));
        if (!currentHash) {
            violations.push(`current workflow-config file ${normalizedPath} is missing or unreadable`);
            continue;
        }
        const normalizedCurrentHash = currentHash.trim().toLowerCase();
        if (normalizedCurrentHash !== expectedHash) {
            violations.push(
                `workflow-config ${normalizedPath} sha256 expected=${expectedHash} current=${normalizedCurrentHash}`
            );
        }
    }
    return violations;
}

function getTriggerPathList(repoRoot: string, preflight: Record<string, unknown>, fieldName: string): string[] {
    const triggers = getPreflightTriggers(preflight);
    return normalizeWorkspaceRelativePaths(repoRoot, triggers[fieldName]);
}

function dirtyBaselineFileMatchesCurrent(
    repoRoot: string,
    changedFile: string,
    dirtyBaselineFileHashes: Record<string, string>
): boolean {
    const normalizedChangedFile = normalizeWorkspaceRelativePath(repoRoot, changedFile);
    if (!normalizedChangedFile) {
        return false;
    }
    const expectedHash = dirtyBaselineFileHashes[normalizedChangedFile];
    if (!expectedHash) {
        return false;
    }
    const currentHash = fileSha256(path.resolve(repoRoot, normalizedChangedFile));
    return !!currentHash && currentHash.trim().toLowerCase() === expectedHash;
}

import { matchAnyRegex } from '../../gate-runtime/text-utils';
import { normalizePath } from '../shared/helpers';

export interface ReviewRemediationScopeBoundary {
    status: 'OK' | 'BLOCKED';
    previousChangedFiles: string[];
    currentChangedFiles: string[];
    expandedFiles: string[];
    expandedNonTestFiles: string[];
    allowedTestOnlyExpansionFiles: string[];
}

export function normalizeReviewRemediationChangedFiles(values: readonly unknown[]): string[] {
    return [...new Set(values.map((entry) => normalizePath(String(entry || '').trim())).filter(Boolean))].sort();
}

export function isTestLikeRemediationPath(relativePath: string, testTriggerRegexes: readonly string[]): boolean {
    return matchAnyRegex(normalizePath(relativePath), [...testTriggerRegexes], {
        skipInvalidRegex: true,
        caseInsensitive: true
    });
}

export function getTaskManualValidationBoundaryFiles(taskId: string, currentChangedFiles: readonly string[]): string[] {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
        return [];
    }
    const taskManualValidationPath = normalizePath(`garda-agent-orchestrator/runtime/manual-validation/${normalizedTaskId}`);
    const deployedTaskManualValidationPath = normalizePath(`runtime/manual-validation/${normalizedTaskId}`);
    return normalizeReviewRemediationChangedFiles(currentChangedFiles).filter((entry) => (
        entry === taskManualValidationPath
        || entry.startsWith(`${taskManualValidationPath}/`)
        || entry === deployedTaskManualValidationPath
        || entry.startsWith(`${deployedTaskManualValidationPath}/`)
    ));
}

export function assessReviewRemediationScopeBoundary(
    previousChangedFiles: readonly string[],
    currentChangedFiles: readonly string[],
    allowedBoundaryFiles: readonly string[] = [],
    testTriggerRegexes: readonly string[] = []
): ReviewRemediationScopeBoundary {
    const previous = normalizeReviewRemediationChangedFiles(previousChangedFiles);
    const current = normalizeReviewRemediationChangedFiles(currentChangedFiles);
    const previousSet = new Set(previous);
    const allowedSet = new Set(normalizeReviewRemediationChangedFiles([...previous, ...allowedBoundaryFiles]));
    const expandedFiles = current.filter((entry) => !previousSet.has(entry));
    const unplannedExpandedFiles = current.filter((entry) => !allowedSet.has(entry));
    const expandedNonTestFiles = unplannedExpandedFiles.filter((entry) => !isTestLikeRemediationPath(entry, testTriggerRegexes));
    const allowedTestOnlyExpansionFiles = unplannedExpandedFiles.filter((entry) => isTestLikeRemediationPath(entry, testTriggerRegexes));
    return {
        status: expandedNonTestFiles.length > 0 ? 'BLOCKED' : 'OK',
        previousChangedFiles: previous,
        currentChangedFiles: current,
        expandedFiles,
        expandedNonTestFiles,
        allowedTestOnlyExpansionFiles
    };
}

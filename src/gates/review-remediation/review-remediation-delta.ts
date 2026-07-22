import { createHash } from 'node:crypto';

import { sha256RedactedJsonPayload } from '../../core/redaction';
import { DEFAULT_REVIEW_TRIGGER_POLICY } from '../../policy/review-trigger-policy';
import type { ReviewRemediationDeltaCategory } from '../../policy/review-remediation-rerun-policy';
import { normalizePath } from '../shared/helpers';
import { isTestLikeRemediationPath } from './review-remediation-scope-boundary';
import {
    buildReviewRemediationDeltaBase,
    getReviewRemediationDeltaBaseViolations,
    REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES,
    type ReviewRemediationDeltaBaseEntry
} from './review-remediation-delta-contract';
import {
    validateReviewRemediationBaselineArtifact,
    type ReviewRemediationBaselineArtifact
} from './review-remediation-baseline';

export const REVIEW_REMEDIATION_DELTA_SCHEMA_VERSION = 1;
export const REVIEW_REMEDIATION_DELTA_MAX_DIFF_WORK_UNITS = 250000;

export type { ReviewRemediationDeltaCategory } from '../../policy/review-remediation-rerun-policy';

export type ReviewRemediationDeltaOperation = 'added' | 'deleted' | 'modified' | 'type_changed';

export interface ReviewRemediationFileDelta {
    path: string;
    operation: ReviewRemediationDeltaOperation;
    category: ReviewRemediationDeltaCategory;
    reason: string;
    baseline_status: ReviewRemediationDeltaBaseEntry['status'];
    current_status: ReviewRemediationDeltaBaseEntry['status'];
    baseline_mode: number | null;
    current_mode: number | null;
    baseline_content_sha256: string | null;
    current_content_sha256: string | null;
    baseline_line_count: number | null;
    current_line_count: number | null;
    additions: number | null;
    deletions: number | null;
    changed_lines: number | null;
}

export interface ReviewRemediationDeltaClassification {
    schema_version: typeof REVIEW_REMEDIATION_DELTA_SCHEMA_VERSION;
    task_id: string;
    review_type: string;
    status: 'CLASSIFIED';
    category: ReviewRemediationDeltaCategory;
    reason: string;
    baseline: {
        artifact_path: string;
        artifact_sha256: string;
        review_tree_state_sha256: string;
        delta_base_snapshot_sha256: string;
    };
    current_snapshot_sha256: string;
    changed_files: string[];
    unchanged_files: string[];
    file_deltas: ReviewRemediationFileDelta[];
    additions_total: number | null;
    deletions_total: number | null;
    changed_lines_total: number | null;
    classification_sha256: string;
}

export interface ClassifyReviewRemediationDeltaOptions {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    baselineArtifactPath: string;
    baselineArtifactSha256: string;
    currentChangedFiles: readonly string[];
    testPathRegexes?: readonly string[];
    structuralTestPathRegexes?: readonly string[];
    structuralTestChangedLinesThreshold?: number;
}

const GENERATED_PATH_PATTERN = /(?:^|\/)(?:\.node-build|\.scripts-build|coverage|dist|generated|snapshots?)(?:\/|$)|\.snap$|\.generated\.[^/]+$/iu;
const PRODUCTION_PATH_PATTERN = /^(?:src|bin|scripts)\/|^garda-agent-orchestrator\/(?:src|bin|scripts)\//iu;
const GLOBAL_PATH_PATTERN = /^(?:docs|docs_local|template|live|\.github)\/|^garda-agent-orchestrator\/(?:template|live)\/|^(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|AGENTS\.md|TASK\.md|README\.md)$/iu;

function sha256Text(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function compilePatterns(patterns: readonly string[], subject: string): RegExp[] {
    return patterns.map((pattern) => {
        try {
            return new RegExp(pattern, 'iu');
        } catch (error: unknown) {
            throw new Error(
                `Review remediation delta ${subject} contains invalid regex '${pattern}': `
                + (error instanceof Error ? error.message : String(error))
            );
        }
    });
}

function normalizeChangedFiles(files: readonly string[]): string[] {
    return [...new Set(files.map((file) => normalizePath(file)).filter(Boolean))].sort();
}

function sameEntry(left: ReviewRemediationDeltaBaseEntry, right: ReviewRemediationDeltaBaseEntry): boolean {
    // Fail closed when bounded snapshot evidence has no content hash: size or path metadata
    // cannot authenticate that an unreviewable file retained the same content.
    const comparableContent = left.content_sha256 !== null
        || left.status === 'missing'
        || (left.status === 'symbolic_link' && left.link_sha256 !== null);
    return comparableContent
        && left.status === right.status
        && left.mode === right.mode
        && left.content_sha256 === right.content_sha256
        && left.link_sha256 === right.link_sha256;
}

function missingEntry(filePath: string): ReviewRemediationDeltaBaseEntry {
    return {
        path: filePath,
        status: 'missing',
        mode: null,
        content_sha256: null,
        link_sha256: null,
        line_hashes: [],
        line_count: 0,
        line_analysis: 'available'
    };
}

type LineComparisonBudget = { remainingWorkUnits: number };

function consumeLineComparisonWork(budget: LineComparisonBudget): boolean {
    if (budget.remainingWorkUnits <= 0) {
        return false;
    }
    budget.remainingWorkUnits -= 1;
    return true;
}

function getLcsLength(
    left: readonly string[],
    right: readonly string[],
    budget: LineComparisonBudget = {
        remainingWorkUnits: REVIEW_REMEDIATION_DELTA_MAX_DIFF_WORK_UNITS
    }
): number | null {
    const leftLength = left.length;
    const rightLength = right.length;
    const maxDistance = leftLength + rightLength;
    const furthest = new Map<number, number>([[1, 0]]);
    for (let distance = 0; distance <= maxDistance; distance += 1) {
        for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
            if (!consumeLineComparisonWork(budget)) {
                return null;
            }
            const down = furthest.get(diagonal + 1) ?? -1;
            const rightward = (furthest.get(diagonal - 1) ?? -1) + 1;
            let x = diagonal === -distance || (diagonal !== distance && down > rightward)
                ? down
                : rightward;
            if (x < 0) {
                x = 0;
            }
            let y = x - diagonal;
            while (x < leftLength && y < rightLength && left[x] === right[y]) {
                if (!consumeLineComparisonWork(budget)) {
                    return null;
                }
                x += 1;
                y += 1;
            }
            furthest.set(diagonal, x);
            if (x >= leftLength && y >= rightLength) {
                return (leftLength + rightLength - distance) / 2;
            }
        }
    }
    return 0;
}

function getLineDelta(
    baseline: ReviewRemediationDeltaBaseEntry,
    current: ReviewRemediationDeltaBaseEntry,
    budget: LineComparisonBudget
): {
    additions: number | null;
    deletions: number | null;
    changedLines: number | null;
    unavailableReason: string | null;
} {
    if (!baseline.line_hashes || !current.line_hashes) {
        return {
            additions: null,
            deletions: null,
            changedLines: null,
            unavailableReason: `line evidence unavailable (baseline=${baseline.line_analysis}, current=${current.line_analysis})`
        };
    }
    if (baseline.line_hashes.length === 0 || current.line_hashes.length === 0) {
        const additions = current.line_hashes.length;
        const deletions = baseline.line_hashes.length;
        return { additions, deletions, changedLines: additions + deletions, unavailableReason: null };
    }
    const lcsLength = getLcsLength(baseline.line_hashes, current.line_hashes, budget);
    if (lcsLength === null) {
        return {
            additions: null,
            deletions: null,
            changedLines: null,
            unavailableReason: `line comparison exceeded ${REVIEW_REMEDIATION_DELTA_MAX_DIFF_WORK_UNITS} work units`
        };
    }
    const additions = current.line_hashes.length - lcsLength;
    const deletions = baseline.line_hashes.length - lcsLength;
    return { additions, deletions, changedLines: additions + deletions, unavailableReason: null };
}

function getOperation(
    baseline: ReviewRemediationDeltaBaseEntry,
    current: ReviewRemediationDeltaBaseEntry
): ReviewRemediationDeltaOperation {
    if (baseline.status === 'missing' && current.status !== 'missing') {
        return 'added';
    }
    if (baseline.status !== 'missing' && current.status === 'missing') {
        return 'deleted';
    }
    if (baseline.status !== current.status) {
        return 'type_changed';
    }
    return 'modified';
}

function categorizeFile(options: {
    filePath: string;
    operation: ReviewRemediationDeltaOperation;
    changedLines: number | null;
    lineDeltaUnavailableReason: string | null;
    baselineStatus: ReviewRemediationDeltaBaseEntry['status'];
    currentStatus: ReviewRemediationDeltaBaseEntry['status'];
    testPathRegexes: readonly string[];
    structuralPatterns: readonly RegExp[];
    structuralThreshold: number;
}): { category: ReviewRemediationDeltaCategory; reason: string } {
    if (
        options.changedLines === null
        || options.baselineStatus === 'symbolic_link'
        || options.currentStatus === 'symbolic_link'
        || options.baselineStatus === 'unreviewable'
        || options.currentStatus === 'unreviewable'
    ) {
        return {
            category: 'ambiguous',
            reason: options.lineDeltaUnavailableReason
                || `line delta is unavailable for ${options.baselineStatus} -> ${options.currentStatus}`
        };
    }
    if (GENERATED_PATH_PATTERN.test(options.filePath)) {
        return { category: 'generated_churn', reason: 'path is a generated or snapshot artifact' };
    }
    if (options.structuralPatterns.some((pattern) => pattern.test(options.filePath))) {
        return {
            category: 'shared_test_helper_or_harness',
            reason: 'path matches the frozen shared test helper or harness policy'
        };
    }
    if (isTestLikeRemediationPath(options.filePath, options.testPathRegexes)) {
        if (options.operation === 'added' || options.operation === 'deleted' || options.operation === 'type_changed') {
            return {
                category: 'structural_test',
                reason: `test file operation '${options.operation}' changes test structure`
            };
        }
        if (options.changedLines > options.structuralThreshold) {
            return {
                category: 'structural_test',
                reason: `test delta ${options.changedLines} exceeds frozen structural threshold ${options.structuralThreshold}`
            };
        }
        return {
            category: 'leaf_test',
            reason: `existing leaf test delta ${options.changedLines} is within frozen threshold ${options.structuralThreshold}`
        };
    }
    if (PRODUCTION_PATH_PATTERN.test(options.filePath)) {
        return { category: 'production', reason: 'path is production runtime source' };
    }
    if (GLOBAL_PATH_PATTERN.test(options.filePath)) {
        return { category: 'global', reason: 'path changes a global config, template, workflow, or documentation contract' };
    }
    return { category: 'ambiguous', reason: 'path does not match a frozen remediation delta class' };
}

function classifyFromBaseline(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    baselineArtifactPath: string;
    baselineArtifactSha256: string;
    baseline: ReviewRemediationBaselineArtifact;
    currentChangedFiles: readonly string[];
    testPathRegexes: readonly string[];
    structuralTestPathRegexes: readonly string[];
    structuralTestChangedLinesThreshold: number;
}): ReviewRemediationDeltaClassification {
    const deltaBase = options.baseline.delta_base;
    if (!deltaBase) {
        throw new Error(
            `Review remediation delta requires a schema v${options.baseline.schema_version} baseline with delta_base evidence.`
        );
    }
    const baseViolations = getReviewRemediationDeltaBaseViolations(deltaBase, {
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewTreeStateSha256: options.baseline.bindings.tree.review_tree_state_sha256
    });
    if (baseViolations.length > 0) {
        throw new Error(`Review remediation delta baseline is incomplete: ${baseViolations.join(' ')}`);
    }
    if (options.currentChangedFiles.length > REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES) {
        throw new Error(
            `Review remediation delta accepts at most ${REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES} current changed files.`
        );
    }
    const allFiles = normalizeChangedFiles([
        ...deltaBase.changed_files,
        ...options.currentChangedFiles
    ]);
    if (allFiles.length > REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES) {
        throw new Error(
            `Review remediation delta union accepts at most ${REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES} changed files.`
        );
    }
    const currentSnapshot = buildReviewRemediationDeltaBase({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewTreeStateSha256: deltaBase.review_tree_state_sha256,
        changedFiles: allFiles
    });
    const baselineEntries = new Map(deltaBase.entries.map((entry) => [entry.path, entry]));
    const currentEntries = new Map(currentSnapshot.entries.map((entry) => [entry.path, entry]));
    const structuralPatterns = compilePatterns(
        options.structuralTestPathRegexes,
        'structural test path policy'
    );
    const fileDeltas: ReviewRemediationFileDelta[] = [];
    const unchangedFiles: string[] = [];
    const lineComparisonBudget: LineComparisonBudget = {
        remainingWorkUnits: REVIEW_REMEDIATION_DELTA_MAX_DIFF_WORK_UNITS
    };
    for (const filePath of allFiles) {
        const capturedBaselineEntry = baselineEntries.get(filePath);
        const baselineEntry = capturedBaselineEntry || missingEntry(filePath);
        const currentEntry = currentEntries.get(filePath) || missingEntry(filePath);
        const currentOnlyMissing = !capturedBaselineEntry && currentEntry.status === 'missing';
        if (!currentOnlyMissing && sameEntry(baselineEntry, currentEntry)) {
            unchangedFiles.push(filePath);
            continue;
        }
        const operation = currentOnlyMissing ? 'deleted' : getOperation(baselineEntry, currentEntry);
        const lineDelta = currentOnlyMissing
            ? {
                additions: null,
                deletions: null,
                changedLines: null,
                unavailableReason: 'path entered the current task scope after the baseline and is now missing'
            }
            : getLineDelta(baselineEntry, currentEntry, lineComparisonBudget);
        const classification = currentOnlyMissing
            ? { category: 'ambiguous' as const, reason: lineDelta.unavailableReason as string }
            : categorizeFile({
            filePath,
            operation,
            changedLines: lineDelta.changedLines,
            lineDeltaUnavailableReason: lineDelta.unavailableReason,
            baselineStatus: baselineEntry.status,
            currentStatus: currentEntry.status,
            testPathRegexes: options.testPathRegexes,
            structuralPatterns,
            structuralThreshold: options.structuralTestChangedLinesThreshold
        });
        fileDeltas.push({
            path: filePath,
            operation,
            category: classification.category,
            reason: classification.reason,
            baseline_status: baselineEntry.status,
            current_status: currentEntry.status,
            baseline_mode: baselineEntry.mode,
            current_mode: currentEntry.mode,
            baseline_content_sha256: baselineEntry.content_sha256,
            current_content_sha256: currentEntry.content_sha256,
            baseline_line_count: baselineEntry.line_count,
            current_line_count: currentEntry.line_count,
            additions: lineDelta.additions,
            deletions: lineDelta.deletions,
            changed_lines: lineDelta.changedLines
        });
    }
    const categories = [...new Set(fileDeltas.map((entry) => entry.category))].sort();
    const category: ReviewRemediationDeltaCategory = fileDeltas.length === 0 || categories.length !== 1
        ? 'ambiguous'
        : categories[0];
    const reason = fileDeltas.length === 0
        ? 'no post-baseline file content changes were detected'
        : category === 'ambiguous' && categories.length === 1
            ? `ambiguous remediation delta: ${fileDeltas.map((entry) => `${entry.path}: ${entry.reason}`).join('; ')}`
        : categories.length === 1
            ? `all changed files classify as ${categories[0]}`
            : `mixed remediation delta classes: ${categories.join(', ')}`;
    const allLineStatsAvailable = fileDeltas.every((entry) => entry.changed_lines !== null);
    const additionsTotal = allLineStatsAvailable
        ? fileDeltas.reduce((total, entry) => total + (entry.additions || 0), 0)
        : null;
    const deletionsTotal = allLineStatsAvailable
        ? fileDeltas.reduce((total, entry) => total + (entry.deletions || 0), 0)
        : null;
    const baseResult: Omit<ReviewRemediationDeltaClassification, 'classification_sha256'> = {
        schema_version: REVIEW_REMEDIATION_DELTA_SCHEMA_VERSION,
        task_id: options.taskId,
        review_type: options.reviewType,
        status: 'CLASSIFIED' as const,
        category,
        reason,
        baseline: {
            artifact_path: normalizePath(options.baselineArtifactPath),
            artifact_sha256: options.baselineArtifactSha256,
            review_tree_state_sha256: deltaBase.review_tree_state_sha256,
            delta_base_snapshot_sha256: deltaBase.snapshot_sha256
        },
        current_snapshot_sha256: currentSnapshot.snapshot_sha256,
        changed_files: fileDeltas.map((entry) => entry.path),
        unchanged_files: unchangedFiles,
        file_deltas: fileDeltas,
        additions_total: additionsTotal,
        deletions_total: deletionsTotal,
        changed_lines_total: additionsTotal === null || deletionsTotal === null
            ? null
            : additionsTotal + deletionsTotal
    };
    return {
        ...baseResult,
        classification_sha256: sha256RedactedJsonPayload(baseResult)
    };
}

/**
 * Pure T-979-37 classification boundary. It deliberately does not select or rerun
 * review lanes: T-979-38 maps this result to the snapshotted rerun policy and
 * T-979-40 integrates that policy with recovery routing.
 */
export function classifyReviewRemediationDelta(
    options: ClassifyReviewRemediationDeltaOptions
): ReviewRemediationDeltaClassification {
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    const baselineValidation = validateReviewRemediationBaselineArtifact({
        artifactPath: options.baselineArtifactPath,
        expectedArtifactSha256: options.baselineArtifactSha256,
        expectedTaskId: options.taskId,
        expectedReviewType: reviewType
    });
    if (!baselineValidation.valid || !baselineValidation.artifact || !baselineValidation.artifact_sha256) {
        throw new Error(
            `Review remediation delta requires a current authenticated baseline: ${baselineValidation.violations.join(' ')}`
        );
    }
    const structuralThreshold = options.structuralTestChangedLinesThreshold
        ?? DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_changed_lines_threshold;
    if (!Number.isInteger(structuralThreshold) || structuralThreshold < 1) {
        throw new Error('Review remediation delta structural test changed-lines threshold must be a positive integer.');
    }
    return classifyFromBaseline({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType,
        baselineArtifactPath: options.baselineArtifactPath,
        baselineArtifactSha256: baselineValidation.artifact_sha256,
        baseline: baselineValidation.artifact,
        currentChangedFiles: options.currentChangedFiles,
        testPathRegexes: options.testPathRegexes ?? DEFAULT_REVIEW_TRIGGER_POLICY.test_path_regexes,
        structuralTestPathRegexes: options.structuralTestPathRegexes
            ?? DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_structural_path_regexes,
        structuralTestChangedLinesThreshold: structuralThreshold
    });
}

export const reviewRemediationDeltaInternals = {
    getLcsLength,
    sha256Text
};

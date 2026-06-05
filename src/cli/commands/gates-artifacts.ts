import * as fs from 'node:fs';
import * as path from 'node:path';
import * as gateHelpers from '../../gates/shared/helpers';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import { resolveActiveTaskIds } from '../../core/active-task-state';
import { resolveCanonicalReviewContextPath } from '../../gates/review-context/review-context-paths';
import {
    resolveLegacyReviewTempRoot,
    resolveReviewScratchRoot,
    resolveReviewScratchRoots
} from '../../gates/review/review-scratch-paths';
import { writeReviewArtifactJson, writeReviewArtifactText } from '../../gate-runtime/review-artifacts';

export interface TerminalLogCleanupResult {
    triggered: boolean;
    attempted_paths: number;
    discovered_paths: string[];
    deleted_paths: string[];
    stale_deleted_paths: string[];
    missing_paths: string[];
    retained_paths: string[];
    errors: string[];
}

interface ReviewTempOwnership {
    task_id: string | null;
    task_id_key: string | null;
    review_type: string | null;
}

const REVIEW_TEMP_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const REVIEW_TEMP_REVIEW_TYPES = [
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'test',
    'performance',
    'infra',
    'dependency'
] as const;

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function requireResolvedPath(resolvedPath: string | null, label: string): string {
    if (!resolvedPath) {
        throw new Error(`${label} must not be empty.`);
    }
    return resolvedPath;
}

function createTerminalCleanupResult(triggered: boolean): TerminalLogCleanupResult {
    return {
        triggered,
        attempted_paths: 0,
        discovered_paths: [],
        deleted_paths: [],
        stale_deleted_paths: [],
        missing_paths: [],
        retained_paths: [],
        errors: []
    };
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
    const normalizedCandidatePath = gateHelpers.normalizePath(path.resolve(candidatePath)).toLowerCase();
    const normalizedRootPath = gateHelpers.normalizePath(path.resolve(rootPath)).toLowerCase();
    return normalizedCandidatePath === normalizedRootPath || normalizedCandidatePath.startsWith(`${normalizedRootPath}/`);
}

function pruneEmptyDirectoriesUpToRoot(startDirectory: string, rootDirectory: string): void {
    let currentDirectory = path.resolve(startDirectory);
    const resolvedRootDirectory = path.resolve(rootDirectory);
    while (isPathInsideRoot(currentDirectory, resolvedRootDirectory)) {
        if (!fs.existsSync(currentDirectory) || !fs.statSync(currentDirectory).isDirectory()) {
            break;
        }
        if (fs.readdirSync(currentDirectory).length > 0) {
            break;
        }
        fs.rmdirSync(currentDirectory);
        if (currentDirectory.toLowerCase() === resolvedRootDirectory.toLowerCase()) {
            break;
        }
        const parentDirectory = path.dirname(currentDirectory);
        if (parentDirectory === currentDirectory) {
            break;
        }
        currentDirectory = parentDirectory;
    }
}

function pruneEmptyDirectoryTree(rootDirectory: string): void {
    if (!fs.existsSync(rootDirectory) || !fs.statSync(rootDirectory).isDirectory()) {
        return;
    }
    const directories = [rootDirectory];
    for (let index = 0; index < directories.length; index += 1) {
        const currentDirectory = directories[index];
        for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                directories.push(path.join(currentDirectory, entry.name));
            }
        }
    }
    for (const directoryPath of directories.sort((left, right) => right.length - left.length)) {
        try {
            if (fs.existsSync(directoryPath)
                && fs.statSync(directoryPath).isDirectory()
                && fs.readdirSync(directoryPath).length === 0) {
                fs.rmdirSync(directoryPath);
            }
        } catch {
            // Best-effort cleanup only. Retained paths are reported by the next cleanup pass.
        }
    }
}

function normalizeTaskIdForComparison(taskId: unknown): string | null {
    const rawTaskId = String(taskId || '').trim();
    if (!rawTaskId) {
        return null;
    }
    try {
        return assertValidTaskId(rawTaskId).toLowerCase();
    } catch {
        return null;
    }
}

function normalizeReviewTypeForComparison(reviewType: string | null | undefined): string | null {
    const normalized = String(reviewType || '').trim().toLowerCase();
    return REVIEW_TEMP_REVIEW_TYPES.includes(normalized as typeof REVIEW_TEMP_REVIEW_TYPES[number])
        ? normalized
        : null;
}

function parseReviewTempFileNameOwnership(fileName: string): ReviewTempOwnership {
    const normalizedFileName = String(fileName || '').trim();
    const normalizedLowerFileName = normalizedFileName.toLowerCase();
    for (const reviewType of REVIEW_TEMP_REVIEW_TYPES) {
        for (const marker of [`-${reviewType}-`, `-${reviewType}.`]) {
            let searchFromIndex = normalizedLowerFileName.length;
            while (searchFromIndex > 0) {
                const markerIndex = normalizedLowerFileName.lastIndexOf(marker, searchFromIndex - 1);
                if (markerIndex <= 0) {
                    break;
                }
                const candidateTaskId = normalizedFileName.slice(0, markerIndex);
                const candidateTaskIdKey = normalizeTaskIdForComparison(candidateTaskId);
                if (candidateTaskIdKey) {
                    return {
                        task_id: candidateTaskId,
                        task_id_key: candidateTaskIdKey,
                        review_type: reviewType
                    };
                }
                searchFromIndex = markerIndex;
            }
        }
    }

    return {
        task_id: null,
        task_id_key: null,
        review_type: null
    };
}

function getReviewTempRelativeSegments(reviewTempRoot: string, candidatePath: string): string[] {
    const resolvedReviewTempRoot = path.resolve(reviewTempRoot);
    const resolvedCandidatePath = path.resolve(candidatePath);
    if (!isPathInsideRoot(resolvedCandidatePath, resolvedReviewTempRoot)) {
        return [];
    }
    const relativePath = gateHelpers.normalizePath(path.relative(resolvedReviewTempRoot, resolvedCandidatePath));
    if (!relativePath || relativePath === '.') {
        return [];
    }
    return relativePath.split('/').filter((segment) => segment.length > 0);
}

function inspectReviewTempOwnership(reviewTempRoot: string, candidatePath: string): ReviewTempOwnership {
    const relativeSegments = getReviewTempRelativeSegments(reviewTempRoot, candidatePath);
    let taskId: string | null = null;
    let taskIdKey: string | null = null;
    let reviewType: string | null = null;
    const lastSegmentIndex = relativeSegments.length - 1;

    for (let index = 0; index < lastSegmentIndex; index += 1) {
        const segment = relativeSegments[index];
        const segmentTaskIdKey = normalizeTaskIdForComparison(segment);
        const nextSegmentReviewType = normalizeReviewTypeForComparison(relativeSegments[index + 1] || '');
        if (segmentTaskIdKey && nextSegmentReviewType) {
            taskId = segment;
            taskIdKey = segmentTaskIdKey;
            reviewType = nextSegmentReviewType;
        }
    }

    const fileNameOwnership = parseReviewTempFileNameOwnership(path.basename(candidatePath));
    if (!taskIdKey && fileNameOwnership.task_id_key) {
        taskId = fileNameOwnership.task_id;
        taskIdKey = fileNameOwnership.task_id_key;
    }
    if (!reviewType && fileNameOwnership.review_type) {
        reviewType = fileNameOwnership.review_type;
    }

    return {
        task_id: taskId,
        task_id_key: taskIdKey,
        review_type: reviewType
    };
}

function isReviewTempPathOwnedByTask(reviewTempRoot: string, candidatePath: string, taskId: string): boolean {
    const normalizedTaskId = normalizeTaskIdForComparison(taskId);
    if (!normalizedTaskId) {
        return false;
    }

    const ownership = inspectReviewTempOwnership(reviewTempRoot, candidatePath);
    if (ownership.task_id_key === normalizedTaskId) {
        return true;
    }

    const relativeSegments = getReviewTempRelativeSegments(reviewTempRoot, candidatePath);
    if (relativeSegments.some((segment) => segment.toLowerCase() === normalizedTaskId)) {
        return true;
    }

    return path.basename(candidatePath).toLowerCase().startsWith(`${normalizedTaskId}-`);
}

export function isTaskOwnedReviewTempPath(repoRoot: string, taskId: string, candidatePath: string): boolean {
    let resolvedCandidatePath: string | null;
    try {
        resolvedCandidatePath = gateHelpers.resolvePathInsideRepo(candidatePath, repoRoot, { allowMissing: true });
    } catch {
        return false;
    }
    if (!resolvedCandidatePath) {
        return false;
    }
    if (!gateHelpers.isPathRealpathInsideRoot(resolvedCandidatePath, repoRoot, { allowMissing: true })) {
        return false;
    }
    const reviewScratchRoot = resolveReviewScratchRoot(repoRoot);
    if (!isPathInsideRoot(resolvedCandidatePath, reviewScratchRoot)) {
        return false;
    }
    if (!gateHelpers.isPathRealpathInsideRoot(resolvedCandidatePath, reviewScratchRoot, { allowMissing: true })) {
        return false;
    }
    return isReviewTempPathOwnedByTask(reviewScratchRoot, resolvedCandidatePath, taskId);
}

function resolveReviewTempActiveTaskIdKeys(repoRoot: string, currentTaskId: string): Set<string> {
    const activeTaskIds = resolveActiveTaskIds(repoRoot, gateHelpers.joinOrchestratorPath(repoRoot, ''));
    const currentTaskIdKey = normalizeTaskIdForComparison(currentTaskId);
    const activeTaskIdKeys = new Set<string>();
    for (const activeTaskId of activeTaskIds) {
        const activeTaskIdKey = normalizeTaskIdForComparison(activeTaskId);
        if (!activeTaskIdKey || activeTaskIdKey === currentTaskIdKey) {
            continue;
        }
        activeTaskIdKeys.add(activeTaskIdKey);
    }
    return activeTaskIdKeys;
}

function isReviewTempPathOwnedByAnyTask(reviewTempRoot: string, candidatePath: string, taskIdKeys: ReadonlySet<string>): boolean {
    const ownership = inspectReviewTempOwnership(reviewTempRoot, candidatePath);
    if (ownership.task_id_key && taskIdKeys.has(ownership.task_id_key)) {
        return true;
    }

    const relativeSegments = getReviewTempRelativeSegments(reviewTempRoot, candidatePath);
    if (relativeSegments.some((segment) => taskIdKeys.has(segment.toLowerCase()))) {
        return true;
    }

    const basename = path.basename(candidatePath).toLowerCase();
    return [...taskIdKeys].some((taskIdKey) => basename.startsWith(`${taskIdKey}-`));
}

function isReviewTempFileStale(candidatePath: string, nowMs: number): boolean {
    try {
        const stat = fs.statSync(candidatePath);
        return nowMs - stat.mtimeMs >= REVIEW_TEMP_STALE_AGE_MS;
    } catch {
        return false;
    }
}

function cleanupCandidateFilePath(
    repoRoot: string,
    candidatePath: string,
    result: TerminalLogCleanupResult,
    kindLabel: string
): void {
    let resolvedCandidatePath: string | null;
    try {
        resolvedCandidatePath = gateHelpers.resolvePathInsideRepo(candidatePath, repoRoot, { allowMissing: true });
    } catch (error) {
        result.errors.push(
            `${kindLabel} path is invalid '${String(candidatePath)}': ${getErrorMessage(error)}`
        );
        return;
    }
    if (!resolvedCandidatePath) {
        result.errors.push(`${kindLabel} path is invalid '${String(candidatePath)}': resolved path is empty.`);
        return;
    }

    const normalizedPath = gateHelpers.normalizePath(resolvedCandidatePath);
    result.discovered_paths.push(normalizedPath);
    result.attempted_paths = result.discovered_paths.length;

    if (!fs.existsSync(resolvedCandidatePath) || !fs.statSync(resolvedCandidatePath).isFile()) {
        result.missing_paths.push(normalizedPath);
        return;
    }

    try {
        fs.unlinkSync(resolvedCandidatePath);
        result.deleted_paths.push(normalizedPath);
    } catch (error) {
        result.errors.push(
            `Failed to delete ${kindLabel.toLowerCase()} '${normalizedPath}': ${getErrorMessage(error)}`
        );
    }
}

export function normalizeOptionalPath(pathValue: unknown): string | null {
    if (!pathValue) {
        return null;
    }
    return gateHelpers.normalizePath(pathValue);
}

export function writeJsonArtifact(filePath: string | null | undefined, payload: unknown): void {
    if (!filePath) {
        return;
    }
    writeReviewArtifactJson(filePath, payload);
}

export function writeTextArtifact(filePath: string | null | undefined, payload: string): void {
    if (!filePath) {
        return;
    }
    writeReviewArtifactText(filePath, payload);
}

export function removeArtifactIfExists(filePath: string | null | undefined): void {
    if (!filePath) {
        return;
    }
    try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            fs.rmSync(filePath, { force: true });
        }
    } catch {
        // Best-effort cleanup only. The original gate failure should surface.
    }
}

export function resolvePathForWrite(pathValue: string, repoRoot: string): string | null {
    return gateHelpers.resolvePathInsideRepo(pathValue, repoRoot, { allowMissing: true });
}

export function resolveDefaultReviewsPath(repoRoot: string, suffix: string): string {
    return gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', suffix));
}

export function resolveDefaultMetricsPath(repoRoot: string): string {
    return gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'metrics.jsonl'));
}

export function resolvePreflightPath(repoRoot: string, explicitPath: string, taskId: string): string {
    if (explicitPath) {
        return requireResolvedPath(gateHelpers.resolvePathInsideRepo(explicitPath, repoRoot), 'PreflightPath');
    }
    return resolveDefaultReviewsPath(repoRoot, `${taskId}-preflight.json`);
}

export function cleanupReviewTempSourceArtifact(
    repoRoot: string,
    taskId: string,
    reviewOutputSourcePath: string | null | undefined
): void {
    const rawSourcePath = String(reviewOutputSourcePath || '').trim();
    if (!rawSourcePath) {
        return;
    }

    let resolvedSourcePath: string | null;
    try {
        resolvedSourcePath = gateHelpers.resolvePathInsideRepo(rawSourcePath, repoRoot, { allowMissing: true });
    } catch {
        return;
    }
    if (!resolvedSourcePath || !fs.existsSync(resolvedSourcePath) || !fs.statSync(resolvedSourcePath).isFile()) {
        return;
    }

    const reviewTempRoot = resolveReviewScratchRoots(repoRoot)
        .find((candidateRoot) => isPathInsideRoot(resolvedSourcePath as string, candidateRoot));
    if (!reviewTempRoot || !isReviewTempPathOwnedByTask(reviewTempRoot, resolvedSourcePath, taskId)) {
        return;
    }

    try {
        fs.unlinkSync(resolvedSourcePath);
        pruneEmptyDirectoriesUpToRoot(path.dirname(resolvedSourcePath), reviewTempRoot);
    } catch {
        // Best-effort cleanup only. Canonical review evidence already exists.
    }
}

export function writeCompileEvidence(
    evidencePath: string | null | undefined,
    resolvedTaskId: string | null | undefined,
    gateContext: Record<string, unknown>,
    status: string,
    outcome: string,
    errorMessage: string | null
): void {
    if (!evidencePath || !resolvedTaskId) {
        return;
    }
    writeJsonArtifact(evidencePath, {
        timestamp_utc: new Date().toISOString(),
        event_source: 'compile-gate',
        task_id: resolvedTaskId,
        status,
        outcome,
        error: errorMessage || null,
        ...gateContext
    });
}

export function resolveReviewContextPath(reviewsRoot: string, taskId: string | null, reviewKey: string): string {
    const timelinePath = path.resolve(reviewsRoot, '..', 'task-events', `${taskId}.jsonl`);
    if (fs.existsSync(timelinePath) && fs.statSync(timelinePath).isFile()) {
        const lines = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0);
        for (let index = lines.length - 1; index >= 0; index -= 1) {
            try {
                const parsed = JSON.parse(lines[index]) as Record<string, unknown>;
                const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                    ? parsed.details as Record<string, unknown>
                    : null;
                const reviewType = String(details?.review_type || details?.reviewType || '').trim().toLowerCase();
                const reviewContextPath = String(details?.review_context_path || details?.reviewContextPath || '').trim();
                if (
                    String(parsed.event_type || '').trim().toUpperCase() === 'REVIEW_RECORDED'
                    && reviewType === reviewKey
                    && reviewContextPath
                    && fs.existsSync(reviewContextPath)
                    && fs.statSync(reviewContextPath).isFile()
                ) {
                    return resolveCanonicalReviewContextPath({
                        reviewsRoot,
                        taskId,
                        reviewType: reviewKey,
                        explicitPath: reviewContextPath
                    });
                }
            } catch {
                // Ignore malformed timeline lines here; downstream validators will surface integrity issues separately.
            }
        }
    }
    return resolveCanonicalReviewContextPath({
        reviewsRoot,
        taskId,
        reviewType: reviewKey
    });
}

export function writeReviewEvidence(
    evidencePath: string | null | undefined,
    resolvedTaskId: string | null | undefined,
    context: Record<string, unknown>,
    status: string,
    outcome: string,
    violations: string[] | null | undefined
): void {
    if (!evidencePath || !resolvedTaskId) {
        return;
    }
    writeJsonArtifact(evidencePath, {
        timestamp_utc: new Date().toISOString(),
        event_source: 'required-reviews-check',
        task_id: resolvedTaskId,
        status,
        outcome,
        violations: violations || [],
        ...context
    });
}

export function cleanupTerminalCompileLogs(repoRoot: string, taskId: string): TerminalLogCleanupResult {
    const result = createTerminalCleanupResult(true);
    const reviewsRoot = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const candidatePaths = new Set<string>();

    if (fs.existsSync(reviewsRoot) && fs.statSync(reviewsRoot).isDirectory()) {
        const prefix = `${taskId}-compile-output`;
        for (const entry of fs.readdirSync(reviewsRoot, { withFileTypes: true })) {
            if (!entry.isFile()) {
                continue;
            }
            if (entry.name.startsWith(prefix) && entry.name.endsWith('.log')) {
                candidatePaths.add(path.join(reviewsRoot, entry.name));
            }
        }
    }

    const compileEvidencePath = path.join(reviewsRoot, `${taskId}-compile-gate.json`);
    if (fs.existsSync(compileEvidencePath) && fs.statSync(compileEvidencePath).isFile()) {
        try {
            const compileEvidence = JSON.parse(fs.readFileSync(compileEvidencePath, 'utf8')) as Record<string, unknown>;
            const compileOutputPath = typeof compileEvidence.compile_output_path === 'string'
                ? compileEvidence.compile_output_path
                : '';
            if (compileOutputPath.trim()) {
                const resolvedCompileOutputPath = gateHelpers.resolvePathInsideRepo(compileOutputPath, repoRoot, { allowMissing: true });
                if (resolvedCompileOutputPath) {
                    candidatePaths.add(resolvedCompileOutputPath);
                }
            }
        } catch (error) {
            result.errors.push(
                `Failed to read compile evidence '${gateHelpers.normalizePath(compileEvidencePath)}': ${getErrorMessage(error)}`
            );
        }
    }

    for (const candidatePath of [...candidatePaths].sort()) {
        cleanupCandidateFilePath(repoRoot, candidatePath, result, 'Compile output');
    }

    return result;
}

export function cleanupTerminalReviewTempOutputs(repoRoot: string, taskId: string): TerminalLogCleanupResult {
    const result = createTerminalCleanupResult(true);
    const candidatePaths = new Set<string>();
    const staleCandidatePaths = new Set<string>();
    const retainedPaths = new Set<string>();
    const nowMs = Date.now();
    const activeTaskIdKeys = resolveReviewTempActiveTaskIdKeys(repoRoot, taskId);

    for (const reviewTempRoot of resolveReviewScratchRoots(repoRoot)) {
        if (!fs.existsSync(reviewTempRoot) || !fs.statSync(reviewTempRoot).isDirectory()) {
            continue;
        }

        const directoryQueue = [reviewTempRoot];
        while (directoryQueue.length > 0) {
            const currentDirectory = directoryQueue.pop() as string;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(currentDirectory, { withFileTypes: true });
            } catch (error) {
                result.errors.push(
                    `Failed to read review temp directory '${gateHelpers.normalizePath(currentDirectory)}': ${getErrorMessage(error)}`
                );
                continue;
            }

            for (const entry of entries) {
                const entryPath = path.join(currentDirectory, entry.name);
                if (entry.isDirectory()) {
                    directoryQueue.push(entryPath);
                    continue;
                }
                if (!entry.isFile()) {
                    continue;
                }
                if (isReviewTempPathOwnedByTask(reviewTempRoot, entryPath, taskId)) {
                    candidatePaths.add(entryPath);
                    continue;
                }
                if (!isReviewTempFileStale(entryPath, nowMs)) {
                    retainedPaths.add(gateHelpers.normalizePath(entryPath));
                    continue;
                }

                if (isReviewTempPathOwnedByAnyTask(reviewTempRoot, entryPath, activeTaskIdKeys)) {
                    retainedPaths.add(gateHelpers.normalizePath(entryPath));
                    continue;
                }
                const ownership = inspectReviewTempOwnership(reviewTempRoot, entryPath);
                if (!ownership.task_id_key) {
                    retainedPaths.add(gateHelpers.normalizePath(entryPath));
                    continue;
                }
                staleCandidatePaths.add(entryPath);
            }
        }
    }

    for (const candidatePath of [...candidatePaths].sort()) {
        const deletedPathsBeforeCleanup = result.deleted_paths.length;
        cleanupCandidateFilePath(repoRoot, candidatePath, result, 'Review temp output');
        if (result.deleted_paths.length > deletedPathsBeforeCleanup) {
            for (const reviewTempRoot of resolveReviewScratchRoots(repoRoot)) {
                if (isPathInsideRoot(candidatePath, reviewTempRoot)) {
                    pruneEmptyDirectoriesUpToRoot(path.dirname(candidatePath), reviewTempRoot);
                    break;
                }
            }
        }
    }
    for (const candidatePath of [...staleCandidatePaths].sort()) {
        const deletedPathsBeforeCleanup = result.deleted_paths.length;
        cleanupCandidateFilePath(repoRoot, candidatePath, result, 'Review temp stale output');
        if (result.deleted_paths.length > deletedPathsBeforeCleanup) {
            result.stale_deleted_paths.push(gateHelpers.normalizePath(candidatePath));
            for (const reviewTempRoot of resolveReviewScratchRoots(repoRoot)) {
                if (isPathInsideRoot(candidatePath, reviewTempRoot)) {
                    pruneEmptyDirectoriesUpToRoot(path.dirname(candidatePath), reviewTempRoot);
                    break;
                }
            }
        }
    }
    result.retained_paths = [...retainedPaths].sort();
    for (const reviewTempRoot of [resolveReviewScratchRoot(repoRoot), resolveLegacyReviewTempRoot(repoRoot)]) {
        pruneEmptyDirectoryTree(reviewTempRoot);
        pruneEmptyDirectoriesUpToRoot(reviewTempRoot, reviewTempRoot);
    }

    return result;
}

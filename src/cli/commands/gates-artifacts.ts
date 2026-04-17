import * as fs from 'node:fs';
import * as path from 'node:path';
import * as gateHelpers from '../../gates/helpers';
import { resolveCanonicalReviewContextPath } from '../../gates/review-context-paths';
import { writeReviewArtifactJson, writeReviewArtifactText } from '../../gate-runtime/review-artifacts';

export interface TerminalLogCleanupResult {
    triggered: boolean;
    attempted_paths: number;
    discovered_paths: string[];
    deleted_paths: string[];
    missing_paths: string[];
    errors: string[];
}

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
        missing_paths: [],
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

    const reviewTempRoot = path.resolve(repoRoot, '.review-temp');
    if (!isPathInsideRoot(resolvedSourcePath, reviewTempRoot)) {
        return;
    }
    if (!path.basename(resolvedSourcePath).startsWith(`${taskId}-`)) {
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
    const reviewTempRoot = path.resolve(repoRoot, '.review-temp');
    if (!fs.existsSync(reviewTempRoot) || !fs.statSync(reviewTempRoot).isDirectory()) {
        return result;
    }

    const candidatePaths = new Set<string>();
    const directoryQueue = [reviewTempRoot];
    const fileNamePrefix = `${taskId}-`;

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
            if (entry.name.startsWith(fileNamePrefix)) {
                candidatePaths.add(entryPath);
            }
        }
    }

    for (const candidatePath of [...candidatePaths].sort()) {
        cleanupCandidateFilePath(repoRoot, candidatePath, result, 'Review temp output');
    }
    pruneEmptyDirectoriesUpToRoot(reviewTempRoot, reviewTempRoot);

    return result;
}

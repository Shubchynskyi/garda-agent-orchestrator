import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildScopedDiffMetadata, convertToGitPathspecs, filterDiffByHunks } from '../gate-runtime/scoped-diff';
import { withReviewArtifactLock, writeArtifactFileAtomically } from '../gate-runtime/review-artifacts';
import { matchAnyRegex } from '../gate-runtime/text-utils';
import { normalizePath, resolveGitRoot, resolvePathInsideRepo, toStringArray, toPosix } from './helpers';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../core/subprocess';

/**
 * Resolve output path for scoped diff.
 */
export function resolveOutputPath(explicitOutputPath: string, preflightPath: string, reviewType: string, repoRoot: string): string {
    if (explicitOutputPath && explicitOutputPath.trim()) {
        return resolvePathInsideRepo(explicitOutputPath, repoRoot, { allowMissing: true }) as string;
    }
    const preflightDir = path.dirname(preflightPath);
    const baseName = path.basename(preflightPath, path.extname(preflightPath)).replace(/-preflight$/, '');
    return path.resolve(preflightDir, `${baseName}-${reviewType}-scoped.diff`);
}

/**
 * Resolve metadata path for scoped diff.
 */
export function resolveMetadataPath(explicitMetadataPath: string, preflightPath: string, reviewType: string, repoRoot: string): string {
    if (explicitMetadataPath && explicitMetadataPath.trim()) {
        return resolvePathInsideRepo(explicitMetadataPath, repoRoot, { allowMissing: true }) as string;
    }
    const preflightDir = path.dirname(preflightPath);
    const baseName = path.basename(preflightPath, path.extname(preflightPath)).replace(/-preflight$/, '');
    return path.resolve(preflightDir, `${baseName}-${reviewType}-scoped.json`);
}

/**
 * Run git diff and return stdout text.
 */
export function runGitDiff(gitRoot: string, useStaged: boolean, pathspecs: string[]): string {
    const gitArgs = ['-C', String(gitRoot), 'diff', '--no-color'];
    if (useStaged) gitArgs.push('--staged');
    else gitArgs.push('HEAD');
    if (pathspecs && pathspecs.length > 0) {
        gitArgs.push('--');
        gitArgs.push(...pathspecs);
    }
    const result = spawnSyncWithTimeout('git', gitArgs, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024,
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS
    });
    if (result.timedOut) {
        throw new Error(`git diff timed out after ${DEFAULT_GIT_TIMEOUT_MS} ms.`);
    }
    if (result.error) {
        throw new Error(`git diff exited with error: ${result.error.message || result.error}`);
    }
    if (result.status !== 0) {
        const errText = String(result.stderr || '').trim();
        throw new Error(`git diff exited with code ${result.status}. ${errText}`);
    }
    return String(result.stdout || '');
}

export interface BuildScopedDiffOptions {
    reviewType: string;
    preflightPath: string;
    pathsConfigPath: string;
    outputPath: string;
    metadataPath: string;
    fullDiffPath?: string | null;
    repoRoot: string;
    useStaged?: boolean;
    hunkLevel?: boolean;
}

/**
 * Build a scoped diff for a specific review type.
 * Orchestrates git operations and writes artifacts.
 * Supports hunk-level filtering when `hunkLevel` is true.
 * Returns the metadata object.
 */
export function buildScopedDiff(options: BuildScopedDiffOptions) {
    const reviewType = options.reviewType;
    const preflightPath = options.preflightPath;
    const pathsConfigPath = options.pathsConfigPath;
    const outputPath = options.outputPath;
    const metadataPath = options.metadataPath;
    const fullDiffPath = options.fullDiffPath || null;
    const repoRoot = options.repoRoot;
    const useStaged = options.useStaged || false;
    const hunkLevel = options.hunkLevel || false;

    const gitRepoRoot = resolveGitRoot(repoRoot);

    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    const changedFiles = [...new Set(
        toStringArray(preflight.changed_files).map(f => String(f).replace(/\\/g, '/')).filter(Boolean)
    )].sort();

    const pathsConfig = JSON.parse(fs.readFileSync(pathsConfigPath, 'utf8'));
    const triggers = pathsConfig.triggers || {};
    const triggerRegexes = toStringArray(triggers[reviewType]);
    if (!triggerRegexes.length) {
        throw new Error(`No trigger regexes found for review type '${reviewType}' in ${pathsConfigPath}`);
    }

    const matchedFiles = changedFiles.filter(
        p => matchAnyRegex(p, triggerRegexes, {
            skipInvalidRegex: true,
            invalidRegexContext: `review '${reviewType}'`,
            caseInsensitive: true
        })
    );

    let scopedDiffText = '';
    let fallbackToFullDiff = false;
    let fullDiffSource = 'none';

    if (matchedFiles.length > 0) {
        try {
            const gitPathspecs = convertToGitPathspecs(matchedFiles, toPosix(repoRoot), toPosix(gitRepoRoot));
            scopedDiffText = runGitDiff(gitRepoRoot, useStaged, gitPathspecs);
            if (!scopedDiffText.trim()) fallbackToFullDiff = true;
        } catch {
            fallbackToFullDiff = true;
        }
    } else {
        fallbackToFullDiff = true;
    }

    let outputDiffText = scopedDiffText;
    if (fallbackToFullDiff) {
        if (fullDiffPath && fs.existsSync(fullDiffPath) && fs.statSync(fullDiffPath).isFile()) {
            outputDiffText = fs.readFileSync(fullDiffPath, 'utf8');
            fullDiffSource = 'artifact';
        } else {
            outputDiffText = runGitDiff(gitRepoRoot, useStaged, []);
            fullDiffSource = 'git';
        }
    }

    // Apply hunk-level filtering when enabled
    let hunkFilterResult = null;
    if (hunkLevel && outputDiffText && outputDiffText.trim()) {
        const filterResult = filterDiffByHunks(outputDiffText, triggerRegexes, {
            reviewType
        });
        // Always apply hunk filtering result, even if it produces empty output
        if (filterResult.hunkLevelFiltered) {
            outputDiffText = filterResult.filteredDiffText;
        }
        hunkFilterResult = {
            total_file_blocks: filterResult.totalFileBlocks,
            included_file_blocks: filterResult.includedFileBlocks,
            total_hunks: filterResult.totalHunks,
            included_hunks: filterResult.includedHunks,
            hunk_level_filtered: filterResult.hunkLevelFiltered
        };
    }

    let outputPayload = outputDiffText || '';
    if (outputPayload && !outputPayload.endsWith('\n')) outputPayload += '\n';

    function lineCount(text: string): number {
        if (!text) return 0;
        return text.split('\n').length;
    }

    const result: Record<string, unknown> = {
        review_type: reviewType,
        preflight_path: normalizePath(preflightPath),
        paths_config_path: normalizePath(pathsConfigPath),
        output_path: normalizePath(outputPath),
        metadata_path: normalizePath(metadataPath),
        git_repo_root: normalizePath(gitRepoRoot),
        full_diff_path: fullDiffPath ? normalizePath(fullDiffPath) : null,
        full_diff_source: fullDiffSource,
        use_staged: !!useStaged,
        matched_files_count: matchedFiles.length,
        matched_files: matchedFiles,
        fallback_to_full_diff: !!fallbackToFullDiff,
        scoped_diff_line_count: lineCount(scopedDiffText),
        output_diff_line_count: lineCount(outputPayload),
        hunk_level: !!hunkLevel
    };

    if (hunkFilterResult) {
        result.hunk_filter = hunkFilterResult;
    }

    withReviewArtifactLock(metadataPath, () => {
        writeArtifactFileAtomically(outputPath, outputPayload);
        writeArtifactFileAtomically(metadataPath, JSON.stringify(result, null, 2) + '\n');
    });

    return result;
}

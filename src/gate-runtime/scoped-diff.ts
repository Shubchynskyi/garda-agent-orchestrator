import { matchAnyRegex } from './text-utils';
import * as path from 'node:path';

/**
 * Build a scoped diff by filtering changed files against trigger regexes.
 * Pure-logic helper: callers provide preflight data and diff text.
 *
 * Shared scoped-diff behavior used by the Node gate runtime.
 * without git or filesystem side effects.
 */
export interface ScopedDiffOptions {
    reviewType: string;
    changedFiles?: string[];
    triggerRegexes?: string[];
    scopedDiffText?: string;
    fullDiffText?: string;
    fullDiffSource?: string;
    useStaged?: boolean;
    preflightPath?: string;
    pathsConfigPath?: string;
    outputPath?: string;
    metadataPath?: string;
    gitRepoRoot?: string;
    fullDiffPath?: string;
}

export function buildScopedDiffMetadata(options: ScopedDiffOptions): Record<string, unknown> {
    const reviewType = options.reviewType;
    const changedFiles = options.changedFiles || [];
    const triggerRegexes = options.triggerRegexes || [];
    const scopedDiffText = options.scopedDiffText || '';
    const fullDiffText = options.fullDiffText || '';
    const fullDiffSource = options.fullDiffSource || 'none';
    const useStaged = options.useStaged || false;
    const preflightPath = options.preflightPath || '';
    const pathsConfigPath = options.pathsConfigPath || '';
    const outputPath = options.outputPath || '';
    const metadataPath = options.metadataPath || '';
    const gitRepoRoot = options.gitRepoRoot || '';
    const fullDiffPath = options.fullDiffPath || '';

    if (!reviewType) {
        throw new Error("reviewType is required.");
    }
    if (triggerRegexes.length === 0) {
        throw new Error(`No trigger regexes found for review type '${reviewType}'.`);
    }

    const normalizedChangedFiles = [...new Set(
        changedFiles.map(f => String(f).replace(/\\/g, '/')).sort()
    )];

    const matchedFiles = normalizedChangedFiles.filter(
        filePath => matchAnyRegex(filePath, triggerRegexes, {
            skipInvalidRegex: true,
            invalidRegexContext: `review '${reviewType}'`,
            caseInsensitive: true
        })
    ).sort();

    let fallbackToFullDiff = false;
    let outputDiffText;

    if (matchedFiles.length > 0 && scopedDiffText && scopedDiffText.trim()) {
        outputDiffText = scopedDiffText;
    } else {
        fallbackToFullDiff = true;
        outputDiffText = fullDiffText;
    }

    function countLines(text: string): number {
        if (!text) return 0;
        return text.split(/\r?\n/).length;
    }

    return {
        review_type: reviewType,
        preflight_path: preflightPath ? String(preflightPath).replace(/\\/g, '/') : null,
        paths_config_path: pathsConfigPath ? String(pathsConfigPath).replace(/\\/g, '/') : null,
        output_path: outputPath ? String(outputPath).replace(/\\/g, '/') : null,
        metadata_path: metadataPath ? String(metadataPath).replace(/\\/g, '/') : null,
        git_repo_root: gitRepoRoot ? String(gitRepoRoot).replace(/\\/g, '/') : null,
        full_diff_path: fullDiffPath ? String(fullDiffPath).replace(/\\/g, '/') : null,
        full_diff_source: fullDiffSource,
        use_staged: useStaged,
        matched_files_count: matchedFiles.length,
        matched_files: matchedFiles,
        fallback_to_full_diff: fallbackToFullDiff,
        scoped_diff_line_count: countLines(scopedDiffText),
        output_diff_line_count: countLines(outputDiffText),
        output_diff_text: outputDiffText
    };
}

// --- Hunk-level diff parsing and filtering ---

export interface DiffHunk {
    header: string;
    lines: string[];
}

export interface DiffFileBlock {
    filePath: string;
    headerLines: string[];
    hunks: DiffHunk[];
}

/**
 * Parse a unified diff into per-file blocks with per-hunk granularity.
 * Handles standard `diff --git` format.
 */
export function parseUnifiedDiff(diffText: string): DiffFileBlock[] {
    if (!diffText || !diffText.trim()) return [];

    const lines = diffText.split('\n');
    const blocks: DiffFileBlock[] = [];
    let currentBlock: DiffFileBlock | null = null;
    let currentHunk: DiffHunk | null = null;
    let headerPhase = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith('diff --git ')) {
            if (currentHunk && currentBlock) {
                currentBlock.hunks.push(currentHunk);
            }
            if (currentBlock) {
                blocks.push(currentBlock);
            }
            const filePath = extractFilePathFromDiffLine(line);
            currentBlock = { filePath, headerLines: [line], hunks: [] };
            currentHunk = null;
            headerPhase = true;
            continue;
        }

        if (!currentBlock) continue;

        if (line.startsWith('@@ ')) {
            if (currentHunk) {
                currentBlock.hunks.push(currentHunk);
            }
            currentHunk = { header: line, lines: [] };
            headerPhase = false;
            continue;
        }

        if (headerPhase) {
            currentBlock.headerLines.push(line);
        } else if (currentHunk) {
            currentHunk.lines.push(line);
        }
    }

    if (currentHunk && currentBlock) {
        currentBlock.hunks.push(currentHunk);
    }
    if (currentBlock) {
        blocks.push(currentBlock);
    }

    return blocks;
}

/**
 * Extract the b-side file path from a `diff --git a/... b/...` line.
 * Tries the repeated-path pattern (a/X b/X) first for robustness with
 * paths containing ` b/`, then falls back to first ` b/` split.
 */
export function extractFilePathFromDiffLine(line: string): string {
    const prefix = 'diff --git a/';
    if (!line.startsWith(prefix)) return '';
    const rest = line.substring(prefix.length);
    // Try each ` b/` position: check if a-side equals b-side (same-file diff)
    let searchFrom = 0;
    while (true) {
        const bIdx = rest.indexOf(' b/', searchFrom);
        if (bIdx < 0) break;
        const aSide = rest.substring(0, bIdx);
        const bSide = rest.substring(bIdx + 3);
        if (aSide === bSide) {
            return bSide;
        }
        searchFrom = bIdx + 1;
    }
    // Fallback for renames: use first ` b/` split
    const firstBIdx = rest.indexOf(' b/');
    if (firstBIdx >= 0) {
        return rest.substring(firstBIdx + 3);
    }
    return '';
}

export interface HunkFilterOptions {
    triggerRegexes: string[];
    reviewType?: string;
}

/**
 * Filter hunks within a file block, keeping only those whose changed lines
 * (additions/deletions) match at least one trigger regex.
 * When no hunk matches, the file block is still included if the file path
 * itself matches the triggers (preserving file-level fallback semantics).
 * Blocks with no hunks (binary/mode-only changes) are included when the
 * file path matches triggers.
 */
export function filterHunksInBlock(
    block: DiffFileBlock,
    options: HunkFilterOptions
): { block: DiffFileBlock; matchedHunkCount: number; totalHunkCount: number; filePathMatched: boolean } {
    const { triggerRegexes, reviewType } = options;
    const totalHunkCount = block.hunks.length;
    const matchOpts = {
        skipInvalidRegex: true,
        invalidRegexContext: reviewType ? `hunk filter for '${reviewType}'` : 'hunk filter',
        caseInsensitive: true
    };

    const filePathMatched = matchAnyRegex(block.filePath, triggerRegexes, matchOpts);

    // File path matched: keep ALL hunks regardless of hunk content
    if (filePathMatched) {
        return {
            block,
            matchedHunkCount: totalHunkCount,
            totalHunkCount,
            filePathMatched: true
        };
    }

    // Binary/mode-only blocks have no hunks; exclude when file path doesn't match
    if (totalHunkCount === 0) {
        return {
            block,
            matchedHunkCount: 0,
            totalHunkCount: 0,
            filePathMatched: false
        };
    }

    // File path not matched: keep only hunks whose content matches triggers
    const matchedHunks: DiffHunk[] = [];
    for (const hunk of block.hunks) {
        if (hunkMatchesTriggers(hunk, triggerRegexes, matchOpts)) {
            matchedHunks.push(hunk);
        }
    }

    if (matchedHunks.length > 0) {
        return {
            block: { ...block, hunks: matchedHunks },
            matchedHunkCount: matchedHunks.length,
            totalHunkCount,
            filePathMatched: false
        };
    }

    return {
        block: { ...block, hunks: [] },
        matchedHunkCount: 0,
        totalHunkCount,
        filePathMatched: false
    };
}

/**
 * Test whether a hunk's changed lines match any trigger regex.
 */
function hunkMatchesTriggers(
    hunk: DiffHunk,
    triggerRegexes: string[],
    matchOpts: { skipInvalidRegex: boolean; invalidRegexContext: string; caseInsensitive: boolean }
): boolean {
    for (const line of hunk.lines) {
        if (line.startsWith('+') || line.startsWith('-')) {
            const content = line.substring(1);
            if (matchAnyRegex(content, triggerRegexes, matchOpts)) {
                return true;
            }
        }
    }
    // Also check the hunk header for function/class context
    if (matchAnyRegex(hunk.header, triggerRegexes, matchOpts)) {
        return true;
    }
    return false;
}

/**
 * Reassemble filtered file blocks into unified diff text.
 * Includes blocks with hunks plus header-only blocks (binary/mode-only)
 * that were retained by file-path matching.
 */
export function reassembleDiff(blocks: DiffFileBlock[]): string {
    const parts: string[] = [];
    for (const block of blocks) {
        if (block.hunks.length === 0 && block.headerLines.length <= 1) continue;
        parts.push(block.headerLines.join('\n'));
        for (const hunk of block.hunks) {
            parts.push(hunk.header);
            if (hunk.lines.length > 0) {
                parts.push(hunk.lines.join('\n'));
            }
        }
    }
    if (parts.length === 0) return '';
    return parts.join('\n') + '\n';
}

export interface HunkLevelFilterResult {
    filteredDiffText: string;
    totalFileBlocks: number;
    includedFileBlocks: number;
    totalHunks: number;
    includedHunks: number;
    hunkLevelFiltered: boolean;
}

/**
 * Apply hunk-level filtering to a unified diff.
 * Files whose path matches triggers are always included.
 * Within non-path-matched files, only hunks with relevant changed lines are kept.
 */
export function filterDiffByHunks(
    diffText: string,
    triggerRegexes: string[],
    options?: { reviewType?: string }
): HunkLevelFilterResult {
    const reviewType = options?.reviewType;
    const blocks = parseUnifiedDiff(diffText);

    if (blocks.length === 0) {
        return {
            filteredDiffText: '',
            totalFileBlocks: 0,
            includedFileBlocks: 0,
            totalHunks: 0,
            includedHunks: 0,
            hunkLevelFiltered: false
        };
    }

    let totalHunks = 0;
    let includedHunks = 0;
    const filteredBlocks: DiffFileBlock[] = [];

    for (const block of blocks) {
        totalHunks += block.hunks.length;
        const result = filterHunksInBlock(block, {
            triggerRegexes,
            reviewType
        });
        // Include block if it has hunks or if it's a path-matched header-only block (binary/mode-only)
        if (result.block.hunks.length > 0 || (result.filePathMatched && block.headerLines.length > 1)) {
            filteredBlocks.push(result.block);
            includedHunks += result.matchedHunkCount;
        }
    }

    const filteredDiffText = reassembleDiff(filteredBlocks);

    return {
        filteredDiffText,
        totalFileBlocks: blocks.length,
        includedFileBlocks: filteredBlocks.length,
        totalHunks,
        includedHunks,
        hunkLevelFiltered: includedHunks < totalHunks || filteredBlocks.length < blocks.length
    };
}

/**
 * Convert pathspecs from repo-root-relative to git-root-relative.
 * Mirrors the legacy pathspec normalization contract.
 */
export function convertToGitPathspecs(pathspecs: string[], repoRoot: string, gitRoot: string): string[] {
    if (!pathspecs || pathspecs.length === 0) {
        return [];
    }

    const repoRootNormalized = repoRoot.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    const gitRootNormalized = gitRoot.replace(/[\\/]+$/, '').replace(/\\/g, '/');

    if (repoRootNormalized.toLowerCase() === gitRootNormalized.toLowerCase()) {
        return [...pathspecs];
    }

    const gitRootName = path.basename(gitRootNormalized);
    const prefix = `${gitRootName}/`;

    return pathspecs.map(pathspec => {
        let normalized = String(pathspec).replace(/\\/g, '/');
        if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
            normalized = normalized.substring(prefix.length);
        }
        return normalized;
    });
}


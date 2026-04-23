import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    extractManagedContent,
    extractUserContent,
    classifyOwnership,
    type OwnershipRegion
} from '../../core/managed-blocks';
import { normalizeLineEndings } from '../../core/line-endings';
import {
    MANAGED_START,
    MANAGED_END,
    COMMIT_GUARD_START,
    COMMIT_GUARD_END,
    INSTALL_BACKUP_CANDIDATE_PATHS
} from '../../materialization/content-builders';

export interface ManagedFileMarkerSet {
    startMarker: string;
    endMarker: string;
}

export interface ManagedFileEntry {
    relativePath: string;
    exists: boolean;
    markers: ManagedFileMarkerSet;
    hasManagedBlock: boolean;
    regions: OwnershipRegion[];
    managedContent: string | null;
    userContent: string;
    managedLineCount: number;
    userLineCount: number;
}

export interface DiffManagedResult {
    targetRoot: string;
    scannedFiles: number;
    filesWithManagedBlocks: number;
    filesWithoutManagedBlocks: number;
    filesMissing: number;
    totalManagedLines: number;
    totalUserLines: number;
    entries: ManagedFileEntry[];
}

const COMMIT_GUARD_PATHS = new Set(['.git/hooks/pre-commit']);

// Shell scripts use comment-based markers; everything else uses HTML comment markers.
export function resolveMarkers(relativePath: string): ManagedFileMarkerSet {
    const normalized = relativePath.replace(/\\/g, '/');
    if (COMMIT_GUARD_PATHS.has(normalized)) {
        return { startMarker: COMMIT_GUARD_START, endMarker: COMMIT_GUARD_END };
    }
    return { startMarker: MANAGED_START, endMarker: MANAGED_END };
}

function countNonEmptyLines(text: string): number {
    if (!text) return 0;
    return normalizeLineEndings(text, '\n').split('\n').filter(function (l) { return l.trim().length > 0; }).length;
}

export function collectManagedDiff(targetRoot: string): DiffManagedResult {
    const resolvedRoot = path.resolve(targetRoot);
    const entries: ManagedFileEntry[] = [];
    let filesWithManagedBlocks = 0;
    let filesWithoutManagedBlocks = 0;
    let filesMissing = 0;
    let totalManagedLines = 0;
    let totalUserLines = 0;

    for (const relativePath of INSTALL_BACKUP_CANDIDATE_PATHS) {
        const fullPath = path.join(resolvedRoot, relativePath);
        const markers = resolveMarkers(relativePath);
        let exists = false;
        let content = '';

        try {
            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                exists = true;
                content = fs.readFileSync(fullPath, 'utf8');
            }
        } catch {
            // Unreadable — treat as missing
        }

        if (!exists) {
            filesMissing++;
            entries.push({
                relativePath,
                exists: false,
                markers,
                hasManagedBlock: false,
                regions: [],
                managedContent: null,
                userContent: '',
                managedLineCount: 0,
                userLineCount: 0
            });
            continue;
        }

        const normalized = normalizeLineEndings(content, '\n');
        const managedContent = extractManagedContent(normalized, markers.startMarker, markers.endMarker);
        const userContent = extractUserContent(normalized, markers.startMarker, markers.endMarker);
        const regions = classifyOwnership(normalized, markers.startMarker, markers.endMarker);
        const hasManagedBlock = managedContent !== null;

        const managedLineCount = hasManagedBlock ? countNonEmptyLines(managedContent!) : 0;
        const userLineCount = countNonEmptyLines(userContent);

        if (hasManagedBlock) {
            filesWithManagedBlocks++;
        } else {
            filesWithoutManagedBlocks++;
        }

        totalManagedLines += managedLineCount;
        totalUserLines += userLineCount;

        entries.push({
            relativePath,
            exists: true,
            markers,
            hasManagedBlock,
            regions,
            managedContent,
            userContent,
            managedLineCount,
            userLineCount
        });
    }

    return {
        targetRoot: resolvedRoot,
        scannedFiles: INSTALL_BACKUP_CANDIDATE_PATHS.length,
        filesWithManagedBlocks,
        filesWithoutManagedBlocks,
        filesMissing,
        totalManagedLines,
        totalUserLines,
        entries
    };
}

export function formatDiffManagedText(result: DiffManagedResult): string {
    const lines: string[] = [];

    lines.push('GARDA_DIFF_MANAGED');
    lines.push(`Target root:      ${result.targetRoot}`);
    lines.push(`Scanned files:    ${result.scannedFiles}`);
    lines.push(`With managed:     ${result.filesWithManagedBlocks}`);
    lines.push(`Without managed:  ${result.filesWithoutManagedBlocks}`);
    lines.push(`Missing:          ${result.filesMissing}`);
    lines.push(`Managed lines:    ${result.totalManagedLines}`);
    lines.push(`User lines:       ${result.totalUserLines}`);
    lines.push('');

    const presentEntries = result.entries.filter(function (e) { return e.exists; });
    if (presentEntries.length === 0) {
        lines.push('No managed files found on disk.');
        return lines.join('\n');
    }

    for (const entry of presentEntries) {
        const status = entry.hasManagedBlock ? 'managed' : 'user-only';
        lines.push(`--- ${entry.relativePath} [${status}]`);
        if (entry.hasManagedBlock) {
            lines.push(`  managed lines: ${entry.managedLineCount}`);
            lines.push(`  user lines:    ${entry.userLineCount}`);
            for (const region of entry.regions) {
                const lineCount = countNonEmptyLines(region.text);
                lines.push(`  [${region.kind}] offset ${region.start}..${region.end} (${lineCount} non-empty lines)`);
            }
        } else {
            lines.push(`  user lines:    ${entry.userLineCount}`);
            lines.push('  (no managed block markers found)');
        }
    }

    return lines.join('\n');
}

export function formatDiffManagedJson(result: DiffManagedResult): string {
    const serializable = {
        target_root: result.targetRoot,
        scanned_files: result.scannedFiles,
        files_with_managed_blocks: result.filesWithManagedBlocks,
        files_without_managed_blocks: result.filesWithoutManagedBlocks,
        files_missing: result.filesMissing,
        total_managed_lines: result.totalManagedLines,
        total_user_lines: result.totalUserLines,
        entries: result.entries.map(function (entry) {
            return {
                relative_path: entry.relativePath,
                exists: entry.exists,
                has_managed_block: entry.hasManagedBlock,
                managed_line_count: entry.managedLineCount,
                user_line_count: entry.userLineCount,
                regions: entry.regions.map(function (region) {
                    return {
                        kind: region.kind,
                        start: region.start,
                        end: region.end,
                        line_count: countNonEmptyLines(region.text)
                    };
                })
            };
        })
    };
    return JSON.stringify(serializable, null, 2);
}

import * as path from 'node:path';
import { pathExists, readTextFile } from '../core/fs';
import { isPathInsideRoot } from '../core/paths';

export type ManifestDiagnosticCode =
    | 'ABSOLUTE_PATH'
    | 'PARENT_TRAVERSAL'
    | 'DRIVE_LETTER'
    | 'UNC_PATH'
    | 'MIXED_SEPARATORS'
    | 'DOT_SEGMENT'
    | 'NUL_BYTE'
    | 'RESERVED_SEGMENT'
    | 'OUTSIDE_ROOT'
    | 'DUPLICATE_RAW'
    | 'DUPLICATE_NORMALIZED';

export interface ManifestEntryDiagnostic {
    code: ManifestDiagnosticCode;
    entry: string;
    message: string;
}

export interface ManifestValidationResult {
    passed: boolean;
    manifestPath: string;
    entriesChecked: number;
    duplicates: string[];
    diagnostics: ManifestEntryDiagnostic[];
}

const WINDOWS_RESERVED_NAMES = new Set([
    'con', 'prn', 'aux', 'nul',
    'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
    'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

/**
 * Parse list items from MANIFEST.md content.
 * Matches lines like "- path/to/file".
 */
export function parseManifestItems(content: string): string[] {
    const items: string[] = [];
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
        const match = line.match(/^\s*-\s+(.+?)\s*$/);
        if (match) {
            const value = match[1].trim();
            if (value) {
                items.push(value);
            }
        }
    }

    return items;
}

/**
 * Normalize a manifest entry to a canonical form for duplicate comparison.
 * Lowercases, collapses separators, resolves `.` segments, strips trailing separators.
 */
export function normalizeManifestEntry(entry: string): string {
    return entry
        .toLowerCase()
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .split('/')
        .filter(seg => seg !== '.')
        .join('/')
        .replace(/\/+$/, '');
}

/**
 * Validate a single manifest entry for path safety issues.
 * Returns an array of diagnostics (empty if the entry is safe).
 */
export function validateManifestEntry(entry: string): ManifestEntryDiagnostic[] {
    const diags: ManifestEntryDiagnostic[] = [];

    if (entry.includes('\0')) {
        diags.push({ code: 'NUL_BYTE', entry, message: 'Entry contains NUL byte' });
    }

    if (/^[A-Za-z]:/.test(entry)) {
        diags.push({ code: 'DRIVE_LETTER', entry, message: 'Entry contains drive letter prefix' });
    }

    if (entry.startsWith('\\\\') || entry.startsWith('//')) {
        diags.push({ code: 'UNC_PATH', entry, message: 'Entry is a UNC path' });
    } else if (/^[\\/]/.test(entry) && !/^[A-Za-z]:/.test(entry)) {
        diags.push({ code: 'ABSOLUTE_PATH', entry, message: 'Entry is an absolute path' });
    }

    const segments = entry.replace(/\\/g, '/').split('/');

    if (segments.some(seg => seg === '..')) {
        diags.push({ code: 'PARENT_TRAVERSAL', entry, message: 'Entry contains parent traversal (..)' });
    }

    if (segments.some(seg => seg === '.')) {
        diags.push({ code: 'DOT_SEGMENT', entry, message: 'Entry contains dot segment (.)' });
    }

    if (/[/]/.test(entry) && /[\\]/.test(entry)) {
        diags.push({ code: 'MIXED_SEPARATORS', entry, message: 'Entry mixes forward and back slashes' });
    }

    for (const seg of segments) {
        const baseName = seg.replace(/\.[^.]*$/, '').toLowerCase();
        if (baseName && WINDOWS_RESERVED_NAMES.has(baseName)) {
            diags.push({ code: 'RESERVED_SEGMENT', entry, message: `Entry contains reserved name '${seg}'` });
            break;
        }
    }

    return diags;
}

/**
 * Check whether a manifest entry resolves outside the given root.
 */
export function checkEntryOutsideRoot(entry: string, rootPath: string): ManifestEntryDiagnostic | null {
    const resolved = path.resolve(rootPath, entry);
    if (!isPathInsideRoot(rootPath, resolved)) {
        return { code: 'OUTSIDE_ROOT', entry, message: `Entry resolves outside root '${rootPath}'` };
    }
    return null;
}

/**
 * Validate a MANIFEST.md file for duplicate, unsafe, non-normalized,
 * and out-of-root entries.
 *
 * Checks performed (in addition to legacy raw-duplicate detection):
 * - NUL bytes
 * - Absolute paths, drive letters, UNC paths
 * - Parent traversal (..) and dot segments (.)
 * - Mixed separators
 * - Windows reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
 * - Duplicate-after-normalization collisions
 * - Entries resolving outside the effective validation root
 *
 * Effective validation root:
 * - `targetRoot`, when provided
 * - otherwise the directory containing `manifestPath`
 *
 * When targetRoot is provided, also rejects the manifest file itself if it
 * resolves outside the repository root.
 *
 * Returns { passed, manifestPath, entriesChecked, duplicates, diagnostics }.
 */
export function validateManifest(manifestPath: string, targetRoot?: string): ManifestValidationResult {
    const resolvedPath = path.resolve(manifestPath);
    const resolvedRoot = targetRoot
        ? path.resolve(String(targetRoot))
        : path.dirname(resolvedPath);

    if (targetRoot) {
        if (!isPathInsideRoot(resolvedRoot, resolvedPath)) {
            throw new Error("ManifestPath must resolve inside TargetRoot '" + resolvedRoot + "'. Resolved path: " + resolvedPath);
        }
    }

    if (!pathExists(resolvedPath)) {
        throw new Error(`Manifest not found: ${resolvedPath}`);
    }

    const content = readTextFile(resolvedPath);
    const items = parseManifestItems(content);

    if (items.length === 0) {
        throw new Error(`No manifest list items found in: ${resolvedPath}`);
    }

    const diagnostics: ManifestEntryDiagnostic[] = [];
    const seenRaw: Record<string, string> = {};
    const seenNormalized: Record<string, string> = {};
    const duplicates: string[] = [];

    for (const item of items) {
        const entryDiags = validateManifestEntry(item);
        diagnostics.push(...entryDiags);

        const rawKey = item.toLowerCase().replace(/\\/g, '/');
        if (rawKey in seenRaw) {
            duplicates.push(item);
            diagnostics.push({ code: 'DUPLICATE_RAW', entry: item, message: `Duplicate of '${seenRaw[rawKey]}'` });
            continue;
        }
        seenRaw[rawKey] = item;

        const normalizedKey = normalizeManifestEntry(item);
        if (normalizedKey in seenNormalized && seenNormalized[normalizedKey] !== item) {
            diagnostics.push({
                code: 'DUPLICATE_NORMALIZED',
                entry: item,
                message: `Collides with '${seenNormalized[normalizedKey]}' after normalization`
            });
        } else {
            seenNormalized[normalizedKey] = item;
        }

        const rootDiag = checkEntryOutsideRoot(item, resolvedRoot);
        if (rootDiag) {
            diagnostics.push(rootDiag);
        }
    }

    return {
        passed: duplicates.length === 0 && diagnostics.length === 0,
        manifestPath: resolvedPath,
        entriesChecked: items.length,
        duplicates,
        diagnostics
    };
}

/**
 * Format manifest validation result as diagnostic output lines.
 * Stable machine-readable diagnostic format for the Node CLI.
 */
export function formatManifestResult(result: ManifestValidationResult): string {
    const lines: string[] = [];

    if (!result.passed) {
        lines.push('MANIFEST_VALIDATION_FAILED');
        lines.push(`ManifestPath: ${result.manifestPath}`);
        if (result.duplicates.length > 0) {
            lines.push('Duplicate entries:');
            for (const dup of result.duplicates) {
                lines.push(`- ${dup}`);
            }
        }
        if (result.diagnostics.length > 0) {
            lines.push(`DiagnosticsCount: ${result.diagnostics.length}`);
            for (const diag of result.diagnostics) {
                lines.push(`[${diag.code}] ${diag.entry}: ${diag.message}`);
            }
        }
    } else {
        lines.push('MANIFEST_VALIDATION_PASSED');
        lines.push(`ManifestPath: ${result.manifestPath}`);
        lines.push(`EntriesChecked: ${result.entriesChecked}`);
    }

    return lines.join('\n');
}

/**
 * Format manifest validation result in compact mode.
 * On success: single summary line. On failure: full output (delegates to formatManifestResult).
 */
export function formatManifestResultCompact(result: ManifestValidationResult): string {
    if (!result.passed) {
        return formatManifestResult(result);
    }
    return `MANIFEST_VALIDATION_PASSED | entries=${result.entriesChecked}`;
}

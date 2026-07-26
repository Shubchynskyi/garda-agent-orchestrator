import * as fs from 'node:fs';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';

import { runGit, runGitBinary } from './git-helpers';
import { normalizeLineEndings } from './line-endings';
import { isPathInsideRoot, isPathRealpathInsideRoot } from './paths';

export const GIT_EOL_CHANGE_POLICY = Object.freeze({
    schemaVersion: 1,
    id: 'eol_only_is_dirty_v1',
    comparisonBasis: 'git_porcelain_v1_candidates_with_blob_comparison',
    eolOnlyTreatment: 'dirty',
    gitNormalizedCleanTreatment: 'clean',
    rationale:
        'Git-visible changes whose raw text differs only by line endings remain in effective dirty scope. ' +
        'Working-tree transformations normalized away by Git attributes or core.autocrlf remain clean.'
} as const);

export type GitChangeLayer = 'staged' | 'unstaged' | 'untracked';
export type GitChangeKind =
    | 'added'
    | 'copied'
    | 'deleted'
    | 'modified'
    | 'renamed'
    | 'type_changed'
    | 'unmerged'
    | 'untracked'
    | 'unknown';
export type GitContentClassification = 'binary' | 'content' | 'eol_only' | 'metadata';

export interface GitLayerChangeClassification {
    path: string;
    previousPath: string | null;
    layer: GitChangeLayer;
    status: string;
    changeKind: GitChangeKind;
    contentClassification: GitContentClassification;
    includedInEffectiveScope: true;
    reason: string;
}

export interface GitChangeClassificationResult {
    policy: typeof GIT_EOL_CHANGE_POLICY;
    gitConfig: {
        autocrlf: string;
        eol: string;
        safecrlf: string;
    };
    audit: {
        effectiveDirty: boolean;
        reason: string;
    };
    changes: GitLayerChangeClassification[];
    effectiveChangedFiles: string[];
    stagedFiles: string[];
    unstagedFiles: string[];
    untrackedFiles: string[];
    eolOnlyFiles: string[];
}

interface ParsedNameStatus {
    status: string;
    path: string;
    previousPath: string | null;
    changeKind: GitChangeKind;
}

interface ParsedPorcelainStatus {
    staged: ParsedNameStatus[];
    unstaged: ParsedNameStatus[];
    untracked: string[];
}

interface ContentSnapshot {
    kind: 'file' | 'missing' | 'other' | 'symlink' | 'unavailable';
    content: Buffer | null;
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_CLASSIFICATION_CONTENT_BYTES = 64 * 1024 * 1024;
const GIT_CONTENT_MAX_BUFFER_BYTES = MAX_CLASSIFICATION_CONTENT_BYTES + 1024;
const GIT_STATUS_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const LAYER_ORDER: Record<GitChangeLayer, number> = {
    staged: 0,
    unstaged: 1,
    untracked: 2
};

function literalPathspec(filePath: string): string {
    return `:(literal)${filePath}`;
}

function uniqueSorted(values: Iterable<string>): string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function mapChangeKind(status: string): GitChangeKind {
    switch (status.charAt(0).toUpperCase()) {
        case 'A':
            return 'added';
        case 'C':
            return 'copied';
        case 'D':
            return 'deleted';
        case 'M':
            return 'modified';
        case 'R':
            return 'renamed';
        case 'T':
            return 'type_changed';
        case 'U':
            return 'unmerged';
        default:
            return 'unknown';
    }
}

function parsePorcelainStatus(output: Buffer): ParsedPorcelainStatus {
    const fields = output.toString('utf8').split('\0');
    const staged: ParsedNameStatus[] = [];
    const unstaged: ParsedNameStatus[] = [];
    const untracked: string[] = [];
    let index = 0;
    while (index < fields.length) {
        const record = String(fields[index++] || '');
        if (!record) {
            continue;
        }
        if (record.length < 4 || record.charAt(2) !== ' ') {
            throw new Error(`Git porcelain output contains a malformed record: '${record.slice(0, 20)}'.`);
        }
        const xStatus = record.charAt(0);
        const yStatus = record.charAt(1);
        const filePath = record.slice(3);
        if (!filePath) {
            throw new Error(`Git porcelain output omitted the path for status '${xStatus}${yStatus}'.`);
        }
        if (xStatus === '?' && yStatus === '?') {
            untracked.push(filePath);
            continue;
        }
        const renameOrCopy = /[RC]/u.test(xStatus) || /[RC]/u.test(yStatus);
        const previousPath = renameOrCopy ? String(fields[index++] || '') : null;
        if (renameOrCopy && !previousPath) {
            throw new Error(`Git porcelain output omitted the source path for status '${xStatus}${yStatus}'.`);
        }
        if (xStatus !== ' ' && xStatus !== '?') {
            staged.push({
                status: xStatus,
                path: filePath,
                previousPath: /[RC]/u.test(xStatus) ? previousPath : null,
                changeKind: mapChangeKind(xStatus)
            });
        }
        if (yStatus !== ' ' && yStatus !== '?') {
            unstaged.push({
                status: yStatus,
                path: filePath,
                previousPath: /[RC]/u.test(yStatus) ? previousPath : null,
                changeKind: mapChangeKind(yStatus)
            });
        }
    }
    return { staged, unstaged, untracked };
}

function readBlobSnapshot(
    repoRoot: string,
    objectId: string,
    kind: Extract<ContentSnapshot['kind'], 'file' | 'symlink'>
): ContentSnapshot {
    if (!/^[0-9a-f]{40,64}$/iu.test(objectId)) {
        return { kind: 'unavailable', content: null };
    }
    const size = Number.parseInt(runGit(repoRoot, ['cat-file', '-s', objectId]).trim(), 10);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CLASSIFICATION_CONTENT_BYTES) {
        return { kind: 'unavailable', content: null };
    }
    const content = runGitBinary(repoRoot, ['cat-file', 'blob', objectId], {
        maxBuffer: GIT_CONTENT_MAX_BUFFER_BYTES
    });
    return content.length <= MAX_CLASSIFICATION_CONTENT_BYTES
        ? { kind, content }
        : { kind: 'unavailable', content: null };
}

function readHeadSnapshot(repoRoot: string, filePath: string): ContentSnapshot {
    const output = runGitBinary(
        repoRoot,
        ['ls-tree', '-z', 'HEAD', '--', literalPathspec(filePath)],
        { allowFailure: true }
    );
    const record = output.toString('utf8').split('\0').find(Boolean);
    if (!record) {
        return { kind: 'missing', content: null };
    }
    const tabIndex = record.indexOf('\t');
    const metadata = tabIndex >= 0 ? record.slice(0, tabIndex) : record;
    const [mode, type, objectId] = metadata.split(/\s+/u);
    if (type !== 'blob') {
        return { kind: 'other', content: null };
    }
    return readBlobSnapshot(repoRoot, objectId, mode === '120000' ? 'symlink' : 'file');
}

function readIndexSnapshot(repoRoot: string, filePath: string): ContentSnapshot {
    const output = runGitBinary(
        repoRoot,
        ['ls-files', '--stage', '-z', '--', literalPathspec(filePath)],
        { allowFailure: true }
    );
    const record = output.toString('utf8').split('\0').find((entry) => /\s0\t/u.test(entry));
    if (!record) {
        return { kind: 'missing', content: null };
    }
    const tabIndex = record.indexOf('\t');
    const metadata = tabIndex >= 0 ? record.slice(0, tabIndex) : record;
    const [mode, objectId] = metadata.split(/\s+/u);
    const kind = mode === '120000' ? 'symlink' : mode.startsWith('100') ? 'file' : 'other';
    return kind === 'other'
        ? { kind, content: null }
        : readBlobSnapshot(repoRoot, objectId, kind);
}

function readWorktreeSnapshot(repoRoot: string, filePath: string): ContentSnapshot {
    const resolvedRoot = path.resolve(repoRoot);
    const resolvedPath = path.resolve(resolvedRoot, filePath);
    if (!isPathInsideRoot(resolvedRoot, resolvedPath)) {
        return { kind: 'unavailable', content: null };
    }
    try {
        const stat = fs.lstatSync(resolvedPath);
        if (stat.isSymbolicLink()) {
            return { kind: 'symlink', content: Buffer.from(fs.readlinkSync(resolvedPath), 'utf8') };
        }
        if (!isPathRealpathInsideRoot(resolvedRoot, resolvedPath)) {
            return { kind: 'unavailable', content: null };
        }
        if (!stat.isFile()) {
            return { kind: 'other', content: null };
        }
        if (stat.size > MAX_CLASSIFICATION_CONTENT_BYTES) {
            return { kind: 'unavailable', content: null };
        }
        const content = fs.readFileSync(resolvedPath);
        return content.length <= MAX_CLASSIFICATION_CONTENT_BYTES
            ? { kind: 'file', content }
            : { kind: 'unavailable', content: null };
    } catch (error: unknown) {
        const code = String((error as NodeJS.ErrnoException)?.code || '');
        return code === 'ENOENT' || code === 'ENOTDIR'
            ? { kind: 'missing', content: null }
            : { kind: 'unavailable', content: null };
    }
}

function decodeText(content: Buffer): string | null {
    if (content.includes(0)) {
        return null;
    }
    try {
        return UTF8_DECODER.decode(content);
    } catch {
        return null;
    }
}

function classifySnapshots(
    before: ContentSnapshot,
    after: ContentSnapshot,
    changeKind: GitChangeKind
): Pick<GitLayerChangeClassification, 'contentClassification' | 'reason'> {
    if (changeKind === 'type_changed' || changeKind === 'unmerged') {
        return {
            contentClassification: 'metadata',
            reason: `Git reports a ${changeKind.replace('_', ' ')} change; byte-level EOL classification is not applicable.`
        };
    }
    if (before.kind === 'unavailable' || after.kind === 'unavailable') {
        return {
            contentClassification: 'metadata',
            reason: 'Content comparison is unavailable or would cross the repository realpath boundary; the Git-visible change stays dirty.'
        };
    }
    if (before.kind === 'other' || after.kind === 'other' || before.kind === 'symlink' || after.kind === 'symlink') {
        return {
            contentClassification: 'metadata',
            reason: 'The change involves a non-regular file or symbolic link; EOL classification is not applicable.'
        };
    }

    const beforeContent = before.content;
    const afterContent = after.content;
    const existingContent = beforeContent || afterContent;
    if (!beforeContent || !afterContent) {
        const binary = existingContent ? decodeText(existingContent) === null : false;
        return binary
            ? {
                contentClassification: 'binary',
                reason: `A binary file was ${beforeContent ? 'deleted' : 'added'}; it remains in effective dirty scope.`
            }
            : {
                contentClassification: 'content',
                reason: `A text file was ${beforeContent ? 'deleted' : 'added'}; it remains in effective dirty scope.`
            };
    }
    if (beforeContent.equals(afterContent)) {
        return {
            contentClassification: 'metadata',
            reason: 'Git reports a path or metadata change while the compared bytes are identical.'
        };
    }

    const beforeText = decodeText(beforeContent);
    const afterText = decodeText(afterContent);
    if (beforeText === null || afterText === null) {
        return {
            contentClassification: 'binary',
            reason: 'At least one compared version is binary or invalid UTF-8; EOL-only classification is not applied.'
        };
    }
    if (normalizeLineEndings(beforeText) === normalizeLineEndings(afterText)) {
        return {
            contentClassification: 'eol_only',
            reason: 'Raw text differs only by line endings; policy eol_only_is_dirty_v1 keeps the change in effective dirty scope.'
        };
    }
    return {
        contentClassification: 'content',
        reason: 'Text content still differs after line-ending normalization.'
    };
}

function classifyLayerChange(
    repoRoot: string,
    layer: Exclude<GitChangeLayer, 'untracked'>,
    change: ParsedNameStatus
): GitLayerChangeClassification {
    const beforePath = change.previousPath || change.path;
    const before = layer === 'staged'
        ? readHeadSnapshot(repoRoot, beforePath)
        : readIndexSnapshot(repoRoot, beforePath);
    const after = layer === 'staged'
        ? readIndexSnapshot(repoRoot, change.path)
        : readWorktreeSnapshot(repoRoot, change.path);
    return {
        path: change.path,
        previousPath: change.previousPath,
        layer,
        status: change.status,
        changeKind: change.changeKind,
        includedInEffectiveScope: true,
        ...classifySnapshots(before, after, change.changeKind)
    };
}

function readPorcelainStatus(repoRoot: string): ParsedPorcelainStatus {
    return parsePorcelainStatus(runGitBinary(repoRoot, [
        '--no-pager',
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
        '--renames'
    ], { maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES }));
}

function readConfig(repoRoot: string, key: string): string {
    return runGit(repoRoot, ['config', '--get', key], { allowFailure: true }).trim() || 'unset';
}

export function classifyGitChanges(repoRoot: string): GitChangeClassificationResult {
    const porcelain = readPorcelainStatus(repoRoot);
    const staged = porcelain.staged
        .map((change) => classifyLayerChange(repoRoot, 'staged', change));
    const unstaged = porcelain.unstaged
        .map((change) => classifyLayerChange(repoRoot, 'unstaged', change));
    const untracked = porcelain.untracked.map((filePath): GitLayerChangeClassification => {
        return {
            path: filePath,
            previousPath: null,
            layer: 'untracked',
            status: '?',
            changeKind: 'untracked',
            includedInEffectiveScope: true,
            ...classifySnapshots(
                { kind: 'missing', content: null },
                readWorktreeSnapshot(repoRoot, filePath),
                'untracked'
            )
        };
    });
    const changes = [...staged, ...unstaged, ...untracked].sort((left, right) =>
        left.path.localeCompare(right.path) || LAYER_ORDER[left.layer] - LAYER_ORDER[right.layer]
    );
    const gitConfig = {
        autocrlf: readConfig(repoRoot, 'core.autocrlf'),
        eol: readConfig(repoRoot, 'core.eol'),
        safecrlf: readConfig(repoRoot, 'core.safecrlf')
    };

    return {
        policy: GIT_EOL_CHANGE_POLICY,
        gitConfig,
        audit: {
            effectiveDirty: changes.length > 0,
            reason: changes.length > 0
                ? `Git porcelain reported ${changes.length} staged, unstaged, or untracked layer change(s); all remain in effective dirty scope.`
                : `Git porcelain reported no effective changes under core.autocrlf=${gitConfig.autocrlf}, core.eol=${gitConfig.eol}, core.safecrlf=${gitConfig.safecrlf}.`
        },
        changes,
        effectiveChangedFiles: uniqueSorted(changes.map((change) => change.path)),
        stagedFiles: uniqueSorted(staged.map((change) => change.path)),
        unstagedFiles: uniqueSorted(unstaged.map((change) => change.path)),
        untrackedFiles: uniqueSorted(untracked.map((change) => change.path)),
        eolOnlyFiles: uniqueSorted(
            changes
                .filter((change) => change.contentClassification === 'eol_only')
                .map((change) => change.path)
        )
    };
}

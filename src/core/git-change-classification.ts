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

export interface GitChangeClassificationOptions {
    timeoutMs?: number;
    explicitUntrackedPaths?: readonly string[];
}

export interface GitChangeLayerSelectionOptions {
    layers: readonly GitChangeLayer[];
    paths?: readonly string[];
    context?: string;
}

export interface GitChangeClassificationEvidence {
    schema_version: 1;
    policy_id: typeof GIT_EOL_CHANGE_POLICY.id;
    eol_only_treatment: typeof GIT_EOL_CHANGE_POLICY.eolOnlyTreatment;
    git_normalized_clean_treatment: typeof GIT_EOL_CHANGE_POLICY.gitNormalizedCleanTreatment;
    policy_rationale: string;
    git_config: {
        autocrlf: string;
        eol: string;
        safecrlf: string;
    };
    effective_dirty: boolean;
    normalization_rationale: string;
    effective_changed_files: string[];
    staged_files: string[];
    unstaged_files: string[];
    untracked_files: string[];
    eol_only_files: string[];
    ignored_eol_only_files: string[];
    file_classifications: Array<{
        path: string;
        previous_path: string | null;
        layer: GitChangeLayer;
        status: string;
        change_kind: GitChangeKind;
        content_classification: GitContentClassification;
        included_in_effective_scope: true;
        reason: string;
    }>;
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
const UNMERGED_STATUS_PAIRS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

interface GitCommandBudget {
    deadlineMs: number | null;
    configuredTimeoutMs: number | null;
}

function createGitCommandBudget(options: GitChangeClassificationOptions): GitCommandBudget {
    if (options.timeoutMs === undefined) {
        return { deadlineMs: null, configuredTimeoutMs: null };
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
        throw new Error('Git change classification timeoutMs must be a positive integer.');
    }
    return {
        deadlineMs: Date.now() + options.timeoutMs,
        configuredTimeoutMs: options.timeoutMs
    };
}

function remainingGitCommandTimeoutMs(budget: GitCommandBudget): number | undefined {
    if (budget.deadlineMs === null || budget.configuredTimeoutMs === null) {
        return undefined;
    }
    const remainingMs = budget.deadlineMs - Date.now();
    if (remainingMs <= 0) {
        throw new Error(
            `Git change classification exceeded its ${budget.configuredTimeoutMs}ms command budget.`
        );
    }
    return remainingMs;
}
const EVIDENCE_LAYERS = new Set<GitChangeLayer>(['staged', 'unstaged', 'untracked']);
const EVIDENCE_CHANGE_KINDS = new Set<GitChangeKind>([
    'added',
    'copied',
    'deleted',
    'modified',
    'renamed',
    'type_changed',
    'unmerged',
    'untracked',
    'unknown'
]);
const EVIDENCE_CONTENT_CLASSIFICATIONS = new Set<GitContentClassification>([
    'binary',
    'content',
    'eol_only',
    'metadata'
]);

function literalPathspec(filePath: string): string {
    return `:(literal)${filePath}`;
}

function compareOrdinal(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: Iterable<string>): string[] {
    return [...new Set(values)].sort(compareOrdinal);
}

export function normalizeGitRepoRelativePath(filePath: string): string | null {
    const normalizedInput = String(filePath || '')
        .replace(/\\/gu, '/')
        .replace(/^\.\/+/u, '')
        .replace(/\/+/gu, '/')
        .trim();
    const normalized = path.posix.normalize(normalizedInput);
    if (
        !normalized
        || normalized === '.'
        || normalized.includes('\0')
        || normalized === '..'
        || normalized.startsWith('../')
        || path.posix.isAbsolute(normalized)
        || path.win32.isAbsolute(normalized)
    ) {
        return null;
    }
    return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEvidenceStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return uniqueSorted(
        value
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
    );
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
        const statusPair = `${xStatus}${yStatus}`;
        if (UNMERGED_STATUS_PAIRS.has(statusPair)) {
            staged.push({
                status: statusPair,
                path: filePath,
                previousPath: null,
                changeKind: 'unmerged'
            });
            unstaged.push({
                status: statusPair,
                path: filePath,
                previousPath: null,
                changeKind: 'unmerged'
            });
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
    kind: Extract<ContentSnapshot['kind'], 'file' | 'symlink'>,
    budget: GitCommandBudget
): ContentSnapshot {
    if (!/^[0-9a-f]{40,64}$/iu.test(objectId)) {
        return { kind: 'unavailable', content: null };
    }
    const size = Number.parseInt(runGit(repoRoot, ['cat-file', '-s', objectId], {
        timeoutMs: remainingGitCommandTimeoutMs(budget)
    }).trim(), 10);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CLASSIFICATION_CONTENT_BYTES) {
        return { kind: 'unavailable', content: null };
    }
    const content = runGitBinary(repoRoot, ['cat-file', 'blob', objectId], {
        maxBuffer: GIT_CONTENT_MAX_BUFFER_BYTES,
        timeoutMs: remainingGitCommandTimeoutMs(budget)
    });
    return content.length <= MAX_CLASSIFICATION_CONTENT_BYTES
        ? { kind, content }
        : { kind: 'unavailable', content: null };
}

function readHeadSnapshot(
    repoRoot: string,
    filePath: string,
    budget: GitCommandBudget
): ContentSnapshot {
    const output = runGitBinary(
        repoRoot,
        ['ls-tree', '-z', 'HEAD', '--', literalPathspec(filePath)],
        {
            allowFailure: true,
            timeoutMs: remainingGitCommandTimeoutMs(budget)
        }
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
    return readBlobSnapshot(repoRoot, objectId, mode === '120000' ? 'symlink' : 'file', budget);
}

function readIndexSnapshot(
    repoRoot: string,
    filePath: string,
    budget: GitCommandBudget
): ContentSnapshot {
    const output = runGitBinary(
        repoRoot,
        ['ls-files', '--stage', '-z', '--', literalPathspec(filePath)],
        {
            allowFailure: true,
            timeoutMs: remainingGitCommandTimeoutMs(budget)
        }
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
        : readBlobSnapshot(repoRoot, objectId, kind, budget);
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
    changeKind: Exclude<GitChangeKind, 'type_changed' | 'unmerged'>
): Pick<GitLayerChangeClassification, 'contentClassification' | 'reason'> {
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
    change: ParsedNameStatus,
    budget: GitCommandBudget
): GitLayerChangeClassification {
    const changeKind = change.changeKind;
    const classificationBase = {
        path: change.path,
        previousPath: change.previousPath,
        layer,
        status: change.status,
        changeKind,
        includedInEffectiveScope: true as const
    };
    if (changeKind === 'type_changed' || changeKind === 'unmerged') {
        return {
            ...classificationBase,
            contentClassification: 'metadata',
            reason: `Git reports a ${changeKind.replace('_', ' ')} change; byte-level EOL classification is not applicable.`
        };
    }

    const beforePath = change.previousPath || change.path;
    const before = layer === 'staged'
        ? readHeadSnapshot(repoRoot, beforePath, budget)
        : readIndexSnapshot(repoRoot, beforePath, budget);
    const after = layer === 'staged'
        ? readIndexSnapshot(repoRoot, change.path, budget)
        : readWorktreeSnapshot(repoRoot, change.path);
    return {
        ...classificationBase,
        ...classifySnapshots(before, after, changeKind)
    };
}

function readPorcelainStatus(repoRoot: string, budget: GitCommandBudget): ParsedPorcelainStatus {
    return parsePorcelainStatus(runGitBinary(repoRoot, [
        '--no-pager',
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
        '--renames'
    ], {
        maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES,
        timeoutMs: remainingGitCommandTimeoutMs(budget)
    }));
}

function readConfig(repoRoot: string, key: string, budget: GitCommandBudget): string {
    return runGit(repoRoot, ['config', '--get', key], {
        allowFailure: true,
        timeoutMs: remainingGitCommandTimeoutMs(budget)
    }).trim() || 'unset';
}

function classifyUntrackedPath(repoRoot: string, filePath: string): GitLayerChangeClassification {
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
}

function readTrackedExplicitPaths(
    repoRoot: string,
    explicitPaths: readonly string[],
    budget: GitCommandBudget
): Set<string> {
    if (explicitPaths.length === 0) {
        return new Set();
    }
    const output = runGitBinary(
        repoRoot,
        ['ls-files', '--cached', '-z', '--', ...explicitPaths.map(literalPathspec)],
        {
            maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES,
            timeoutMs: remainingGitCommandTimeoutMs(budget)
        }
    );
    return new Set(output.toString('utf8').split('\0').filter(Boolean));
}

export function classifyGitChanges(
    repoRoot: string,
    options: GitChangeClassificationOptions = {}
): GitChangeClassificationResult {
    const budget = createGitCommandBudget(options);
    const porcelain = readPorcelainStatus(repoRoot, budget);
    const staged = porcelain.staged
        .map((change) => classifyLayerChange(repoRoot, 'staged', change, budget));
    const unstaged = porcelain.unstaged
        .map((change) => classifyLayerChange(repoRoot, 'unstaged', change, budget));
    const untracked = porcelain.untracked.map((filePath) => classifyUntrackedPath(repoRoot, filePath));
    const explicitUntrackedPaths = uniqueSorted(
        (options.explicitUntrackedPaths || [])
            .map(normalizeGitRepoRelativePath)
            .filter((filePath): filePath is string => filePath !== null)
    );
    const trackedExplicitPaths = readTrackedExplicitPaths(repoRoot, explicitUntrackedPaths, budget);
    const porcelainUntrackedPaths = new Set(porcelain.untracked);
    for (const filePath of explicitUntrackedPaths) {
        if (trackedExplicitPaths.has(filePath) || porcelainUntrackedPaths.has(filePath)) {
            continue;
        }
        const worktree = readWorktreeSnapshot(repoRoot, filePath);
        if (worktree.kind !== 'file') {
            continue;
        }
        untracked.push({
            path: filePath,
            previousPath: null,
            layer: 'untracked',
            status: '?',
            changeKind: 'untracked',
            includedInEffectiveScope: true,
            ...classifySnapshots(
                { kind: 'missing', content: null },
                worktree,
                'untracked'
            )
        });
    }
    const changes = [...staged, ...unstaged, ...untracked].sort((left, right) =>
        compareOrdinal(left.path, right.path) || LAYER_ORDER[left.layer] - LAYER_ORDER[right.layer]
    );
    const gitConfig = {
        autocrlf: readConfig(repoRoot, 'core.autocrlf', budget),
        eol: readConfig(repoRoot, 'core.eol', budget),
        safecrlf: readConfig(repoRoot, 'core.safecrlf', budget)
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

export function selectGitChangeClassificationLayers(
    classification: GitChangeClassificationResult,
    options: GitChangeLayerSelectionOptions
): GitChangeClassificationResult {
    const selectedLayers = new Set(options.layers);
    const selectedPaths = options.paths ? new Set(options.paths) : null;
    const changes = classification.changes.filter((change) =>
        selectedLayers.has(change.layer)
        && (
            !selectedPaths
            || selectedPaths.has(change.path)
            || (change.previousPath !== null && selectedPaths.has(change.previousPath))
        )
    );
    const staged = changes.filter((change) => change.layer === 'staged');
    const unstaged = changes.filter((change) => change.layer === 'unstaged');
    const untracked = changes.filter((change) => change.layer === 'untracked');
    const layerSummary = [...selectedLayers].sort(
        (left, right) => LAYER_ORDER[left] - LAYER_ORDER[right]
    ).join(', ') || 'none';
    const context = String(options.context || 'selected Git scope').trim() || 'selected Git scope';

    return {
        policy: classification.policy,
        gitConfig: { ...classification.gitConfig },
        audit: {
            effectiveDirty: changes.length > 0,
            reason: changes.length > 0
                ? `${context} selected ${changes.length} canonical Git layer change(s) from layers ${layerSummary}; all remain in effective dirty scope.`
                : `${context} selected no canonical Git changes from layers ${layerSummary} under core.autocrlf=${classification.gitConfig.autocrlf}, core.eol=${classification.gitConfig.eol}, core.safecrlf=${classification.gitConfig.safecrlf}.`
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

export function buildGitChangeClassificationEvidence(
    classification: GitChangeClassificationResult
): GitChangeClassificationEvidence {
    return {
        schema_version: 1,
        policy_id: classification.policy.id,
        eol_only_treatment: classification.policy.eolOnlyTreatment,
        git_normalized_clean_treatment: classification.policy.gitNormalizedCleanTreatment,
        policy_rationale: classification.policy.rationale,
        git_config: { ...classification.gitConfig },
        effective_dirty: classification.audit.effectiveDirty,
        normalization_rationale: classification.audit.reason,
        effective_changed_files: [...classification.effectiveChangedFiles],
        staged_files: [...classification.stagedFiles],
        unstaged_files: [...classification.unstagedFiles],
        untracked_files: [...classification.untrackedFiles],
        eol_only_files: [...classification.eolOnlyFiles],
        ignored_eol_only_files: [],
        file_classifications: classification.changes.map((change) => ({
            path: change.path,
            previous_path: change.previousPath,
            layer: change.layer,
            status: change.status,
            change_kind: change.changeKind,
            content_classification: change.contentClassification,
            included_in_effective_scope: change.includedInEffectiveScope,
            reason: change.reason
        }))
    };
}

export function normalizeGitChangeClassificationEvidence(
    value: unknown
): GitChangeClassificationEvidence | null {
    if (!isRecord(value) || value.schema_version !== 1) {
        return null;
    }
    if (
        value.policy_id !== GIT_EOL_CHANGE_POLICY.id
        || value.eol_only_treatment !== GIT_EOL_CHANGE_POLICY.eolOnlyTreatment
        || value.git_normalized_clean_treatment !== GIT_EOL_CHANGE_POLICY.gitNormalizedCleanTreatment
    ) {
        return null;
    }
    const gitConfig = isRecord(value.git_config) ? value.git_config : {};
    const fileClassifications = Array.isArray(value.file_classifications)
        ? value.file_classifications.flatMap((entry) => {
            if (!isRecord(entry)) {
                return [];
            }
            const layer = String(entry.layer || '') as GitChangeLayer;
            const changeKind = String(entry.change_kind || '') as GitChangeKind;
            const contentClassification = String(entry.content_classification || '') as GitContentClassification;
            const filePath = String(entry.path || '').trim();
            if (
                !filePath
                || !EVIDENCE_LAYERS.has(layer)
                || !EVIDENCE_CHANGE_KINDS.has(changeKind)
                || !EVIDENCE_CONTENT_CLASSIFICATIONS.has(contentClassification)
                || entry.included_in_effective_scope !== true
            ) {
                return [];
            }
            const previousPath = entry.previous_path == null
                ? null
                : String(entry.previous_path || '').trim() || null;
            return [{
                path: filePath,
                previous_path: previousPath,
                layer,
                status: String(entry.status || '').trim(),
                change_kind: changeKind,
                content_classification: contentClassification,
                included_in_effective_scope: true as const,
                reason: String(entry.reason || '').trim()
            }];
        })
        : [];
    const ignoredEolOnlyFiles = normalizeEvidenceStringList(value.ignored_eol_only_files);
    if (ignoredEolOnlyFiles.length > 0) {
        return null;
    }

    return {
        schema_version: 1,
        policy_id: GIT_EOL_CHANGE_POLICY.id,
        eol_only_treatment: GIT_EOL_CHANGE_POLICY.eolOnlyTreatment,
        git_normalized_clean_treatment: GIT_EOL_CHANGE_POLICY.gitNormalizedCleanTreatment,
        policy_rationale: String(value.policy_rationale || GIT_EOL_CHANGE_POLICY.rationale).trim(),
        git_config: {
            autocrlf: String(gitConfig.autocrlf || 'unset').trim() || 'unset',
            eol: String(gitConfig.eol || 'unset').trim() || 'unset',
            safecrlf: String(gitConfig.safecrlf || 'unset').trim() || 'unset'
        },
        effective_dirty: value.effective_dirty === true,
        normalization_rationale: String(value.normalization_rationale || '').trim(),
        effective_changed_files: normalizeEvidenceStringList(value.effective_changed_files),
        staged_files: normalizeEvidenceStringList(value.staged_files),
        unstaged_files: normalizeEvidenceStringList(value.unstaged_files),
        untracked_files: normalizeEvidenceStringList(value.untracked_files),
        eol_only_files: normalizeEvidenceStringList(value.eol_only_files),
        ignored_eol_only_files: [],
        file_classifications: fileClassifications
    };
}

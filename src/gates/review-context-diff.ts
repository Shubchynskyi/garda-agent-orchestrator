import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../core/subprocess';
import { stringSha256 } from '../gate-runtime/hash';
import { writeArtifactFileAtomically } from '../gate-runtime/review-artifacts';
import { fileSha256, normalizePath } from './helpers';

export const REVIEW_CONTEXT_DIFF_MAX_CHARS = 60000;
export const REVIEW_CONTEXT_NON_CODE_PROMPT_DIFF_MAX_CHARS = 20000;

const GIT_NO_COLOR_GLOBAL_ARGS = ['-c', 'color.ui=false'];
const GIT_DIFF_HARDENING_ARGS = ['--no-ext-diff', '--no-textconv', '--no-color'];

export interface GitDiffSummary {
    stat: string | null;
    diff: string | null;
    diff_truncated: boolean;
    diff_char_count: number;
    command_status: number | null;
    source: string;
    error: string | null;
    cache_path: string | null;
    cached: boolean;
}

export function readReviewContextChangedFiles(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map((entry) => {
        const normalized = normalizeReviewContextChangedFilePath(entry);
        if (!normalized) {
            throw new Error(`Preflight changed_files contains an unsafe path for reviewer diff collection: ${String(entry || '')}`);
        }
        return normalized;
    });
}

function normalizeReviewContextChangedFilePath(value: unknown): string | null {
    const raw = String(value || '').trim();
    if (!raw) {
        return null;
    }
    if (/[\u0000-\u001f\u007f]/.test(raw)) {
        return null;
    }
    const slashPath = raw.replace(/\\/g, '/');
    if (
        slashPath.startsWith('/')
        || /^[A-Za-z]:\//.test(slashPath)
        || slashPath === '.'
        || slashPath === '..'
        || slashPath.startsWith('../')
        || slashPath.endsWith('/..')
        || slashPath.includes('/../')
        || slashPath.startsWith(':')
    ) {
        return null;
    }
    const normalized = normalizePath(slashPath);
    if (
        !normalized
        || normalized === '.'
        || normalized === '..'
        || normalized.startsWith('../')
        || normalized.endsWith('/..')
        || normalized.includes('/../')
        || normalized.startsWith(':')
        || path.isAbsolute(normalized)
    ) {
        return null;
    }
    return normalized;
}

function toLiteralGitPathspecs(changedFiles: string[]): string[] {
    return changedFiles.map((filePath) => `:(literal)${filePath}`);
}

function readTextFileBounded(filePath: string, maxChars: number): {
    text: string | null;
    charCount: number;
    truncated: boolean;
    skippedReason?: string | null;
} {
    try {
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink()) {
            return { text: null, charCount: 0, truncated: false, skippedReason: 'symbolic_link' };
        }
        if (!stat.isFile() || stat.size === 0) {
            return { text: null, charCount: 0, truncated: false };
        }
        const file = fs.openSync(filePath, 'r');
        try {
            const buffer = Buffer.alloc(Math.min(stat.size, maxChars + 4096));
            const bytesRead = fs.readSync(file, buffer, 0, buffer.length, 0);
            const text = buffer.subarray(0, bytesRead).toString('utf8');
            const truncated = text.length > maxChars || stat.size > bytesRead;
            const boundedText = text.slice(0, maxChars);
            return {
                text: boundedText.length > 0 ? boundedText : null,
                charCount: Math.max(stat.size, text.length),
                truncated
            };
        } finally {
            fs.closeSync(file);
        }
    } catch {
        return { text: null, charCount: 0, truncated: false };
    }
}

function resolveRepoRelativePath(repoRoot: string, relativeFile: string): string | null {
    const resolvedRoot = path.resolve(repoRoot);
    const resolvedPath = path.resolve(resolvedRoot, relativeFile);
    const relativeFromRoot = path.relative(resolvedRoot, resolvedPath);
    if (!relativeFromRoot || relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
        return null;
    }
    try {
        const stat = fs.lstatSync(resolvedPath);
        if (stat.isSymbolicLink()) {
            return resolvedPath;
        }
        const realRoot = fs.realpathSync.native(resolvedRoot);
        const realPath = fs.realpathSync.native(resolvedPath);
        const realRelativeFromRoot = path.relative(realRoot, realPath);
        if (!realRelativeFromRoot || realRelativeFromRoot.startsWith('..') || path.isAbsolute(realRelativeFromRoot)) {
            return null;
        }
        return resolvedPath;
    } catch {
        return null;
    }
}

function runGitTextCommand(
    repoRoot: string,
    args: string[],
    maxChars: number
): { text: string | null; status: number | null; error: string | null; charCount: number; truncated: boolean } {
    try {
        const result = spawnSyncWithTimeout('git', [...GIT_NO_COLOR_GLOBAL_ARGS, ...args], {
            cwd: repoRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
            maxBuffer: Math.max(8192, (Math.max(maxChars, 0) * 4) + 4096),
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS
        });
        const status = typeof result.status === 'number' ? result.status : null;
        const stdout = normalizeSpawnText(result.stdout);
        const stderr = normalizeSpawnText(result.stderr).slice(0, 8000).trim() || null;
        const maxBufferHit = isSpawnMaxBufferError(result.error);
        const output = boundText(stdout, maxChars, maxBufferHit);
        if (result.timedOut) {
            return { ...output, status, error: `git timed out after ${DEFAULT_GIT_TIMEOUT_MS} ms.` };
        }
        if (result.error && !maxBufferHit) {
            return { ...output, status, error: result.error.message };
        }
        if (maxBufferHit) {
            return { ...output, status, error: null };
        }
        if (status !== 0) {
            return { ...output, status, error: stderr || `git exited with status ${status}` };
        }
        return { ...output, status, error: null };
    } catch (error) {
        return { text: null, status: null, error: error instanceof Error ? error.message : String(error), charCount: 0, truncated: false };
    }
}

function normalizeSpawnText(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (Buffer.isBuffer(value)) {
        return value.toString('utf8');
    }
    return '';
}

function isSpawnMaxBufferError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const code = 'code' in error ? String((error as { code?: unknown }).code || '') : '';
    const message = 'message' in error ? String((error as { message?: unknown }).message || '') : '';
    return code === 'ENOBUFS' || message.includes('maxBuffer');
}

function boundText(text: string, maxChars: number, forceTruncated = false): {
    text: string | null;
    charCount: number;
    truncated: boolean;
} {
    const effectiveMax = Math.max(maxChars, 0);
    const boundedText = text.slice(0, effectiveMax);
    return {
        text: boundedText.length > 0 ? boundedText : null,
        charCount: forceTruncated ? Math.max(text.length, effectiveMax + 1) : text.length,
        truncated: forceTruncated || text.length > effectiveMax
    };
}

function buildUntrackedFileDiff(repoRoot: string, changedFiles: string[], maxChars: number): { text: string | null; charCount: number; truncated: boolean } {
    const literalPathspecs = toLiteralGitPathspecs(changedFiles);
    const untrackedResult = runGitTextCommand(repoRoot, ['ls-files', '--others', '--exclude-standard', '--', ...literalPathspecs], maxChars);
    const untrackedFiles = String(untrackedResult.text || '')
        .split('\n')
        .map((entry) => normalizePath(entry))
        .filter((entry) => entry.length > 0);
    if (untrackedFiles.length === 0) {
        return { text: null, charCount: 0, truncated: false };
    }
    const chunks: string[] = [];
    let charCount = 0;
    let truncated = false;
    for (const relativeFile of untrackedFiles) {
        const absolutePath = resolveRepoRelativePath(repoRoot, relativeFile);
        const content = absolutePath
            ? readTextFileBounded(absolutePath, Math.max(0, maxChars - charCount))
            : { text: null, charCount: 0, truncated: false, skippedReason: 'outside_repo' };
        const fileMode = content.skippedReason === 'symbolic_link' ? '120000' : '100644';
        const header = `diff --git a/${relativeFile} b/${relativeFile}\nnew file mode ${fileMode}\n--- /dev/null\n+++ b/${relativeFile}\n`;
        const body = content.text
            ? content.text.split('\n').map((line) => `+${line}`).join('\n')
            : content.skippedReason
                ? `+[untracked file content omitted: ${content.skippedReason}]`
            : '';
        const chunk = `${header}${body}`;
        chunks.push(chunk);
        charCount += chunk.length;
        truncated = truncated || content.truncated || charCount >= maxChars;
        if (charCount >= maxChars) {
            break;
        }
    }
    const text = chunks.join('\n').slice(0, maxChars);
    return { text: text || null, charCount, truncated };
}

function resolveSharedScopedDiffSummaryPath(preflightPath: string): string {
    const directory = path.dirname(preflightPath);
    const fileName = path.basename(preflightPath);
    const baseName = fileName.endsWith('-preflight.json')
        ? fileName.slice(0, -'-preflight.json'.length)
        : fileName.replace(/\.json$/i, '');
    return path.join(directory, `${baseName}-scoped-diff-summary.json`);
}

function buildGitDiffSummaryCacheKey(options: {
    preflightSha256: string | null;
    detectionSource: string;
    changedFiles: string[];
    source: string;
    statText: string | null;
    statStatus: number | null;
    statTruncated: boolean;
    contentFingerprint: string;
}): string {
    return stringSha256(JSON.stringify({
        schema_version: 1,
        max_chars: REVIEW_CONTEXT_DIFF_MAX_CHARS,
        hardening_args: GIT_DIFF_HARDENING_ARGS,
        preflight_sha256: options.preflightSha256,
        detection_source: options.detectionSource,
        changed_files: options.changedFiles,
        source: options.source,
        stat_text: options.statText,
        stat_status: options.statStatus,
        stat_truncated: options.statTruncated,
        content_fingerprint: options.contentFingerprint
    })) || '';
}

function getStagedChangedFileFingerprintEntries(repoRoot: string, changedFiles: string[]): Map<string, Record<string, unknown>> {
    const stagedEntries = new Map<string, Record<string, unknown>>();
    if (changedFiles.length === 0) {
        return stagedEntries;
    }
    const result = runGitTextCommand(repoRoot, ['ls-files', '-s', '--', ...toLiteralGitPathspecs(changedFiles)], 120000);
    if (result.error || !result.text) {
        return stagedEntries;
    }
    for (const line of result.text.split(/\r?\n/)) {
        const match = /^(\d+)\s+([0-9a-f]{40,64})\s+\d+\t(.+)$/.exec(line);
        if (!match) {
            continue;
        }
        const filePath = normalizePath(match[3] || '');
        if (!filePath) {
            continue;
        }
        stagedEntries.set(filePath, {
            path: filePath,
            status: 'staged',
            mode: match[1],
            object_id: String(match[2] || '').toLowerCase()
        });
    }
    return stagedEntries;
}

export function buildChangedFileFingerprintEntries(
    repoRoot: string,
    changedFiles: string[],
    options: { stagedScope?: boolean } = {}
): Record<string, unknown>[] {
    const resolvedRoot = path.resolve(repoRoot);
    const stagedEntries = options.stagedScope
        ? getStagedChangedFileFingerprintEntries(repoRoot, changedFiles)
        : new Map<string, Record<string, unknown>>();
    let realRoot: string | null = null;
    try {
        realRoot = fs.realpathSync.native(resolvedRoot);
    } catch {
        realRoot = null;
    }
    return changedFiles.map((relativeFile) => {
        const normalizedRelativeFile = normalizePath(relativeFile);
        const stagedEntry = stagedEntries.get(normalizedRelativeFile);
        if (stagedEntry) {
            return stagedEntry;
        }
        const absolutePath = path.resolve(resolvedRoot, relativeFile);
        const relativeFromRoot = path.relative(resolvedRoot, absolutePath);
        if (!relativeFromRoot || relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
            return { path: relativeFile, status: 'outside_repo' };
        }
        try {
            const stat = fs.lstatSync(absolutePath);
            const base = {
                path: relativeFile,
                mode: stat.mode,
                size: stat.size,
                mtime_ms: stat.mtimeMs,
                ctime_ms: stat.ctimeMs
            };
            if (stat.isSymbolicLink()) {
                return {
                    ...base,
                    status: 'symbolic_link',
                    link_sha256: stringSha256(fs.readlinkSync(absolutePath)) || null
                };
            }
            if (realRoot) {
                const realPath = fs.realpathSync.native(absolutePath);
                const realRelativeFromRoot = path.relative(realRoot, realPath);
                if (!realRelativeFromRoot || realRelativeFromRoot.startsWith('..') || path.isAbsolute(realRelativeFromRoot)) {
                    return { ...base, status: 'outside_repo' };
                }
            }
            if (stat.isFile()) {
                return {
                    ...base,
                    status: 'file'
                };
            }
            if (stat.isDirectory()) {
                return { ...base, status: 'directory' };
            }
            return { ...base, status: 'special' };
        } catch {
            return { path: relativeFile, status: 'missing' };
        }
    });
}

function buildDiffCacheContentFingerprint(
    repoRoot: string,
    changedFiles: string[],
    diffBaseArgs: string[],
    literalPathspecs: string[],
    options: { stagedScope?: boolean } = {}
): string {
    const rawResult = runGitTextCommand(
        repoRoot,
        [...diffBaseArgs, '--full-index', '--raw', '--', ...literalPathspecs],
        20000
    );
    return stringSha256(JSON.stringify({
        schema_version: 1,
        git_raw: rawResult.text,
        git_raw_status: rawResult.status,
        git_raw_truncated: rawResult.truncated,
        changed_file_fingerprints: buildChangedFileFingerprintEntries(repoRoot, changedFiles, {
            stagedScope: options.stagedScope === true
        })
    })) || '';
}

function normalizeCachedGitDiffSummary(value: unknown, cachePath: string): GitDiffSummary | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    return {
        stat: typeof record.stat === 'string' ? record.stat : null,
        diff: typeof record.diff === 'string' ? record.diff : null,
        diff_truncated: record.diff_truncated === true,
        diff_char_count: typeof record.diff_char_count === 'number' ? record.diff_char_count : 0,
        command_status: typeof record.command_status === 'number' ? record.command_status : null,
        source: typeof record.source === 'string' ? record.source : 'cache',
        error: typeof record.error === 'string' ? record.error : null,
        cache_path: normalizePath(cachePath),
        cached: true
    };
}

function readCachedGitDiffSummary(cachePath: string, cacheKey: string): GitDiffSummary | null {
    try {
        if (!fs.existsSync(cachePath) || !fs.statSync(cachePath).isFile()) {
            return null;
        }
        const document = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
        if (document.schema_version !== 1 || document.cache_key !== cacheKey) {
            return null;
        }
        return normalizeCachedGitDiffSummary(document.summary, cachePath);
    } catch {
        return null;
    }
}

function writeCachedGitDiffSummary(cachePath: string, cacheKey: string, preflightSha256: string | null, summary: GitDiffSummary): void {
    try {
        writeArtifactFileAtomically(cachePath, JSON.stringify({
            schema_version: 1,
            cache_key: cacheKey,
            preflight_sha256: preflightSha256,
            generated_at_utc: new Date().toISOString(),
            summary: {
                stat: summary.stat,
                diff: summary.diff,
                diff_truncated: summary.diff_truncated,
                diff_char_count: summary.diff_char_count,
                command_status: summary.command_status,
                source: summary.source,
                error: summary.error
            }
        }, null, 2) + '\n');
    } catch {
        // Cache writes are opportunistic; review context generation still returns the freshly computed diff.
    }
}

export function buildGitDiffSummary(
    repoRoot: string,
    changedFiles: string[],
    preflight: Record<string, unknown>,
    preflightPath: string
): GitDiffSummary {
    const cachePath = resolveSharedScopedDiffSummaryPath(preflightPath);
    if (changedFiles.length === 0) {
        return {
            stat: null,
            diff: null,
            diff_truncated: false,
            diff_char_count: 0,
            command_status: null,
            source: 'none',
            error: null,
            cache_path: normalizePath(cachePath),
            cached: false
        };
    }

    const detectionSource = String(preflight.detection_source || '').trim().toLowerCase();
    const usesStagedScope = detectionSource === 'git_staged_only' || detectionSource === 'git_staged_plus_untracked';
    const includeUntracked = detectionSource === 'git_staged_plus_untracked'
        || detectionSource === 'git_auto'
        || detectionSource === 'explicit_changed_files';
    const diffTargetArgs = usesStagedScope ? ['--cached'] : ['HEAD'];
    const diffBaseArgs = ['diff', ...GIT_DIFF_HARDENING_ARGS, ...diffTargetArgs];
    const literalPathspecs = toLiteralGitPathspecs(changedFiles);
    const statResult = runGitTextCommand(repoRoot, [...diffBaseArgs, '--stat', '--', ...literalPathspecs], 20000);
    const source = usesStagedScope
        ? (includeUntracked ? 'git_diff_cached_plus_untracked' : 'git_diff_cached')
        : (includeUntracked ? 'git_diff_head_plus_untracked' : 'git_diff_head');
    const preflightSha256 = fileSha256(preflightPath);
    const contentFingerprint = buildDiffCacheContentFingerprint(repoRoot, changedFiles, diffBaseArgs, literalPathspecs, {
        stagedScope: usesStagedScope
    });
    const cacheKey = buildGitDiffSummaryCacheKey({
        preflightSha256,
        detectionSource,
        changedFiles,
        source,
        statText: statResult.text,
        statStatus: statResult.status,
        statTruncated: statResult.truncated,
        contentFingerprint
    });
    const cached = readCachedGitDiffSummary(cachePath, cacheKey);
    if (cached) {
        return cached;
    }
    const diffResult = runGitTextCommand(repoRoot, [...diffBaseArgs, '--', ...literalPathspecs], REVIEW_CONTEXT_DIFF_MAX_CHARS);
    const untrackedDiff = includeUntracked
        ? buildUntrackedFileDiff(repoRoot, changedFiles, Math.max(0, REVIEW_CONTEXT_DIFF_MAX_CHARS - (diffResult.text || '').length))
        : { text: null, charCount: 0, truncated: false };
    const fullDiff = [diffResult.text, untrackedDiff.text].filter(Boolean).join('\n');
    const diffTruncated = diffResult.truncated || untrackedDiff.truncated || fullDiff.length > REVIEW_CONTEXT_DIFF_MAX_CHARS;
    const summary = {
        stat: statResult.text,
        diff: fullDiff ? fullDiff.slice(0, REVIEW_CONTEXT_DIFF_MAX_CHARS) : null,
        diff_truncated: diffTruncated,
        diff_char_count: diffResult.charCount + untrackedDiff.charCount,
        command_status: diffResult.status,
        source,
        error: diffResult.error || statResult.error,
        cache_path: normalizePath(cachePath),
        cached: false
    };
    if (!summary.error) {
        writeCachedGitDiffSummary(cachePath, cacheKey, preflightSha256, summary);
    }
    return summary;
}

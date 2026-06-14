import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { assertCanonicalTaskId } from '../../core/task-ids';
import { redactSecretText } from '../../core/redaction';
import { normalizePath } from '../shared/helpers';
import {
    type FullSuiteFailureEvidence,
    type FullSuiteFailureEvidenceCopiedLog,
    type FullSuiteFailureEvidenceOptions
} from './full-suite-validation-types';

const DEFAULT_FAILURE_EVIDENCE_MAX_LOGS = 6;
const DEFAULT_FAILURE_EVIDENCE_MAX_LOG_CHARS = 200_000;
const DEFAULT_FAILURE_EVIDENCE_LAST_OUTPUT_LINES = 80;
const DEFAULT_FAILURE_EVIDENCE_MAX_SUMMARY_LINE_CHARS = 4_000;

interface TrustedShardLogDeclarations {
    declaredPaths: Set<string>;
    trustedShardLogDir: string | null;
}

function isFailedOrWarnedStatus(status: string): status is 'FAILED' | 'WARNED' {
    return status === 'FAILED' || status === 'WARNED';
}

function normalizeAbsolutePath(value: string, repoRoot: string): string | null {
    const trimmed = value.trim().replace(/^"|"$/g, '');
    if (!trimmed) {
        return null;
    }
    return path.resolve(repoRoot, trimmed);
}

function isInsidePath(parentPath: string, childPath: string): boolean {
    const relative = path.relative(parentPath, childPath);
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isInsideOrEqualPath(parentPath: string, childPath: string): boolean {
    const relative = path.relative(parentPath, childPath);
    return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function collectTrustedShardLogDeclarations(outputLines: string[], repoRoot: string): TrustedShardLogDeclarations {
    const declaredPaths = new Set<string>();
    let trustedShardLogDir: string | null = null;
    let collectingSetupBlock = false;
    let setupBlockClosed = false;

    for (const line of outputLines) {
        if (setupBlockClosed) {
            break;
        }

        const logDirMatch = line.match(/^NODE_FOUNDATION_TEST_SHARD_LOG_DIR\s+(.+)$/u);
        if (!collectingSetupBlock) {
            if (!logDirMatch) {
                continue;
            }
            trustedShardLogDir = normalizeAbsolutePath(logDirMatch[1], repoRoot);
            collectingSetupBlock = true;
            continue;
        }

        if (logDirMatch) {
            continue;
        }
        if (/^NODE_FOUNDATION_TEST_DURATION_TELEMETRY\s+/u.test(line)
            || /^NODE_FOUNDATION_TEST_SHARD_RUNTIME\s+/u.test(line)
            || /^NODE_FOUNDATION_TEST_SHARD_START\s+\d+\/\d+\s+/u.test(line)) {
            continue;
        }

        const directMatch = line.match(/^NODE_FOUNDATION_TEST_SHARD_LOG\s+\d+\/\d+\s+(.+)$/u);
        if (directMatch) {
            const resolved = normalizeAbsolutePath(directMatch[1], repoRoot);
            if (
                resolved
                && trustedShardLogDir
                && isInsideOrEqualPath(trustedShardLogDir, resolved)
            ) {
                declaredPaths.add(resolved);
            }
            continue;
        }

        setupBlockClosed = true;
    }

    return { declaredPaths, trustedShardLogDir };
}

function collectShardLogPaths(outputLines: string[], repoRoot: string): TrustedShardLogDeclarations {
    const failedDonePaths = new Set<string>();
    const { declaredPaths, trustedShardLogDir } = collectTrustedShardLogDeclarations(outputLines, repoRoot);
    for (const line of outputLines) {
        const failedDoneMatch = line.match(/^NODE_FOUNDATION_TEST_SHARD_DONE\s+\d+\/\d+\s+exit=(?!0\b)\S+.*\slog=(.+)$/u);
        if (failedDoneMatch) {
            const resolved = normalizeAbsolutePath(failedDoneMatch[1], repoRoot);
            if (resolved && (
                declaredPaths.has(resolved)
                || (trustedShardLogDir !== null && isInsideOrEqualPath(trustedShardLogDir, resolved))
            )) {
                failedDonePaths.add(resolved);
            }
        }
    }
    return {
        declaredPaths: failedDonePaths.size > 0 ? failedDonePaths : declaredPaths,
        trustedShardLogDir
    };
}

function collectFailureDiagnostics(outputLines: string[], pattern: RegExp): string[] {
    return outputLines
        .map((line) => line.trim())
        .map(redactFailureEvidenceSummaryLine)
        .filter((line) => pattern.test(line))
        .slice(0, 20);
}

function truncateFailureEvidenceSummaryLine(line: string): string {
    if (line.length <= DEFAULT_FAILURE_EVIDENCE_MAX_SUMMARY_LINE_CHARS) {
        return line;
    }
    const suffix = ` ... [truncated original_chars=${line.length}]`;
    const retainedChars = Math.max(0, DEFAULT_FAILURE_EVIDENCE_MAX_SUMMARY_LINE_CHARS - suffix.length);
    return `${line.slice(0, retainedChars)}${suffix}`;
}

function redactFailureEvidenceSummaryLine(line: string): string {
    return truncateFailureEvidenceSummaryLine(redactSecretText(line));
}

function redactLineList(lines: string[]): string[] {
    return lines.map((line) => redactFailureEvidenceSummaryLine(line));
}

function redactLineChunks(chunks: string[][]): string[][] {
    return chunks.map(redactLineList);
}

function copyFailureEvidenceLog(
    sourcePath: string,
    evidenceDir: string,
    repoRoot: string,
    trustedShardLogDir: string | null,
    index: number,
    maxLogChars: number
): FullSuiteFailureEvidenceCopiedLog | null {
    let canonicalSource: string;
    let canonicalRepoRoot: string;
    let canonicalTrustedShardLogDir: string | null = null;
    try {
        canonicalRepoRoot = fs.realpathSync.native(path.resolve(repoRoot));
        canonicalSource = fs.realpathSync.native(path.resolve(sourcePath));
        canonicalTrustedShardLogDir = trustedShardLogDir === null
            ? null
            : fs.realpathSync.native(path.resolve(trustedShardLogDir));
    } catch {
        return null;
    }
    if (
        !isInsidePath(canonicalRepoRoot, canonicalSource)
        || canonicalTrustedShardLogDir === null
        || !isInsidePath(canonicalTrustedShardLogDir, canonicalSource)
        || !fs.statSync(canonicalSource).isFile()
    ) {
        return null;
    }
    const rawContent = fs.readFileSync(canonicalSource, 'utf8');
    const redactedContent = redactSecretText(rawContent);
    const truncated = redactedContent.length > maxLogChars;
    const copiedContent = truncated
        ? [
            `FULL_SUITE_FAILURE_EVIDENCE_LOG_TRUNCATED original_chars=${redactedContent.length} retained_tail_chars=${maxLogChars}`,
            redactedContent.slice(-maxLogChars)
        ].join('\n')
        : redactedContent;
    const extension = path.extname(canonicalSource) || '.log';
    const artifactPath = path.join(evidenceDir, `shard-log-${String(index + 1).padStart(2, '0')}${extension}`);
    fs.writeFileSync(artifactPath, copiedContent, 'utf8');
    return {
        source_path: normalizePath(canonicalSource),
        artifact_path: normalizePath(artifactPath),
        sha256: createHash('sha256').update(copiedContent).digest('hex'),
        bytes: Buffer.byteLength(copiedContent, 'utf8'),
        lines: copiedContent.length === 0 ? 0 : copiedContent.split(/\r?\n/u).length,
        truncated
    };
}

export function persistFullSuiteFailureEvidence(options: FullSuiteFailureEvidenceOptions): FullSuiteFailureEvidence | null {
    if (!isFailedOrWarnedStatus(options.result.status)) {
        return null;
    }
    const taskId = assertCanonicalTaskId(options.taskId);
    const maxCopiedLogs = Math.max(0, Math.trunc(options.maxCopiedLogs ?? DEFAULT_FAILURE_EVIDENCE_MAX_LOGS));
    const maxLogChars = Math.max(1, Math.trunc(options.maxLogChars ?? DEFAULT_FAILURE_EVIDENCE_MAX_LOG_CHARS));
    const evidenceDir = path.join(options.reviewsRoot, `${taskId}-full-suite-failure-evidence`);
    fs.mkdirSync(evidenceDir, { recursive: true });

    const shardLogPaths = collectShardLogPaths(options.outputLines, options.repoRoot);
    const copiedLogs = Array.from(shardLogPaths.declaredPaths)
        .slice(0, maxCopiedLogs)
        .map((sourcePath, index) => copyFailureEvidenceLog(
            sourcePath,
            evidenceDir,
            options.repoRoot,
            shardLogPaths.trustedShardLogDir,
            index,
            maxLogChars
        ))
        .filter((entry): entry is FullSuiteFailureEvidenceCopiedLog => entry !== null);
    const summaryPath = path.join(evidenceDir, 'summary.json');
    const evidence: FullSuiteFailureEvidence = {
        schema_version: 1,
        task_id: taskId,
        status: options.result.status,
        command: redactFailureEvidenceSummaryLine(options.result.command),
        exit_code: options.result.exit_code,
        timed_out: options.result.timed_out,
        output_artifact_path: options.result.output_artifact_path,
        summary_artifact_path: normalizePath(summaryPath),
        copied_logs: copiedLogs,
        copied_logs_count: copiedLogs.length,
        max_copied_logs: maxCopiedLogs,
        max_log_chars: maxLogChars,
        failure_chunks: redactLineChunks(options.result.failure_chunks),
        compact_summary: redactLineList(options.result.compact_summary),
        last_output_lines: redactLineList(options.outputLines.slice(-DEFAULT_FAILURE_EVIDENCE_LAST_OUTPUT_LINES)),
        shard_diagnostics: collectFailureDiagnostics(
            options.outputLines,
            /\bNODE_FOUNDATION_TEST_SHARD_(?:DONE|TIMEOUT|CLEANUP_GRACE_EXPIRED|LOG|GREEN_EXIT_MISMATCH|GREEN_EXIT_TAIL|ISOLATION_FAIL|ISOLATION_TAIL|ISOLATION_NO_REPRO|ISOLATION_CAPPED)\b/u
        ),
        timeout_diagnostics: collectFailureDiagnostics(options.outputLines, /\b(?:timed out|timeout|NODE_FOUNDATION_TEST_SHARD_TIMEOUT)\b/iu)
    };
    fs.writeFileSync(summaryPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    return evidence;
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    isNodeFoundationTestShardDiagnosticLine,
    isNodeFoundationTestShardSetupLine,
    lineHasNodeFoundationTestMarker,
    NODE_FOUNDATION_TEST_MARKERS,
    parseNodeFoundationTestShardDoneLine,
    parseNodeFoundationTestShardLogDirLine,
    parseNodeFoundationTestShardLogLine
} from '../../core/node-foundation-test-shard-markers';
import { assertCanonicalTaskId } from '../../core/task-ids';
import { redactSecretText } from '../../core/redaction';
import { normalizePath } from '../shared/helpers';
import {
    type FullSuiteFailureEvidence,
    type FullSuiteFailureEvidenceCopiedLog,
    type FullSuiteFailureEvidenceOptions,
    type FullSuiteFailureKind,
    type FullSuiteTopFailure
} from './full-suite-validation-types';

const DEFAULT_FAILURE_EVIDENCE_MAX_LOGS = 6;
const DEFAULT_FAILURE_EVIDENCE_MAX_LOG_CHARS = 200_000;
const DEFAULT_FAILURE_EVIDENCE_LAST_OUTPUT_LINES = 80;
const DEFAULT_FAILURE_EVIDENCE_MAX_SUMMARY_LINE_CHARS = 4_000;
const DEFAULT_FAILURE_EVIDENCE_MAX_TOP_FAILURES = 8;

interface TrustedShardLogDeclarations {
    declaredPaths: Set<string>;
    trustedShardLogDir: string | null;
}

interface CopiedFailureEvidenceLog {
    copiedLog: FullSuiteFailureEvidenceCopiedLog;
    sourceLines: string[];
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

        const logDir = parseNodeFoundationTestShardLogDirLine(line);
        if (!collectingSetupBlock) {
            if (!logDir) {
                continue;
            }
            trustedShardLogDir = normalizeAbsolutePath(logDir, repoRoot);
            collectingSetupBlock = true;
            continue;
        }

        if (logDir) {
            continue;
        }
        if (isNodeFoundationTestShardSetupLine(line)) {
            continue;
        }

        const shardLog = parseNodeFoundationTestShardLogLine(line);
        if (shardLog) {
            const resolved = normalizeAbsolutePath(shardLog.log_path, repoRoot);
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
        const doneLine = parseNodeFoundationTestShardDoneLine(line);
        if (doneLine && doneLine.exit !== '0') {
            const resolved = normalizeAbsolutePath(doneLine.log_path, repoRoot);
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

function collectFailureDiagnostics(outputLines: string[], pattern: { test(line: string): boolean; }): string[] {
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

function parseSourceLocation(value: string): { filePath: string | null; line: number | null; } {
    const match = value.match(/(.+?):(\d+)(?::\d+)?$/u);
    if (!match) {
        return { filePath: value.trim() || null, line: null };
    }
    return {
        filePath: normalizePath(match[1].trim()),
        line: Number.parseInt(match[2], 10)
    };
}

function classifyFailureLine(line: string): FullSuiteFailureKind {
    if (lineHasNodeFoundationTestMarker(line, NODE_FOUNDATION_TEST_MARKERS.SHARD_TIMEOUT)) {
        return /\blast_output_age_ms=\d+/u.test(line) ? 'process_hang' : 'timeout';
    }
    const shardDone = parseNodeFoundationTestShardDoneLine(line);
    if (/\b(?:AssertionError|ERR_ASSERTION)\b/u.test(line)) {
        return 'assertion';
    }
    if (
        /^(?:Error:\s+)?(?:node(?:\.exe)?|npm|pnpm|yarn)\b.*\bfailed \(exit \d+\)/iu.test(line)
        || (shardDone !== null && shardDone.exit !== '0')
        || /\b(?:failed \(exit \d+\)|exit!=0)\b/u.test(line)
    ) {
        return 'process_exit';
    }
    if (
        (shardDone !== null && shardDone.timed_out === true)
        || /\b(?:Process|Command|Full suite|Shard|Test command)\b.*\btimed out\b/iu.test(line)
        || /^(?:Error:\s+)?Timed out\b/iu.test(line)
        || /\btimed out after \d+\s*ms\b/iu.test(line)
    ) {
        return 'timeout';
    }
    return 'unknown';
}

function mergeFailureKind(current: FullSuiteFailureKind, next: FullSuiteFailureKind): FullSuiteFailureKind {
    const rank: Record<FullSuiteFailureKind, number> = {
        process_hang: 5,
        timeout: 4,
        assertion: 3,
        process_exit: 2,
        unknown: 1
    };
    return rank[next] > rank[current] ? next : current;
}

function pushTopFailure(
    failures: FullSuiteTopFailure[],
    seenKeys: Set<string>,
    failure: FullSuiteTopFailure
): void {
    if (!failure.summary.trim()) {
        return;
    }
    const key = [
        failure.kind,
        failure.source,
        failure.source_path || '',
        failure.artifact_path || '',
        failure.test_name || '',
        failure.file_path || '',
        String(failure.line || ''),
        failure.summary
    ].join('\u0000');
    if (seenKeys.has(key)) {
        return;
    }
    seenKeys.add(key);
    failures.push(failure);
}

function hasConcreteFailedTest(failure: FullSuiteTopFailure): boolean {
    return !!failure.test_name?.trim();
}

function getTopFailurePriority(failure: FullSuiteTopFailure): number {
    if (hasConcreteFailedTest(failure)) {
        const kindPriority: Record<FullSuiteFailureKind, number> = {
            assertion: 50,
            timeout: 40,
            process_hang: 30,
            process_exit: 20,
            unknown: 10
        };
        return 100 + kindPriority[failure.kind];
    }
    const infrastructurePriority: Record<FullSuiteFailureKind, number> = {
        process_hang: 50,
        timeout: 40,
        assertion: 30,
        process_exit: 20,
        unknown: 10
    };
    return infrastructurePriority[failure.kind];
}

function isNonFailureNodeTestLine(line: string): boolean {
    return /^(?:✔|✓)\s/u.test(line)
        || /^ok\s+\d+\b/u.test(line)
        || /^▶\s/u.test(line)
        || /^Summary:/u.test(line)
        || /^COMMAND_TIMEOUT_DIAGNOSTICS_PASSED$/u.test(line);
}

function lineLooksLikePrimaryFailureAnchor(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed || isNonFailureNodeTestLine(trimmed) || /^✖ failing tests:?$/u.test(trimmed)) {
        return false;
    }
    return /^(?:✖|x)\s+.+/u.test(trimmed)
        || /^not ok\s+\d+\s+-\s+.+/u.test(trimmed)
        || classifyFailureLine(trimmed) !== 'unknown';
}

function lineLooksLikeFailureAnchor(line: string): boolean {
    return lineLooksLikePrimaryFailureAnchor(line) || /^test at .+$/u.test(line.trim());
}

function findFailureAnchorOffsetBy(content: string, predicate: (line: string) => boolean): number | null {
    let offset = 0;
    for (const line of content.split(/\r?\n/u)) {
        if (predicate(line)) {
            return offset;
        }
        offset += line.length + 1;
    }
    return null;
}

function findExplicitFailingTestsMarkerOffset(content: string): number | null {
    let offset = 0;
    for (const line of content.split(/\r?\n/u)) {
        offset += line.length + 1;
        if (/^✖ failing tests:?$/u.test(line.trim())) {
            return offset;
        }
    }
    return null;
}

function findFailureAnchorOffset(content: string): number | null {
    const explicitFailureListOffset = findExplicitFailingTestsMarkerOffset(content);
    if (explicitFailureListOffset !== null) {
        const explicitFailureList = content.slice(explicitFailureListOffset);
        const explicitAnchorOffset = findFailureAnchorOffsetBy(explicitFailureList, lineLooksLikePrimaryFailureAnchor)
            ?? findFailureAnchorOffsetBy(explicitFailureList, lineLooksLikeFailureAnchor);
        if (explicitAnchorOffset !== null) {
            return explicitFailureListOffset + explicitAnchorOffset;
        }
    }
    return findFailureAnchorOffsetBy(content, lineLooksLikePrimaryFailureAnchor)
        ?? findFailureAnchorOffsetBy(content, lineLooksLikeFailureAnchor);
}

function buildTruncatedCopiedContent(redactedContent: string, maxLogChars: number): string {
    const anchorOffset = findFailureAnchorOffset(redactedContent);
    if (anchorOffset === null) {
        return [
            `FULL_SUITE_FAILURE_EVIDENCE_LOG_TRUNCATED original_chars=${redactedContent.length} retained_tail_chars=${maxLogChars}`,
            redactedContent.slice(-maxLogChars)
        ].join('\n');
    }
    const prefix = `FULL_SUITE_FAILURE_EVIDENCE_LOG_TRUNCATED original_chars=${redactedContent.length} retained_failure_window_chars=${maxLogChars}`;
    const halfWindow = Math.floor(maxLogChars / 2);
    const start = Math.max(0, anchorOffset - halfWindow);
    const end = Math.min(redactedContent.length, start + maxLogChars);
    const finalStart = Math.max(0, end - maxLogChars);
    return [
        prefix,
        `FULL_SUITE_FAILURE_EVIDENCE_WINDOW source_start_char=${finalStart} source_end_char=${end}`,
        redactedContent.slice(finalStart, end)
    ].join('\n');
}

function collectTopFailuresFromLines(options: {
    lines: string[];
    source: FullSuiteTopFailure['source'];
    sourcePath: string | null;
    artifactPath: string | null;
    seenKeys: Set<string>;
}): FullSuiteTopFailure[] {
    const explicitFailureListIndex = options.lines.findIndex((line) => /^✖ failing tests:?$/u.test(line.trim()));
    if (explicitFailureListIndex >= 0) {
        const explicitFailures = collectTopFailuresFromCandidateLines({
            ...options,
            lines: options.lines.slice(explicitFailureListIndex + 1)
        });
        if (explicitFailures.length > 0) {
            return explicitFailures;
        }
    }
    return collectTopFailuresFromCandidateLines(options);
}

function collectTopFailuresFromCandidateLines(options: {
    lines: string[];
    source: FullSuiteTopFailure['source'];
    sourcePath: string | null;
    artifactPath: string | null;
    seenKeys: Set<string>;
}): FullSuiteTopFailure[] {
    const failures: FullSuiteTopFailure[] = [];
    let pendingLocation: { filePath: string | null; line: number | null; } | null = null;
    let lastFailure: FullSuiteTopFailure | null = null;

    for (const rawLine of options.lines) {
        const line = redactFailureEvidenceSummaryLine(rawLine.trim());
        if (!line) {
            continue;
        }
        const testAtMatch = line.match(/^test at (.+)$/u);
        if (testAtMatch) {
            pendingLocation = parseSourceLocation(testAtMatch[1]);
            continue;
        }
        if (/^✖ failing tests:?$/u.test(line) || isNonFailureNodeTestLine(line)) {
            continue;
        }
        const failedTestMatch = line.match(/^(?:✖|x)\s+(.+?)(?:\s+\([\d.]+ms\))?$/u)
            || line.match(/^not ok\s+\d+\s+-\s+(.+)$/u);
        if (failedTestMatch) {
            const failure: FullSuiteTopFailure = {
                kind: 'unknown',
                summary: line,
                source: options.source,
                source_path: options.sourcePath,
                artifact_path: options.artifactPath,
                test_name: failedTestMatch[1].trim(),
                file_path: pendingLocation?.filePath || null,
                line: pendingLocation?.line || null
            };
            pushTopFailure(failures, options.seenKeys, failure);
            lastFailure = failure;
            pendingLocation = null;
            continue;
        }
        const kind = classifyFailureLine(line);
        if (kind === 'unknown') {
            continue;
        }
        if (lastFailure && lastFailure.kind === 'unknown') {
            lastFailure.kind = kind;
            lastFailure.summary = `${lastFailure.summary}; ${line}`;
            continue;
        }
        pushTopFailure(failures, options.seenKeys, {
            kind,
            summary: line,
            source: options.source,
            source_path: options.sourcePath,
            artifact_path: options.artifactPath,
            file_path: pendingLocation?.filePath || null,
            line: pendingLocation?.line || null
        });
        lastFailure = failures[failures.length - 1] || lastFailure;
        pendingLocation = null;
    }

    return failures;
}

function collectTopFailures(options: {
    outputLines: string[];
    outputArtifactPath: string | null;
    copiedLogs: CopiedFailureEvidenceLog[];
}): FullSuiteTopFailure[] {
    const seenKeys = new Set<string>();
    const topFailures = collectTopFailuresFromLines({
        lines: options.outputLines,
        source: 'main_output',
        sourcePath: options.outputArtifactPath,
        artifactPath: options.outputArtifactPath,
        seenKeys
    });
    for (const copiedLog of options.copiedLogs) {
        topFailures.push(...collectTopFailuresFromLines({
            lines: copiedLog.sourceLines,
            source: 'copied_log',
            sourcePath: copiedLog.copiedLog.source_path,
            artifactPath: copiedLog.copiedLog.artifact_path,
            seenKeys
        }));
    }
    const actionableFailures = topFailures.filter((failure) => (
        failure.kind !== 'process_exit'
        && (failure.kind !== 'unknown' || hasConcreteFailedTest(failure))
    ));
    return (actionableFailures.length > 0 ? actionableFailures : topFailures)
        .sort((left, right) => getTopFailurePriority(right) - getTopFailurePriority(left))
        .slice(0, DEFAULT_FAILURE_EVIDENCE_MAX_TOP_FAILURES);
}

function resolveFailureKind(topFailures: FullSuiteTopFailure[], timedOut: boolean): FullSuiteFailureKind {
    let kind: FullSuiteFailureKind = timedOut ? 'timeout' : 'unknown';
    const concreteTestFailures = topFailures.filter(hasConcreteFailedTest);
    if (concreteTestFailures.length > 0) {
        const primaryKind = concreteTestFailures[0].kind;
        return primaryKind === 'unknown' ? kind : primaryKind;
    }
    for (const failure of topFailures) {
        kind = mergeFailureKind(kind, failure.kind);
    }
    return kind;
}

function copyFailureEvidenceLog(
    sourcePath: string,
    evidenceDir: string,
    repoRoot: string,
    trustedShardLogDir: string | null,
    index: number,
    maxLogChars: number
): CopiedFailureEvidenceLog | null {
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
        ? buildTruncatedCopiedContent(redactedContent, maxLogChars)
        : redactedContent;
    const extension = path.extname(canonicalSource) || '.log';
    const artifactPath = path.join(evidenceDir, `shard-log-${String(index + 1).padStart(2, '0')}${extension}`);
    fs.writeFileSync(artifactPath, copiedContent, 'utf8');
    return {
        copiedLog: {
            source_path: normalizePath(canonicalSource),
            artifact_path: normalizePath(artifactPath),
            sha256: createHash('sha256').update(copiedContent).digest('hex'),
            bytes: Buffer.byteLength(copiedContent, 'utf8'),
            lines: copiedContent.length === 0 ? 0 : copiedContent.split(/\r?\n/u).length,
            truncated
        },
        sourceLines: redactedContent.split(/\r?\n/u)
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
    const copiedLogEvidence = Array.from(shardLogPaths.declaredPaths)
        .slice(0, maxCopiedLogs)
        .map((sourcePath, index) => copyFailureEvidenceLog(
            sourcePath,
            evidenceDir,
            options.repoRoot,
            shardLogPaths.trustedShardLogDir,
            index,
            maxLogChars
        ))
        .filter((entry): entry is CopiedFailureEvidenceLog => entry !== null);
    const copiedLogs = copiedLogEvidence.map((entry) => entry.copiedLog);
    const topFailures = collectTopFailures({
        outputLines: options.outputLines,
        outputArtifactPath: options.result.output_artifact_path,
        copiedLogs: copiedLogEvidence
    });
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
        failure_kind: resolveFailureKind(topFailures, options.result.timed_out),
        top_failures: topFailures,
        failure_chunks: redactLineChunks(options.result.failure_chunks),
        compact_summary: redactLineList(options.result.compact_summary),
        last_output_lines: redactLineList(options.outputLines.slice(-DEFAULT_FAILURE_EVIDENCE_LAST_OUTPUT_LINES)),
        shard_diagnostics: collectFailureDiagnostics(
            options.outputLines,
            { test: isNodeFoundationTestShardDiagnosticLine }
        ),
        timeout_diagnostics: collectFailureDiagnostics(options.outputLines, {
            test: (line: string) => (
                /\b(?:timed out|timeout)\b/iu.test(line)
                || lineHasNodeFoundationTestMarker(line, NODE_FOUNDATION_TEST_MARKERS.SHARD_TIMEOUT)
            )
        })
    };
    fs.writeFileSync(summaryPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    return evidence;
}

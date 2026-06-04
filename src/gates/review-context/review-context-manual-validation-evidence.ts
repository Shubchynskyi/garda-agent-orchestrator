import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
    fileSha256,
    joinOrchestratorPath,
    normalizePath,
    toStringArray
} from '../shared/helpers';

const SELECTOR_FILE_NAME = 'review-evidence.json';
const MAX_SUMMARY_LINES = 20;
const MAX_SUMMARY_LINE_CHARS = 500;
const MAX_SUMMARY_TOTAL_CHARS = 4_000;
const MAX_TAIL_LINES = 80;
const LOG_READ_CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 1024 * 1024;
const SECRET_VALUE_REDACTION = '[REDACTED_SECRET]';
const SECRET_KEY_PATTERN_SOURCE = 'api[_-]?key|access[_-]?token|auth[_-]?token|authorization|bearer[_-]?token|refresh[_-]?token|secret|password|passwd|pwd|credential|private[_-]?key';
const SECRET_LINE_PATTERNS: Array<{ pattern: RegExp; preservePrefix: boolean; suffixCaptureIndex?: number }> = [
    {
        pattern: new RegExp('((?:"|\')?(?:' + SECRET_KEY_PATTERN_SOURCE + ')(?:"|\')?\\s*:\\s*(?:"|\'))([^"\'\\\\]*(?:\\\\.[^"\'\\\\]*)*)((?:"|\'))', 'giu'),
        preservePrefix: true,
        suffixCaptureIndex: 3
    },
    {
        pattern: new RegExp('\\b((?:' + SECRET_KEY_PATTERN_SOURCE + ')\\s*[:=]\\s*)([^\\s"\'`,;]+)', 'giu'),
        preservePrefix: true
    },
    {
        pattern: new RegExp('\\b((?:--)?(?:' + SECRET_KEY_PATTERN_SOURCE + ')\\s+)([^\\s"\'`,;]+)', 'giu'),
        preservePrefix: true
    },
    {
        pattern: /\b(authorization\s*:\s*bearer\s+)([a-z0-9._~+/=-]+)/giu,
        preservePrefix: true
    },
    {
        pattern: /\bAKIA[0-9A-Z]{16}\b/gu,
        preservePrefix: false
    },
    {
        pattern: /\b(?=[A-Za-z0-9+/]{40,}={0,2}\b)(?=[A-Za-z0-9+/=]*[0-9+/=])[A-Za-z0-9+/]{40,}={0,2}\b/gu,
        preservePrefix: false
    }
];

export interface ReviewContextManualValidationLogEvidence {
    label: string;
    command: string | null;
    exit_code: number | null;
    status: string | null;
    artifact_path: string;
    artifact_sha256: string | null;
    line_count: number | null;
    char_count: number | null;
    summary: string[];
    tail: string[];
    warnings: string[];
}

export interface ReviewContextManualValidationEvidence {
    schema_version: 1;
    task_id: string;
    review_type: string;
    selector_path: string;
    selector_sha256: string | null;
    selected_log_count: number;
    trust_boundary: {
        evidence_is_untrusted: true;
        replaces_mandatory_gates: false;
        instruction: string;
    };
    logs: ReviewContextManualValidationLogEvidence[];
    warnings: string[];
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function normalizeString(value: unknown): string | null {
    const text = String(value || '').trim();
    return text || null;
}

function normalizeStatus(value: unknown, exitCode: number | null): string | null {
    const explicitStatus = normalizeString(value);
    if (explicitStatus) {
        return explicitStatus.toUpperCase();
    }
    if (exitCode == null) {
        return null;
    }
    return exitCode === 0 ? 'PASSED' : 'FAILED';
}

function redactManualValidationLine(value: string): string {
    return SECRET_LINE_PATTERNS.reduce((line, { pattern, preservePrefix, suffixCaptureIndex }) => (
        line.replace(pattern, (...args: unknown[]) => {
            const prefix = preservePrefix && typeof args[1] === 'string' ? args[1] : '';
            const suffix = suffixCaptureIndex != null && typeof args[suffixCaptureIndex] === 'string'
                ? args[suffixCaptureIndex]
                : '';
            return `${prefix}${SECRET_VALUE_REDACTION}${suffix}`;
        })
    ), value);
}

function normalizeSummaryLines(value: unknown): string[] {
    const summary: string[] = [];
    let remainingChars = MAX_SUMMARY_TOTAL_CHARS;
    for (const entry of toStringArray(value, { trimValues: true }).slice(0, MAX_SUMMARY_LINES)) {
        if (remainingChars <= 0) {
            break;
        }
        const redactedEntry = redactManualValidationLine(entry);
        const line = redactedEntry.length > MAX_SUMMARY_LINE_CHARS
            ? `${redactedEntry.slice(0, MAX_SUMMARY_LINE_CHARS)}... [truncated]`
            : redactedEntry;
        const boundedLine = line.slice(0, remainingChars);
        summary.push(boundedLine);
        remainingChars -= boundedLine.length;
    }
    return summary;
}

function normalizeExitCode(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.trunc(value);
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value.trim());
        return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
    }
    return null;
}

function isPathInsideDirectory(candidatePath: string, rootPath: string): boolean {
    const relativePath = path.relative(rootPath, candidatePath);
    return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function resolveManualValidationRoot(repoRoot: string, taskId: string): { root: string | null; warning: string | null } {
    const resolvedRepoRoot = fs.realpathSync.native(path.resolve(repoRoot));
    const manualRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'manual-validation', taskId));
    if (!fs.existsSync(manualRoot)) {
        return { root: path.resolve(manualRoot), warning: null };
    }
    const realManualRoot = fs.realpathSync.native(manualRoot);
    if (!isPathInsideDirectory(realManualRoot, resolvedRepoRoot)) {
        return {
            root: null,
            warning: `manual-validation root realpath must stay inside repo root: ${normalizePath(realManualRoot)}`
        };
    }
    return { root: realManualRoot, warning: null };
}

function resolveManualValidationSelectorPath(repoRoot: string, taskId: string): {
    selectorPath: string;
    readablePath: string | null;
    selectorSha256: string | null;
    missing: boolean;
    warnings: string[];
} {
    const selectorPath = joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'manual-validation', taskId, SELECTOR_FILE_NAME)
    );
    if (!fs.existsSync(selectorPath) || !fs.statSync(selectorPath).isFile()) {
        return {
            selectorPath,
            readablePath: null,
            selectorSha256: null,
            missing: true,
            warnings: []
        };
    }

    const manualRoot = resolveManualValidationRoot(repoRoot, taskId);
    if (manualRoot.warning || !manualRoot.root) {
        return {
            selectorPath,
            readablePath: null,
            selectorSha256: null,
            missing: false,
            warnings: [manualRoot.warning || 'manual-validation root is unavailable']
        };
    }

    const resolvedRepoRoot = fs.realpathSync.native(path.resolve(repoRoot));
    const realSelectorPath = fs.realpathSync.native(selectorPath);
    if (
        !isPathInsideDirectory(realSelectorPath, manualRoot.root)
        || !isPathInsideDirectory(realSelectorPath, resolvedRepoRoot)
    ) {
        return {
            selectorPath,
            readablePath: null,
            selectorSha256: null,
            missing: false,
            warnings: [`manual-validation selector realpath must stay inside runtime/manual-validation/${taskId}`]
        };
    }

    return {
        selectorPath,
        readablePath: realSelectorPath,
        selectorSha256: fileSha256(realSelectorPath),
        missing: false,
        warnings: []
    };
}

function resolveSelectedLogPath(repoRoot: string, taskId: string, value: unknown): { path: string | null; warning: string | null } {
    const manualRoot = resolveManualValidationRoot(repoRoot, taskId);
    if (manualRoot.warning || !manualRoot.root) {
        return { path: null, warning: manualRoot.warning || 'manual-validation root is unavailable' };
    }
    const rawPath = normalizeString(value);
    if (!rawPath) {
        return { path: null, warning: 'selected log is missing path' };
    }
    const resolvedManualRoot = manualRoot.root;
    const candidatePath = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(resolvedManualRoot, rawPath);
    if (!isPathInsideDirectory(candidatePath, resolvedManualRoot)) {
        return {
            path: normalizePath(candidatePath),
            warning: `selected log path must stay inside runtime/manual-validation/${taskId}`
        };
    }
    if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile()) {
        return { path: normalizePath(candidatePath), warning: 'selected log file is missing' };
    }
    const realCandidatePath = fs.realpathSync.native(candidatePath);
    if (!isPathInsideDirectory(realCandidatePath, resolvedManualRoot)) {
        return {
            path: normalizePath(realCandidatePath),
            warning: `selected log realpath must stay inside runtime/manual-validation/${taskId}`
        };
    }
    return { path: realCandidatePath, warning: null };
}

function readFileSha256Streaming(filePath: string): string {
    const hash = createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(LOG_READ_CHUNK_BYTES);
        let bytesRead = 0;
        do {
            bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead > 0) {
                hash.update(buffer.subarray(0, bytesRead));
            }
        } while (bytesRead > 0);
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function countFileLinesBoundedMemory(filePath: string, fileSize: number): number {
    if (fileSize === 0) {
        return 0;
    }
    const fd = fs.openSync(filePath, 'r');
    let newlineCount = 0;
    let lastByte: number | null = null;
    try {
        const buffer = Buffer.allocUnsafe(LOG_READ_CHUNK_BYTES);
        let position = 0;
        let bytesRead = 0;
        do {
            bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
            if (bytesRead > 0) {
                for (let index = 0; index < bytesRead; index += 1) {
                    if (buffer[index] === 10) {
                        newlineCount += 1;
                    }
                }
                lastByte = buffer[bytesRead - 1];
                position += bytesRead;
            }
        } while (bytesRead > 0);
    } finally {
        fs.closeSync(fd);
    }
    return newlineCount + (lastByte === 10 ? 0 : 1);
}

function readTailLinesBoundedMemory(filePath: string, fileSize: number): string[] {
    if (fileSize === 0) {
        return [];
    }
    const fd = fs.openSync(filePath, 'r');
    const chunks: Buffer[] = [];
    let collectedBytes = 0;
    let newlineCount = 0;
    try {
        let position = fileSize;
        while (position > 0 && newlineCount <= MAX_TAIL_LINES && collectedBytes < MAX_TAIL_BYTES) {
            const bytesToRead = Math.min(LOG_READ_CHUNK_BYTES, position, MAX_TAIL_BYTES - collectedBytes);
            position -= bytesToRead;
            const buffer = Buffer.allocUnsafe(bytesToRead);
            fs.readSync(fd, buffer, 0, bytesToRead, position);
            chunks.unshift(buffer);
            collectedBytes += bytesToRead;
            for (let index = 0; index < bytesToRead; index += 1) {
                if (buffer[index] === 10) {
                    newlineCount += 1;
                }
            }
        }
    } finally {
        fs.closeSync(fd);
    }
    const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/u);
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines.slice(-MAX_TAIL_LINES).map(redactManualValidationLine);
}

function readBoundedLogEvidence(filePath: string | null): {
    artifactSha256: string | null;
    lineCount: number | null;
    charCount: number | null;
    tail: string[];
} {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return {
            artifactSha256: null,
            lineCount: null,
            charCount: null,
            tail: []
        };
    }
    const stats = fs.statSync(filePath);
    return {
        artifactSha256: readFileSha256Streaming(filePath),
        lineCount: countFileLinesBoundedMemory(filePath, stats.size),
        charCount: stats.size,
        tail: readTailLinesBoundedMemory(filePath, stats.size)
    };
}

function selectedLogAppliesToReview(entry: Record<string, unknown>, reviewType: string): boolean {
    const reviewTypes = toStringArray(entry.review_types ?? entry.reviewTypes, { trimValues: true })
        .map((value) => value.toLowerCase());
    return reviewTypes.length === 0 || reviewTypes.includes(reviewType.toLowerCase());
}

function normalizeSelectedLogs(selector: Record<string, unknown>): {
    logs: Record<string, unknown>[];
    warnings: string[];
} {
    const warnings: string[] = [];
    const rawLogs = Array.isArray(selector.selected_logs)
        ? selector.selected_logs
        : Array.isArray(selector.logs)
            ? selector.logs
            : [];
    if (!Array.isArray(selector.selected_logs) && !Array.isArray(selector.logs)) {
        const selectorHasSelectedLogs = Object.prototype.hasOwnProperty.call(selector, 'selected_logs');
        const selectorHasLegacyLogs = Object.prototype.hasOwnProperty.call(selector, 'logs');
        warnings.push(selectorHasSelectedLogs || selectorHasLegacyLogs
            ? 'manual-validation selector selected_logs must be an array'
            : 'manual-validation selector selected_logs is required and must be an array');
    }
    const logs = rawLogs.flatMap((entry, index) => {
        const record = asPlainRecord(entry);
        if (!record) {
            warnings.push(`manual-validation selector selected_logs[${index}] must be an object`);
            return [];
        }
        return [record];
    });
    return { logs, warnings };
}

export function buildManualValidationEvidence(options: {
    repoRoot: string;
    taskId: string | null;
    reviewType: string;
}): ReviewContextManualValidationEvidence | null {
    if (!options.taskId) {
        return null;
    }
    const selectorResolution = resolveManualValidationSelectorPath(options.repoRoot, options.taskId);
    if (selectorResolution.missing) {
        return null;
    }

    const warnings: string[] = [...selectorResolution.warnings];
    let selector: Record<string, unknown> = {};
    if (selectorResolution.readablePath) {
        try {
            const parsedSelector = JSON.parse(fs.readFileSync(selectorResolution.readablePath, 'utf8'));
            const selectorRecord = asPlainRecord(parsedSelector);
            if (selectorRecord) {
                selector = selectorRecord;
            } else {
                warnings.push('manual-validation selector must be a JSON object');
            }
        } catch (error) {
            warnings.push(`manual-validation selector could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const selectorTaskId = normalizeString(selector.task_id);
    if (!selectorTaskId) {
        warnings.push(`manual-validation selector task_id is required and must match ${options.taskId}`);
    } else if (selectorTaskId !== options.taskId) {
        warnings.push(`manual-validation selector task_id does not match ${options.taskId}`);
    }
    const selectorTaskIdMatches = selectorTaskId === options.taskId;
    const selectedLogs = normalizeSelectedLogs(selector);
    warnings.push(...selectedLogs.warnings);

    const logs = (selectorTaskIdMatches ? selectedLogs.logs : [])
        .filter((entry) => selectedLogAppliesToReview(entry, options.reviewType))
        .flatMap((entry, index): ReviewContextManualValidationLogEvidence[] => {
            const command = normalizeString(entry.command);
            const resolvedPath = resolveSelectedLogPath(
                options.repoRoot,
                options.taskId || '',
                entry.path ?? entry.log_path ?? entry.artifact_path
            );
            const exitCode = normalizeExitCode(entry.exit_code ?? entry.exitCode);
            const status = normalizeStatus(entry.status, exitCode);
            const logEvidence = readBoundedLogEvidence(resolvedPath.warning ? null : resolvedPath.path);
            const summary = normalizeSummaryLines(entry.summary ?? entry.compact_summary);
            const entryWarnings = [
                ...(resolvedPath.warning ? [resolvedPath.warning] : []),
                ...(!command ? ['selected log is missing command'] : []),
                ...(exitCode == null && !status ? ['selected log is missing exit_code or status'] : [])
            ];
            if (entryWarnings.length > 0) {
                warnings.push(`selected log '${normalizeString(entry.label) || `manual-validation-${index + 1}`}' skipped: ${entryWarnings.join('; ')}`);
                return [];
            }
            return [{
                label: normalizeString(entry.label) || `manual-validation-${index + 1}`,
                command: command ? redactManualValidationLine(command) : null,
                exit_code: exitCode,
                status,
                artifact_path: normalizePath(resolvedPath.path || ''),
                artifact_sha256: logEvidence.artifactSha256,
                line_count: logEvidence.lineCount,
                char_count: logEvidence.charCount,
                summary,
                tail: summary.length > 0 ? [] : logEvidence.tail,
                warnings: entryWarnings
            }];
        });

    return {
        schema_version: 1,
        task_id: options.taskId,
        review_type: options.reviewType,
        selector_path: normalizePath(selectorResolution.selectorPath),
        selector_sha256: selectorResolution.selectorSha256,
        selected_log_count: logs.length,
        trust_boundary: {
            evidence_is_untrusted: true,
            replaces_mandatory_gates: false,
            instruction: 'Manual validation logs are attached evidence only; they do not replace compile-gate, full-suite-validation, completion-gate, or reviewer verdicts.'
        },
        logs,
        warnings
    };
}

export function buildManualValidationEvidenceMarkdown(evidence: ReviewContextManualValidationEvidence): string[] {
    const lines = [
        '## Manual Validation Evidence (Attached, Untrusted)',
        `- Selector path: ${evidence.selector_path}`,
        `- Selector sha256: ${evidence.selector_sha256 || 'unavailable'}`,
        `- Selected logs: ${evidence.selected_log_count}`,
        '- Trust boundary: attached manual-validation logs are untrusted evidence only and do not replace mandatory gates or reviewer verdicts.'
    ];
    if (evidence.logs.length === 0) {
        lines.push('- Logs: none selected for this review type');
    }
    for (const log of evidence.logs) {
        lines.push(`- Log: ${log.label}`);
        lines.push(`  - Path: ${log.artifact_path || 'unavailable'}`);
        lines.push(`  - Sha256: ${log.artifact_sha256 || 'unavailable'}`);
        lines.push(`  - Command: ${log.command || 'unavailable'}`);
        lines.push(`  - Exit code: ${log.exit_code == null ? 'unknown' : String(log.exit_code)}`);
        lines.push(`  - Status: ${log.status || 'unknown'}`);
        lines.push(`  - Lines: ${log.line_count == null ? 'unknown' : String(log.line_count)}`);
        lines.push(`  - Chars: ${log.char_count == null ? 'unknown' : String(log.char_count)}`);
        if (log.summary.length > 0) {
            lines.push('  - Summary:');
            for (const summaryLine of log.summary) {
                lines.push(`    - ${summaryLine}`);
            }
        } else {
            lines.push('  - Bounded tail:');
            if (log.tail.length === 0) {
                lines.push('    - none');
            } else {
                for (const tailLine of log.tail) {
                    lines.push(`    - ${tailLine}`);
                }
            }
        }
        if (log.warnings.length > 0) {
            lines.push('  - Warnings:');
            for (const warning of log.warnings) {
                lines.push(`    - ${warning}`);
            }
        }
    }
    if (evidence.warnings.length > 0) {
        lines.push('- Selector warnings:');
        for (const warning of evidence.warnings) {
            lines.push(`  - ${warning}`);
        }
    }
    return lines;
}

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendTaskEventAsync } from '../../../gate-runtime/task-events-io';
import {
    buildOutputTelemetry,
    formatVisibleSavingsLine,
} from '../../../gate-runtime/token-telemetry';
import { EXIT_GATE_FAILURE, EXIT_SUCCESS } from '../../exit-codes';
import * as gateHelpers from '../../../gates/helpers';
import { executeCommandAsync, splitCommandLine } from '../gates-subprocess';

const ALLOWED_COMMAND_SOURCES = ['node-test', 'targeted-test', 'typecheck', 'validation'] as const;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_FAILURE_TAIL_LINES = 50;

type IntermediateCommandSource = (typeof ALLOWED_COMMAND_SOURCES)[number];

export interface RunIntermediateCommandOptions {
    taskId?: unknown;
    command?: unknown;
    commandSource?: unknown;
    artifactPath?: unknown;
    outputPath?: unknown;
    timeoutMs?: unknown;
    repoRoot?: unknown;
    eventsRoot?: unknown;
}

interface IntermediateCommandArtifacts {
    artifactPath: string;
    outputPath: string;
}

interface IntermediateCommandResult {
    exitCode: number;
    outputLines: string[];
}

interface IntermediateCommandRecord {
    schema_version: 1;
    task_id: string;
    command_source: IntermediateCommandSource;
    command: string;
    status: 'PASSED' | 'FAILED';
    exit_code: number;
    duration_ms: number;
    output_artifact: string;
    output_telemetry: ReturnType<typeof buildOutputTelemetry>;
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${fieldName} is required.`);
    }
    return value.trim();
}

function normalizeOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeTimeoutMs(value: unknown): number {
    if (typeof value === 'undefined') {
        return DEFAULT_TIMEOUT_MS;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--timeout-ms must be a positive number.');
    }
    return Math.trunc(parsed);
}

function normalizeCommandSource(value: unknown): IntermediateCommandSource {
    const commandSource = normalizeRequiredString(value, '--command-source');
    if (!ALLOWED_COMMAND_SOURCES.includes(commandSource as IntermediateCommandSource)) {
        throw new Error(`--command-source must be one of: ${ALLOWED_COMMAND_SOURCES.join(', ')}.`);
    }
    return commandSource as IntermediateCommandSource;
}

function basenameLower(token: string): string {
    return path.basename(token).toLowerCase();
}

function isBareCommandToken(token: string): boolean {
    return token === path.basename(token) && !token.includes('/') && !token.includes('\\');
}

function isNpmToken(token: string): boolean {
    return isBareCommandToken(token) && ['npm', 'npm.cmd', 'npm.exe'].includes(basenameLower(token));
}

function isNodeToken(token: string): boolean {
    return isBareCommandToken(token) && ['node', 'node.exe'].includes(basenameLower(token));
}

function isAllowedIntermediateCommand(command: string, commandSource: IntermediateCommandSource): boolean {
    const tokens = splitCommandLine(command);
    if (tokens.length === 0) {
        return false;
    }
    const [binary, ...args] = tokens;
    if (commandSource === 'node-test') {
        return isNodeToken(binary) && args[0] === '--test' && args.length >= 2;
    }
    if (commandSource === 'targeted-test') {
        return isNpmToken(binary) && args[0] === 'test' && args.includes('--');
    }
    if (commandSource === 'typecheck') {
        return isNpmToken(binary) && args[0] === 'run' && args[1] === 'typecheck';
    }
    if (commandSource === 'validation') {
        return isNpmToken(binary) && args[0] === 'run' && /^validate(?::|-|$)/.test(args[1] ?? '');
    }
    return false;
}

function buildDefaultArtifacts(
    repoRoot: string,
    taskId: string,
    commandSource: IntermediateCommandSource,
    command: string,
): IntermediateCommandArtifacts {
    const commandHash = createHash('sha256').update(command).digest('hex').slice(0, 12);
    const safeSource = commandSource.replace(/[^a-z0-9-]/gi, '-');
    const baseName = `${taskId}-intermediate-command-${safeSource}-${commandHash}`;
    const artifactPath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${baseName}.json`));
    const outputPath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${baseName}.log`));
    return { artifactPath, outputPath };
}

function resolveArtifacts(
    repoRoot: string,
    taskId: string,
    commandSource: IntermediateCommandSource,
    command: string,
    artifactPathInput: unknown,
    outputPathInput: unknown,
): IntermediateCommandArtifacts {
    const defaults = buildDefaultArtifacts(repoRoot, taskId, commandSource, command);
    const artifactPath = path.resolve(repoRoot, normalizeOptionalString(artifactPathInput) ?? defaults.artifactPath);
    const outputPath = path.resolve(repoRoot, normalizeOptionalString(outputPathInput) ?? defaults.outputPath);
    return { artifactPath, outputPath };
}

function boundedTail(lines: string[]): string[] {
    if (lines.length <= DEFAULT_FAILURE_TAIL_LINES) {
        return lines;
    }
    return lines.slice(lines.length - DEFAULT_FAILURE_TAIL_LINES);
}

function formatStatusLines(
    status: 'PASSED' | 'FAILED',
    commandSource: IntermediateCommandSource,
    command: string,
    exitCode: number,
    durationMs: number,
    artifactPath: string,
    outputPath: string,
): string[] {
    return [
        `INTERMEDIATE_COMMAND_${status}`,
        `CommandSource: ${commandSource}`,
        `Command: ${command}`,
        `ExitCode: ${exitCode}`,
        `DurationMs: ${durationMs}`,
        `ArtifactPath: ${artifactPath}`,
        `OutputArtifact: ${outputPath}`,
    ];
}

function formatRejectedLines(message: string, commandSource: IntermediateCommandSource, command: string): string[] {
    return [
        'INTERMEDIATE_COMMAND_REJECTED',
        `CommandSource: ${commandSource}`,
        `Command: ${command}`,
        `Reason: ${message}`,
    ];
}

function formatTelemetryLine(telemetry: Record<string, unknown>): string {
    return [
        `raw_lines=${telemetry.raw_line_count ?? 0}`,
        `visible_lines=${telemetry.filtered_line_count ?? 0}`,
        `estimated_saved_chars=${telemetry.estimated_saved_chars ?? 0}`,
        `estimated_saved_tokens=${telemetry.estimated_saved_tokens ?? 0}`,
    ].join('; ');
}

async function persistCommandEvent(
    repoRoot: string,
    taskId: string,
    commandSource: IntermediateCommandSource,
    command: string,
    status: 'PASSED' | 'FAILED',
    record: IntermediateCommandRecord,
    artifactPath: string,
    eventsRoot?: string,
): Promise<void> {
    await appendTaskEventAsync(
        gateHelpers.joinOrchestratorPath(repoRoot, ''),
        taskId,
        'INTERMEDIATE_COMMAND_RUN',
        status,
        `Intermediate ${commandSource} command ${status.toLowerCase()}.`,
        {
            command_source: commandSource,
            command,
            artifact_path: artifactPath,
            output_artifact_path: record.output_artifact,
            output_telemetry: record.output_telemetry,
            exit_code: record.exit_code,
            duration_ms: record.duration_ms,
        },
        {
            actor: 'gate',
            eventsRoot,
        },
    );
}

export async function runIntermediateCommandCommand(
    options: RunIntermediateCommandOptions,
): Promise<IntermediateCommandResult> {
    const repoRoot = path.resolve(normalizeOptionalString(options.repoRoot) ?? process.cwd());
    const taskId = normalizeRequiredString(options.taskId, '--task-id');
    const command = normalizeRequiredString(options.command, '--command');
    const commandSource = normalizeCommandSource(options.commandSource);
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);

    if (!isAllowedIntermediateCommand(command, commandSource)) {
        const message = 'Command is not eligible for auditable intermediate compaction for the selected source.';
        return {
            exitCode: EXIT_GATE_FAILURE,
            outputLines: formatRejectedLines(message, commandSource, command),
        };
    }

    const artifacts = resolveArtifacts(
        repoRoot,
        taskId,
        commandSource,
        command,
        options.artifactPath,
        options.outputPath,
    );
    const startedAt = Date.now();
    const result = await executeCommandAsync(command, { cwd: repoRoot, timeoutMs });
    const durationMs = Date.now() - startedAt;
    const rawLines = result.outputLines;
    fs.mkdirSync(path.dirname(artifacts.outputPath), { recursive: true });
    fs.writeFileSync(artifacts.outputPath, `${rawLines.join('\n')}\n`, 'utf8');

    const status = result.exitCode === EXIT_SUCCESS ? 'PASSED' : 'FAILED';
    const statusLines = formatStatusLines(
        status,
        commandSource,
        command,
        result.exitCode,
        durationMs,
        artifacts.artifactPath,
        artifacts.outputPath,
    );
    const visibleLines = status === 'PASSED' ? statusLines : [...statusLines, ...boundedTail(rawLines)];
    const telemetry = buildOutputTelemetry(rawLines, visibleLines, {
        filterMode: 'compact_summary',
        parserName: 'intermediate-command',
        parserStrategy: status === 'PASSED' ? 'status_summary' : 'bounded_failure_tail',
    });
    const record: IntermediateCommandRecord = {
        schema_version: 1,
        task_id: taskId,
        command_source: commandSource,
        command,
        status,
        exit_code: result.exitCode,
        duration_ms: durationMs,
        output_artifact: artifacts.outputPath,
        output_telemetry: telemetry,
    };
    fs.mkdirSync(path.dirname(artifacts.artifactPath), { recursive: true });
    fs.writeFileSync(artifacts.artifactPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await persistCommandEvent(
        repoRoot,
        taskId,
        commandSource,
        command,
        status,
        record,
        artifacts.artifactPath,
        normalizeOptionalString(options.eventsRoot),
    );

    const savingsLine = formatVisibleSavingsLine(telemetry, {
        label: 'intermediate-command',
        minimumSavedChars: 0,
        minimumSavedTokens: 0,
    });
    const outputLines = [...visibleLines, `OutputTelemetry: ${formatTelemetryLine(telemetry)}`];
    return {
        exitCode: result.exitCode,
        outputLines: savingsLine ? [...outputLines, savingsLine] : outputLines,
    };
}

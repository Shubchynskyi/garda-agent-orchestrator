import * as fs from 'node:fs';
import * as path from 'node:path';
import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from '../../../core/constants';
import { emitMandatoryFullSuiteValidationEventAsync } from '../../../gate-runtime/lifecycle-events';
import * as gateHelpers from '../../../gates/helpers';
import {
    buildSkippedResult,
    buildValidationResult,
    formatFullSuiteValidationResult,
    loadFullSuiteValidationConfig,
    type FullSuiteValidationCycleBinding
} from '../../../gates/full-suite-validation';
import { executeCommand } from '../gates-subprocess';
import { EXIT_GATE_FAILURE, EXIT_GENERAL_FAILURE } from '../../exit-codes';
import {
    normalizePathValue,
    ensureDirectoryExists,
    parseRequiredText
} from '../cli-helpers';
import { requireResolvedPath } from '../shared-command-utils';

export interface FullSuiteValidationCommandOptions {
    taskId?: unknown;
    preflightPath?: unknown;
    repoRoot?: unknown;
}

export interface FullSuiteValidationCommandResult {
    outputText: string;
    exitCode: number;
}

function readLatestCompileGatePassedTimestamp(repoRoot: string, taskId: string): string | null {
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    if (!fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
        return null;
    }

    let latestTimestamp: string | null = null;
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (String(parsed.event_type || '').trim() !== 'COMPILE_GATE_PASSED') {
                continue;
            }
            const timestamp = String(parsed.timestamp_utc || '').trim();
            if (timestamp) {
                latestTimestamp = timestamp;
            }
        } catch {
            // Best-effort only; timeline integrity is validated elsewhere.
        }
    }

    return latestTimestamp;
}

export async function runFullSuiteValidationCommand(
    options: FullSuiteValidationCommandOptions
): Promise<FullSuiteValidationCommandResult> {
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    ensureDirectoryExists(repoRoot, 'Repo root');

    const taskId = parseRequiredText(options.taskId, 'TaskId');
    const preflightPath = requireResolvedPath(
        gateHelpers.resolvePathInsideRepo(String(options.preflightPath || ''), repoRoot, { allowMissing: true }),
        'PreflightPath'
    );
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        throw new Error(`Preflight artifact not found: ${gateHelpers.normalizePath(preflightPath)}`);
    }

    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const preflightTaskId = String(preflight.task_id || '').trim();
    if (preflightTaskId && preflightTaskId !== taskId) {
        throw new Error(
            `Preflight task_id '${preflightTaskId}' does not match requested task '${taskId}'.`
        );
    }

    const config = loadFullSuiteValidationConfig(repoRoot);
    const reviewsRoot = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const artifactPath = path.join(reviewsRoot, `${taskId}-full-suite-validation.json`);
    const outputArtifactPath = path.join(reviewsRoot, `${taskId}-full-suite-output.log`);
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const cycleBinding: FullSuiteValidationCycleBinding = {
        task_id: taskId,
        preflight_path: gateHelpers.normalizePath(preflightPath),
        preflight_sha256: gateHelpers.fileSha256(preflightPath) || '',
        compile_gate_timestamp: readLatestCompileGatePassedTimestamp(repoRoot, taskId)
    };

    if (!config.enabled) {
        const skippedResult = buildSkippedResult(config, cycleBinding);
        fs.writeFileSync(artifactPath, `${JSON.stringify(skippedResult, null, 2)}\n`, 'utf8');
        await emitMandatoryFullSuiteValidationEventAsync(repoRoot, taskId, skippedResult.status, {
            status: skippedResult.status,
            enabled: skippedResult.enabled,
            preflight_path: cycleBinding.preflight_path,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            cycle_binding: skippedResult.cycle_binding
        });
        return {
            outputText: `${formatFullSuiteValidationResult(skippedResult)}\n`,
            exitCode: 0
        };
    }

    if (String(config.command || '').trim() === UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND) {
        const unconfiguredResult = {
            status: 'FAILED' as const,
            enabled: true,
            command: config.command,
            exit_code: null,
            timed_out: false,
            output_artifact_path: null,
            compact_summary: ['Full-suite validation command is not configured.'],
            failure_chunks: [],
            out_of_scope_failure_policy: config.out_of_scope_failure_policy,
            out_of_scope_failure_detected: false,
            out_of_scope_audit_verdict: 'NOT_APPLICABLE' as const,
            violations: [
                'Full-suite validation command is not configured. Run agent-init to seed a project-appropriate default or set workflow-config.full_suite_validation.command explicitly.'
            ],
            warnings: [],
            cycle_binding: cycleBinding
        };
        fs.writeFileSync(artifactPath, `${JSON.stringify(unconfiguredResult, null, 2)}\n`, 'utf8');
        await emitMandatoryFullSuiteValidationEventAsync(repoRoot, taskId, unconfiguredResult.status, {
            status: unconfiguredResult.status,
            enabled: unconfiguredResult.enabled,
            command: unconfiguredResult.command,
            exit_code: unconfiguredResult.exit_code,
            timed_out: unconfiguredResult.timed_out,
            preflight_path: cycleBinding.preflight_path,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            cycle_binding: unconfiguredResult.cycle_binding,
            out_of_scope_audit_verdict: unconfiguredResult.out_of_scope_audit_verdict,
            violations: unconfiguredResult.violations,
            warnings: unconfiguredResult.warnings
        });
        return {
            outputText: `${formatFullSuiteValidationResult(unconfiguredResult)}\n`,
            exitCode: EXIT_GATE_FAILURE
        };
    }

    let commandExitCode = EXIT_GENERAL_FAILURE;
    let timedOut = false;
    let outputLines: string[] = [];
    try {
        const execution = executeCommand(config.command, {
            cwd: repoRoot,
            timeoutMs: config.timeout_ms
        });
        commandExitCode = execution.exitCode;
        timedOut = execution.timedOut;
        outputLines = execution.outputLines;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        outputLines = [message];
    }

    fs.writeFileSync(
        outputArtifactPath,
        outputLines.length > 0 ? `${outputLines.join('\n')}\n` : '',
        'utf8'
    );
    const result = buildValidationResult(
        config,
        commandExitCode,
        timedOut,
        outputLines,
        outputArtifactPath,
        changedFiles,
        cycleBinding
    );
    fs.writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await emitMandatoryFullSuiteValidationEventAsync(repoRoot, taskId, result.status, {
        status: result.status,
        enabled: result.enabled,
        command: result.command,
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        preflight_path: cycleBinding.preflight_path,
        artifact_path: gateHelpers.normalizePath(artifactPath),
        output_artifact_path: gateHelpers.normalizePath(outputArtifactPath),
        cycle_binding: result.cycle_binding,
        out_of_scope_audit_verdict: result.out_of_scope_audit_verdict,
        violations: result.violations,
        warnings: result.warnings
    });

    return {
        outputText: `${formatFullSuiteValidationResult(result)}\n`,
        exitCode: result.status === 'FAILED' ? EXIT_GATE_FAILURE : 0
    };
}

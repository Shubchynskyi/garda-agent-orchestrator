import {
    materializeFullSuiteRepairTask,
    restoreFullSuiteRepairWip
} from '../../../../gates/full-suite/full-suite-repair-task';
import {
    EXIT_GATE_FAILURE,
    EXIT_SUCCESS
} from '../../../exit-codes';
import {
    normalizePathValue,
    parseRequiredText
} from '../../cli-helpers';
import type { ParsedOptionsRecord } from '../../shared-command-utils';

export interface FullSuiteRepairTaskCommandResult {
    outputLines: string[];
    exitCode: number;
}

export function runMaterializeFullSuiteRepairTaskCommand(
    options: ParsedOptionsRecord
): FullSuiteRepairTaskCommandResult {
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    const result = materializeFullSuiteRepairTask({
        repoRoot,
        taskId: parseRequiredText(options.taskId, 'TaskId'),
        preflightPath: parseRequiredText(options.preflightPath, 'PreflightPath'),
        fullSuiteArtifactPath: String(options.fullSuiteArtifactPath || ''),
        reviewsRoot: String(options.reviewsRoot || '')
    });
    return {
        outputLines: result.output_lines,
        exitCode: result.status === 'BLOCKED' ? EXIT_GATE_FAILURE : EXIT_SUCCESS
    };
}

export function runRestoreFullSuiteRepairWipCommand(
    options: ParsedOptionsRecord
): FullSuiteRepairTaskCommandResult {
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    const result = restoreFullSuiteRepairWip({
        repoRoot,
        taskId: parseRequiredText(options.taskId, 'TaskId'),
        fullSuiteArtifactPath: parseRequiredText(options.fullSuiteArtifactPath, 'FullSuiteArtifactPath'),
        manifestPath: parseRequiredText(options.manifestPath, 'ManifestPath'),
        childTaskId: options.childTaskId ? String(options.childTaskId) : null,
        reviewsRoot: String(options.reviewsRoot || ''),
        dryRun: Boolean(options.dryRun)
    });
    return {
        outputLines: result.output_lines,
        exitCode: result.status === 'BLOCKED' ? EXIT_GATE_FAILURE : EXIT_SUCCESS
    };
}

import {
    materializeReviewFindingsFollowUpTasks
} from '../../../../gates/review/review-findings-follow-up-tasks';
import {
    EXIT_GATE_FAILURE,
    EXIT_SUCCESS
} from '../../../exit-codes';
import {
    normalizePathValue,
    parseRequiredText
} from '../../cli-helpers';
import type { ParsedOptionsRecord } from '../../shared-command-utils';

export interface ReviewFollowUpTaskCommandResult {
    outputLines: string[];
    exitCode: number;
}

export function runMaterializeReviewFollowUpTasksCommand(
    options: ParsedOptionsRecord
): ReviewFollowUpTaskCommandResult {
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    const result = materializeReviewFindingsFollowUpTasks({
        repoRoot,
        taskId: parseRequiredText(options.taskId, 'TaskId'),
        reviewType: parseRequiredText(options.reviewType, 'ReviewType'),
        dispositionArtifactPath: options.dispositionArtifactPath
            ? String(options.dispositionArtifactPath)
            : null,
        receiptPath: options.receiptPath ? String(options.receiptPath) : null,
        artifactPath: options.artifactPath ? String(options.artifactPath) : null,
        reviewsRoot: options.reviewsRoot ? String(options.reviewsRoot) : null
    });
    return {
        outputLines: result.output_lines,
        exitCode: result.status === 'BLOCKED' ? EXIT_GATE_FAILURE : EXIT_SUCCESS
    };
}

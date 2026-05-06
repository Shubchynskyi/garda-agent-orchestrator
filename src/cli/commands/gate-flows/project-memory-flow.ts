import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendMandatoryTaskEvent } from '../../../gate-runtime/task-events';
import { EXIT_GATE_FAILURE } from '../../exit-codes';
import {
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    PROJECT_MEMORY_IMPACT_BLOCKED_EVENT,
    assessProjectMemoryImpact
} from '../../../gates/project-memory-impact';
import type { ProjectMemoryMaintenanceMode } from '../../../core/workflow-config';
import { normalizePath } from '../../../gates/helpers';
import { writeJsonArtifact } from '../gates-artifacts';
import { expandValueList, parseBooleanOption } from '../gates-parser';
import { getErrorMessage, resolveOrchestratorRoot } from './gate-flow-helpers';

export interface ProjectMemoryImpactCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    preflightPath?: string;
    changedFiles?: unknown;
    confirmUpdated?: unknown;
    updatedMemoryFiles?: unknown;
    mode?: string;
    artifactPath?: string;
    updateArtifactPath?: string;
}

function formatProjectMemoryImpactOutput(input: {
    artifact: ReturnType<typeof assessProjectMemoryImpact>['artifact'];
    artifactPath: string;
    updateArtifactPath: string;
}): string[] {
    const artifact = input.artifact;
    const lines = [
        'GARDA_PROJECT_MEMORY_IMPACT',
        `Task: ${artifact.task_id}`,
        `Mode: ${artifact.mode}`,
        `Status: ${artifact.status}`,
        `UpdateNeeded: ${artifact.update_needed}`,
        `WritesAllowed: ${artifact.writes_allowed}`,
        `Artifact: ${normalizePath(input.artifactPath)}`
    ];

    if (artifact.affected_memory_files.length > 0) {
        lines.push('AffectedMemoryFiles:');
        for (const file of artifact.affected_memory_files) {
            lines.push(`  - ${file}`);
        }
    }
    if (artifact.reasons.length > 0) {
        lines.push('Reasons:');
        for (const reason of artifact.reasons) {
            lines.push(`  - ${reason.changed_file}: ${reason.reason}`);
        }
    }
    if (artifact.update_evidence.status !== 'NOT_REQUIRED') {
        lines.push(`UpdateEvidenceStatus: ${artifact.update_evidence.status}`);
        lines.push(`UpdateEvidence: ${normalizePath(input.updateArtifactPath)}`);
    }
    if (artifact.violations.length > 0) {
        lines.push('Violations:');
        for (const violation of artifact.violations) {
            lines.push(`- ${violation}`);
        }
    }
    lines.push(`Next: ${artifact.next_step}`);
    return lines;
}

export function runProjectMemoryImpactCommand(
    options: ProjectMemoryImpactCommandOptions
): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const taskId = String(options.taskId || '').trim();
    const modeOverride = options.mode
        ? String(options.mode) as ProjectMemoryMaintenanceMode
        : null;
    const changedFiles = options.changedFiles === undefined
        ? undefined
        : expandValueList(options.changedFiles, { splitDelimiters: false });
    const result = assessProjectMemoryImpact({
        repoRoot,
        taskId,
        preflightPath: options.preflightPath,
        changedFiles,
        confirmUpdated: parseBooleanOption(options.confirmUpdated, false),
        updatedMemoryFiles: expandValueList(options.updatedMemoryFiles, { splitDelimiters: false }),
        modeOverride,
        artifactPath: options.artifactPath || null,
        updateArtifactPath: options.updateArtifactPath || null
    });

    fs.mkdirSync(path.dirname(result.artifactPath), { recursive: true });
    writeJsonArtifact(result.artifactPath, result.artifact);
    if (result.updateEvidenceToWrite) {
        fs.mkdirSync(path.dirname(result.updateArtifactPath), { recursive: true });
        writeJsonArtifact(result.updateArtifactPath, result.updateEvidenceToWrite);
    }

    try {
        appendMandatoryTaskEvent(
            resolveOrchestratorRoot(repoRoot),
            result.artifact.task_id,
            result.artifact.status === 'BLOCKED' ? PROJECT_MEMORY_IMPACT_BLOCKED_EVENT : PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
            result.artifact.outcome,
            result.artifact.status === 'BLOCKED'
                ? 'Project memory impact gate blocked completion.'
                : 'Project memory impact gate assessed memory impact.',
            result.artifact
        );
    } catch (error: unknown) {
        throw new Error(`project-memory-impact failed because lifecycle event could not be appended. ${getErrorMessage(error)}`);
    }

    return {
        outputLines: formatProjectMemoryImpactOutput({
            artifact: result.artifact,
            artifactPath: result.artifactPath,
            updateArtifactPath: result.updateArtifactPath
        }),
        exitCode: result.artifact.status === 'BLOCKED' ? EXIT_GATE_FAILURE : 0
    };
}

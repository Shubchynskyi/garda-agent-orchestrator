import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendMandatoryTaskEvent } from '../../../../gate-runtime/task-events';
import { EXIT_GATE_FAILURE } from '../../../exit-codes';
import { getBundleCliCommand, getSourceCliCommand, resolveBundleNameForTarget } from '../../../../core/constants';
import { PROJECT_MEMORY_MAP_WRITE_CONTRACT } from '../../../../core/project-memory';
import {
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    PROJECT_MEMORY_IMPACT_BLOCKED_EVENT,
    assessProjectMemoryImpact
} from '../../../../gates/project-memory-impact/project-memory-impact';
import type { ProjectMemoryMaintenanceMode } from '../../../../core/workflow-config';
import { isOrchestratorSourceCheckout, normalizePath } from '../../../../gates/shared/helpers';
import { writeJsonArtifact } from '../../gates/gates-artifacts';
import { expandValueList, parseBooleanOption } from '../../gates/gates-parser';
import { getErrorMessage, resolveOrchestratorRoot } from '../compile/gate-flow-helpers';

export interface ProjectMemoryImpactCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    preflightPath?: string;
    changedFiles?: unknown;
    confirmUpdated?: unknown;
    updatedMemoryFiles?: unknown;
    skippedMemoryFiles?: unknown;
    skipUnchangedCandidatesRationale?: string;
    mode?: string;
    artifactPath?: string;
    updateArtifactPath?: string;
}

function quoteCliValue(value: string): string {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function toRepoDisplayPath(repoRoot: string, filePath: string): string {
    const resolvedRepoRoot = path.resolve(repoRoot);
    const resolvedPath = path.resolve(filePath);
    const relative = path.relative(resolvedRepoRoot, resolvedPath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return normalizePath(relative);
    }
    return normalizePath(resolvedPath);
}

function buildProjectMemoryRemediationCommand(
    repoRoot: string,
    artifact: ReturnType<typeof assessProjectMemoryImpact>['artifact']
): string | null {
    if (artifact.status !== 'BLOCKED' || artifact.affected_memory_files.length === 0) {
        return null;
    }
    const cliPrefix = isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleNameForTarget(repoRoot));
    const parts = [
        `${cliPrefix} gate project-memory-impact`,
        `--task-id ${quoteCliValue(artifact.task_id)}`,
        `--mode ${quoteCliValue(artifact.mode)}`
    ];
    if (artifact.changed_files_source === 'preflight' && artifact.preflight_path) {
        parts.push(`--preflight-path ${quoteCliValue(toRepoDisplayPath(repoRoot, artifact.preflight_path))}`);
    } else if (artifact.changed_files.length > 0) {
        for (const changedFile of artifact.changed_files) {
            parts.push(`--changed-file ${quoteCliValue(changedFile)}`);
        }
    } else if (artifact.preflight_path) {
        parts.push(`--preflight-path ${quoteCliValue(toRepoDisplayPath(repoRoot, artifact.preflight_path))}`);
    }
    parts.push('--confirm-updated');
    for (const file of artifact.update_evidence.updated_memory_files) {
        parts.push(`--updated-memory-file ${quoteCliValue(file)}`);
    }
    const updated = new Set(artifact.update_evidence.updated_memory_files);
    for (const file of artifact.affected_memory_files.filter((candidate) => !updated.has(candidate))) {
        parts.push(`--skipped-memory-file ${quoteCliValue(file)}`);
    }
    if (artifact.update_evidence.updated_memory_files.length === 0) {
        parts.push('--skip-unchanged-candidates-rationale "Current project-memory content already covers these candidate files; no durable map change is needed for this task impact."');
    } else {
        parts.push('--skip-unchanged-candidates-rationale "Unedited candidate files already cover this task impact; only the listed project-memory files changed."');
    }
    parts.push('--repo-root "."');
    return parts.join(' ');
}

function formatProjectMemoryImpactOutput(input: {
    repoRoot: string;
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
        lines.push(`MemoryWriteContract: ${PROJECT_MEMORY_MAP_WRITE_CONTRACT}`);
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
        if (artifact.update_evidence.skipped_memory_files.length > 0) {
            lines.push('SkippedCandidateMemoryFiles:');
            for (const file of artifact.update_evidence.skipped_memory_files) {
                lines.push(`  - ${file}`);
            }
        }
    }
    if (artifact.violations.length > 0) {
        lines.push('Violations:');
        for (const violation of artifact.violations) {
            lines.push(`- ${violation}`);
        }
    }
    const remediationCommand = buildProjectMemoryRemediationCommand(input.repoRoot, artifact);
    if (remediationCommand) {
        lines.push(`RemediationCommand: ${remediationCommand}`);
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
        skippedMemoryFiles: expandValueList(options.skippedMemoryFiles, { splitDelimiters: false }),
        skipUnchangedCandidatesRationale: options.skipUnchangedCandidatesRationale || null,
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
            repoRoot,
            artifact: result.artifact,
            artifactPath: result.artifactPath,
            updateArtifactPath: result.updateArtifactPath
        }),
        exitCode: result.artifact.status === 'BLOCKED' ? EXIT_GATE_FAILURE : 0
    };
}

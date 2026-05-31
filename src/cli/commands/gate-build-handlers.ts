import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseTaskMdTableRow } from '../../core/task-md-table';
import { buildScopedDiff, resolveMetadataPath, resolveOutputPath } from '../../gates/build-scoped-diff';
import {
    emitSkillSelectedEventAsync
} from '../../runtime/skill-telemetry';
import {
    computeOptionalSkillTaskTextSha256,
    getOptionalSkillSelectionArtifactViolations,
    isOptionalSkillSelectionPolicyConfigured,
    readOptionalSkillSelectionArtifact,
    readOptionalSkillSelectionPolicyConfig
} from '../../runtime/optional-skill-selection';
import * as gateHelpers from '../../gates/helpers';
import { resolveGateExecutionPath } from '../../gates/isolation-sandbox';
import {
    runClassifyChangeCommand,
    runCompileGateCommand
} from './gate-flows/compile-flow';
import {
    readTimelineEventsSummary,
    runBuildReviewContextCommand,
    type BuildReviewContextCommandOptions,
    type BuildReviewContextCommandResult
} from './gate-flows/review-context-flow';
import {
    parseOptions,
    normalizePathValue,
    ensureDirectoryExists,
    parseRequiredText
} from './cli-helpers';
import {
    buildKeyValueOutputLines,
    formatKeyValueOutput,
    GateFailureError,
    type ParsedOptionsRecord,
    requireResolvedPath
} from './shared-command-utils';

export type { BuildReviewContextCommandOptions, BuildReviewContextCommandResult };
export { runBuildReviewContextCommand, readTimelineEventsSummary };

export async function handleClassifyChange(gateArgv: string[]): Promise<void> {
    const defs = {
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--changed-file': { key: 'changedFiles', type: 'string[]' },
        '--changed-files': { key: 'changedFiles', type: 'string[]' },
        '--use-staged': { key: 'useStaged', type: 'boolean' },
        '--include-untracked': { key: 'includeUntracked', type: 'boolean' },
        '--task-id': { key: 'taskId', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--rule-pack-path': { key: 'rulePackPath', type: 'string' },
        '--task-intent': { key: 'taskIntent', type: 'string' },
        '--fast-path-max-files': { key: 'fastPathMaxFiles', type: 'string' },
        '--fast-path-max-changed-lines': { key: 'fastPathMaxChangedLines', type: 'string' },
        '--performance-heuristic-min-lines': { key: 'performanceHeuristicMinLines', type: 'string' },
        '--force-all-domain-reviews': { key: 'forceAllDomainReviews', type: 'boolean' },
        '--force-code-review': { key: 'forceCodeReview', type: 'boolean' },
        '--output-path': { key: 'outputPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runClassifyChangeCommand(options);
    process.stdout.write(result.outputText);
}

export async function handleCompileGate(gateArgv: string[]): Promise<void> {
    const defs = {
        '--commands-path': { key: 'commandsPath', type: 'string' },
        '--task-id': { key: 'taskId', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--rule-pack-path': { key: 'rulePackPath', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--compile-evidence-path': { key: 'compileEvidencePath', type: 'string' },
        '--compile-output-path': { key: 'compileOutputPath', type: 'string' },
        '--fail-tail-lines': { key: 'failTailLines', type: 'string' },
        '--output-filters-path': { key: 'outputFiltersPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--allow-plan-drift': { key: 'allowPlanDrift', type: 'boolean' },
        '--allow-plan-drift-reason': { key: 'allowPlanDriftReason', type: 'string' },
        '--allow-full-test-compile-command': { key: 'allowFullTestCompileCommand', type: 'boolean' },
        '--allow-full-test-compile-command-reason': { key: 'allowFullTestCompileCommandReason', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = await runCompileGateCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleBuildScopedDiff(gateArgv: string[]): Promise<void> {
    const defs = {
        '--review-type': { key: 'reviewType', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--paths-config-path': { key: 'pathsConfigPath', type: 'string' },
        '--output-path': { key: 'outputPath', type: 'string' },
        '--metadata-path': { key: 'metadataPath', type: 'string' },
        '--full-diff-path': { key: 'fullDiffPath', type: 'string' },
        '--use-staged': { key: 'useStaged', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--hunk-level': { key: 'hunkLevel', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs);
    const options = rawOptions as ParsedOptionsRecord;
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    ensureDirectoryExists(repoRoot, 'Repo root');
    const reviewType = parseRequiredText(options.reviewType, 'ReviewType');
    const preflightPath = requireResolvedPath(
        gateHelpers.resolvePathInsideRepo(parseRequiredText(options.preflightPath, 'PreflightPath'), repoRoot),
        'PreflightPath'
    );
    const pathsConfigPath = options.pathsConfigPath
        ? requireResolvedPath(gateHelpers.resolvePathInsideRepo(String(options.pathsConfigPath), repoRoot), 'PathsConfigPath')
        : resolveGateExecutionPath(repoRoot, path.join('live', 'config', 'paths.json'));
    const outputPath = resolveOutputPath(String(options.outputPath || ''), preflightPath, reviewType, repoRoot);
    const metadataPath = resolveMetadataPath(String(options.metadataPath || ''), preflightPath, reviewType, repoRoot);
    const fullDiffPath = options.fullDiffPath
        ? gateHelpers.resolvePathInsideRepo(String(options.fullDiffPath), repoRoot)
        : null;
    const useStaged = Object.prototype.hasOwnProperty.call(options, 'useStaged')
        ? options.useStaged === true
        : undefined;
    const result = buildScopedDiff({
        reviewType,
        preflightPath,
        pathsConfigPath,
        outputPath,
        metadataPath,
        fullDiffPath,
        repoRoot,
        useStaged,
        hunkLevel: options.hunkLevel === true
    });
    const outputKV: Record<string, unknown> = {
        outputPath: result.output_path,
        metadataPath: result.metadata_path,
        matchedFilesCount: result.matched_files_count,
        fallbackToFullDiff: result.fallback_to_full_diff,
        hunkLevel: result.hunk_level
    };
    const orderedKeys = ['outputPath', 'metadataPath', 'matchedFilesCount', 'fallbackToFullDiff', 'hunkLevel'];
    if (result.hunk_filter) {
        const hf = result.hunk_filter as Record<string, unknown>;
        outputKV.hunkFiltered = hf.hunk_level_filtered;
        outputKV.totalHunks = hf.total_hunks;
        outputKV.includedHunks = hf.included_hunks;
        orderedKeys.push('hunkFiltered', 'totalHunks', 'includedHunks');
    }
    formatKeyValueOutput(outputKV, orderedKeys);
}

export async function handleBuildReviewContext(gateArgv: string[]): Promise<void> {
    const defs = {
        '--review-type': { key: 'reviewType', type: 'string' },
        '--depth': { key: 'depth', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--token-economy-config-path': { key: 'tokenEconomyConfigPath', type: 'string' },
        '--scoped-diff-metadata-path': { key: 'scopedDiffMetadataPath', type: 'string' },
        '--output-path': { key: 'outputPath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs);
    const result = await runBuildReviewContextCommand(rawOptions as BuildReviewContextCommandOptions);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
}

async function runActivateOptionalSkillCommand(options: ParsedOptionsRecord) {
    const taskId = parseRequiredText(options.taskId, 'TaskId');
    const skillId = parseRequiredText(options.skillId, 'SkillId');
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    ensureDirectoryExists(repoRoot, 'RepoRoot');
    const orchestratorRoot = gateHelpers.joinOrchestratorPath(repoRoot, '');
    if (!isOptionalSkillSelectionPolicyConfigured(orchestratorRoot)) {
        throw new Error('Optional skill activation requires a repo-local optional-skill-selection policy.');
    }

    const policyConfig = readOptionalSkillSelectionPolicyConfig(orchestratorRoot);
    if (policyConfig.mode === 'off') {
        throw new Error("Optional skill activation is not allowed while policy mode is 'off'.");
    }

    const artifact = readOptionalSkillSelectionArtifact(orchestratorRoot, taskId);
    if (!artifact) {
        throw new Error(`Optional skill selection artifact is missing for task '${taskId}'. Run classify-change for the current cycle first.`);
    }

    const preflightPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-preflight.json`)
    );
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        throw new Error(`Optional skill activation requires the current preflight artifact for task '${taskId}'. Run classify-change for the current cycle first.`);
    }
    const preflightSha256 = gateHelpers.fileSha256(preflightPath);
    const taskPath = path.join(repoRoot, 'TASK.md');
    let currentTaskText: string | null = null;
    if (fs.existsSync(taskPath) && fs.statSync(taskPath).isFile()) {
        for (const line of fs.readFileSync(taskPath, 'utf8').split('\n')) {
            const cells = parseTaskMdTableRow(line);
            if (cells.length >= 5 && cells[0]?.trimmed === taskId) {
                currentTaskText = cells[4]?.trimmed || null;
                break;
            }
        }
    }

    const artifactViolations = getOptionalSkillSelectionArtifactViolations(orchestratorRoot, artifact, {
        requireMaterializedArtifact: policyConfig.mode === 'required' || policyConfig.mode === 'strict',
        expectedPreflightPath: preflightPath,
        expectedPreflightSha256: preflightSha256,
        expectedTaskTextSha256: computeOptionalSkillTaskTextSha256(String(currentTaskText || '')),
        expectedPolicyMode: policyConfig.mode
    });
    if (artifactViolations.length > 0) {
        throw new Error(artifactViolations.join(' '));
    }

    const selectedSkill = artifact.payload.selected_installed_skills.find(
        (entry) => String(entry.id || '').trim() === skillId
    );
    if (!selectedSkill) {
        throw new Error(
            `Optional skill '${skillId}' is not selected for task '${taskId}'. Use one of the current selected skill ids or proceed as_is.`
        );
    }

    const skillPath = path.isAbsolute(selectedSkill.allowed_skill_path)
        ? path.resolve(selectedSkill.allowed_skill_path)
        : path.resolve(path.dirname(orchestratorRoot), selectedSkill.allowed_skill_path);
    if (!fs.existsSync(skillPath) || !fs.statSync(skillPath).isFile()) {
        throw new Error(`Selected optional skill '${skillId}' points to a missing skill file: ${selectedSkill.allowed_skill_path}`);
    }

    await emitSkillSelectedEventAsync(
        orchestratorRoot,
        taskId,
        selectedSkill.id,
        selectedSkill.pack || null,
        'optional_skill_selection'
    );

    return {
        outputLines: buildKeyValueOutputLines(
            {
                status: 'ACTIVATED',
                taskId,
                skillId: selectedSkill.id,
                skillPath: gateHelpers.normalizePath(skillPath)
            },
            ['status', 'taskId', 'skillId', 'skillPath']
        )
    };
}

export async function handleActivateOptionalSkill(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--skill-id': { key: 'skillId', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs);
    try {
        const result = await runActivateOptionalSkillCommand(rawOptions as ParsedOptionsRecord);
        for (const line of result.outputLines) {
            console.log(line);
        }
    } catch (error: unknown) {
        throw new GateFailureError(error instanceof Error ? error.message : String(error));
    }
}

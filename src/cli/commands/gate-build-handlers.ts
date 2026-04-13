import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    buildReviewContext,
    resolveContextOutputPath,
    resolveReviewSkillId,
    resolveScopedDiffMetadataPath
} from '../../gates/build-review-context';
import { buildScopedDiff, resolveMetadataPath, resolveOutputPath } from '../../gates/build-scoped-diff';
import {
    emitReviewPhaseStartedEventAsync,
} from '../../gate-runtime/lifecycle-events';
import {
    emitSkillReferenceLoadedEventAsync,
    emitSkillSelectedEventAsync
} from '../../runtime/skill-telemetry';
import * as gateHelpers from '../../gates/helpers';
import { assertReviewLifecycleGuard } from '../../gates/review-lifecycle-guard';
import { resolveGateExecutionPath } from '../../gates/isolation-sandbox';
import {
    runClassifyChangeCommand,
    runCompileGateCommand
} from './gates';
import {
    parseOptions,
    normalizePathValue,
    ensureDirectoryExists,
    parseRequiredText
} from './cli-helpers';
import {
    formatKeyValueOutput,
    type ParsedOptionsRecord,
    requireResolvedPath
} from './shared-command-utils';

export async function handleClassifyChange(gateArgv: string[]): Promise<void> {
    const defs = {
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--changed-file': { key: 'changedFiles', type: 'string[]' },
        '--changed-files': { key: 'changedFiles', type: 'string[]' },
        '--use-staged': { key: 'useStaged', type: 'boolean' },
        '--include-untracked': { key: 'includeUntracked', type: 'boolean' },
        '--task-id': { key: 'taskId', type: 'string' },
        '--rule-pack-path': { key: 'rulePackPath', type: 'string' },
        '--task-intent': { key: 'taskIntent', type: 'string' },
        '--fast-path-max-files': { key: 'fastPathMaxFiles', type: 'string' },
        '--fast-path-max-changed-lines': { key: 'fastPathMaxChangedLines', type: 'string' },
        '--performance-heuristic-min-lines': { key: 'performanceHeuristicMinLines', type: 'string' },
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
    const result = buildScopedDiff({
        reviewType,
        preflightPath,
        pathsConfigPath,
        outputPath,
        metadataPath,
        fullDiffPath,
        repoRoot,
        useStaged: options.useStaged === true,
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
        '--token-economy-config-path': { key: 'tokenEconomyConfigPath', type: 'string' },
        '--scoped-diff-metadata-path': { key: 'scopedDiffMetadataPath', type: 'string' },
        '--output-path': { key: 'outputPath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs);
    const options = rawOptions as ParsedOptionsRecord;
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    ensureDirectoryExists(repoRoot, 'Repo root');
    const reviewType = parseRequiredText(options.reviewType, 'ReviewType');
    const depth = Number.parseInt(parseRequiredText(options.depth, 'Depth'), 10);
    if (!Number.isInteger(depth) || depth < 1 || depth > 3) {
        throw new Error('Depth must be an integer between 1 and 3.');
    }
    const preflightPath = requireResolvedPath(
        gateHelpers.resolvePathInsideRepo(parseRequiredText(options.preflightPath, 'PreflightPath'), repoRoot),
        'PreflightPath'
    );
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const taskId = String(preflightPayload.task_id || '').trim();
    if (taskId) {
        assertReviewLifecycleGuard(repoRoot, taskId, 'build-review-context', 'review_phase');
    }
    const tokenEconomyConfigPath = options.tokenEconomyConfigPath
        ? requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(String(options.tokenEconomyConfigPath), repoRoot, { allowMissing: true }),
            'TokenEconomyConfigPath'
        )
        : resolveGateExecutionPath(repoRoot, path.join('live', 'config', 'token-economy.json'));
    const outputPath = resolveContextOutputPath(String(options.outputPath || ''), preflightPath, reviewType, repoRoot);
    const scopedDiffMetadataPath = resolveScopedDiffMetadataPath(
        String(options.scopedDiffMetadataPath || ''),
        preflightPath,
        reviewType,
        repoRoot
    );
    const result = buildReviewContext({
        reviewType,
        depth,
        preflightPath,
        tokenEconomyConfigPath,
        scopedDiffMetadataPath,
        outputPath,
        repoRoot
    });

    try {
        if (taskId) {
            const orchestratorRoot = gateHelpers.joinOrchestratorPath(repoRoot, '');
            const skillId = resolveReviewSkillId(reviewType, repoRoot);
            const skillPath = resolveGateExecutionPath(repoRoot, path.join('live', 'skills', skillId, 'SKILL.md'));

            await emitReviewPhaseStartedEventAsync(orchestratorRoot, taskId, {
                review_type: reviewType,
                depth,
                preflight_path: gateHelpers.normalizePath(preflightPath),
                output_path: result.output_path,
                review_context_artifact_path: result.rule_context.artifact_path
            });
            await emitSkillSelectedEventAsync(orchestratorRoot, taskId, skillId, null, 'required_review');
            if (fs.existsSync(skillPath) && fs.statSync(skillPath).isFile()) {
                await emitSkillReferenceLoadedEventAsync(orchestratorRoot, taskId, gateHelpers.normalizePath(skillPath), skillId, 'review_skill');
            }
            await emitSkillReferenceLoadedEventAsync(
                orchestratorRoot,
                taskId,
                gateHelpers.normalizePath(result.rule_context.artifact_path),
                skillId,
                'review_context_artifact'
            );
        }
    } catch {
        // Keep build-review-context resilient even when telemetry cannot be emitted.
    }

    formatKeyValueOutput({
        outputPath: result.output_path,
        ruleContextArtifactPath: result.rule_context.artifact_path,
        tokenEconomyActive: result.token_economy_active
    }, ['outputPath', 'ruleContextArtifactPath', 'tokenEconomyActive']);
}

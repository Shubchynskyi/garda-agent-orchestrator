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
    emitReviewerDelegationRoutedEventAsync,
    emitReviewRecordedEventAsync
} from '../../gate-runtime/lifecycle-events';
import {
    applyReviewerRoutingMetadata,
    buildReviewReceipt,
    normalizeReviewerExecutionMode,
    restoreReviewerRoutingMetadata,
    type ReviewReceipt
} from '../../gate-runtime/review-context';
import {
    emitSkillReferenceLoadedEventAsync,
    emitSkillSelectedEventAsync
} from '../../runtime/skill-telemetry';
import { writeReviewArtifactJson } from '../../gate-runtime/review-artifacts';
import * as gateHelpers from '../../gates/helpers';
import { assertReviewLifecycleGuardFromEntries } from '../../gates/review-lifecycle-guard';
import {
    assertRequiredUpstreamReviewDependencies,
    type ReviewDependencyTimelineEvent
} from '../../gates/review-dependencies';
import { resolveGateExecutionPath } from '../../gates/isolation-sandbox';
import {
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash
} from '../../gates/review-reuse';
import {
    runClassifyChangeCommand,
    runCompileGateCommand
} from './gate-flows/compile-flow';
import {
    parseOptions,
    normalizePathValue,
    ensureDirectoryExists,
    parseRequiredText
} from './cli-helpers';
import {
    buildKeyValueOutputLines,
    formatKeyValueOutput,
    type ParsedOptionsRecord,
    requireResolvedPath
} from './shared-command-utils';

interface ReviewReuseResult {
    reused: boolean;
    receiptPath: string | null;
    reviewerExecutionMode: string | null;
    reviewerIdentity: string | null;
}

interface CompileEvidenceSummary {
    status: string | null;
    preflightPath: string | null;
    preflightHashSha256: string | null;
}

interface TimelineEventsSummaryResult {
    events: ReviewDependencyTimelineEvent[];
    hasInvalidLines: boolean;
}

function readTimelineEventsSummary(timelinePath: string): TimelineEventsSummaryResult {
    if (!fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
        return {
            events: [],
            hasInvalidLines: false
        };
    }
    const events: ReviewDependencyTimelineEvent[] = [];
    let hasInvalidLines = false;
    const lines = fs.readFileSync(timelinePath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
    for (let index = 0; index < lines.length; index += 1) {
        try {
            const parsed = JSON.parse(lines[index]) as Record<string, unknown>;
            const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                ? parsed.details as Record<string, unknown>
                : null;
            events.push({
                event_type: String(parsed.event_type || '').trim().toUpperCase(),
                sequence: index,
                details
            });
        } catch {
            hasInvalidLines = true;
        }
    }
    return {
        events,
        hasInvalidLines
    };
}

function findLatestTimelineSequence(
    events: readonly ReviewDependencyTimelineEvent[],
    predicate: (entry: ReviewDependencyTimelineEvent) => boolean
): number | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (predicate(events[index])) {
            return events[index].sequence;
        }
    }
    return null;
}

function readCompileEvidenceSummary(repoRoot: string, taskId: string): CompileEvidenceSummary {
    const compileEvidencePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-compile-gate.json`));
    if (!fs.existsSync(compileEvidencePath) || !fs.statSync(compileEvidencePath).isFile()) {
        return {
            status: null,
            preflightPath: null,
            preflightHashSha256: null
        };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(compileEvidencePath, 'utf8')) as Record<string, unknown>;
        return {
            status: String(parsed.status || '').trim() || null,
            preflightPath: gateHelpers.normalizePath(parsed.preflight_path),
            preflightHashSha256: String(parsed.preflight_hash_sha256 || '').trim().toLowerCase() || null
        };
    } catch {
        return {
            status: null,
            preflightPath: null,
            preflightHashSha256: null
        };
    }
}

async function tryReuseCodeReviewEvidence(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    reviewContextPath: string;
    previousReviewContextReuseSha256?: string | null;
}): Promise<ReviewReuseResult> {
    if (options.reviewType !== 'code') {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    const codeScopeFingerprint = computeCodeReviewScopeFingerprint(options.preflightPayload, options.repoRoot);
    if (codeScopeFingerprint.missing_non_test_files.length > 0) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }

    const reviewsRoot = path.dirname(options.preflightPath);
    const artifactPath = path.join(reviewsRoot, `${options.taskId}-${options.reviewType}.md`);
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    if (!fs.existsSync(receiptPath) || !fs.statSync(receiptPath).isFile()) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }

    let receipt: ReviewReceipt;
    try {
        receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as ReviewReceipt;
    } catch {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }

    const reviewerExecutionMode = normalizeReviewerExecutionMode(receipt.reviewer_execution_mode);
    const reviewerIdentity = String(receipt.reviewer_identity || '').trim() || null;
    const reviewerFallbackReason = String(receipt.reviewer_fallback_reason || '').trim() || null;
    const expectedContextSha256 = String(receipt.review_context_sha256 || '').trim().toLowerCase() || null;
    const expectedContextReuseSha256 = String(
        receipt.review_context_reuse_sha256 || options.previousReviewContextReuseSha256 || ''
    ).trim().toLowerCase() || null;
    const expectedCodeScopeSha256 = String(receipt.code_scope_sha256 || '').trim().toLowerCase() || null;
    if (receipt.task_id !== options.taskId || receipt.review_type !== options.reviewType) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    if (!reviewerExecutionMode || !reviewerIdentity || !expectedContextSha256) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    if (String(receipt.review_artifact_sha256 || '').trim().toLowerCase() !== String(gateHelpers.fileSha256(artifactPath) || '').trim().toLowerCase()) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    const hasCurrentCodeScope = codeScopeFingerprint.non_test_changed_files.length > 0;
    if (
        hasCurrentCodeScope
        && (!expectedCodeScopeSha256
            || expectedCodeScopeSha256 !== String(codeScopeFingerprint.code_scope_sha256 || '').trim().toLowerCase())
    ) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }

    const compileEvidence = readCompileEvidenceSummary(options.repoRoot, options.taskId);
    const currentPreflightHash = String(gateHelpers.fileSha256(options.preflightPath) || '').trim().toLowerCase() || null;
    const normalizedPreflightPath = gateHelpers.normalizePath(options.preflightPath);
    if (
        compileEvidence.status !== 'PASSED'
        || compileEvidence.preflightPath !== normalizedPreflightPath
        || compileEvidence.preflightHashSha256 !== currentPreflightHash
    ) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }

    const timelinePath = gateHelpers.joinOrchestratorPath(options.repoRoot, path.join('runtime', 'task-events', `${options.taskId}.jsonl`));
    const timelineEvents = readTimelineEventsSummary(timelinePath).events;
    const latestCompilePassSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
    );
    if (latestCompilePassSequence == null) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    const hasCurrentCycleReviewEvidence = timelineEvents.some((entry) => (
        entry.sequence > latestCompilePassSequence
        && (
            (entry.event_type === 'REVIEWER_DELEGATION_ROUTED'
                && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === options.reviewType)
            || (entry.event_type === 'REVIEW_RECORDED'
                && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === options.reviewType)
        )
    ));
    if (hasCurrentCycleReviewEvidence) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }

    const currentReviewContext = JSON.parse(fs.readFileSync(options.reviewContextPath, 'utf8')) as Record<string, unknown>;
    const currentRouting = currentReviewContext.reviewer_routing
        && typeof currentReviewContext.reviewer_routing === 'object'
        && !Array.isArray(currentReviewContext.reviewer_routing)
        ? currentReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    const currentReviewContextSha256 = String(gateHelpers.fileSha256(options.reviewContextPath) || '').trim().toLowerCase() || null;
    const contextHashMatches = !!expectedContextSha256 && expectedContextSha256 === currentReviewContextSha256;
    const contextReuseHashMatches = !!expectedContextReuseSha256
        && expectedContextReuseSha256 === String(computeReviewContextReuseHash(currentReviewContext) || '').trim().toLowerCase();
    if (!contextHashMatches && !contextReuseHashMatches) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    const routingUpdate = applyReviewerRoutingMetadata(
        options.reviewContextPath,
        {
            actualExecutionMode: reviewerExecutionMode,
            reviewerSessionId: reviewerIdentity,
            fallbackReason: reviewerFallbackReason
        }
    );
    if (!routingUpdate.updated || !routingUpdate.contextSha256) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    const previousRoutingUpdate = {
        actualExecutionMode: currentRouting?.actual_execution_mode != null
            ? String(currentRouting.actual_execution_mode).trim() || null
            : null,
        reviewerSessionId: currentRouting?.reviewer_session_id != null
            ? String(currentRouting.reviewer_session_id).trim() || null
            : null,
        fallbackReason: currentRouting?.fallback_reason != null
            ? String(currentRouting.fallback_reason).trim() || null
            : null
    };
    const receiptRollbackState = fs.existsSync(receiptPath) && fs.statSync(receiptPath).isFile()
        ? {
            existed: true,
            content: fs.readFileSync(receiptPath, 'utf8')
        }
        : {
            existed: false,
            content: null as string | null
        };
    const refreshedReceipt = buildReviewReceipt({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256: currentPreflightHash,
        scopeSha256: String((options.preflightPayload.metrics as Record<string, unknown> | undefined)?.changed_files_sha256 || '').trim() || null,
        codeScopeSha256: String(codeScopeFingerprint.code_scope_sha256 || '').trim().toLowerCase() || null,
        reviewContextSha256: routingUpdate.contextSha256,
        reviewContextReuseSha256: String(computeReviewContextReuseHash(JSON.parse(fs.readFileSync(options.reviewContextPath, 'utf8')) as Record<string, unknown>) || '').trim().toLowerCase() || null,
        reviewArtifactSha256: String(gateHelpers.fileSha256(artifactPath) || '').trim().toLowerCase() || null,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason,
        trustLevel: String(receipt.trust_level || '').trim() || 'LOCAL_AUDITED'
    });
    writeReviewArtifactJson(receiptPath, refreshedReceipt);

    const orchestratorRoot = gateHelpers.joinOrchestratorPath(options.repoRoot, '');
    try {
        const routedEvent = await emitReviewerDelegationRoutedEventAsync(
            orchestratorRoot,
            options.taskId,
            options.reviewType,
            reviewerExecutionMode,
            reviewerIdentity,
            reviewerFallbackReason
        );
        if (!routedEvent || (Array.isArray(routedEvent.warnings) && routedEvent.warnings.length > 0)) {
            throw new Error('REVIEWER_DELEGATION_ROUTED telemetry could not be persisted for review reuse.');
        }
        const recordedEvent = await emitReviewRecordedEventAsync(orchestratorRoot, options.taskId, options.reviewType, {
            ...refreshedReceipt,
            reused_existing_review: true,
            receipt_path: gateHelpers.normalizePath(receiptPath),
            review_artifact_path: gateHelpers.normalizePath(artifactPath),
            review_context_path: gateHelpers.normalizePath(options.reviewContextPath),
            review_context_sha256: routingUpdate.contextSha256
        });
        if (!recordedEvent || (Array.isArray(recordedEvent.warnings) && recordedEvent.warnings.length > 0)) {
            throw new Error('REVIEW_RECORDED telemetry could not be persisted for review reuse.');
        }
    } catch {
        try {
            restoreReviewerRoutingMetadata(options.reviewContextPath, previousRoutingUpdate);
        } catch {
            // Best-effort rollback only.
        }
        try {
            if (receiptRollbackState.existed) {
                fs.writeFileSync(receiptPath, String(receiptRollbackState.content || ''), 'utf8');
            } else if (fs.existsSync(receiptPath)) {
                fs.rmSync(receiptPath, { force: true });
            }
        } catch {
            // Best-effort rollback only.
        }
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    return {
        reused: true,
        receiptPath: gateHelpers.normalizePath(receiptPath),
        reviewerExecutionMode,
        reviewerIdentity
    };
}

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

export interface BuildReviewContextCommandResult {
    reviewType: string;
    outputPath: string;
    ruleContextArtifactPath: string;
    tokenEconomyActive: boolean;
    reusedReviewEvidence: boolean;
    reusedReceiptPath: string | null;
    reusedReviewerExecutionMode: string | null;
    reusedReviewerIdentity: string | null;
    outputLines: string[];
}

export interface BuildReviewContextCommandOptions {
    reviewType?: unknown;
    depth?: unknown;
    preflightPath?: unknown;
    taskModePath?: unknown;
    tokenEconomyConfigPath?: unknown;
    scopedDiffMetadataPath?: unknown;
    outputPath?: unknown;
    repoRoot?: unknown;
}

export async function runBuildReviewContextCommand(
    options: BuildReviewContextCommandOptions
): Promise<BuildReviewContextCommandResult> {
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
        const timelinePath = gateHelpers.joinOrchestratorPath(
            repoRoot,
            path.join('runtime', 'task-events', `${taskId}.jsonl`)
        );
        const timelineSummary = readTimelineEventsSummary(timelinePath);
        assertReviewLifecycleGuardFromEntries(
            timelinePath,
            timelineSummary.events,
            timelineSummary.hasInvalidLines,
            'build-review-context',
            'review_phase'
        );
        assertRequiredUpstreamReviewDependencies({
            taskId,
            preflightPath,
            preflightPayload,
            reviewType,
            timelineEvents: timelineSummary.events,
            taskModePath: String(options.taskModePath || '').trim()
        });
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
    let previousReviewContextReuseSha256: string | null = null;
    if (reviewType === 'code' && fs.existsSync(outputPath) && fs.statSync(outputPath).isFile()) {
        try {
            previousReviewContextReuseSha256 = computeReviewContextReuseHash(
                JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, unknown>
            );
        } catch {
            previousReviewContextReuseSha256 = null;
        }
    }
    const result = buildReviewContext({
        reviewType,
        depth,
        preflightPath,
        preflightPayload,
        taskModePath: String(options.taskModePath || '').trim() || null,
        tokenEconomyConfigPath,
        scopedDiffMetadataPath,
        outputPath,
        repoRoot
    });
    let reviewReuseResult: ReviewReuseResult = {
        reused: false,
        receiptPath: null,
        reviewerExecutionMode: null,
        reviewerIdentity: null
    };

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
            reviewReuseResult = await tryReuseCodeReviewEvidence({
                repoRoot,
                taskId,
                reviewType,
                preflightPath,
                preflightPayload,
                reviewContextPath: outputPath,
                previousReviewContextReuseSha256
            });
        }
    } catch {
        // Keep build-review-context resilient even when telemetry cannot be emitted.
    }

    const outputKV: Record<string, unknown> = {
        outputPath: result.output_path,
        ruleContextArtifactPath: result.rule_context.artifact_path,
        tokenEconomyActive: result.token_economy_active
    };
    const orderedKeys = ['outputPath', 'ruleContextArtifactPath', 'tokenEconomyActive'];
    if (reviewReuseResult.reused) {
        outputKV.reusedReviewEvidence = true;
        outputKV.reusedReceiptPath = reviewReuseResult.receiptPath;
        outputKV.reusedReviewerExecutionMode = reviewReuseResult.reviewerExecutionMode;
        outputKV.reusedReviewerIdentity = reviewReuseResult.reviewerIdentity;
        orderedKeys.push('reusedReviewEvidence', 'reusedReceiptPath', 'reusedReviewerExecutionMode', 'reusedReviewerIdentity');
    }
    const outputLines = buildKeyValueOutputLines(outputKV, orderedKeys);
    return {
        reviewType,
        outputPath: result.output_path,
        ruleContextArtifactPath: result.rule_context.artifact_path,
        tokenEconomyActive: result.token_economy_active,
        reusedReviewEvidence: reviewReuseResult.reused,
        reusedReceiptPath: reviewReuseResult.receiptPath,
        reusedReviewerExecutionMode: reviewReuseResult.reviewerExecutionMode,
        reusedReviewerIdentity: reviewReuseResult.reviewerIdentity,
        outputLines
    };
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

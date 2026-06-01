import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    EXIT_GATE_FAILURE,
    EXIT_GENERAL_FAILURE
} from '../../../../../../src/cli/exit-codes';
import {
    buildGateHelpText
} from '../../../../../../src/cli/commands/gate-command-help';
import {
    getNodeHumanCommitCommand
} from '../../../../../../src/materialization/command-constants';
import * as gateReviewHandlers from '../../../../../../src/cli/commands/gate-review-handlers';
import {
    runCompileGateCommand,
    runDocImpactGateCommand,
    runHumanCommitCommand,
    runLogTaskEventCommand,
    runRequiredReviewsCheckCommand,
    executeCommand,
    executeCommandAsync
} from '../../../../../../src/cli/commands/gates';
import {
    runCliMainWithHandling
} from '../../../../../../src/cli/main';
import { formatCompileOutputEntry } from '../../../../../../src/cli/commands/gates-formatter';
import { runCompletionGate } from '../../../../../../src/gates/completion';
import { buildReviewContext } from '../../../../../../src/gates/review-context/build-review-context';
import { getWorkspaceSnapshot } from '../../../../../../src/gates/compile/compile-gate';
import { buildReviewTreeState } from '../../../../../../src/gates/review/review-tree-state';
import {
    applyReviewerRoutingMetadata
} from '../../../../../../src/gate-runtime/review-context';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { writeOptionalSkillSelectionArtifact } from '../../../../../../src/runtime/optional-skill-selection';
import * as childProcess from 'node:child_process';

import {
    createTempRepo,
    createWindowsBatchNodeFixture,
    createDependentValidationFixture,
    writeReviewCapabilitiesConfig,
    writeBudgetOutputFilters,
    seedTaskQueue,
    seedInitAnswers,
    writeNodeFoundationManifest,
    getReviewsRoot,
    getOrchestratorRoot,
    runEnterTaskMode,
    createReviewerRoutingFixture,
    writePreflight,
    prepareReviewDiffFixture,
    writeCompilePassEvidence,
    writeReceiptBackedReviewArtifact,
    writeCleanReviewArtifact,
    seedReusableReviewEvidence,
    loadTaskEntryRulePack,
    loadPostPreflightRulePack,
    runHandshakeForTask,
    runShellSmokeForTask,
    prepareCurrentReviewPhase,
    runExplicitPreflight,
    runGit,
    initializeGitRepo,
    readTaskTimelineEvents,
    findLastTimelineEventIndex,
    readTaskQueueStatusFromTaskFile,
    captureExpectedAsyncError,
    runCliWithCapturedOutput,
    assertGateChainDecision,
    ageFixturePath
} from '../../gate-test-helpers';

export {
    describe,
    it,
    assert,
    fs,
    os,
    path,
    createHash,
    EXIT_GATE_FAILURE,
    EXIT_GENERAL_FAILURE,
    buildGateHelpText,
    getNodeHumanCommitCommand,
    gateReviewHandlers,
    runCompileGateCommand,
    runDocImpactGateCommand,
    runHumanCommitCommand,
    runLogTaskEventCommand,
    runRequiredReviewsCheckCommand,
    executeCommand,
    executeCommandAsync,
    runCliMainWithHandling,
    formatCompileOutputEntry,
    runCompletionGate,
    buildReviewContext,
    getWorkspaceSnapshot,
    buildReviewTreeState,
    applyReviewerRoutingMetadata,
    appendTaskEvent,
    writeOptionalSkillSelectionArtifact,
    childProcess,
    createTempRepo,
    createWindowsBatchNodeFixture,
    createDependentValidationFixture,
    writeReviewCapabilitiesConfig,
    writeBudgetOutputFilters,
    seedTaskQueue,
    seedInitAnswers,
    writeNodeFoundationManifest,
    getReviewsRoot,
    getOrchestratorRoot,
    runEnterTaskMode,
    createReviewerRoutingFixture,
    writePreflight,
    prepareReviewDiffFixture,
    writeCompilePassEvidence,
    writeReceiptBackedReviewArtifact,
    writeCleanReviewArtifact,
    seedReusableReviewEvidence,
    loadTaskEntryRulePack,
    loadPostPreflightRulePack,
    runHandshakeForTask,
    runShellSmokeForTask,
    prepareCurrentReviewPhase,
    runExplicitPreflight,
    runGit,
    initializeGitRepo,
    readTaskTimelineEvents,
    findLastTimelineEventIndex,
    readTaskQueueStatusFromTaskFile,
    captureExpectedAsyncError,
    runCliWithCapturedOutput,
    assertGateChainDecision,
    ageFixturePath
};

export const TEST_REVIEW_LAUNCH_PREPARED_AT_UTC = '2026-04-28T00:00:00.000Z';
export const TEST_REVIEW_LAUNCHED_AT_UTC = '2026-04-28T00:00:01.000Z';
export const TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC = '2026-04-28T00:00:02.000Z';
export const TEST_REVIEW_INVOCATION_ATTESTED_AT_UTC = '2026-04-28T00:00:03.000Z';

export function stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function fileSha256(pathToFile: string): string {
    return createHash('sha256').update(fs.readFileSync(pathToFile)).digest('hex');
}

// Manual review-context fixtures are used only by CLI routing/receipt tests that
// do not exercise production review-context construction.
export function manualReviewContextTaskScopeFixture(repoRoot: string, taskId: string): Record<string, unknown> {
    const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
    let changedFiles = ['src/app.ts'];
    if (fs.existsSync(preflightPath) && fs.statSync(preflightPath).isFile()) {
        try {
            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            changedFiles = Array.isArray(preflight.changed_files)
                ? preflight.changed_files
                    .map((entry) => String(entry || '').replace(/\\/g, '/').trim())
                    .filter(Boolean)
                : changedFiles;
        } catch {
            // Keep the stable default fixture.
        }
    }
    return {
        changed_files: changedFiles,
        changed_file_count: changedFiles.length,
        diff: {
            available: changedFiles.length > 0,
            source: 'fixture_task_diff',
            char_count: changedFiles.length > 0 ? 120 : 0,
            truncated: false
        }
    };
}

export function manualReviewContextBindingFixture(repoRoot: string, taskId: string, reviewType: string): Record<string, unknown> {
    const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const preflightSha256 = fs.existsSync(preflightPath)
        ? createHash('sha256').update(fs.readFileSync(preflightPath)).digest('hex')
        : null;
    const treeState = manualReviewContextTreeStateFixture(repoRoot, taskId);
    return {
        ...(treeState ? { schema_version: 2, tree_state: treeState } : {}),
        task_id: taskId,
        review_type: reviewType,
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_sha256: preflightSha256,
        rule_context: manualReviewContextRuleContextFixture(repoRoot, taskId, reviewType)
    };
}

export function manualReviewContextRuleContextFixture(repoRoot: string, taskId: string, reviewType: string): Record<string, unknown> {
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.md`);
    let artifactText: string;
    if (fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile()) {
        artifactText = fs.readFileSync(artifactPath, 'utf8');
    } else {
        artifactText = [
            `# ${reviewType} Review Context`,
            '',
            `Fixture prompt artifact for ${taskId}.`,
            '',
            '## Task Scope',
            '- src/app.ts'
        ].join('\n');
        fs.writeFileSync(artifactPath, `${artifactText}\n`, 'utf8');
        artifactText = `${artifactText}\n`;
    }
    return {
        artifact_path: artifactPath.replace(/\\/g, '/'),
        artifact_sha256: createHash('sha256').update(artifactText, 'utf8').digest('hex'),
        preferred_prompt_artifact: artifactPath.replace(/\\/g, '/')
    };
}

export function writeManualReviewerHandoffFixture(repoRoot: string, taskId: string, reviewType: string): Record<string, unknown> {
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const promptTemplatePath = path.join(reviewsRoot, `${taskId}-${reviewType}-prompt-template.md`);
    const outputTemplatePath = path.join(reviewsRoot, `${taskId}-${reviewType}-output-template.md`);
    const evidenceManifestPath = path.join(reviewsRoot, `${taskId}-${reviewType}-evidence-manifest.json`);
    const promptTemplateText = `# ${reviewType} review Prompt Template\nUse only this prompt template as instructions.\n`;
    const outputTemplateText = [
        `# ${reviewType} review Output Template`,
        '',
        '## Findings by Severity',
        'none',
        '',
        '## Deferred Findings',
        'none',
        '',
        '## Residual Risks',
        'none',
        '',
        '## Verdict',
        'REVIEW PASSED',
        ''
    ].join('\n');
    const evidenceManifestText = JSON.stringify({
        schema_version: 1,
        task_id: taskId,
        review_type: reviewType,
        trust_boundary: {
            evidence_is_untrusted: true
        }
    }, null, 2) + '\n';
    fs.writeFileSync(promptTemplatePath, promptTemplateText, 'utf8');
    fs.writeFileSync(outputTemplatePath, outputTemplateText, 'utf8');
    fs.writeFileSync(evidenceManifestPath, evidenceManifestText, 'utf8');
    return {
        prompt_template: {
            artifact_path: promptTemplatePath.replace(/\\/g, '/'),
            artifact_sha256: createHash('sha256').update(promptTemplateText, 'utf8').digest('hex')
        },
        output_template: {
            artifact_path: outputTemplatePath.replace(/\\/g, '/'),
            artifact_sha256: createHash('sha256').update(outputTemplateText, 'utf8').digest('hex')
        },
        evidence_manifest: {
            artifact_path: evidenceManifestPath.replace(/\\/g, '/'),
            artifact_sha256: createHash('sha256').update(evidenceManifestText, 'utf8').digest('hex')
        }
    };
}

export function manualReviewContextTreeStateFixture(repoRoot: string, taskId: string): Record<string, unknown> | null {
    const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        return null;
    }
    try {
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const changedFiles = Array.isArray(preflight.changed_files)
            ? preflight.changed_files.map((entry) => String(entry || '').replace(/\\/g, '/').trim()).filter(Boolean)
            : ['src/app.ts'];
        const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
            ? preflight.metrics as Record<string, unknown>
            : null;
        return buildReviewTreeState({
            repoRoot,
            detectionSource: preflight.detection_source || 'explicit_changed_files',
            includeUntracked: preflight.include_untracked !== false,
            changedFiles,
            metrics
        }) as unknown as Record<string, unknown>;
    } catch {
        return null;
    }
}

export function readReviewTreeStateSha256FromContextPath(reviewContextPath: string): string | null {
    if (!fs.existsSync(reviewContextPath) || !fs.statSync(reviewContextPath).isFile()) {
        return null;
    }
    try {
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const treeState = reviewContext.tree_state && typeof reviewContext.tree_state === 'object' && !Array.isArray(reviewContext.tree_state)
            ? reviewContext.tree_state as Record<string, unknown>
            : null;
        const treeStateSha256 = String(treeState?.tree_state_sha256 || treeState?.treeStateSha256 || '').trim().toLowerCase();
        return treeStateSha256 || null;
    } catch {
        return null;
    }
}

export function reviewContextScopedDiffFixture(repoRoot: string, taskId: string, reviewType: string): Record<string, unknown> {
    return {
        expected: false,
        metadata_path: path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewType}-scoped.json`).replace(/\\/g, '/'),
        metadata: null
    };
}

export async function recordReviewRoutingViaCli(options: {
    taskId: string;
    reviewType: string;
    repoRoot: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewerFallbackReason?: string;
    reviewContextPath?: string;
}) {
    const args = [
        'gate',
        'record-review-routing',
        '--task-id', options.taskId,
        '--review-type', options.reviewType,
        '--repo-root', options.repoRoot,
        '--reviewer-execution-mode', options.reviewerExecutionMode,
        '--reviewer-identity', options.reviewerIdentity
    ];
    if (options.reviewerFallbackReason) {
        args.push('--reviewer-fallback-reason', options.reviewerFallbackReason);
    }
    await runCliMainWithHandling(args);
    if ((process.exitCode ?? 0) !== 0) {
        return;
    }
    const taskEventsPath = path.join(getOrchestratorRoot(options.repoRoot), 'runtime', 'task-events', `${options.taskId}.jsonl`);
    if (!fs.existsSync(taskEventsPath)) {
        return;
    }
    attestReviewerInvocationForTest({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewContextPath: options.reviewContextPath || path.join(
            getReviewsRoot(options.repoRoot),
            `${options.taskId}-${options.reviewType}-review-context.json`
        ),
        reviewerIdentity: options.reviewerIdentity,
        reviewerExecutionMode: options.reviewerExecutionMode
    });
}

export function attestReviewerInvocationForTest(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewContextPath: string;
    reviewerIdentity: string;
    reviewerExecutionMode?: 'delegated_subagent';
}): void {
    const reviewerExecutionMode = options.reviewerExecutionMode || 'delegated_subagent';
    const events = readTaskTimelineEvents(options.repoRoot, options.taskId);
    const routedEvent = [...events].reverse().find((event) => (
        event.event_type === 'REVIEWER_DELEGATION_ROUTED'
        && String((event.details as Record<string, unknown> | undefined)?.review_type || '').trim().toLowerCase() === options.reviewType
        && String((event.details as Record<string, unknown> | undefined)?.reviewer_session_id || '').trim() === options.reviewerIdentity
        && String((event.details as Record<string, unknown> | undefined)?.reviewer_execution_mode || '').trim() === reviewerExecutionMode
    ));
    const routedIntegrity = routedEvent?.integrity as { event_sha256?: string } | null | undefined;
    assert.ok(routedIntegrity?.event_sha256, `Missing routed reviewer integrity for ${options.taskId}/${options.reviewType}.`);
    applyReviewerRoutingMetadata(options.reviewContextPath, {
        actualExecutionMode: reviewerExecutionMode,
        reviewerSessionId: options.reviewerIdentity,
        fallbackReason: null
    });
    const crypto = require('node:crypto');
    const reviewContextSha256 = crypto.createHash('sha256')
        .update(fs.readFileSync(options.reviewContextPath))
        .digest('hex');
    const reviewTreeStateSha256 = readReviewTreeStateSha256FromContextPath(options.reviewContextPath);
    if (events.some((event) => (
        event.event_type === 'REVIEWER_INVOCATION_ATTESTED'
        && String((event.details as Record<string, unknown> | undefined)?.review_type || '').trim().toLowerCase() === options.reviewType
        && String((event.details as Record<string, unknown> | undefined)?.reviewer_session_id || '').trim() === options.reviewerIdentity
        && String((event.details as Record<string, unknown> | undefined)?.review_context_sha256 || '').trim().toLowerCase() === reviewContextSha256
        && (!reviewTreeStateSha256 || String((event.details as Record<string, unknown> | undefined)?.review_tree_state_sha256 || '').trim().toLowerCase() === reviewTreeStateSha256)
        && String((event.details as Record<string, unknown> | undefined)?.routing_event_sha256 || '').trim().toLowerCase() === String(routedIntegrity.event_sha256).trim().toLowerCase()
    ))) {
        return;
    }
    appendTaskEvent(getOrchestratorRoot(options.repoRoot), options.taskId, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', 'Reviewer invocation attested by test controller fixture.', {
        task_id: options.taskId,
        review_type: options.reviewType,
        reviewer_execution_mode: reviewerExecutionMode,
        reviewer_session_id: options.reviewerIdentity,
        reviewer_identity: options.reviewerIdentity,
        review_context_sha256: reviewContextSha256,
        review_tree_state_sha256: reviewTreeStateSha256,
        routing_event_sha256: routedIntegrity.event_sha256,
        launch_prepared_at_utc: TEST_REVIEW_LAUNCH_PREPARED_AT_UTC,
        launched_at_utc: TEST_REVIEW_LAUNCHED_AT_UTC,
        launch_completed_at_utc: TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC,
        invocation_attested_at_utc: TEST_REVIEW_INVOCATION_ATTESTED_AT_UTC
    });
}

export async function seedRoutedReviewerLaunchFixture(options: {
    repoRoot: string;
    taskId: string;
    provider?: string;
    reviewerIdentity?: string;
}) {
    const provider = options.provider || 'Antigravity';
    const reviewerIdentity = options.reviewerIdentity || 'agent:test-reviewer';
    const reviewType = 'code';
    seedTaskQueue(options.repoRoot, options.taskId);
    seedInitAnswers(options.repoRoot, provider);
    const preflightPath = writePreflight(options.repoRoot, options.taskId);
    prepareCurrentReviewPhase(options.repoRoot, options.taskId, preflightPath, provider);
    const reviewsRoot = getReviewsRoot(options.repoRoot);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const reviewerPromptPath = path.join(reviewsRoot, `${options.taskId}-${reviewType}-review-context.md`);
    const reviewerPromptContent = 'reviewer prompt payload\n';
    fs.writeFileSync(reviewerPromptPath, reviewerPromptContent, 'utf8');
    const reviewContextPath = path.join(reviewsRoot, `${options.taskId}-${reviewType}-review-context.json`);
    const reviewSnapshot = getWorkspaceSnapshot(options.repoRoot, 'explicit_changed_files', true, ['src/app.ts']);
    const reviewerHandoff = writeManualReviewerHandoffFixture(options.repoRoot, options.taskId, reviewType);
    const reviewTreeState = buildReviewTreeState({
        repoRoot: options.repoRoot,
        detectionSource: 'explicit_changed_files',
        includeUntracked: true,
        changedFiles: ['src/app.ts'],
        metrics: {
            changed_files_sha256: reviewSnapshot.changed_files_sha256,
            scope_content_sha256: reviewSnapshot.scope_content_sha256,
            scope_sha256: reviewSnapshot.scope_sha256
        }
    });
    fs.writeFileSync(reviewContextPath, JSON.stringify({
        ...manualReviewContextBindingFixture(options.repoRoot, options.taskId, reviewType),
        task_scope: manualReviewContextTaskScopeFixture(options.repoRoot, options.taskId),
        tree_state: reviewTreeState,
        scoped_diff: reviewContextScopedDiffFixture(options.repoRoot, options.taskId, reviewType),
        rule_context: {
            artifact_path: reviewerPromptPath.replace(/\\/g, '/'),
            artifact_sha256: createHash('sha256').update(reviewerPromptContent, 'utf8').digest('hex'),
            preferred_prompt_artifact: reviewerPromptPath.replace(/\\/g, '/')
        },
        reviewer_handoff: reviewerHandoff,
        reviewer_routing: createReviewerRoutingFixture(provider, {
            capability_level: 'delegation_capable'
        })
    }, null, 2) + '\n', 'utf8');

    const previousExitCode = process.exitCode;
    const previousCwd = process.cwd();
    process.exitCode = 0;
    try {
        process.chdir(options.repoRoot);
        await runCliMainWithHandling([
            'gate',
            'record-review-routing',
            '--task-id', options.taskId,
            '--review-type', reviewType,
            '--repo-root', options.repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity
        ]);
        assert.equal(process.exitCode ?? 0, 0);
    } finally {
        process.chdir(previousCwd);
        process.exitCode = previousExitCode;
    }

    const events = readTaskTimelineEvents(options.repoRoot, options.taskId);
    const routingEvent = [...events].reverse().find((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED');
    const routingIntegrity = routingEvent?.integrity as Record<string, unknown> | undefined;
    assert.ok(routingIntegrity?.event_sha256);
    const reviewContextSha256 = createHash('sha256').update(fs.readFileSync(reviewContextPath)).digest('hex');
    return {
        preflightPath,
        reviewsRoot,
        reviewType,
        reviewerIdentity,
        reviewerPromptPath,
        promptTemplatePath: String((reviewerHandoff.prompt_template as Record<string, unknown>).artifact_path),
        outputTemplatePath: String((reviewerHandoff.output_template as Record<string, unknown>).artifact_path),
        evidenceManifestPath: String((reviewerHandoff.evidence_manifest as Record<string, unknown>).artifact_path),
        reviewContextPath,
        reviewContextSha256,
        reviewTreeStateSha256: reviewTreeState.tree_state_sha256,
        routingEventSha256: String(routingIntegrity.event_sha256)
    };
}

export async function seedPromptBoundReviewFixture(options: {
    repoRoot: string;
    taskId: string;
    provider?: string;
    reviewerIdentity?: string;
}) {
    const provider = options.provider || 'Codex';
    const reviewerIdentity = options.reviewerIdentity || `agent:${options.taskId}-reviewer`;
    seedTaskQueue(options.repoRoot, options.taskId);
    seedInitAnswers(options.repoRoot, provider);
    initializeGitRepo(options.repoRoot);
    fs.writeFileSync(path.join(options.repoRoot, 'src', 'app.ts'), 'const promptBoundValue = 2;\n', 'utf8');
    const snapshot = getWorkspaceSnapshot(options.repoRoot, 'explicit_changed_files', true, ['src/app.ts']);
    const preflightPath = writePreflight(options.repoRoot, options.taskId, {
        detection_source: 'explicit_changed_files',
        scope_category: 'code',
        changed_files: ['src/app.ts'],
        metrics: {
            changed_lines_total: snapshot.changed_lines_total,
            changed_files_sha256: snapshot.changed_files_sha256,
            scope_content_sha256: snapshot.scope_content_sha256,
            scope_sha256: snapshot.scope_sha256
        },
        required_reviews: {
            code: true,
            db: false,
            security: false,
            refactor: false,
            api: false,
            test: false,
            performance: false,
            infra: false,
            dependency: false
        },
        triggers: { runtime_changed: true, runtime_code_changed: true }
    });
    prepareCurrentReviewPhase(options.repoRoot, options.taskId, preflightPath, provider);

    const reviewsRoot = getReviewsRoot(options.repoRoot);
    const reviewContextPath = path.join(reviewsRoot, `${options.taskId}-code-review-context.json`);
    buildReviewContext({
        reviewType: 'code',
        depth: 2,
        preflightPath,
        tokenEconomyConfigPath: path.join(options.repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'token-economy.json'),
        scopedDiffMetadataPath: path.join(reviewsRoot, `${options.taskId}-code-scoped.json`),
        outputPath: reviewContextPath,
        repoRoot: options.repoRoot
    });

    const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
    const ruleContext = reviewContext.rule_context as Record<string, unknown>;
    const rawReviewerPromptPath = String(ruleContext.artifact_path || ruleContext.preferred_prompt_artifact || '');
    const reviewerPromptPath = path.isAbsolute(rawReviewerPromptPath)
        ? rawReviewerPromptPath
        : path.resolve(options.repoRoot, rawReviewerPromptPath);
    const reviewerHandoff = reviewContext.reviewer_handoff as Record<string, Record<string, unknown>>;
    const promptTemplatePathValue = String(reviewerHandoff.prompt_template?.artifact_path || '');
    const outputTemplatePathValue = String(reviewerHandoff.output_template?.artifact_path || '');
    const evidenceManifestPathValue = String(reviewerHandoff.evidence_manifest?.artifact_path || '');
    const routing = await runCliWithCapturedOutput([
        'gate',
        'record-review-routing',
        '--task-id', options.taskId,
        '--review-type', 'code',
        '--repo-root', options.repoRoot,
        '--reviewer-execution-mode', 'delegated_subagent',
        '--reviewer-identity', reviewerIdentity
    ], { cwd: options.repoRoot });
    assert.equal(routing.exitCode, 0, routing.errors.join('\n'));

    return {
        preflightPath,
        reviewsRoot,
        reviewType: 'code',
        reviewerIdentity,
        reviewerPromptPath,
        promptTemplatePath: path.isAbsolute(promptTemplatePathValue) ? promptTemplatePathValue : path.resolve(options.repoRoot, promptTemplatePathValue),
        outputTemplatePath: path.isAbsolute(outputTemplatePathValue) ? outputTemplatePathValue : path.resolve(options.repoRoot, outputTemplatePathValue),
        evidenceManifestPath: path.isAbsolute(evidenceManifestPathValue) ? evidenceManifestPathValue : path.resolve(options.repoRoot, evidenceManifestPathValue),
        reviewContextPath,
        launchArtifactPath: path.join(options.repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', options.taskId, 'code', 'reviewer-launch.json')
    };
}

export async function prepareReviewerLaunchForTest(options: {
    repoRoot: string;
    taskId: string;
    reviewerIdentity: string;
    launchArtifactPath: string;
}): Promise<void> {
    const prepare = await runCliWithCapturedOutput([
        'gate',
        'prepare-reviewer-launch',
        '--task-id', options.taskId,
        '--review-type', 'code',
        '--repo-root', options.repoRoot,
        '--reviewer-execution-mode', 'delegated_subagent',
        '--reviewer-identity', options.reviewerIdentity,
        '--reviewer-launch-artifact-path', options.launchArtifactPath
    ], { cwd: options.repoRoot });
    assert.equal(prepare.exitCode, 0, prepare.errors.join('\n'));
}

export function completeReviewerLaunchArtifactForTest(launchArtifactPath: string): void {
    const preparedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(launchArtifactPath, JSON.stringify({
        ...preparedArtifact,
        evidence_type: 'delegated_reviewer_launch',
        attestation_state: 'launched',
        attestation_source: 'test_provider_controller',
        launch_tool: 'test-subagent-spawn',
        provider_invocation_id: 'test-invocation-265',
        launched_at_utc: '2026-04-28T00:00:00.000Z',
        fork_context: false
    }, null, 2) + '\n', 'utf8');
}

export function seedNodeBackendOptionalSkillFixture(repoRoot: string, policyMode: 'advisory' | 'required' | 'strict' | 'off' = 'advisory') {
    const orchestratorRoot = getOrchestratorRoot(repoRoot);
    const configDir = path.join(orchestratorRoot, 'live', 'config');
    const skillRoot = path.join(orchestratorRoot, 'live', 'skills', 'node-backend');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, 'garda.config.json'),
        JSON.stringify({
            version: 1,
            configs: {
                'optional-skill-selection-policy': 'optional-skill-selection-policy.json',
                'skill-packs': 'skill-packs.json'
            }
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(configDir, 'skill-packs.json'),
        JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(configDir, 'optional-skill-selection-policy.json'),
        JSON.stringify({ version: 1, mode: policyMode }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(skillRoot, 'skill.json'),
        JSON.stringify({
            id: 'node-backend',
            pack: 'node-backend',
            name: 'Node Backend',
            summary: 'Node backend API implementation helper.',
            tags: ['node', 'backend', 'api'],
            aliases: ['node-backend', 'node'],
            task_signals: ['request validation', 'api endpoint', 'node-backend'],
            changed_path_signals: ['src/api/', 'orders.ts'],
            references: [],
            cost_hint: 'low',
            priority: 50,
            autoload: 'suggest'
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Node Backend\n', 'utf8');
    return path.join(skillRoot, 'SKILL.md');
}


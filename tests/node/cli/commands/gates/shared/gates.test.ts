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

const TEST_REVIEW_LAUNCH_PREPARED_AT_UTC = '2026-04-28T00:00:00.000Z';
const TEST_REVIEW_LAUNCHED_AT_UTC = '2026-04-28T00:00:01.000Z';
const TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC = '2026-04-28T00:00:02.000Z';
const TEST_REVIEW_INVOCATION_ATTESTED_AT_UTC = '2026-04-28T00:00:03.000Z';

function stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function fileSha256(pathToFile: string): string {
    return createHash('sha256').update(fs.readFileSync(pathToFile)).digest('hex');
}

// Manual review-context fixtures are used only by CLI routing/receipt tests that
// do not exercise production review-context construction.
function manualReviewContextTaskScopeFixture(repoRoot: string, taskId: string): Record<string, unknown> {
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

function manualReviewContextBindingFixture(repoRoot: string, taskId: string, reviewType: string): Record<string, unknown> {
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

function manualReviewContextRuleContextFixture(repoRoot: string, taskId: string, reviewType: string): Record<string, unknown> {
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

function writeManualReviewerHandoffFixture(repoRoot: string, taskId: string, reviewType: string): Record<string, unknown> {
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

function manualReviewContextTreeStateFixture(repoRoot: string, taskId: string): Record<string, unknown> | null {
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

function readReviewTreeStateSha256FromContextPath(reviewContextPath: string): string | null {
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

function reviewContextScopedDiffFixture(repoRoot: string, taskId: string, reviewType: string): Record<string, unknown> {
    return {
        expected: false,
        metadata_path: path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewType}-scoped.json`).replace(/\\/g, '/'),
        metadata: null
    };
}

async function recordReviewRoutingViaCli(options: {
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

function attestReviewerInvocationForTest(options: {
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

async function seedRoutedReviewerLaunchFixture(options: {
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

async function seedPromptBoundReviewFixture(options: {
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

async function prepareReviewerLaunchForTest(options: {
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

function completeReviewerLaunchArtifactForTest(launchArtifactPath: string): void {
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

function seedNodeBackendOptionalSkillFixture(repoRoot: string, policyMode: 'advisory' | 'required' | 'strict' | 'off' = 'advisory') {
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

describe('cli/commands/gates', () => {
    it('activate-optional-skill records telemetry only for currently selected skills', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill-activate';
        try {
            seedTaskQueue(repoRoot, taskId);
            const taskPath = path.join(repoRoot, 'TASK.md');
            fs.writeFileSync(
                taskPath,
                fs.readFileSync(taskPath, 'utf8').replace(
                    'Update app flow',
                    'Implement request validation for a Node.js API endpoint'
                ),
                'utf8'
            );
            seedInitAnswers(repoRoot);
            const expectedSkillPath = seedNodeBackendOptionalSkillFixture(repoRoot, 'advisory');
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['src/api/orders.ts'],
                required_reviews: {}
            });
            writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
                taskText: 'Implement request validation for a Node.js API endpoint',
                changedPaths: ['src/api/orders.ts'],
                preflightPath
            });

            const result = await runCliWithCapturedOutput(
                ['gate', 'activate-optional-skill', '--task-id', taskId, '--skill-id', 'node-backend'],
                { cwd: repoRoot }
            );

            assert.equal(result.exitCode, 0);
            assert.equal(result.errors.length, 0);
            const combinedOutput = result.logs.join('\n');
            assert.ok(combinedOutput.includes('Status: ACTIVATED'));
            assert.ok(combinedOutput.includes(`SkillPath: ${expectedSkillPath.replace(/\\/g, '/')}`));

            const taskEvents = readTaskTimelineEvents(repoRoot, taskId);
            assert.ok(taskEvents.some((event) => (
                event.event_type === 'SKILL_SELECTED'
                && (event.details as Record<string, unknown> | null)?.skill_id === 'node-backend'
                && (event.details as Record<string, unknown> | null)?.trigger_reason === 'optional_skill_selection'
            )));
            assert.ok(taskEvents.every((event) => (
                event.event_type !== 'SKILL_REFERENCE_LOADED'
                || (event.details as Record<string, unknown> | null)?.trigger_reason !== 'optional_task_skill'
            )));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('activate-optional-skill rejects a stale optional-skill artifact that no longer matches the current preflight', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill-activate-stale-preflight';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            seedNodeBackendOptionalSkillFixture(repoRoot, 'advisory');
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['src/api/orders.ts'],
                required_reviews: {}
            });
            const artifact = writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
                taskText: 'Implement request validation for a Node.js API endpoint',
                changedPaths: ['src/api/orders.ts'],
                preflightPath
            });
            fs.writeFileSync(
                artifact.artifactPath,
                JSON.stringify({
                    ...artifact.payload,
                    preflight_sha256: 'stale-preflight-hash'
                }, null, 2),
                'utf8'
            );

            const result = await runCliWithCapturedOutput(
                ['gate', 'activate-optional-skill', '--task-id', taskId, '--skill-id', 'node-backend'],
                { cwd: repoRoot }
            );

            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.match(result.errors.join('\n'), /current preflight artifact hash/i);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('activate-optional-skill rejects a stale optional-skill artifact that no longer matches the current TASK.md title', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill-activate-stale-task-text';
        try {
            seedTaskQueue(repoRoot, taskId);
            const taskPath = path.join(repoRoot, 'TASK.md');
            fs.writeFileSync(
                taskPath,
                fs.readFileSync(taskPath, 'utf8').replace(
                    'Update app flow',
                    'Implement request validation for a Node.js API endpoint'
                ),
                'utf8'
            );
            seedInitAnswers(repoRoot);
            seedNodeBackendOptionalSkillFixture(repoRoot, 'advisory');
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['docs/landing.md'],
                required_reviews: {}
            });
            writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
                taskText: 'Implement request validation for a Node.js API endpoint',
                changedPaths: ['docs/landing.md'],
                preflightPath
            });
            fs.writeFileSync(
                taskPath,
                fs.readFileSync(taskPath, 'utf8').replace(
                    'Implement request validation for a Node.js API endpoint',
                    'Refresh landing-page copy for the marketing site'
                ),
                'utf8'
            );

            const result = await runCliWithCapturedOutput(
                ['gate', 'activate-optional-skill', '--task-id', taskId, '--skill-id', 'node-backend'],
                { cwd: repoRoot }
            );

            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.match(result.errors.join('\n'), /current task summary hash/i);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('applies budget tiers to review gate telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-budget';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            budget_forecast: {
                task_id: taskId,
                requested_depth: 1,
                effective_depth: 1,
                depth_escalated: false,
                path_mode: 'FULL_PATH',
                changed_files_count: 1,
                changed_lines_total: 3,
                required_reviews: ['code'],
                review_budget_estimates: [],
                total_estimated_review_tokens: 400,
                compile_gate_estimated_tokens: 300,
                total_forecast_tokens: 700,
                token_economy_enabled: true,
                token_economy_active_for_depth: true,
                forecast_savings_estimate: 200,
                effective_forecast_tokens: 500
            }
        });
        const commandsPath = path.join(repoRoot, 'commands-review-budget.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'budget ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Budget telemetry check'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const result = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-review-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(evidence.status, 'PASSED');
        assert.equal(evidence.selected_budget_tier, 'tight');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('logs terminal task events with reviewer scratch cleanup and command audit', () => {
        for (const eventType of ['TASK_DONE', 'TASK_BLOCKED'] as const) {
            const repoRoot = createTempRepo();
            const taskId = `T-904-${eventType.toLowerCase()}`;
            const activeForeignTaskId = 'T-foreign-active';
            const staleForeignTaskId = 'T-foreign-stale';
            const reviewsRoot = getReviewsRoot(repoRoot);
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const reviewTempRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews');
            const stagedReviewOutputPath = path.join(reviewTempRoot, taskId, 'code', 'review-output.md');
            const foreignReviewOutputPath = path.join(reviewTempRoot, 'scratch-output.md');
            const activeForeignReviewOutputPath = path.join(reviewTempRoot, 'session-1', activeForeignTaskId, 'code', 'review-output.md');
            const staleForeignReviewOutputPath = path.join(reviewTempRoot, `${staleForeignTaskId}-code-output.md`);
            const unattributedStaleReviewOutputPath = path.join(reviewTempRoot, 'session-42', 'review-output.md');
            fs.mkdirSync(path.dirname(stagedReviewOutputPath), { recursive: true });
            fs.mkdirSync(path.dirname(activeForeignReviewOutputPath), { recursive: true });
            fs.mkdirSync(path.dirname(unattributedStaleReviewOutputPath), { recursive: true });
            fs.writeFileSync(stagedReviewOutputPath, 'temporary reviewer output\n', 'utf8');
            fs.writeFileSync(foreignReviewOutputPath, 'leave unrelated reviewer output alone\n', 'utf8');
            fs.writeFileSync(activeForeignReviewOutputPath, 'keep active foreign reviewer output\n', 'utf8');
            fs.writeFileSync(staleForeignReviewOutputPath, 'delete stale foreign reviewer output\n', 'utf8');
            fs.writeFileSync(unattributedStaleReviewOutputPath, 'retain unattributed stale reviewer output\n', 'utf8');
            ageFixturePath(activeForeignReviewOutputPath, 25 * 60 * 60 * 1000);
            ageFixturePath(staleForeignReviewOutputPath, 25 * 60 * 60 * 1000);
            ageFixturePath(unattributedStaleReviewOutputPath, 25 * 60 * 60 * 1000);
            appendTaskEvent(getOrchestratorRoot(repoRoot), activeForeignTaskId, 'TASK_MODE_ENTERED', 'PASS', 'foreign task started', {});
            appendTaskEvent(getOrchestratorRoot(repoRoot), activeForeignTaskId, 'STATUS_CHANGED', 'INFO', 'foreign task entered review', {
                previous_status: 'IN_PROGRESS',
                new_status: 'IN_REVIEW'
            });
            fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
                '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                `| ${taskId} | IN_REVIEW | P1 | test | Current review task | unassigned | 2026-03-28 | default | fixture |`,
                `| ${activeForeignTaskId} | DONE | P1 | test | Active foreign review task with stale queue status | unassigned | 2026-03-28 | default | fixture |`,
                `| ${staleForeignTaskId} | DONE | P1 | test | Stale foreign review task | unassigned | 2026-03-28 | default | fixture |`
            ].join('\n'), 'utf8');
            const compileOutputPath = path.join(reviewsRoot, `${taskId}-compile-output.log`);
            fs.writeFileSync(compileOutputPath, 'temporary compile output\n', 'utf8');
            fs.writeFileSync(path.join(reviewsRoot, `${taskId}-compile-gate.json`), JSON.stringify({
                task_id: taskId,
                compile_output_path: `garda-agent-orchestrator/runtime/reviews/${taskId}-compile-output.log`
            }, null, 2), 'utf8');

            const result = runLogTaskEventCommand({
                repoRoot,
                taskId,
                eventType,
                outcome: eventType === 'TASK_DONE' ? 'PASS' : 'BLOCKED',
                detailsJson: JSON.stringify({
                    command: 'docker logs api',
                    command_mode: 'scan'
                })
            });

            const payload = JSON.parse(result.outputText);
            assert.equal(result.exitCode, 0);
            assert.equal(payload.status, 'TASK_EVENT_LOGGED');
            assert.equal(payload.command_policy_audit.warning_count > 0, true);
            assert.equal(payload.terminal_log_cleanup.deleted_paths.length, 1);
            assert.equal(payload.terminal_review_temp_cleanup.deleted_paths.length, 2);
            assert.equal(payload.terminal_review_temp_cleanup.stale_deleted_paths.length, 1);
            assert.deepEqual(
                payload.terminal_review_temp_cleanup.retained_paths,
                [
                    activeForeignReviewOutputPath.replace(/\\/g, '/'),
                    foreignReviewOutputPath.replace(/\\/g, '/'),
                    unattributedStaleReviewOutputPath.replace(/\\/g, '/')
                ].sort()
            );
            assert.equal(fs.existsSync(compileOutputPath), false);
            assert.equal(fs.existsSync(stagedReviewOutputPath), false);
            assert.equal(fs.existsSync(foreignReviewOutputPath), true);
            assert.equal(fs.existsSync(activeForeignReviewOutputPath), true);
            assert.equal(fs.existsSync(staleForeignReviewOutputPath), false);
            assert.equal(fs.existsSync(unattributedStaleReviewOutputPath), true);

            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects reviewer provenance events through the public log-task-event gate', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904-log-task-event-reviewer-provenance';

        for (const eventType of [
            'REVIEWER_INVOCATION_ATTESTED',
            'reviewer_invocation_attested',
            'REVIEWER_DELEGATION_ROUTED',
            'reviewer_delegation_routed'
        ]) {
            assert.throws(
                () => runLogTaskEventCommand({
                    repoRoot,
                    taskId,
                    eventType,
                    outcome: 'INFO',
                    message: 'forged reviewer invocation',
                    detailsJson: JSON.stringify({
                        review_type: 'code',
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_session_id: 'agent:forged-reviewer',
                        review_context_sha256: 'a'.repeat(64),
                        routing_event_sha256: 'b'.repeat(64)
                    })
                }),
                /reserved and cannot be emitted via log-task-event/
            );
        }

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('build-review-context blocks downstream test review until current-cycle code review is recorded', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-sequenced-test-review';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        prepareReviewDiffFixture(repoRoot, preflightPath);
        const commandsPath = path.join(repoRoot, 'commands-sequenced-review.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Block downstream test review until code review is recorded',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const blockedTestReviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context-blocked.json`);
        const blockedTestReviewContextArtifactPath = blockedTestReviewContextPath.replace(/\.json$/, '.md');
        const blockedTestScopedDiffPath = path.join(reviewsRoot, `${taskId}-test-scoped-blocked.json`);
        const testReviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        const testReviewScopedDiffPath = path.join(reviewsRoot, `${taskId}-test-scoped.json`);
        const testReviewArtifactPath = path.join(reviewsRoot, `${taskId}-test.md`);
        const testReviewReceiptPath = testReviewArtifactPath.replace(/\.md$/, '-receipt.json');
        const codeReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const blockedErrors: string[] = [];
        process.exitCode = 0;
        let blockedExitCode = 0;
        let blockedAttemptTestPhaseCount = 0;
        let blockedErrorOutput = '';
        let codeReviewBuildExitCode = 0;
        let codeReviewRecordExitCode = 0;
        let testReviewBuildExitCode = 0;
        try {
            process.chdir(repoRoot);
            console.error = (...args: unknown[]) => {
                blockedErrors.push(args.map((value) => String(value)).join(' '));
            };

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--scoped-diff-metadata-path', blockedTestScopedDiffPath,
                '--output-path', blockedTestReviewContextPath
            ]);
            blockedExitCode = Number(process.exitCode ?? 0);
            blockedAttemptTestPhaseCount = readTaskTimelineEvents(repoRoot, taskId).filter((event) => (
                event.event_type === 'REVIEW_PHASE_STARTED'
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
            )).length;
            blockedErrorOutput = blockedErrors.join('\n');

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', codeReviewContextPath
            ]);
            codeReviewBuildExitCode = Number(process.exitCode ?? 0);

            fs.writeFileSync(codeReviewOutputPath, [
            '# Review',
            '',
            'Validated `src/gates/completion.ts` and `src/cli/commands/gate-build-handlers.ts`, confirming that current-cycle upstream review evidence is present before downstream test review preparation is allowed to continue.',
            '',
            '## Validation Notes',
            'Reviewed `src/gates/completion.ts` and `src/cli/commands/gate-build-handlers.ts` for current-cycle upstream review evidence before downstream test review preparation is allowed.',
            '',
            '## Findings by Severity',
            'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n'), 'utf8');

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--review-context-path', codeReviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'code',
                reviewContextPath: codeReviewContextPath,
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', codeReviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            codeReviewRecordExitCode = Number(process.exitCode ?? 0);

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--scoped-diff-metadata-path', testReviewScopedDiffPath,
                '--output-path', testReviewContextPath
            ]);
            testReviewBuildExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(blockedExitCode !== 0, `Expected non-zero exit code, got ${blockedExitCode}`);
        assert.equal(blockedAttemptTestPhaseCount, 0);
        assert.ok(
            blockedErrorOutput.includes("ReviewType 'test' is blocked until upstream reviews pass for the current cycle: code."),
            blockedErrorOutput
        );
        assert.ok(
            blockedErrorOutput.includes('Run and record those reviews first.'),
            blockedErrorOutput
        );
        assert.ok(
            blockedErrorOutput.includes('BlockerTaxonomy: missing_upstream_pass=code'),
            blockedErrorOutput
        );
        assert.ok(
            blockedErrorOutput.includes('code: [missing_upstream_pass] no REVIEW_RECORDED evidence after the latest COMPILE_GATE_PASSED'),
            blockedErrorOutput
        );
        assert.equal(fs.existsSync(blockedTestReviewContextPath), false);
        assert.equal(fs.existsSync(blockedTestReviewContextArtifactPath), false);
        assert.equal(fs.existsSync(blockedTestScopedDiffPath), false);
        assert.equal(fs.existsSync(testReviewArtifactPath), false);
        assert.equal(fs.existsSync(testReviewReceiptPath), false);
        assert.equal(codeReviewBuildExitCode, 0);
        assert.equal(fs.existsSync(codeReviewContextPath), true);
        assert.equal(codeReviewRecordExitCode, 0);
        assert.equal(testReviewBuildExitCode, 0);
        assert.equal(fs.existsSync(testReviewContextPath), true);
        assert.equal(fs.existsSync(testReviewScopedDiffPath), false);

        const testReviewPhaseEvents = readTaskTimelineEvents(repoRoot, taskId).filter((event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
        ));
        assert.equal(testReviewPhaseEvents.length, 1);
        const allEvents = readTaskTimelineEvents(repoRoot, taskId);
        const codeReviewRecordedIndex = findLastTimelineEventIndex(allEvents, (event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        const testReviewPhaseIndex = findLastTimelineEventIndex(allEvents, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
        ));
        assert.ok(codeReviewRecordedIndex >= 0);
        assert.ok(testReviewPhaseIndex > codeReviewRecordedIndex);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('build-review-context keeps downstream test review blocked when upstream code review is not gate-eligible', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-sequenced-test-review-invalid-code';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        prepareReviewDiffFixture(repoRoot, preflightPath);
        const commandsPath = path.join(repoRoot, 'commands-sequenced-review-invalid.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Keep downstream test review blocked until upstream code review is gate-eligible',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const blockedTestReviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context-blocked.json`);
        const blockedTestReviewContextArtifactPath = blockedTestReviewContextPath.replace(/\.json$/, '.md');
        const blockedTestScopedDiffPath = path.join(reviewsRoot, `${taskId}-test-scoped-blocked.json`);
        const testReviewArtifactPath = path.join(reviewsRoot, `${taskId}-test.md`);
        const testReviewReceiptPath = testReviewArtifactPath.replace(/\.md$/, '-receipt.json');
        const codeReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const blockedErrors: string[] = [];
        process.exitCode = 0;
        let codeReviewBuildExitCode = 0;
        let codeReviewRecordExitCode = 0;
        let blockedExitCode = 0;
        let blockedAttemptTestPhaseCount = 0;
        let blockedErrorOutput = '';
        try {
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', codeReviewContextPath
            ]);
            codeReviewBuildExitCode = process.exitCode ?? 0;

            fs.writeFileSync(codeReviewOutputPath, [
                '# Review',
                '',
                'Looks good.',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n'), 'utf8');

            process.exitCode = 0;
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', codeReviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            codeReviewRecordExitCode = process.exitCode ?? 0;

            process.exitCode = 0;
            console.error = (...args: unknown[]) => {
                blockedErrors.push(args.map((value) => String(value)).join(' '));
            };
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--scoped-diff-metadata-path', blockedTestScopedDiffPath,
                '--output-path', blockedTestReviewContextPath
            ]);
            blockedExitCode = Number(process.exitCode ?? 0);
            blockedAttemptTestPhaseCount = readTaskTimelineEvents(repoRoot, taskId).filter((event) => (
                event.event_type === 'REVIEW_PHASE_STARTED'
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
            )).length;
            blockedErrorOutput = blockedErrors.join('\n');
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(codeReviewBuildExitCode, 0);
        assert.ok(codeReviewRecordExitCode !== 0, `Expected invalid upstream code review to be rejected, got ${codeReviewRecordExitCode}`);
        assert.ok(blockedExitCode !== 0, `Expected non-zero exit code, got ${blockedExitCode}`);
        assert.equal(blockedAttemptTestPhaseCount, 0);
        assert.ok(
            blockedErrorOutput.includes("ReviewType 'test' is blocked until upstream reviews pass for the current cycle: code."),
            blockedErrorOutput
        );
        assert.ok(
            blockedErrorOutput.includes('BlockerTaxonomy: missing_upstream_pass=code'),
            blockedErrorOutput
        );
        assert.ok(
            blockedErrorOutput.includes('[missing_upstream_pass] no REVIEW_RECORDED evidence after the latest COMPILE_GATE_PASSED'),
            blockedErrorOutput
        );
        assert.equal(fs.existsSync(blockedTestReviewContextPath), false);
        assert.equal(fs.existsSync(blockedTestReviewContextArtifactPath), false);
        assert.equal(fs.existsSync(blockedTestScopedDiffPath), false);
        assert.equal(fs.existsSync(testReviewArtifactPath), false);
        assert.equal(fs.existsSync(testReviewReceiptPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('build-review-context accepts upstream code review evidence recorded with an explicit custom review-context path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-custom-code-context';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        prepareReviewDiffFixture(repoRoot, preflightPath);
        const commandsPath = path.join(repoRoot, 'commands-custom-code-context.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow downstream test review after code review was recorded from a custom context path',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const customCodeReviewContextPath = path.join(reviewsRoot, 'custom-code-context.json');
        const codeReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const testReviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        const testReviewOutputPath = path.join(reviewsRoot, `${taskId}-test-review-output.md`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        let codeReviewBuildExitCode = 0;
        let codeReviewRecordExitCode = 0;
        let testReviewBuildExitCode = 0;
        let testReviewRecordExitCode = 0;
        try {
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', customCodeReviewContextPath
            ]);
            codeReviewBuildExitCode = Number(process.exitCode ?? 0);

            fs.writeFileSync(codeReviewOutputPath, [
            '# Review',
            '',
            'Validated `src/cli/commands/gate-build-handlers.ts`, `src/gates/review-dependencies.ts`, and `src/cli/commands/gate-review-handlers.ts`, confirming that current-cycle upstream review readiness now follows recorded review-context paths and that downstream sequencing is enforced consistently across both preparation and materialization gates.',
            '',
            '## Validation Notes',
            'Reviewed `src/cli/commands/gate-build-handlers.ts`, `src/gates/review-dependencies.ts`, and `src/cli/commands/gate-review-handlers.ts` for recorded custom review-context path sequencing across preparation and materialization gates.',
            '',
            '## Findings by Severity',
            'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n'), 'utf8');

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--review-context-path', customCodeReviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'code',
                reviewContextPath: customCodeReviewContextPath,
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', codeReviewOutputPath,
                '--review-context-path', customCodeReviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            codeReviewRecordExitCode = Number(process.exitCode ?? 0);

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', testReviewContextPath
            ]);
            testReviewBuildExitCode = Number(process.exitCode ?? 0);

            fs.writeFileSync(testReviewOutputPath, [
            '# Review',
            '',
            'Validated `src/cli/commands/gate-review-handlers.ts`, `src/cli/commands/gates-artifacts.ts`, and `src/gates/completion.ts`, confirming that downstream review validation now follows the recorded custom code review-context path through materialization, review-gate verification, and completion-gate consumption.',
            '',
            '## Validation Notes',
            'Reviewed `src/cli/commands/gate-review-handlers.ts`, `src/cli/commands/gates-artifacts.ts`, and `src/gates/completion.ts` for downstream validation through the recorded custom code review-context path.',
            '',
            '## Findings by Severity',
            'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'TEST REVIEW PASSED'
            ].join('\n'), 'utf8');

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'test',
                '--review-context-path', testReviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'test',
                reviewContextPath: testReviewContextPath,
                reviewerIdentity: 'agent:test-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'test',
                '--preflight-path', preflightPath,
                '--review-output-path', testReviewOutputPath,
                '--review-context-path', testReviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            testReviewRecordExitCode = Number(process.exitCode ?? 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(codeReviewBuildExitCode, 0);
        assert.equal(codeReviewRecordExitCode, 0);
        assert.equal(testReviewBuildExitCode, 0);
        assert.equal(testReviewRecordExitCode, 0);
        assert.equal(fs.existsSync(customCodeReviewContextPath), true);
        assert.equal(fs.existsSync(testReviewContextPath), true);

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            testReviewVerdict: 'TEST REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0);

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Custom review-context path is an internal gate-contract regression fixture.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});

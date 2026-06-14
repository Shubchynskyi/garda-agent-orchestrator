import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    runCliMainWithHandling
} from '../../../../../../src/cli/main';
import { buildReviewContext } from '../../../../../../src/gates/review-context/build-review-context';
import { getWorkspaceSnapshot } from '../../../../../../src/gates/compile/compile-gate';
import { buildReviewTreeState } from '../../../../../../src/gates/review/review-tree-state';
import {
    applyReviewerRoutingMetadata
} from '../../../../../../src/gate-runtime/review-context';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';

import {
    createTempRepo,
    seedTaskQueue,
    seedInitAnswers,
    getReviewsRoot,
    getOrchestratorRoot,
    createReviewerRoutingFixture,
    writePreflight,
    prepareCurrentReviewPhase,
    runGit,
    initializeGitRepo,
    readTaskTimelineEvents,
    runCliWithCapturedOutput
} from '../../gate-test-helpers';

const TEST_REVIEW_LAUNCH_PREPARED_AT_UTC = '2026-04-28T00:00:00.000Z';
const TEST_REVIEW_LAUNCHED_AT_UTC = '2026-04-28T00:00:01.000Z';
const TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC = '2026-04-28T00:00:02.000Z';
const TEST_REVIEW_INVOCATION_ATTESTED_AT_UTC = '2026-04-28T00:00:03.000Z';

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
    const rolePromptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-role-prompt.md`);
    const promptTemplatePath = path.join(reviewsRoot, `${taskId}-${reviewType}-prompt-template.md`);
    const outputTemplatePath = path.join(reviewsRoot, `${taskId}-${reviewType}-output-template.md`);
    const evidenceManifestPath = path.join(reviewsRoot, `${taskId}-${reviewType}-evidence-manifest.json`);
    const rolePromptText = `# ${reviewType} review Role Prompt\nSelected skill id: ${reviewType}-review\n`;
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
    fs.writeFileSync(rolePromptPath, rolePromptText, 'utf8');
    fs.writeFileSync(promptTemplatePath, promptTemplateText, 'utf8');
    fs.writeFileSync(outputTemplatePath, outputTemplateText, 'utf8');
    fs.writeFileSync(evidenceManifestPath, evidenceManifestText, 'utf8');
    return {
        role_prompt: {
            artifact_path: rolePromptPath.replace(/\\/g, '/'),
            artifact_sha256: createHash('sha256').update(rolePromptText, 'utf8').digest('hex'),
            selected_skill: {
                skill_id: `${reviewType}-review`,
                skill_path: rolePromptPath.replace(/\\/g, '/'),
                skill_sha256: createHash('sha256').update(rolePromptText, 'utf8').digest('hex')
            }
        },
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
        delegation_started_at_utc: TEST_REVIEW_LAUNCHED_AT_UTC,
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
    const reviewerPromptSha256 = createHash('sha256').update(fs.readFileSync(reviewerPromptPath)).digest('hex');
    return {
        preflightPath,
        reviewsRoot,
        reviewType,
        reviewerIdentity,
        reviewerPromptPath,
        reviewerPromptSha256,
        rolePromptPath: String((reviewerHandoff.role_prompt as Record<string, unknown>).artifact_path),
        promptTemplatePath: String((reviewerHandoff.prompt_template as Record<string, unknown>).artifact_path),
        outputTemplatePath: String((reviewerHandoff.output_template as Record<string, unknown>).artifact_path),
        evidenceManifestPath: String((reviewerHandoff.evidence_manifest as Record<string, unknown>).artifact_path),
        reviewContextPath,
        launchArtifactPath: path.join(options.repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', options.taskId, reviewType, 'reviewer-launch.json'),
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

async function recordReviewerDelegationStartedForTest(options: {
    repoRoot: string;
    taskId: string;
    reviewerIdentity: string;
    launchArtifactPath: string;
    providerInvocationId?: string;
    controllerInvocationId?: string;
    attestationSource?: string;
}): Promise<void> {
    const providerInvocationId = String(options.providerInvocationId || '').trim();
    const controllerInvocationId = String(options.controllerInvocationId || '').trim();
    const invocationArgs = controllerInvocationId
        ? ['--controller-invocation-id', controllerInvocationId]
        : ['--provider-invocation-id', providerInvocationId || 'test-invocation-305'];
    const started = await runCliWithCapturedOutput([
        'gate',
        'record-reviewer-delegation-started',
        '--task-id', options.taskId,
        '--review-type', 'code',
        '--repo-root', options.repoRoot,
        '--reviewer-execution-mode', 'delegated_subagent',
        '--reviewer-identity', options.reviewerIdentity,
        '--reviewer-launch-artifact-path', options.launchArtifactPath,
        ...invocationArgs,
        '--attestation-source', options.attestationSource || 'test_provider_controller',
        ...launchArtifactInputArgsForTest(options.launchArtifactPath),
        '--fork-context', 'false'
    ], { cwd: options.repoRoot });
    assert.equal(started.exitCode, 0, started.errors.join('\n'));
}

function completeReviewerLaunchArtifactForTest(launchArtifactPath: string): void {
    const preparedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
    const preparedLaunchArtifactSha256 = fileSha256ForTest(launchArtifactPath);
    const normalizedLaunchArtifactPath = launchArtifactPath.replace(/\\/g, '/');
    const orchestratorRootMarker = '/garda-agent-orchestrator/';
    const markerIndex = normalizedLaunchArtifactPath.indexOf(orchestratorRootMarker);
    assert.notEqual(markerIndex, -1, `Unexpected reviewer launch artifact path: ${normalizedLaunchArtifactPath}`);
    const repoRoot = normalizedLaunchArtifactPath.slice(0, markerIndex);
    const taskId = String(preparedArtifact.task_id || preparedArtifact.taskId || '').trim();
    const reviewType = String(preparedArtifact.review_type || preparedArtifact.reviewType || '').trim().toLowerCase();
    const reviewerExecutionMode = String(
        preparedArtifact.reviewer_execution_mode || preparedArtifact.reviewerExecutionMode || ''
    ).trim();
    const reviewerIdentity = String(
        preparedArtifact.reviewer_identity || preparedArtifact.reviewerIdentity || preparedArtifact.reviewer_session_id || ''
    ).trim();
    const reviewContextSha256 = String(preparedArtifact.review_context_sha256 || preparedArtifact.reviewContextSha256 || '').trim();
    const routingEventSha256 = String(preparedArtifact.routing_event_sha256 || preparedArtifact.routingEventSha256 || '').trim();
    const launchBindingSha256 = String(preparedArtifact.launch_binding_sha256 || preparedArtifact.launchBindingSha256 || '').trim();
    const preparedLaunchEventSha256 = String(
        preparedArtifact.prepared_launch_event_sha256 || preparedArtifact.preparedLaunchEventSha256 || ''
    ).trim();
    fs.writeFileSync(launchArtifactPath, JSON.stringify({
        ...preparedArtifact,
        evidence_type: 'delegated_reviewer_launch',
        attestation_state: 'launched',
        attestation_source: 'test_provider_controller',
        launch_tool: 'test-subagent-spawn',
        provider_invocation_id: 'test-invocation-265',
        launch_input_mode: 'launch_artifact_path',
        launch_input_artifact_path: launchArtifactPath.replace(/\\/g, '/'),
        launch_input_sha256: preparedLaunchArtifactSha256,
        launch_input_artifact_sha256: preparedLaunchArtifactSha256,
        prepared_reviewer_launch_artifact_sha256: preparedLaunchArtifactSha256,
        launch_input_copy_paste_reviewer_launch_prompt_sha256: preparedArtifact.copy_paste_reviewer_launch_prompt_sha256,
        delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
        launched_at_utc: '2026-04-28T00:00:00.000Z',
        launch_completed_at_utc: TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC,
        fork_context: false
    }, null, 2) + '\n', 'utf8');
    const completedLaunchArtifactSha256 = fileSha256ForTest(launchArtifactPath);
    appendTaskEvent(
        getOrchestratorRoot(repoRoot),
        taskId,
        'REVIEWER_DELEGATION_STARTED',
        'INFO',
        'Reviewer delegation started by test controller fixture.',
        {
            task_id: taskId,
            review_type: reviewType,
            reviewer_execution_mode: reviewerExecutionMode,
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: reviewContextSha256,
            routing_event_sha256: routingEventSha256,
            launch_binding_sha256: launchBindingSha256,
            prepared_launch_event_sha256: preparedLaunchEventSha256,
            provider_invocation_id: 'test-invocation-265',
            delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
            launched_at_utc: '2026-04-28T00:00:00.000Z'
        }
    );
    appendTaskEvent(
        getOrchestratorRoot(repoRoot),
        taskId,
        'REVIEWER_LAUNCH_COMPLETED',
        'INFO',
        'Reviewer launch completed by test controller fixture.',
        {
            task_id: taskId,
            review_type: reviewType,
            reviewer_execution_mode: reviewerExecutionMode,
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: reviewContextSha256,
            routing_event_sha256: routingEventSha256,
            reviewer_launch_artifact_path: launchArtifactPath.replace(/\\/g, '/'),
            reviewer_launch_artifact_sha256: completedLaunchArtifactSha256,
            provider_invocation_id: 'test-invocation-265',
            delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            launch_completed_at_utc: TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC
        }
    );
}

function fileSha256ForTest(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function launchArtifactInputArgsForTest(launchArtifactPath: string): string[] {
    return [
        '--launch-input-mode', 'launch_artifact_path',
        '--launch-input-artifact-path', launchArtifactPath,
        '--launch-input-sha256', fileSha256ForTest(launchArtifactPath)
    ];
}

export {
    describe,
    it,
    assert,
    fs,
    os,
    path,
    createHash,
    runCliMainWithHandling,
    buildReviewContext,
    getWorkspaceSnapshot,
    buildReviewTreeState,
    applyReviewerRoutingMetadata,
    appendTaskEvent,
    createTempRepo,
    seedTaskQueue,
    seedInitAnswers,
    getReviewsRoot,
    getOrchestratorRoot,
    createReviewerRoutingFixture,
    writePreflight,
    prepareCurrentReviewPhase,
    runGit,
    initializeGitRepo,
    readTaskTimelineEvents,
    runCliWithCapturedOutput,
    manualReviewContextTaskScopeFixture,
    manualReviewContextBindingFixture,
    manualReviewContextRuleContextFixture,
    writeManualReviewerHandoffFixture,
    manualReviewContextTreeStateFixture,
    readReviewTreeStateSha256FromContextPath,
    reviewContextScopedDiffFixture,
    recordReviewRoutingViaCli,
    attestReviewerInvocationForTest,
    seedRoutedReviewerLaunchFixture,
    seedPromptBoundReviewFixture,
    prepareReviewerLaunchForTest,
    recordReviewerDelegationStartedForTest,
    completeReviewerLaunchArtifactForTest,
    fileSha256ForTest,
    launchArtifactInputArgsForTest,
    TEST_REVIEW_LAUNCH_PREPARED_AT_UTC,
    TEST_REVIEW_LAUNCHED_AT_UTC,
    TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC,
    TEST_REVIEW_INVOCATION_ATTESTED_AT_UTC
};

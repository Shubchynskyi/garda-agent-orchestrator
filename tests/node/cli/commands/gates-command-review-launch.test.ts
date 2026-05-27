import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    runCliMainWithHandling
} from '../../../../src/cli/main';
import { buildReviewContext } from '../../../../src/gates/build-review-context';
import { getWorkspaceSnapshot } from '../../../../src/gates/compile-gate';
import { buildReviewTreeState } from '../../../../src/gates/review-tree-state';
import {
    applyReviewerRoutingMetadata
} from '../../../../src/gate-runtime/review-context';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';

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
} from './gate-test-helpers';

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

describe('cli/commands/gates review launch routing', () => {
    it('record-review-routing updates review-context routing metadata without minting launch attestation', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const reviewerHandoff = writeManualReviewerHandoffFixture(repoRoot, taskId, 'code');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_handoff: reviewerHandoff,
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:test-reviewer');
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 0);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rejects required canonical contexts without current preflight binding', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-missing-binding';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.notEqual(observedExitCode, 0);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation accepts completed launch metadata after current preparation', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-invocation';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const reviewerHandoff = writeManualReviewerHandoffFixture(repoRoot, taskId, 'code');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_handoff: reviewerHandoff,
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');

        const previousRoutingExitCode = process.exitCode;
        const previousRoutingCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousRoutingCwd);
            process.exitCode = previousRoutingExitCode;
        }
        let events = readTaskTimelineEvents(repoRoot, taskId);
        const invocationEventsBefore = events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length;
        const routingEvent = events.find((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED');
        const routingIntegrity = routingEvent?.integrity as Record<string, unknown> | undefined;
        assert.ok(routingIntegrity?.event_sha256);
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');
        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer',
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }
        const preparedLaunchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        fs.writeFileSync(launchArtifactPath, JSON.stringify({
            ...preparedLaunchArtifact,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            attestation_source: 'test_provider_controller',
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            fork_context: false
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-invocation',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer',
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, invocationEventsBefore + 1);
        const invocationEvent = [...events].reverse().find((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED');
        const invocationDetails = invocationEvent?.details as Record<string, unknown> | undefined;
        assert.equal(invocationDetails?.review_type, 'code');
        assert.equal(invocationDetails?.reviewer_session_id, 'agent:test-reviewer');
        assert.equal(invocationDetails?.execution_provider, 'Antigravity');
        assert.equal(invocationDetails?.execution_provider_source, 'provider_bridge');
        assert.equal(invocationDetails?.canonical_source_of_truth, 'Antigravity');
        assert.equal(invocationDetails?.reviewer_launch_tool, 'test-subagent-spawn');
        assert.equal(invocationDetails?.provider_invocation_id, 'test-invocation-123');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rejects schema-less review contexts without tree_state binding', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-schema-less-tree-state-bypass';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const preflightSha256 = createHash('sha256').update(fs.readFileSync(preflightPath)).digest('hex');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            task_id: taskId,
            review_type: 'code',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: preflightSha256,
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');

        const reviewerIdentity = 'agent:test-schema-less-tree-state-reviewer';
        const routing = await runCliWithCapturedOutput([
            'gate',
            'record-review-routing',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity
        ], { cwd: repoRoot });

        assert.notEqual(routing.exitCode, 0);
        assert.ok(
            routing.errors.some((line) => line.includes('record-review-routing requires review context tree_state binding')),
            routing.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch writes current prepared launch metadata without attesting invocation', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-prepare-launch';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');
        const reviewOutputPath = path.join(path.dirname(launchArtifactPath), 'review-output.md');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleLog = console.log;
        const capturedLogs: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.log = (...args: unknown[]) => {
            capturedLogs.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(path.join(repoRoot, 'src'));
            await runCliMainWithHandling([
                'gate',
                'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(launchArtifactPath), true);
        const launchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(launchArtifact.schema_version, 1);
        assert.equal(launchArtifact.evidence_type, 'delegated_reviewer_launch_preparation');
        assert.equal(launchArtifact.attestation_state, 'prepared');
        assert.equal(launchArtifact.task_id, taskId);
        assert.equal(launchArtifact.review_type, 'code');
        assert.equal(launchArtifact.reviewer_identity, fixture.reviewerIdentity);
        assert.equal(launchArtifact.review_context_sha256, fixture.reviewContextSha256);
        assert.equal(launchArtifact.review_tree_state_sha256, fixture.reviewTreeStateSha256);
        assert.equal(launchArtifact.review_tree_state.tree_state_sha256, fixture.reviewTreeStateSha256);
        assert.equal(launchArtifact.routing_event_sha256, fixture.routingEventSha256);
        assert.equal(launchArtifact.reviewer_prompt_path, fixture.reviewerPromptPath.replace(/\\/g, '/'));
        assert.equal(launchArtifact.prompt_template_path, fixture.promptTemplatePath.replace(/\\/g, '/'));
        assert.equal(launchArtifact.output_template_path, fixture.outputTemplatePath.replace(/\\/g, '/'));
        assert.equal(launchArtifact.evidence_manifest_path, fixture.evidenceManifestPath.replace(/\\/g, '/'));
        assert.equal(launchArtifact.review_output_path, reviewOutputPath.replace(/\\/g, '/'));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes('First open and read PromptTemplatePath:'));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(fixture.promptTemplatePath.replace(/\\/g, '/')));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes('Then open and read ReviewerPromptPath:'));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(fixture.reviewerPromptPath.replace(/\\/g, '/')));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes('Use EvidenceManifestPath to locate the review context, scoped diff, and supporting evidence:'));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(fixture.evidenceManifestPath.replace(/\\/g, '/')));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes('Fill OutputTemplatePath exactly, preserving the required sections:'));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(fixture.outputTemplatePath.replace(/\\/g, '/')));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes('Required sections: Validation Notes, Findings by Severity, Deferred Findings, Residual Risks, Verdict.'));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(reviewOutputPath.replace(/\\/g, '/')));
        assert.equal(launchArtifact.prompt_template_sha256, createHash('sha256').update(fs.readFileSync(fixture.promptTemplatePath)).digest('hex'));
        assert.equal(launchArtifact.output_template_sha256, createHash('sha256').update(fs.readFileSync(fixture.outputTemplatePath)).digest('hex'));
        assert.equal(launchArtifact.evidence_manifest_sha256, createHash('sha256').update(fs.readFileSync(fixture.evidenceManifestPath)).digest('hex'));
        assert.equal(launchArtifact.attestation_source, 'garda_prepare_reviewer_launch');
        assert.equal(typeof launchArtifact.launch_binding_sha256, 'string');
        assert.ok(launchArtifact.launch_binding_sha256.length > 0);
        assert.equal(typeof launchArtifact.launch_prepared_at_utc, 'string');
        assert.equal(Number.isNaN(Date.parse(launchArtifact.launch_prepared_at_utc)), false);
        assert.equal(launchArtifact.generated_at_utc, launchArtifact.launch_prepared_at_utc);
        assert.equal(launchArtifact.launch_completion_token, undefined);
        assert.equal(launchArtifact.controller_launch_completion_token, undefined);
        assert.equal(typeof launchArtifact.prepared_launch_event_sha256, 'string');
        assert.ok(launchArtifact.prepared_launch_event_sha256.length > 0);
        assert.equal(typeof launchArtifact.reviewer_launch_prepared_event_recorded_at_utc, 'string');
        assert.equal(Number.isNaN(Date.parse(launchArtifact.reviewer_launch_prepared_event_recorded_at_utc)), false);
        assert.equal(typeof launchArtifact.launch_tool, 'string');
        assert.ok(String(launchArtifact.launch_tool).length > 0);
        assert.equal(
            launchArtifact.local_trust_boundary,
            'Local reviewer launch artifacts are convenience metadata for a real delegated reviewer launch; they are not non-forgeable proof without provider-owned recording.'
        );
        assert.equal(launchArtifact.after_launch_required_updates.evidence_type, 'delegated_reviewer_launch');
        assert.equal(launchArtifact.after_launch_required_updates.attestation_state, 'launched');
        assert.equal(launchArtifact.after_launch_required_updates.provider_invocation_id_or_controller_invocation_id, '<actual delegated reviewer invocation id>');
        assert.equal(launchArtifact.after_launch_required_updates.launch_completed_at_utc, '<gate-owned ISO-8601 completion timestamp>');
        assert.deepEqual(launchArtifact.preserve_prepared_fields, [
            'review_context_sha256',
            'routing_event_sha256',
            'reviewer_prompt_sha256',
            'prompt_template_sha256',
            'output_template_sha256',
            'evidence_manifest_sha256',
            'review_tree_state_sha256',
            'launch_binding_sha256',
            'prepared_launch_event_sha256',
            'prepared_launch_event_task_sequence'
        ]);
        assert.ok(String(launchArtifact.record_invocation_command).includes('gate record-review-invocation'));
        assert.ok(String(launchArtifact.record_invocation_command).includes(`--reviewer-identity "${fixture.reviewerIdentity}"`));
        assert.ok(String(launchArtifact.next_action).includes('Launch a real subagent using built-in tools'));
        assert.ok(String(launchArtifact.next_action).includes('if for some reason that is impossible right now, you must stop and report this to the user'));
        assert.ok(String(launchArtifact.next_action).includes('this is expected behavior in this repository'));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const launchPreparedEvent = events.find((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED');
        const launchPreparedIntegrity = launchPreparedEvent?.integrity as { event_sha256?: string } | undefined;
        const launchPreparedDetails = launchPreparedEvent?.details as Record<string, unknown> | undefined;
        assert.equal(launchPreparedIntegrity?.event_sha256, launchArtifact.prepared_launch_event_sha256);
        assert.equal(launchPreparedDetails?.launch_prepared_at_utc, launchArtifact.launch_prepared_at_utc);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 0);
        assert.ok(capturedLogs.some((line) => line.includes('REVIEWER_LAUNCH_PREPARED: code')));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewContextSha256: ${fixture.reviewContextSha256}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewTreeStateSha256: ${fixture.reviewTreeStateSha256}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`RoutingEventSha256: ${fixture.routingEventSha256}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`RepoRoot: ${repoRoot.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewContextPath: ${fixture.reviewContextPath.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewerPromptPath: ${fixture.reviewerPromptPath.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`PromptTemplatePath: ${fixture.promptTemplatePath.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`OutputTemplatePath: ${fixture.outputTemplatePath.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`EvidenceManifestPath: ${fixture.evidenceManifestPath.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewOutputPath: ${reviewOutputPath.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`ScopedDiffMetadataPath: ${path.join(getReviewsRoot(repoRoot), `${taskId}-code-scoped.json`).replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewerLaunchArtifactPath: ${launchArtifactPath.replace(/\\/g, '/')}`)));
        assert.equal(capturedLogs.some((line) => line.includes('LaunchCompletionToken:')), false);
        assert.equal(capturedLogs.some((line) => line.includes('LaunchCompletionTokenSha256:')), false);
        assert.ok(capturedLogs.some((line) => line.includes('PreparedLaunchEventSha256:')));
        assert.ok(capturedLogs.some((line) => line.includes('AttestationState: prepared')));
        assert.ok(capturedLogs.some((line) => line.includes('TrustBoundary: Local reviewer launch artifacts are convenience metadata')));
        assert.ok(capturedLogs.some((line) => line.includes('HandoffInstruction: Treat review context as an opaque handoff artifact')));
        assert.ok(capturedLogs.some((line) => line.includes('Do not open or summarize the generated review-context markdown')));
        assert.ok(capturedLogs.some((line) => line.includes('RequiredCompletedFields:')));
        assert.ok(capturedLogs.some((line) => line.includes('PreservePreparedFields: review_context_sha256')));
        assert.ok(capturedLogs.some((line) => line.includes('RecordInvocationCommand: node bin/garda.js gate record-review-invocation')));
        assert.ok(capturedLogs.some((line) => line.includes('CopyPasteReviewerLaunchPrompt:')));
        assert.ok(capturedLogs.some((line) => line.includes('First open and read PromptTemplatePath:')));
        assert.ok(capturedLogs.some((line) => line.includes('Then open and read ReviewerPromptPath:')));
        assert.ok(capturedLogs.some((line) => line.includes('Use EvidenceManifestPath to locate the review context, scoped diff, and supporting evidence:')));
        assert.ok(capturedLogs.some((line) => line.includes('Fill OutputTemplatePath exactly, preserving the required sections:')));
        assert.ok(capturedLogs.some((line) => line.includes('Required sections: Validation Notes, Findings by Severity, Deferred Findings, Residual Risks, Verdict.')));
        assert.ok(capturedLogs.some((line) => line.includes('Write the final review report to ReviewOutputPath when file writing is available')));
        assert.ok(capturedLogs.some((line) => line.includes('NextAction: launch the delegated reviewer with PromptTemplatePath, ReviewerPromptPath, OutputTemplatePath, and EvidenceManifestPath as opaque handoff artifacts')));
        assert.ok(capturedLogs.some((line) => line.includes('Launch a real subagent using built-in tools')));
        assert.ok(capturedLogs.some((line) => line.includes('if for some reason that is impossible right now, you must stop and report this to the user')));
        assert.ok(capturedLogs.some((line) => line.includes('this is expected behavior in this repository')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch rejects stale staged review contexts after MM drift', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-staged-launch-drift';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        initializeGitRepo(repoRoot);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const stagedSnapshot = getWorkspaceSnapshot(repoRoot, 'git_staged_only', false, []);
        const preflightPath = writePreflight(repoRoot, taskId, {
            detection_source: 'git_staged_only',
            scope_category: 'code',
            changed_files: ['src/app.ts'],
            metrics: {
                changed_lines_total: stagedSnapshot.changed_lines_total,
                changed_files_sha256: stagedSnapshot.changed_files_sha256,
                scope_content_sha256: stagedSnapshot.scope_content_sha256,
                scope_sha256: stagedSnapshot.scope_sha256
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
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const tokenConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'token-economy.json');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        buildReviewContext({
            reviewType: 'code',
            depth: 2,
            preflightPath,
            tokenEconomyConfigPath: tokenConfigPath,
            scopedDiffMetadataPath: path.join(reviewsRoot, `${taskId}-code-scoped.json`),
            outputPath: reviewContextPath,
            repoRoot
        });

        const reviewerIdentity = 'agent:test-staged-drift-reviewer';
        const routing = await runCliWithCapturedOutput([
            'gate',
            'record-review-routing',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity
        ], { cwd: repoRoot });
        assert.equal(routing.exitCode, 0, routing.errors.join('\n'));

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const value = 3;\n', 'utf8');
        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity,
            '--reviewer-launch-artifact-path', path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json')
        ], { cwd: repoRoot });

        assert.notEqual(prepare.exitCode, 0);
        assert.ok(
            prepare.errors.some((line) => line.includes('prepare-reviewer-launch cannot continue because the current reviewer-visible tree state is stale')),
            prepare.errors.join('\n')
        );
        assert.ok(
            prepare.errors.some((line) => line.includes('Staged review scope is stale: src/app.ts has unstaged working-tree changes')),
            prepare.errors.join('\n')
        );
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch rejects review contexts after full workspace scope drift', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-launch-scope-drift';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# baseline\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const value = 2;\n', 'utf8');
        const snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
        assert.deepEqual(snapshot.changed_files, ['src/app.ts']);
        const preflightPath = writePreflight(repoRoot, taskId, {
            detection_source: 'git_auto',
            scope_category: 'code',
            changed_files: snapshot.changed_files,
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
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const tokenConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'token-economy.json');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        buildReviewContext({
            reviewType: 'code',
            depth: 2,
            preflightPath,
            tokenEconomyConfigPath: tokenConfigPath,
            scopedDiffMetadataPath: path.join(reviewsRoot, `${taskId}-code-scoped.json`),
            outputPath: reviewContextPath,
            repoRoot
        });

        const reviewerIdentity = 'agent:test-scope-drift-reviewer';
        const routing = await runCliWithCapturedOutput([
            'gate',
            'record-review-routing',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity
        ], { cwd: repoRoot });
        assert.equal(routing.exitCode, 0, routing.errors.join('\n'));

        fs.writeFileSync(path.join(repoRoot, 'src', 'new-file.ts'), 'export const next = true;\n', 'utf8');
        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity,
            '--reviewer-launch-artifact-path', path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json')
        ], { cwd: repoRoot });

        assert.notEqual(prepare.exitCode, 0);
        assert.ok(
            prepare.errors.some((line) => line.includes('prepare-reviewer-launch cannot continue because review context scope is stale')),
            prepare.errors.join('\n')
        );
        assert.ok(
            prepare.errors.some((line) => line.includes('Missing from review context: [src/new-file.ts]')),
            prepare.errors.join('\n')
        );
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch rejects stale reviewer prompt artifacts', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-stale-prompt-prepare';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });

        fs.writeFileSync(fixture.reviewerPromptPath, 'stale reviewer prompt payload\n', 'utf8');
        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(prepare.exitCode, 0);
        assert.ok(
            prepare.errors.some((line) => line.includes('prepare-reviewer-launch cannot continue because reviewer prompt artifact is stale')),
            prepare.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch rejects stale reviewer prompt-template artifacts', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-556-stale-prompt-template-prepare';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });

        fs.writeFileSync(fixture.promptTemplatePath, 'stale reviewer prompt template payload\n', 'utf8');
        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(prepare.exitCode, 0);
        assert.ok(
            prepare.errors.some((line) => line.includes('prepare-reviewer-launch cannot continue because reviewer prompt template artifact is stale')),
            prepare.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch rejects prompt-template artifacts whose realpath escapes the repo root', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-556-prompt-template-realpath-escape';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${taskId}-external-`));
        const externalTemplatePath = path.join(externalRoot, 'prompt-template.md');
        const externalTemplateText = '# code review Prompt Template\nexternal prompt template payload\n';
        fs.writeFileSync(externalTemplatePath, externalTemplateText, 'utf8');
        const linkDir = path.join(getReviewsRoot(repoRoot), `${taskId}-linked-external`);
        fs.symlinkSync(externalRoot, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
        const linkedTemplatePath = path.join(linkDir, 'prompt-template.md');

        const reviewContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerHandoff = reviewContext.reviewer_handoff as Record<string, Record<string, string>>;
        reviewerHandoff.prompt_template.artifact_path = linkedTemplatePath.replace(/\\/g, '/');
        reviewerHandoff.prompt_template.artifact_sha256 = createHash('sha256')
            .update(externalTemplateText, 'utf8')
            .digest('hex');
        fs.writeFileSync(fixture.reviewContextPath, JSON.stringify(reviewContext, null, 2) + '\n', 'utf8');

        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(prepare.exitCode, 0);
        assert.ok(
            prepare.errors.some((line) => line.includes('prepare-reviewer-launch requires reviewer prompt template artifact to stay inside repo root')),
            prepare.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(externalRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch rejects prompt artifacts without a context hash binding', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-missing-prompt-binding';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        const reviewContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as Record<string, unknown>;
        const ruleContext = reviewContext.rule_context as Record<string, unknown>;
        delete ruleContext.artifact_sha256;
        fs.writeFileSync(fixture.reviewContextPath, JSON.stringify(reviewContext, null, 2) + '\n', 'utf8');

        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(prepare.exitCode, 0);
        assert.ok(
            prepare.errors.some((line) => line.includes('prepare-reviewer-launch requires review context rule_context.artifact_sha256')),
            prepare.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch rejects prompt artifacts outside the repo root', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-prompt-outside-repo';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        const externalPromptPath = path.join(path.dirname(repoRoot), `${taskId}-outside-prompt.md`);
        const externalPromptContent = 'external reviewer prompt payload\n';
        fs.writeFileSync(externalPromptPath, externalPromptContent, 'utf8');
        const reviewContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as Record<string, unknown>;
        const ruleContext = reviewContext.rule_context as Record<string, unknown>;
        ruleContext.artifact_path = externalPromptPath.replace(/\\/g, '/');
        ruleContext.preferred_prompt_artifact = externalPromptPath.replace(/\\/g, '/');
        ruleContext.artifact_sha256 = createHash('sha256').update(externalPromptContent, 'utf8').digest('hex');
        fs.writeFileSync(fixture.reviewContextPath, JSON.stringify(reviewContext, null, 2) + '\n', 'utf8');

        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(prepare.exitCode, 0);
        assert.ok(
            prepare.errors.some((line) => line.includes('Path must stay inside repo root')),
            prepare.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(externalPromptPath, { force: true });
    });

    it('prepare-reviewer-launch rejects review contexts without an explicit prompt artifact path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-missing-prompt-path';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        const reviewContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as Record<string, unknown>;
        const ruleContext = reviewContext.rule_context as Record<string, unknown>;
        delete ruleContext.artifact_path;
        delete ruleContext.preferred_prompt_artifact;
        fs.writeFileSync(fixture.reviewContextPath, JSON.stringify(reviewContext, null, 2) + '\n', 'utf8');

        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(prepare.exitCode, 0);
        assert.ok(
            prepare.errors.some((line) => line.includes('requires review context rule_context.preferred_prompt_artifact or rule_context.artifact_path')),
            prepare.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects stale reviewer prompt artifacts after preparation', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-stale-prompt-complete';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath: fixture.launchArtifactPath
        });

        fs.writeFileSync(fixture.reviewerPromptPath, 'stale reviewer prompt payload before completion\n', 'utf8');
        const complete = await runCliWithCapturedOutput([
            'gate',
            'complete-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath,
            '--provider-invocation-id', 'test-invocation-265-complete',
            '--attestation-source', 'test_provider_controller',
            '--fork-context', 'false'
        ], { cwd: repoRoot });

        assert.notEqual(complete.exitCode, 0);
        assert.ok(
            complete.errors.some((line) => line.includes('complete-reviewer-launch cannot continue because reviewer prompt artifact is stale')),
            complete.errors.join('\n')
        );
        const launchArtifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(launchArtifact.attestation_state, 'prepared');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation rejects stale reviewer prompt artifacts after preparation', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-stale-prompt-invocation';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath: fixture.launchArtifactPath
        });
        completeReviewerLaunchArtifactForTest(fixture.launchArtifactPath);

        fs.writeFileSync(fixture.reviewerPromptPath, 'stale reviewer prompt payload before invocation\n', 'utf8');
        const invocation = await runCliWithCapturedOutput([
            'gate',
            'record-review-invocation',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(invocation.exitCode, 0);
        assert.ok(
            invocation.errors.some((line) => line.includes('record-review-invocation cannot continue because reviewer prompt artifact is stale')),
            invocation.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation rejects review contexts without tree_state binding after preparation', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-invocation-no-tree-state';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath: fixture.launchArtifactPath
        });
        completeReviewerLaunchArtifactForTest(fixture.launchArtifactPath);
        const reviewContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as Record<string, unknown>;
        delete reviewContext.tree_state;
        delete reviewContext.schema_version;
        fs.writeFileSync(fixture.reviewContextPath, JSON.stringify(reviewContext, null, 2) + '\n', 'utf8');

        const invocation = await runCliWithCapturedOutput([
            'gate',
            'record-review-invocation',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(invocation.exitCode, 0);
        assert.ok(
            invocation.errors.some((line) => line.includes('record-review-invocation requires review context tree_state binding')),
            invocation.errors.join('\n')
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch replaces stale prepared hashes with the current routing and context hashes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-prepare-launch-stale';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');
        fs.mkdirSync(path.dirname(launchArtifactPath), { recursive: true });
        fs.writeFileSync(launchArtifactPath, JSON.stringify({
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch_preparation',
            attestation_state: 'prepared',
            task_id: taskId,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: fixture.reviewerIdentity,
            review_context_sha256: 'a'.repeat(64),
            routing_event_sha256: 'b'.repeat(64),
            attestation_source: 'garda_prepare_reviewer_launch',
            launch_tool: 'stale'
        }, null, 2) + '\n', 'utf8');
        const staleArtifactSha256 = createHash('sha256').update(fs.readFileSync(launchArtifactPath)).digest('hex');
        const staleSnapshotPath = launchArtifactPath.replace(/\.json$/, `-superseded-${staleArtifactSha256}.json`);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const launchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(launchArtifact.review_context_sha256, fixture.reviewContextSha256);
        assert.equal(launchArtifact.routing_event_sha256, fixture.routingEventSha256);
        assert.notEqual(launchArtifact.launch_tool, 'stale');
        assert.equal(fs.existsSync(staleSnapshotPath), true);
        assert.deepEqual(JSON.parse(fs.readFileSync(staleSnapshotPath, 'utf8')), {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch_preparation',
            attestation_state: 'prepared',
            task_id: taskId,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: fixture.reviewerIdentity,
            review_context_sha256: 'a'.repeat(64),
            routing_event_sha256: 'b'.repeat(64),
            attestation_source: 'garda_prepare_reviewer_launch',
            launch_tool: 'stale'
        });
        assert.equal(launchArtifact.superseded_launch_artifact.artifact_sha256, staleArtifactSha256);
        assert.equal(launchArtifact.superseded_launch_artifact.snapshot_path, staleSnapshotPath.replace(/\\/g, '/'));
        assert.ok(
            launchArtifact.superseded_launch_artifact.mismatches.includes('review_context_sha256 mismatch'),
            launchArtifact.superseded_launch_artifact.superseded_reason
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch leaves current prepared launch metadata unchanged', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-prepare-launch-current';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const runPrepare = async (): Promise<number> => {
            const previousExitCode = process.exitCode;
            const previousCwd = process.cwd();
            process.exitCode = 0;
            try {
                process.chdir(repoRoot);
                await runCliMainWithHandling([
                    'gate',
                    'prepare-reviewer-launch',
                    '--task-id', taskId,
                    '--review-type', 'code',
                    '--repo-root', repoRoot,
                    '--reviewer-execution-mode', 'delegated_subagent',
                    '--reviewer-identity', fixture.reviewerIdentity
                ]);
                return process.exitCode ?? 0;
            } finally {
                process.chdir(previousCwd);
                process.exitCode = previousExitCode;
            }
        };

        assert.equal(await runPrepare(), 0);
        const firstArtifactText = fs.readFileSync(launchArtifactPath, 'utf8');
        const firstArtifactSha256 = createHash('sha256').update(fs.readFileSync(launchArtifactPath)).digest('hex');
        const firstPreparedEvents = readTaskTimelineEvents(repoRoot, taskId)
            .filter((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED').length;

        const capturedLogs: string[] = [];
        const originalConsoleLog = console.log;
        console.log = (...args: unknown[]) => {
            capturedLogs.push(args.map((value) => String(value)).join(' '));
        };
        try {
            assert.equal(await runPrepare(), 0);
        } finally {
            console.log = originalConsoleLog;
        }

        assert.equal(fs.readFileSync(launchArtifactPath, 'utf8'), firstArtifactText);
        assert.equal(createHash('sha256').update(fs.readFileSync(launchArtifactPath)).digest('hex'), firstArtifactSha256);
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED').length,
            firstPreparedEvents
        );
        assert.equal(
            fs.readdirSync(path.dirname(launchArtifactPath)).some((entry) => entry.includes('-superseded-')),
            false
        );
        assert.ok(capturedLogs.some((line) => line.includes('NextAction: existing reviewer launch metadata is current')));
        assert.ok(capturedLogs.some((line) => line.includes('Launch a real subagent using built-in tools')));
        assert.ok(capturedLogs.some((line) => line.includes('if for some reason that is impossible right now, you must stop and report this to the user')));
        assert.ok(capturedLogs.some((line) => line.includes('this is expected behavior in this repository')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch replaces legacy prepared metadata that lacks copy-paste handoff fields', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-prepare-launch-legacy-handoff';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const runPrepare = async (): Promise<number> => {
            const previousExitCode = process.exitCode;
            const previousCwd = process.cwd();
            process.exitCode = 0;
            try {
                process.chdir(repoRoot);
                await runCliMainWithHandling([
                    'gate',
                    'prepare-reviewer-launch',
                    '--task-id', taskId,
                    '--review-type', 'code',
                    '--repo-root', repoRoot,
                    '--reviewer-execution-mode', 'delegated_subagent',
                    '--reviewer-identity', fixture.reviewerIdentity
                ]);
                return process.exitCode ?? 0;
            } finally {
                process.chdir(previousCwd);
                process.exitCode = previousExitCode;
            }
        };

        assert.equal(await runPrepare(), 0);
        const legacyArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        delete legacyArtifact.review_output_path;
        delete legacyArtifact.copy_paste_reviewer_launch_prompt;
        fs.writeFileSync(launchArtifactPath, `${JSON.stringify(legacyArtifact, null, 2)}\n`, 'utf8');

        assert.equal(await runPrepare(), 0);
        const refreshedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(
            refreshedArtifact.review_output_path,
            path.join(path.dirname(launchArtifactPath), 'review-output.md').replace(/\\/g, '/')
        );
        assert.ok(String(refreshedArtifact.copy_paste_reviewer_launch_prompt).includes('First open and read PromptTemplatePath:'));
        assert.ok(String(refreshedArtifact.copy_paste_reviewer_launch_prompt).includes('Required sections: Validation Notes, Findings by Severity, Deferred Findings, Residual Risks, Verdict.'));
        assert.equal(refreshedArtifact.superseded_launch_artifact.mismatches.includes('review_output_path mismatch'), true);
        assert.equal(refreshedArtifact.superseded_launch_artifact.mismatches.includes('copy_paste_reviewer_launch_prompt mismatch'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation rejects prepared-only launch metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-prepared-not-attested';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-invocation',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(capturedErrors.some((line) => line.includes('prepared reviewer launch metadata cannot satisfy REVIEWER_INVOCATION_ATTESTED')));
        assert.ok(capturedErrors.some((line) => line.includes('Completion hint:')));
        assert.ok(capturedErrors.some((line) => line.includes("evidence_type='delegated_reviewer_launch'")));
        assert.ok(capturedErrors.some((line) => line.includes('provider_invocation_id or controller_invocation_id=<actual delegated reviewer invocation id>')));
        assert.ok(capturedErrors.some((line) => line.includes('not non-forgeable proof')));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation rejects hand-authored completed launch artifacts without prepared telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-launch-without-prepared-event';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');
        fs.mkdirSync(path.dirname(launchArtifactPath), { recursive: true });
        fs.writeFileSync(launchArtifactPath, JSON.stringify({
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            task_id: taskId,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: fixture.reviewerIdentity,
            review_context_sha256: fixture.reviewContextSha256,
            routing_event_sha256: fixture.routingEventSha256,
            attestation_source: 'test_provider_controller',
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            fork_context: false
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-invocation',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(capturedErrors.some((line) => line.includes('launch_binding_sha256 is required')));
        assert.ok(capturedErrors.some((line) => line.includes('prepared_launch_event_sha256 is required')));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation accepts completed launch artifacts that extend prepared metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-launch-from-prepared-metadata';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const preparedLaunchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        fs.writeFileSync(launchArtifactPath, JSON.stringify({
            ...preparedLaunchArtifact,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            attestation_source: 'test_provider_controller',
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            fork_context: false
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-invocation',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 1);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-invocation rejects mixed-case forbidden source and malformed launch timestamp', async () => {
        const cases = [
            {
                taskId: 'T-257-launch-mixed-case-source',
                artifactUpdates: { attestation_source: 'Manual' },
                expectedError: 'attestation_source must be provider/controller-owned completed launch evidence'
            },
            {
                taskId: 'T-257-launch-invalid-timestamp',
                artifactUpdates: { launched_at_utc: 'not-a-date' },
                expectedError: 'launched_at_utc must be a valid UTC ISO-8601 timestamp'
            },
            {
                taskId: 'T-564-1-launch-invalid-prepared-timestamp',
                artifactUpdates: { launch_prepared_at_utc: 'not-a-date' },
                expectedError: 'launch_prepared_at_utc must be a valid UTC ISO-8601 timestamp'
            },
            {
                taskId: 'T-564-1-launch-invalid-completed-timestamp',
                artifactUpdates: { launch_completed_at_utc: 'not-a-date' },
                expectedError: 'launch_completed_at_utc must be a valid UTC ISO-8601 timestamp'
            }
        ];

        for (const testCase of cases) {
            const repoRoot = createTempRepo();
            try {
                const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId: testCase.taskId });
                const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', testCase.taskId, 'code', 'reviewer-launch.json');

                const previousPrepareExitCode = process.exitCode;
                const previousPrepareCwd = process.cwd();
                process.exitCode = 0;
                try {
                    process.chdir(repoRoot);
                    await runCliMainWithHandling([
                        'gate',
                        'prepare-reviewer-launch',
                        '--task-id', testCase.taskId,
                        '--review-type', 'code',
                        '--repo-root', repoRoot,
                        '--reviewer-execution-mode', 'delegated_subagent',
                        '--reviewer-identity', fixture.reviewerIdentity
                    ]);
                    assert.equal(process.exitCode ?? 0, 0);
                } finally {
                    process.chdir(previousPrepareCwd);
                    process.exitCode = previousPrepareExitCode;
                }

                const preparedLaunchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
                fs.writeFileSync(launchArtifactPath, JSON.stringify({
                    ...preparedLaunchArtifact,
                    evidence_type: 'delegated_reviewer_launch',
                    attestation_state: 'launched',
                    attestation_source: 'test_provider_controller',
                    launch_tool: 'test-subagent-spawn',
                    provider_invocation_id: 'test-invocation-123',
                    launched_at_utc: '2026-04-28T00:00:00.000Z',
                    fork_context: false,
                    ...testCase.artifactUpdates
                }, null, 2) + '\n', 'utf8');

                const previousExitCode = process.exitCode;
                const previousCwd = process.cwd();
                const originalConsoleError = console.error;
                const capturedErrors: string[] = [];
                process.exitCode = 0;
                let observedExitCode = 0;
                console.error = (...args: unknown[]) => {
                    capturedErrors.push(args.map((value) => String(value)).join(' '));
                };
                try {
                    process.chdir(repoRoot);
                    await runCliMainWithHandling([
                        'gate',
                        'record-review-invocation',
                        '--task-id', testCase.taskId,
                        '--review-type', 'code',
                        '--repo-root', repoRoot,
                        '--reviewer-execution-mode', 'delegated_subagent',
                        '--reviewer-identity', fixture.reviewerIdentity,
                        '--reviewer-launch-artifact-path', launchArtifactPath
                    ]);
                    observedExitCode = process.exitCode ?? 0;
                } finally {
                    console.error = originalConsoleError;
                    process.chdir(previousCwd);
                    process.exitCode = previousExitCode;
                }

                assert.ok(observedExitCode !== 0, `Expected non-zero exit code for ${testCase.taskId}, got ${observedExitCode}`);
                assert.ok(capturedErrors.some((line) => line.includes(testCase.expectedError)), capturedErrors.join('\n'));
                const events = readTaskTimelineEvents(repoRoot, testCase.taskId);
                assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 0);
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        }
    });

    it('record-review-invocation rejects completed-looking launch artifacts without provider invocation provenance', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-launch-missing-provider-proof';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');
        fs.mkdirSync(path.dirname(launchArtifactPath), { recursive: true });
        fs.writeFileSync(launchArtifactPath, JSON.stringify({
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            task_id: taskId,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: fixture.reviewerIdentity,
            review_context_sha256: fixture.reviewContextSha256,
            routing_event_sha256: fixture.routingEventSha256,
            attestation_source: 'provider_controller',
            launch_tool: 'test-subagent-spawn',
            fork_context: false
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-invocation',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(capturedErrors.some((line) => line.includes('provider_invocation_id or controller_invocation_id is required')));
        assert.ok(capturedErrors.some((line) => line.includes('launched_at_utc is required')));
        assert.ok(capturedErrors.some((line) => line.includes('Completion hint:')));
        assert.ok(capturedErrors.some((line) => line.includes('fresh_context=true, isolated_context=true, or fork_context=false')));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch completes a prepared artifact that record-review-invocation accepts', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-valid';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const capturedLines: string[] = [];
        const originalConsoleLog = console.log;
        const previousCompleteExitCode = process.exitCode;
        const previousCompleteCwd = process.cwd();
        process.exitCode = 0;
        let observedCompleteExitCode = 0;
        console.log = (...args: unknown[]) => capturedLines.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-305',
                '--attestation-source', 'claude_task_tool_launch',
                '--fork-context', 'false'
            ]);
            observedCompleteExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCompleteCwd);
            process.exitCode = previousCompleteExitCode;
        }

        assert.equal(observedCompleteExitCode, 0, `complete-reviewer-launch should succeed, got exit code ${observedCompleteExitCode}`);
        assert.ok(capturedLines.some((line) => line.includes('REVIEWER_LAUNCH_COMPLETED: code')));

        const completedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(completedArtifact.attestation_state, 'launched', 'Artifact state should be launched');
        assert.equal(completedArtifact.evidence_type, 'delegated_reviewer_launch', 'Evidence type should be updated');
        assert.equal(completedArtifact.attestation_source, 'claude_task_tool_launch', 'Attestation source should be set');
        assert.equal(completedArtifact.provider_invocation_id, 'test-invocation-305', 'Provider invocation ID should be set');
        assert.equal(typeof completedArtifact.launched_at_utc, 'string', 'Launched timestamp should be set by the gate');
        assert.equal(Number.isNaN(Date.parse(completedArtifact.launched_at_utc)), false);
        assert.equal(typeof completedArtifact.launch_prepared_at_utc, 'string');
        assert.equal(Number.isNaN(Date.parse(completedArtifact.launch_prepared_at_utc)), false);
        assert.equal(typeof completedArtifact.launch_completed_at_utc, 'string');
        assert.equal(Number.isNaN(Date.parse(completedArtifact.launch_completed_at_utc)), false);
        assert.equal(completedArtifact.fork_context, false, 'Fork context should be false');

        const previousInvokeExitCode = process.exitCode;
        const previousInvokeCwd = process.cwd();
        process.exitCode = 0;
        let observedInvokeExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'record-review-invocation',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            observedInvokeExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousInvokeCwd);
            process.exitCode = previousInvokeExitCode;
        }

        assert.equal(observedInvokeExitCode, 0, `record-review-invocation should accept the completed artifact, got exit code ${observedInvokeExitCode}`);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 1);
        const invocationEvent = events.find((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED');
        const invocationDetails = invocationEvent?.details as Record<string, unknown> | undefined;
        assert.equal(invocationDetails?.launch_prepared_at_utc, completedArtifact.launch_prepared_at_utc);
        assert.equal(invocationDetails?.launched_at_utc, completedArtifact.launched_at_utc);
        assert.equal(invocationDetails?.launch_completed_at_utc, completedArtifact.launch_completed_at_utc);
        assert.equal(typeof invocationDetails?.invocation_attested_at_utc, 'string');
        assert.equal(Number.isNaN(Date.parse(String(invocationDetails?.invocation_attested_at_utc))), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects tampered prepared launch bindings and leaves artifact unchanged', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-complete-launch-binding-tamper';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath: fixture.launchArtifactPath
        });
        const preparedArtifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(fixture.launchArtifactPath, JSON.stringify({
            ...preparedArtifact,
            launch_binding_sha256: '0'.repeat(64)
        }, null, 2) + '\n', 'utf8');

        const complete = await runCliWithCapturedOutput([
            'gate',
            'complete-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath,
            '--provider-invocation-id', 'test-invocation-265-binding',
            '--attestation-source', 'test_provider_controller',
            '--fork-context', 'false'
        ], { cwd: repoRoot });

        assert.notEqual(complete.exitCode, 0);
        assert.ok(
            complete.errors.some((line) => line.includes('launch_binding_sha256 must match the current prepared launch binding')),
            complete.errors.join('\n')
        );
        const artifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(artifact.attestation_state, 'prepared');
        assert.equal(artifact.provider_invocation_id, undefined);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects missing provider invocation id and leaves artifact unchanged', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-missing-id';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const capturedErrors: string[] = [];
        const originalConsoleError = console.error;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => capturedErrors.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--attestation-source', 'claude_task_tool_launch',
                '--fork-context', 'false'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(capturedErrors.some((line) => line.includes('ProviderInvocationId or ControllerInvocationId is required')));
        const artifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(artifact.attestation_state, 'prepared', 'Artifact should remain in prepared state after failed complete');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects stale context hash when review context changed after prepare', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-stale-hash';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        // Mutate the review context so its SHA256 no longer matches the prepared artifact
        fs.writeFileSync(fixture.reviewContextPath, fs.readFileSync(fixture.reviewContextPath, 'utf8') + '\n', 'utf8');

        const capturedErrors: string[] = [];
        const originalConsoleError = console.error;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => capturedErrors.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-305',
                '--attestation-source', 'claude_task_tool_launch',
                '--fork-context', 'false'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(
            capturedErrors.some((line) => line.includes('review_context_sha256 must match the current review context')),
            'Expected error about stale review context sha256'
        );
        const artifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(artifact.attestation_state, 'prepared', 'Artifact should remain in prepared state after failed complete');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects stale routing hash when prepared artifact no longer matches routing telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-stale-routing';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const preparedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        fs.writeFileSync(
            launchArtifactPath,
            JSON.stringify({ ...preparedArtifact, routing_event_sha256: '0'.repeat(64) }, null, 2),
            'utf8'
        );

        const capturedErrors: string[] = [];
        const originalConsoleError = console.error;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => capturedErrors.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-305',
                '--attestation-source', 'claude_task_tool_launch',
                '--fork-context', 'false'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(
            capturedErrors.some((line) => line.includes('routing_event_sha256 must match the current routing event')),
            'Expected error about stale routing event sha256'
        );
        const artifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(artifact.attestation_state, 'prepared', 'Artifact should remain in prepared state after failed complete');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects when both provider and controller invocation ids are provided', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-both-ids';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const capturedErrors: string[] = [];
        const originalConsoleError = console.error;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => capturedErrors.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'provider-id-305',
                '--controller-invocation-id', 'controller-id-305',
                '--attestation-source', 'claude_task_tool_launch',
                '--fork-context', 'false'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(capturedErrors.some((line) => line.includes('not both')));
        const artifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(artifact.attestation_state, 'prepared', 'Artifact should remain in prepared state after failed complete');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects forbidden attestation source', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-bad-source';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const capturedErrors: string[] = [];
        const originalConsoleError = console.error;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => capturedErrors.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-305',
                '--attestation-source', 'Manual',
                '--fork-context', 'false'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(capturedErrors.some((line) => line.includes('not a valid provider/controller-owned attestation source')));
        const artifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(artifact.attestation_state, 'prepared', 'Artifact should remain in prepared state after failed complete');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects when no fresh-context flag is provided', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-no-ctx';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const capturedErrors: string[] = [];
        const originalConsoleError = console.error;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => capturedErrors.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-305',
                '--attestation-source', 'claude_task_tool_launch'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(capturedErrors.some((line) => line.includes('At least one of --fresh-context, --isolated-context, or --fork-context false')));
        const artifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(artifact.attestation_state, 'prepared', 'Artifact should remain in prepared state after failed complete');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch succeeds with controller-invocation-id and writes correct artifact field', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-controller-id';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--controller-invocation-id', 'ctrl-invocation-305',
                '--attestation-source', 'claude_task_tool_launch',
                '--fork-context', 'false'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0, `complete-reviewer-launch with controller id should succeed, got ${observedExitCode}`);
        const completedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(completedArtifact.attestation_state, 'launched');
        assert.equal(completedArtifact.controller_invocation_id, 'ctrl-invocation-305', 'Controller invocation ID should be set');
        assert.equal(completedArtifact.provider_invocation_id, undefined, 'Provider invocation ID should not be set');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch writes fresh_context and isolated_context fields when flags provided', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-ctx-flags';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-305',
                '--attestation-source', 'claude_task_tool_launch',
                '--fresh-context',
                '--isolated-context'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0, `complete-reviewer-launch with fresh+isolated context should succeed, got ${observedExitCode}`);
        const completedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(completedArtifact.attestation_state, 'launched');
        assert.equal(completedArtifact.fresh_context, true, 'fresh_context should be set to true');
        assert.equal(completedArtifact.isolated_context, true, 'isolated_context should be set to true');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch records gate-owned launched-at-utc when the flag is omitted', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-no-utc';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const capturedErrors: string[] = [];
        const originalConsoleError = console.error;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => capturedErrors.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-305',
                '--attestation-source', 'claude_task_tool_launch',
                '--fork-context', 'false'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0, `Expected complete-reviewer-launch to succeed, got ${observedExitCode}: ${capturedErrors.join('\n')}`);
        const artifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(artifact.attestation_state, 'launched', 'Artifact should be completed');
        assert.equal(typeof artifact.launched_at_utc, 'string', 'Gate should write launched_at_utc');
        assert.equal(Number.isNaN(Date.parse(artifact.launched_at_utc)), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects caller-supplied launched-at-utc as spoof-like input', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-257-complete-launch-spoof-utc';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const capturedErrors: string[] = [];
        const originalConsoleError = console.error;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => capturedErrors.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-305',
                '--launched-at-utc', '2026-05-18T12:34:56.789Z',
                '--attestation-source', 'claude_task_tool_launch',
                '--fork-context', 'false'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.notEqual(observedExitCode, 0, 'Expected complete-reviewer-launch to reject caller-owned launched-at-utc');
        assert.match(capturedErrors.join('\n'), /spoof-like launch freshness input/i);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing keeps canonical routing when aggregate telemetry index fails', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-routing-aggregate-warning';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const aggregatePath = path.join(taskEventsRoot, 'all-tasks.jsonl');
        fs.rmSync(aggregatePath, { force: true });
        fs.mkdirSync(aggregatePath, { recursive: true });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:test-reviewer');
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 0);
        assert.equal(fs.statSync(path.join(taskEventsRoot, 'all-tasks.jsonl')).isDirectory(), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rolls back review-context routing metadata when delegated telemetry cannot be recorded', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-routing-lock';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        fs.mkdirSync(taskEventsRoot, { recursive: true });
        const lockPath = path.join(taskEventsRoot, `.${taskId}.lock`);
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const timelinePath = path.join(taskEventsRoot, `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rejects same-agent fallback when direct Codex runtime remains delegation-required', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-routing-policy-tamper';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', `self:${taskId}`,
                '--reviewer-fallback-reason', 'tampered review-context policy'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        assert.equal(reviewContext.reviewer_routing.fallback_reason, null);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rejects delegated_subagent with a self-scoped reviewer identity', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-routing-self-identity';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', `self:${taskId}`
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rejects late routing after the review gate already passed', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-late-routing';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Required reviews gate passed.', {});

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rejects late reroute after the same review type has recorded a result', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904z-late-reroute';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904z-late-reroute',
            '## Summary',
            'Verified delegated reviewer routing with concrete implementation detail and realistic wording.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let rerouteExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:first-code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:first-code-reviewer'
            ]);

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:late-code-reviewer'
            ]);
            rerouteExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(rerouteExitCode !== 0, `Expected non-zero exit code, got ${rerouteExitCode}`);
        assert.ok(capturedErrors.some((line) => line.includes("Review routing for 'code' is locked")));
        assert.ok(capturedErrors.some((line) => line.includes('restart-review-cycle')));
        assert.ok(capturedErrors.some((line) => line.includes('does not require a full task reset')));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:first-code-reviewer');
        const routingEvents = readTaskTimelineEvents(repoRoot, taskId)
            .filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED');
        assert.equal(routingEvents.length, 1);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing allows rerouting before a review result is recorded', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904z-pre-result-reroute';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let rerouteExitCode = 0;
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:first-code-reviewer'
            });
            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:replacement-code-reviewer'
            ]);
            rerouteExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(rerouteExitCode, 0);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:replacement-code-reviewer');
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 2);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing keeps different review types independent after a review result is recorded', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904z-cross-type-reroute';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: true,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const codeArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const securityReviewContextPath = path.join(reviewsRoot, `${taskId}-security-review-context.json`);
        fs.writeFileSync(codeArtifactPath, [
            '# Code Review T-904z-cross-type-reroute',
            '## Summary',
            'Verified delegated reviewer routing with concrete implementation detail and realistic wording.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(codeReviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(securityReviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'security'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'security'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let securityRoutingExitCode = 0;
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer',
                reviewContextPath: codeReviewContextPath
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'security',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:security-reviewer'
            ]);
            securityRoutingExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(securityRoutingExitCode, 0);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.ok(events.some((event) => (
            event.event_type === 'REVIEWER_DELEGATION_ROUTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '') === 'code'
        )));
        assert.ok(events.some((event) => (
            event.event_type === 'REVIEWER_DELEGATION_ROUTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '') === 'security'
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing accepts delegated_subagent for Qwen after fallback removal', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904za';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Qwen')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:test-reviewer');
        assert.equal(reviewContext.reviewer_routing.expected_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.fallback_allowed, false);
        assert.equal(reviewContext.reviewer_routing.fallback_reason_required, false);
        assert.equal(reviewContext.reviewer_routing.fallback_reason, null);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const routingEvents = fs.existsSync(timelinePath)
            ? readTaskTimelineEvents(repoRoot, taskId).filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED')
            : [];
        assert.equal(routingEvents.length, 1);
        assert.equal((routingEvents[0]?.details as Record<string, unknown> | undefined)?.reviewer_fallback_reason ?? null, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});

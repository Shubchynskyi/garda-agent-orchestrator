import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildReviewContext, getRulePack } from '../../../src/gates/build-review-context';
import { getWorkspaceSnapshot } from '../../../src/gates/compile-gate';
import { buildTaskModeArtifact, resolveTaskModeArtifactPath } from '../../../src/gates/task-mode';
import {
    handleCompleteReviewerLaunch,
    handlePrepareReviewerLaunch,
    handleRecordReviewInvocation,
    handleRecordReviewRouting
} from '../../../src/cli/commands/gate-review-handlers';

const REVIEWER_IDENTITY = 'agent:019de361-0000-7000-a000-000000000001';

function runGit(repoRoot: string, args: string[]): void {
    execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'ignore' });
}

function writeJson(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function appendTimelineEvent(repoRoot: string, taskId: string, eventType: string, details: Record<string, unknown> = {}): void {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    fs.appendFileSync(
        timelinePath,
        `${JSON.stringify({
            event_type: eventType,
            timestamp_utc: new Date().toISOString(),
            details
        })}\n`,
        'utf8'
    );
}

function makeStagedReviewContextFixture(taskId: string): {
    repoRoot: string;
    reviewsRoot: string;
    contextPath: string;
    launchArtifactPath: string;
} {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-launch-tree-state-'));
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
    const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'task-events'), { recursive: true });
    fs.mkdirSync(rulesRoot, { recursive: true });
    fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
    writeJson(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), { SourceOfTruth: 'Codex' });
    for (const ruleFile of getRulePack('code').full) {
        fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
    }
    writeJson(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), {
        enabled: true,
        enabled_depths: [1, 2]
    });

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.invalid']);
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
    runGit(repoRoot, ['add', 'src/app.ts']);
    runGit(repoRoot, ['commit', '-m', 'baseline']);

    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
    runGit(repoRoot, ['add', 'src/app.ts']);
    const stagedSnapshot = getWorkspaceSnapshot(repoRoot, 'git_staged_only', false, []);
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    writeJson(preflightPath, {
        task_id: taskId,
        detection_source: 'git_staged_only',
        mode: 'FULL_PATH',
        scope_category: 'code',
        changed_files: stagedSnapshot.changed_files,
        metrics: {
            changed_files_sha256: stagedSnapshot.changed_files_sha256,
            scope_content_sha256: stagedSnapshot.scope_content_sha256,
            scope_sha256: stagedSnapshot.scope_sha256
        },
        required_reviews: { code: true },
        triggers: { runtime_changed: true, runtime_code_changed: true }
    });

    fs.writeFileSync(resolveTaskModeArtifactPath(repoRoot, taskId, ''), `${JSON.stringify(buildTaskModeArtifact({
        taskId,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Enforce reviewer launch freshness against tree-state mismatch',
        startBanner: 'Garda captures my mind',
        provider: 'Codex',
        canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'explicit_provider',
        runtimeIdentityStatus: 'resolved',
        reviewerSubagentLaunchStatus: 'launchable',
        reviewerSubagentLaunchRoute: 'AGENTS.md'
    }), null, 2)}\n`, 'utf8');

    const contextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
    buildReviewContext({
        reviewType: 'code',
        depth: 2,
        preflightPath,
        tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
        scopedDiffMetadataPath: path.join(reviewsRoot, `${taskId}-code-scoped.json`),
        outputPath: contextPath,
        repoRoot
    });
    appendTimelineEvent(repoRoot, taskId, 'COMPILE_GATE_PASSED', {
        preflight_path: preflightPath
    });

    return {
        repoRoot,
        reviewsRoot,
        contextPath,
        launchArtifactPath: path.join(repoRoot, '.review-temp', taskId, 'code', 'reviewer-launch.json')
    };
}

async function recordRouting(repoRoot: string, taskId: string): Promise<void> {
    await handleRecordReviewRouting([
        '--task-id', taskId,
        '--review-type', 'code',
        '--reviewer-execution-mode', 'delegated_subagent',
        '--reviewer-identity', REVIEWER_IDENTITY,
        '--repo-root', repoRoot
    ]);
}

async function prepareLaunch(repoRoot: string, taskId: string, launchArtifactPath: string): Promise<void> {
    await handlePrepareReviewerLaunch([
        '--task-id', taskId,
        '--review-type', 'code',
        '--reviewer-execution-mode', 'delegated_subagent',
        '--reviewer-identity', REVIEWER_IDENTITY,
        '--reviewer-launch-artifact-path', launchArtifactPath,
        '--repo-root', repoRoot
    ]);
}

async function completeLaunch(repoRoot: string, taskId: string, launchArtifactPath: string): Promise<void> {
    await handleCompleteReviewerLaunch([
        '--task-id', taskId,
        '--review-type', 'code',
        '--reviewer-execution-mode', 'delegated_subagent',
        '--reviewer-identity', REVIEWER_IDENTITY,
        '--reviewer-launch-artifact-path', launchArtifactPath,
        '--provider-invocation-id', REVIEWER_IDENTITY.slice('agent:'.length),
        '--launched-at-utc', '2026-05-02T00:00:00.000Z',
        '--attestation-source', 'codex_spawn_agent',
        '--fork-context', 'false',
        '--repo-root', repoRoot
    ]);
}

function dirtyWorkingTree(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 3;\n', 'utf8');
}

describe('reviewer launch tree-state freshness', () => {
    it('blocks record-review-routing when a staged review context becomes MM before routing', async () => {
        const taskId = 'T-901-launch-routing-mm';
        const fixture = makeStagedReviewContextFixture(taskId);
        try {
            dirtyWorkingTree(fixture.repoRoot);

            await assert.rejects(
                () => recordRouting(fixture.repoRoot, taskId),
                /record-review-routing cannot continue because the current reviewer-visible tree state is stale.*Staged review scope is stale: src\/app\.ts has unstaged working-tree changes/s
            );
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks complete-reviewer-launch when a prepared staged launch becomes MM before completion', async () => {
        const taskId = 'T-901-launch-complete-mm';
        const fixture = makeStagedReviewContextFixture(taskId);
        try {
            await recordRouting(fixture.repoRoot, taskId);
            await prepareLaunch(fixture.repoRoot, taskId, fixture.launchArtifactPath);
            dirtyWorkingTree(fixture.repoRoot);

            await assert.rejects(
                () => completeLaunch(fixture.repoRoot, taskId, fixture.launchArtifactPath),
                /complete-reviewer-launch cannot continue because the current reviewer-visible tree state is stale.*Staged review scope is stale: src\/app\.ts has unstaged working-tree changes/s
            );
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks record-review-invocation when a completed staged launch becomes MM before attestation', async () => {
        const taskId = 'T-901-launch-invocation-mm';
        const fixture = makeStagedReviewContextFixture(taskId);
        try {
            await recordRouting(fixture.repoRoot, taskId);
            await prepareLaunch(fixture.repoRoot, taskId, fixture.launchArtifactPath);
            await completeLaunch(fixture.repoRoot, taskId, fixture.launchArtifactPath);
            dirtyWorkingTree(fixture.repoRoot);

            await assert.rejects(
                () => handleRecordReviewInvocation([
                    '--task-id', taskId,
                    '--review-type', 'code',
                    '--reviewer-execution-mode', 'delegated_subagent',
                    '--reviewer-identity', REVIEWER_IDENTITY,
                    '--reviewer-launch-artifact-path', fixture.launchArtifactPath,
                    '--repo-root', fixture.repoRoot
                ]),
                /record-review-invocation cannot continue because the current reviewer-visible tree state is stale.*Staged review scope is stale: src\/app\.ts has unstaged working-tree changes/s
            );
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });
});

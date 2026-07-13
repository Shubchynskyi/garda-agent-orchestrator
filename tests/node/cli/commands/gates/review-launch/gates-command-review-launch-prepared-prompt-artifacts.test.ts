import {
    assert,
    createHash,
    createTempRepo,
    describe,
    fs,
    getReviewsRoot,
    it,
    os,
    path,
    readTaskTimelineEvents,
    runCliWithCapturedOutput,
    seedPromptBoundReviewFixture
} from './gates-command-review-launch-fixtures';
import {
    buildCopyPasteReviewerLaunchPrompt,
    type ReviewerLaunchPromptOptions
} from '../../../../../../src/cli/commands/gate-review-handlers/launch/reviewer-handoff-support';

function buildPromptOptions(executionProvider: string): ReviewerLaunchPromptOptions {
    return {
        repoRoot: 'D:/repo',
        executionProvider,
        taskId: 'T-provider-notice',
        reviewType: 'code',
        reviewContextSha256: '1'.repeat(64),
        reviewTreeStateSha256: '2'.repeat(64),
        rolePromptPath: 'D:/repo/role-prompt.md',
        rolePromptSha256: '3'.repeat(64),
        reviewerPromptPath: 'D:/repo/reviewer-prompt.md',
        reviewerPromptSha256: '4'.repeat(64),
        promptTemplatePath: 'D:/repo/prompt-template.md',
        promptTemplateSha256: '5'.repeat(64),
        outputTemplatePath: 'D:/repo/output-template.md',
        outputTemplateSha256: '6'.repeat(64),
        evidenceManifestPath: 'D:/repo/evidence-manifest.json',
        evidenceManifestSha256: '7'.repeat(64),
        reviewOutputPath: 'D:/repo/review-output.json'
    };
}

describe('cli/commands/gates review launch prepared prompt artifacts', () => {
    it('names ChatGPT Codex as the completeness checker for a Claude executor', () => {
        const prompt = buildCopyPasteReviewerLaunchPrompt(buildPromptOptions('Claude'));
        const notices = prompt.match(/The completeness of your review will be checked by [^.]+\./g) || [];

        assert.deepEqual(notices, [
            'The completeness of your review will be checked by ChatGPT Codex.'
        ]);
    });

    it('names Claude as the completeness checker for non-Claude executors', () => {
        for (const executionProvider of ['Codex', 'Gemini', 'Cursor']) {
            const prompt = buildCopyPasteReviewerLaunchPrompt(buildPromptOptions(executionProvider));
            const notices = prompt.match(/The completeness of your review will be checked by [^.]+\./g) || [];

            assert.deepEqual(notices, [
                'The completeness of your review will be checked by Claude.'
            ], executionProvider);
        }
    });

    it('prepare-reviewer-launch injects the executor-specific notice exactly once', async () => {
        for (const [provider, expectedChecker] of [
            ['Claude', 'ChatGPT Codex'],
            ['Codex', 'Claude']
        ] as const) {
            const repoRoot = createTempRepo();
            const taskId = `T-provider-notice-${provider.toLowerCase()}`;
            const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId, provider });
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

            assert.equal(prepare.exitCode, 0, prepare.errors.join('\n'));
            const artifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')) as Record<string, unknown>;
            const prompt = String(artifact.copy_paste_reviewer_launch_prompt || '');
            const notices = prompt.match(/The completeness of your review will be checked by [^.]+\./g) || [];
            assert.deepEqual(notices, [
                `The completeness of your review will be checked by ${expectedChecker}.`
            ]);

            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
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
});

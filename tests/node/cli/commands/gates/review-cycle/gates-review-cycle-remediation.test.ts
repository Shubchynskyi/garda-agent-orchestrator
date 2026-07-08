import {
    EXIT_GATE_FAILURE,
    assert,
    createTempRepo,
    describe,
    fileSha256,
    findLastTimelineEventIndex,
    fs,
    getReviewsRoot,
    initializeGitRepo,
    it,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    markAsSourceCheckout,
    path,
    prepareScopedDiffFixture,
    readTaskTimelineEvents,
    runCompileGateCommand,
    runEnterTaskMode,
    runExplicitPreflight,
    runHandshakeForTask,
    runRestartReviewCycleCommandRaw,
    runRestartReviewCycleCommand,
    runShellSmokeForTask,
    seedInitAnswers,
    seedRemediationRepoBase,
    seedReusableReviewEvidence,
    seedTaskQueue,
    writeProtectedControlPlaneManifest,
    writeProfilesConfig,
    writeReviewCapabilitiesConfig,
    writeReceiptBackedReviewArtifact,
    writeSimpleCompileCommandsFile
} from './gates-review-cycle-fixtures';
import { resolveNextStep } from '../../../../../../src/gates/next-step/next-step';

const IGNORED_CHANGELOG_PATH = 'garda-agent-orchestrator/live/docs/changes/CHANGELOG.md';
const ROOT_IGNORED_CHANGELOG_PATH = 'CHANGELOG.md';

function writeRepoFile(repoRoot: string, relativePath: string, content: string): void {
    const filePath = path.join(repoRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function appendIgnoredChangelogRule(repoRoot: string, changelogPath = IGNORED_CHANGELOG_PATH): void {
    fs.appendFileSync(
        path.join(repoRoot, '.gitignore'),
        `${changelogPath}\n`,
        'utf8'
    );
}

function buildIgnoredChangelogImpactAnalysis(changelogPath = IGNORED_CHANGELOG_PATH): string {
    return [
        `Reviewer finding: failed review requires release-note remediation in ${changelogPath}.`,
        `Intended fix: update only the ignored changelog remediation target ${changelogPath}.`,
        `Affected files/contracts: ${changelogPath} is the affected release-note artifact and runtime contracts stay unchanged.`,
        `API/runtime/artifact/test impact: artifact impact is limited to the release-note evidence in ${changelogPath}.`,
        'Possible side effects: review reuse must fail closed if code or runtime behavior changes appear.',
        'Required targeted checks: restart-review-cycle must refresh preflight, compile, and review context evidence.',
        'Scope or review-type changes: the ignored changelog is in scope only because the failed review named it.',
        'Related blockers/follow-up: no separate follow-up is needed for this same failed-review blocker.'
    ].join(' ');
}

async function prepareIgnoredChangelogFixture(
    taskId: string,
    suffix: string,
    changelogPath = IGNORED_CHANGELOG_PATH,
    plannedChangedFiles = ['src/app.ts']
): Promise<{
    repoRoot: string;
    preflightPath: string;
    commandsPath: string;
    outputFiltersPath: string;
}> {
    const repoRoot = createTempRepo();
    seedRemediationRepoBase(repoRoot);
    appendIgnoredChangelogRule(repoRoot, changelogPath);
    writeReviewCapabilitiesConfig(repoRoot);
    writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 1;\n');
    writeRepoFile(repoRoot, changelogPath, '# Changelog\n\n- Initial ignored release note.\n');
    const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, suffix);
    initializeGitRepo(repoRoot);
    seedTaskQueue(repoRoot, taskId);
    seedInitAnswers(repoRoot, 'Codex');

    runEnterTaskMode({
        repoRoot,
        taskId,
        taskSummary: 'Restart review cycle with explicit ignored changelog remediation',
        plannedChangedFiles
    });
    loadTaskEntryRulePack(repoRoot, taskId);
    runHandshakeForTask(repoRoot, taskId);
    runShellSmokeForTask(repoRoot, taskId);
    const preflightPath = runExplicitPreflight(
        repoRoot,
        taskId,
        'Restart review cycle with explicit ignored changelog remediation',
        ['src/app.ts']
    );
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
    return {
        repoRoot,
        preflightPath,
        commandsPath,
        outputFiltersPath
    };
}

function writeFailedIgnoredChangelogReviewRequest(
    repoRoot: string,
    taskId: string,
    changelogPath = IGNORED_CHANGELOG_PATH
): void {
    writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'CODE REVIEW FAILED', [
        '# Code Review',
        '',
        `Finding: failed review requires release-note remediation in ${changelogPath}.`,
        '',
        'CODE REVIEW FAILED',
        '',
        '## Findings by Severity',
        `- Blocking: add the explicit ignored changelog target ${changelogPath}.`,
        '',
        '## Residual Risks',
        'The release-note artifact remains missing from the current review-cycle recovery scope.',
        '',
        '## Verdict',
        'CODE REVIEW FAILED'
    ]);
}

function writeFailedIgnoredChangelogPathFirstReviewRequest(
    repoRoot: string,
    taskId: string,
    changelogPath = IGNORED_CHANGELOG_PATH
): void {
    writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'CODE REVIEW FAILED', [
        '# Code Review',
        '',
        `${changelogPath} is missing the required release-note entry for this failed review.`,
        '',
        'CODE REVIEW FAILED',
        '',
        '## Findings by Severity',
        `- Blocking: ${changelogPath} is required for release-note remediation.`,
        '',
        '## Residual Risks',
        'The release-note artifact remains missing from the current review-cycle recovery scope.',
        '',
        '## Verdict',
        'CODE REVIEW FAILED'
    ]);
}

function writeFailedIgnoredChangelogExampleOnlyReviewRequest(
    repoRoot: string,
    taskId: string,
    changelogPath = IGNORED_CHANGELOG_PATH
): void {
    writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'CODE REVIEW FAILED', [
        '# Code Review',
        '',
        `High: support path-first findings such as ${changelogPath} is missing the required release-note entry.`,
        '',
        'CODE REVIEW FAILED',
        '',
        '## Findings by Severity',
        'High: update the parser behavior; the example path is not the requested remediation target.',
        '',
        '## Residual Risks',
        'none',
        '',
        '## Verdict',
        'CODE REVIEW FAILED'
    ]);
}

function writeFailedSourceOnlyReviewRequest(repoRoot: string, taskId: string): void {
    writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'CODE REVIEW FAILED', [
        '# Code Review',
        '',
        'Finding: failed review requires source remediation in src/app.ts.',
        '',
        'CODE REVIEW FAILED',
        '',
        '## Findings by Severity',
        '- Blocking: update src/app.ts for the failed review.',
        '',
        '## Residual Risks',
        'The source remediation remains incomplete.',
        '',
        '## Verdict',
        'CODE REVIEW FAILED'
    ]);
}

describe('cli/commands/gates – review-cycle remediation suite', () => {
    it('restart-review-cycle reuses unaffected security and refactor evidence after test hook remediation invalidates code', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-reuse';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-reuse');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart the review cycle and reuse code review evidence before rebuilding downstream test context',
            plannedChangedFiles: [
                'commands-restart-review-cycle-reuse.md',
                'garda-agent-orchestrator/live/config/review-capabilities.json',
                'src/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart the review cycle and reuse code review evidence before rebuilding downstream test context',
            ['src/app.ts', 'tests/app.test.ts']
        );
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

        const codeReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            codeReviewContextPath,
            'agent:code-reviewer'
        );
        const securityReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-security-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'security',
            'SECURITY REVIEW PASSED',
            preflightPath,
            securityReviewContextPath,
            'agent:security-reviewer'
        );
        const refactorReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-refactor-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'refactor',
            'REFACTOR REVIEW PASSED',
            preflightPath,
            refactorReviewContextPath,
            'agent:refactor-reviewer'
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysis: [
                'Reviewer finding: failed review blocker requires isolating the _testHooks helper in src/app.ts.',
                'Intended fix: constrain _testHooks exposure in src/app.ts without changing production behavior.',
                'Affected files/contracts: src/app.ts and tests/app.test.ts are the affected files; external contracts stay unchanged.',
                'API/runtime/artifact/test impact: test hook isolation only; no product contract or privileged handling impact is intended.',
                'Possible side effects: review reuse must fail closed if unrelated behavior changes appear.',
                'Required targeted checks: compile gate and downstream test review context assertions cover the fix.',
                'Scope or review-type changes: test hook isolation invalidates code review while preserving security and refactor evidence.',
                'Related blockers/follow-up: no separate follow-up is needed for this isolated hook fix.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /RemediationFixClassification: test_hook_isolation; invalidated_review_types=code; preserved_review_types=refactor, security, test/);
        assert.match(output, /PreparedReviewTypes: code, security, refactor/);
        assert.match(output, /LaunchRequiredReviewTypes: code/);
        assert.match(output, /ReusedReviewTypes: security, refactor/);
        assert.match(output, /PendingReviewTypes: test/);
        assert.match(output, /PendingReason:/);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`)),
            true
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-test-review-context.json`)),
            false
        );

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const handshakeIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (event.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED') {
                indexes.push(index);
            }
            return indexes;
        }, []);
        const shellSmokeIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (event.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED') {
                indexes.push(index);
            }
            return indexes;
        }, []);
        const firstCompileIndex = events.findIndex((event) => event.event_type === 'COMPILE_GATE_PASSED');
        const lastCompileIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const lastCodeReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        const lastHandshakeIndex = handshakeIndexes.at(-1) ?? -1;
        const lastShellSmokeIndex = shellSmokeIndexes.at(-1) ?? -1;
        assert.ok(lastCompileIndex >= 0);
        assert.equal(handshakeIndexes.length, 2);
        assert.equal(shellSmokeIndexes.length, 2);
        assert.ok(firstCompileIndex >= 0);
        assert.ok(firstCompileIndex > shellSmokeIndexes[0]);
        assert.ok(lastHandshakeIndex > firstCompileIndex);
        assert.ok(lastShellSmokeIndex > lastHandshakeIndex);
        assert.ok(lastCompileIndex > lastShellSmokeIndex);
        assert.ok(lastCodeReviewPhaseIndex > lastCompileIndex);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle blocks review reuse for fail-closed remediation classifications', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-fail-closed-reuse';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-fail-closed-reuse');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart the review cycle without reusing fail-closed runtime remediation evidence',
            plannedChangedFiles: [
                'commands-restart-review-cycle-fail-closed-reuse.md',
                'garda-agent-orchestrator/live/config/review-capabilities.json',
                'src/app.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart the review cycle without reusing fail-closed runtime remediation evidence',
            ['src/app.ts']
        );
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

        const codeReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            codeReviewContextPath,
            'agent:code-reviewer'
        );
        const securityReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-security-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'security',
            'SECURITY REVIEW PASSED',
            preflightPath,
            securityReviewContextPath,
            'agent:security-reviewer'
        );
        const refactorReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-refactor-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'refactor',
            'REFACTOR REVIEW PASSED',
            preflightPath,
            refactorReviewContextPath,
            'agent:refactor-reviewer'
        );

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysis: [
                'Reviewer finding: failed review blocker changes runtime deletion behavior and trust handling in src/app.ts.',
                'Intended fix: update the runtime deletion execution path in src/app.ts and refresh review evidence.',
                'Affected files/contracts: src/app.ts is the affected file and its trust-sensitive runtime behavior changes.',
                'API/runtime/artifact/test impact: runtime behavior and trust changes require fail-closed review handling.',
                'Possible side effects: stale security evidence could miss a trust-boundary regression.',
                'Required targeted checks: compile gate and review-cycle classification assertions cover the fix.',
                'Scope or review-type changes: all affected review types must be reconsidered before reuse.',
                'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /RemediationFixClassification: unknown; invalidated_review_types=code, refactor, security; preserved_review_types=none/);
        assert.match(output, /LaunchRequiredReviewTypes: code, security, refactor/);
        assert.doesNotMatch(output, /ReusedReviewTypes: code/);
        assert.doesNotMatch(output, /ReusedReviewTypes: security/);

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const reviewReuse = remediationArtifact.review_reuse as Record<string, unknown>;
        assert.deepEqual(reviewReuse.reused_review_types, []);
        assert.deepEqual(reviewReuse.launch_required_review_types, ['code', 'security', 'refactor']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle blocks non-test remediation files outside the failed review scope', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-expanded-source';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-expanded-source');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle refuses expanded source remediation',
            plannedChangedFiles: ['src/app.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle refuses expanded source remediation',
            ['src/app.ts']
        );
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

        fs.writeFileSync(path.join(repoRoot, 'src', 'extra.ts'), 'export const extra = true;\n', 'utf8');

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: [
                'src/app.ts',
                `garda-agent-orchestrator/runtime/manual-validation/${taskId}/gradle-test.log`,
                `garda-agent-orchestrator/runtime/manual-validation/${taskId}/review-evidence.json`
            ],
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTART_FAILED/);
        assert.match(output, /non-test files outside the failed review scope changed: src\/extra.ts/);

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const reviewsIndex = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), 'reviews-index.json'),
            'utf8'
        )) as Record<string, unknown>;
        assert.equal(remediationArtifact.status, 'BLOCKED');
        assert.equal(
            (remediationArtifact.remediation_fix_classification as Record<string, unknown>).category,
            'unknown'
        );
        assert.equal(
            (remediationArtifact.remediation_fix_classification as Record<string, unknown>).scope_category,
            'expanded_non_test_blocked'
        );
        assert.equal(
            (remediationArtifact.remediation_fix_classification as Record<string, unknown>).blocked_before_reuse,
            true
        );
        assert.equal(
            (remediationArtifact.remediation_scope as Record<string, unknown>).status,
            'BLOCKED'
        );
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).expanded_non_test_files,
            ['src/extra.ts']
        );
        assert.ok((reviewsIndex.entries as Array<Record<string, unknown>>).some((entry) => (
            entry.fileName === `${taskId}-review-remediation-cycle.json`
            && entry.taskId === taskId
            && entry.artifactType === 'review-remediation-cycle.json'
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle allows task-scoped manual-validation evidence refresh files', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-manual-validation';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-manual-validation');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle after refreshing manual validation evidence',
            plannedChangedFiles: ['src/app.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle after refreshing manual validation evidence',
            ['src/app.ts']
        );
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

        const manualValidationRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'manual-validation', taskId);
        fs.mkdirSync(manualValidationRoot, { recursive: true });
        fs.writeFileSync(path.join(manualValidationRoot, 'gradle-test.log'), 'BUILD SUCCESSFUL\n', 'utf8');
        fs.writeFileSync(path.join(manualValidationRoot, 'review-evidence.json'), JSON.stringify({
            schema_version: 1,
            task_id: taskId,
            selected_logs: [
                {
                    path: 'gradle-test.log',
                    command: './gradlew test',
                    exit_code: 0,
                    review_types: ['test']
                }
            ]
        }, null, 2), 'utf8');

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: [
                'src/app.ts',
                `garda-agent-orchestrator/runtime/manual-validation/${taskId}/gradle-test.log`,
                `garda-agent-orchestrator/runtime/manual-validation/${taskId}/review-evidence.json`
            ],
            impactAnalysis: [
                'Reviewer finding: failed review could not inspect attached manual validation evidence for the test lane.',
                'Intended fix: add task-scoped runtime/manual-validation selector and log artifacts for reviewer handoff.',
                'Affected files/contracts: src/app.ts remains the scoped source file and garda-agent-orchestrator/runtime/manual-validation artifacts are attached evidence only.',
                'API/runtime/artifact/test impact: runtime artifact impact is limited to reviewer evidence; tests are not changed by the selector refresh.',
                'Possible side effects: review reuse must fail closed if the runtime evidence changes behavior or expands source scope.',
                'Required targeted checks: compile gate, review context build, and manual-validation evidence handoff checks cover the refresh.',
                'Scope or review-type changes: only the test evidence handoff is refreshed; source scope stays unchanged.',
                'Related blockers/follow-up: no separate follow-up is needed for task-owned manual-validation evidence refresh.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const remediationScope = remediationArtifact.remediation_scope as Record<string, unknown>;
        assert.equal(remediationScope.status, 'OK');
        assert.deepEqual(remediationScope.expanded_non_test_files, []);
        assert.ok((remediationScope.current_changed_files as string[]).includes(
            `garda-agent-orchestrator/runtime/manual-validation/${taskId}/review-evidence.json`
        ));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle includes allowed test-only expansion in explicit refresh scope', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-explicit-test-expansion';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-explicit-test-expansion');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle preserves explicit test-only remediation scope',
            plannedChangedFiles: ['src/app.ts', 'tests/app.test.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle preserves explicit test-only remediation scope',
            ['src/app.ts']
        );
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

        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts'],
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /DetectionSource: explicit_changed_files/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts', 'tests/app.test.ts']);
        assert.equal((refreshedPreflight.required_reviews as Record<string, boolean>).test, true);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).allowed_test_only_expansion_files,
            ['tests/app.test.ts']
        );
        assert.equal(
            (remediationArtifact.remediation_fix_classification as Record<string, unknown>).category,
            'test_coverage_only'
        );
        assert.equal(
            (remediationArtifact.remediation_fix_classification as Record<string, unknown>).scope_category,
            'test_only_expansion'
        );
        assert.deepEqual(
            (remediationArtifact.remediation_fix_classification as Record<string, unknown>).invalidated_review_types,
            ['test']
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle uses expanded remediation files for semantic classification', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-892-restart-review-cycle-semantic-test-expansion';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-semantic-test-expansion');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle classifies only the remediation delta',
            plannedChangedFiles: ['src/app.ts', 'tests/app.test.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle classifies only the remediation delta',
            ['src/app.ts', 'tests/app.test.ts']
        );
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

        fs.writeFileSync(
            path.join(repoRoot, 'tests', 'remediation-only.test.ts'),
            'it("covers the failed review path", () => {});\n',
            'utf8'
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', 'tests/app.test.ts'],
            impactAnalysis: [
                'Reviewer finding: test reviewer reported missing coverage for tests/remediation-only.test.ts retry routing.',
                'Intended fix: add tests/remediation-only.test.ts as assertion coverage for the failed test lane only.',
                'Affected files/contracts: tests/remediation-only.test.ts is the affected file; source contracts are unchanged.',
                'API/runtime/artifact/test impact: test impact is limited to added coverage assertions and no product files are touched.',
                'Possible side effects: the restart may preserve non-test review receipts and invalidate only the test review.',
                'Required targeted checks: focused review-cycle classification checks cover the remediation artifact fields.',
                'Scope or review-type changes: review-type impact stays in test; code, security, and refactor remain reuse candidates.',
                'Related blockers/follow-up: no separate follow-up is needed because the remediation delta is a test file.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, [
            'src/app.ts',
            'tests/app.test.ts',
            'tests/remediation-only.test.ts'
        ]);

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const classification = remediationArtifact.remediation_fix_classification as Record<string, unknown>;
        const evidence = classification.evidence as Record<string, unknown>;
        assert.equal(classification.category, 'test_coverage_only');
        assert.equal(classification.scope_category, 'test_only_expansion');
        assert.deepEqual(classification.invalidated_review_types, ['test']);
        assert.deepEqual(evidence.semantic_changed_files, ['tests/remediation-only.test.ts']);
        assert.equal(evidence.semantic_scope_source, 'expanded_files');
        assert.equal(evidence.test_refactor_trigger_reason, 'new_test_file');
        assert.deepEqual(evidence.test_refactor_trigger_files, ['tests/remediation-only.test.ts']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle reuses upstream non-test evidence after failed test remediation adds only tests', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-892-restart-review-cycle-test-only-rerun';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-test-only-rerun');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle returns test-only remediation to test review',
            plannedChangedFiles: ['src/app.ts', 'tests/app.test.ts', 'tests/remediation-only.test.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle returns test-only remediation to test review',
            ['src/app.ts', 'tests/app.test.ts']
        );
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

        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`),
            'agent:code-reviewer'
        );
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'security',
            'SECURITY REVIEW PASSED',
            preflightPath,
            path.join(getReviewsRoot(repoRoot), `${taskId}-security-review-context.json`),
            'agent:security-reviewer'
        );
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'refactor',
            'REFACTOR REVIEW PASSED',
            preflightPath,
            path.join(getReviewsRoot(repoRoot), `${taskId}-refactor-review-context.json`),
            'agent:refactor-reviewer'
        );

        fs.writeFileSync(
            path.join(repoRoot, 'tests', 'remediation-only.test.ts'),
            'it("covers the failed test review rerun", () => {});\n',
            'utf8'
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', 'tests/app.test.ts'],
            impactAnalysis: [
                'Reviewer finding: test reviewer reported missing coverage for failed test review rerun routing.',
                'Intended fix: add tests/remediation-only.test.ts assertion coverage only for the failed test lane.',
                'Affected files/contracts: tests/remediation-only.test.ts is the affected file; source contracts are unchanged.',
                'API/runtime/artifact/test impact: test impact is limited to added coverage assertions and no product files are touched.',
                'Possible side effects: stale upstream code, security, or refactor evidence must not be relaunched when lane-domain fingerprints match.',
                'Required targeted checks: focused review-cycle classification and reuse assertions cover the remediation artifact.',
                'Scope or review-type changes: review-type impact stays in test; code, security, and refactor remain reuse candidates.',
                'Related blockers/follow-up: no separate follow-up is needed because the remediation delta is a test file.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const classification = remediationArtifact.remediation_fix_classification as Record<string, unknown>;
        const evidence = classification.evidence as Record<string, unknown>;
        const reviewReuse = remediationArtifact.review_reuse as Record<string, unknown>;
        assert.equal(classification.category, 'test_coverage_only');
        assert.equal(classification.scope_category, 'test_only_expansion');
        assert.deepEqual(classification.invalidated_review_types, ['refactor', 'test']);
        assert.equal(evidence.test_refactor_trigger_reason, 'new_test_file');
        assert.deepEqual(
            [...((classification.preserved_review_types as string[]) || [])].sort(),
            ['code', 'security']
        );
        assert.deepEqual(
            [...((reviewReuse.reused_review_types as string[]) || [])].sort(),
            ['code', 'security']
        );
        assert.deepEqual(
            [...((reviewReuse.launch_required_review_types as string[]) || [])].sort(),
            ['refactor']
        );
        assert.deepEqual(
            [...((reviewReuse.pending_review_types as string[]) || [])].sort(),
            ['test']
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle preserves upstream lanes when failed test remediation edits an existing test file', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-902-existing-test-remediation-reuse';
        const sourceFile = 'src/api/orders.ts';
        const performanceFile = 'perf/review-routing.ts';
        const testFile = 'tests/node/gates/quality-checklist/quality-checklist.test.ts';
        const changedFiles = [sourceFile, performanceFile, testFile];
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'existing-test-remediation-reuse');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle after failed test review edits existing test coverage only',
            plannedChangedFiles: changedFiles
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, sourceFile), 'export const orderStatus = "draft";\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'perf'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, performanceFile), 'export const routingBudgetMs = 25;\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(repoRoot, testFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, testFile), 'it("keeps review routing covered", () => {});\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle after failed test review edits existing test coverage only',
            changedFiles
        );
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

        for (const reviewType of ['api', 'code', 'performance', 'refactor', 'security']) {
            seedReusableReviewEvidence(
                repoRoot,
                taskId,
                reviewType,
                `${reviewType.toUpperCase()} REVIEW PASSED`,
                preflightPath,
                path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`),
                `agent:${reviewType}-reviewer`
            );
        }

        fs.writeFileSync(
            path.join(repoRoot, testFile),
            'it("keeps review routing covered", () => { assert.equal(1, 1); });\n',
            'utf8'
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles,
            impactAnalysis: [
                `Reviewer finding: test reviewer reported missing assertion coverage in ${testFile}.`,
                `Intended fix: edit ${testFile} only to add the missing assertion for the failed test review.`,
                `Affected files/contracts: ${testFile} is the only affected file; product contracts stay unchanged.`,
                `API/runtime/artifact/test impact: only test impact is expected from ${testFile}; runtime and artifacts stay unchanged.`,
                'Possible side effects: stale upstream api, code, performance, security, or refactor evidence must not be relaunched when lane-domain fingerprints match.',
                'Required targeted checks: focused review-cycle classification and reuse assertions cover the existing test-file remediation path.',
                'Scope or review-type changes: review-type impact stays in test; api, code, performance, security, and refactor remain reuse candidates.',
                'Related blockers/follow-up: no separate follow-up is needed because the remediation delta is limited to the failed test-review file.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const classification = remediationArtifact.remediation_fix_classification as Record<string, unknown>;
        const evidence = classification.evidence as Record<string, unknown>;
        const reviewReuse = remediationArtifact.review_reuse as Record<string, unknown>;
        const expectedPreservedReviews = ['api', 'code', 'performance', 'refactor', 'security'];
        assert.equal(classification.category, 'test_coverage_only');
        assert.equal(classification.scope_category, 'previous_scope_only');
        assert.deepEqual(classification.invalidated_review_types, ['test']);
        assert.deepEqual(
            [...((classification.preserved_review_types as string[]) || [])].sort(),
            expectedPreservedReviews
        );
        assert.deepEqual(evidence.semantic_changed_files, [testFile]);
        assert.equal(evidence.semantic_scope_source, 'impact_analysis_files');
        assert.deepEqual(
            [...((reviewReuse.reused_review_types as string[]) || [])].sort(),
            expectedPreservedReviews
        );
        assert.deepEqual(reviewReuse.launch_required_review_types, ['test']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle preserves every supported code-dependent review lane after test-only remediation', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-910-all-supported-lanes-test-remediation';
        const sourceFile = 'src/app.ts';
        const dbFile = 'db/schema.sql';
        const infraFile = 'scripts/deploy.ps1';
        const dependencyFile = 'package.json';
        const testFile = 'tests/app.test.ts';
        const changedFiles = [sourceFile, dbFile, infraFile, dependencyFile, testFile];
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot, { infra: true });
        writeProfilesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'all-supported-lanes-test-remediation');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle preserves every supported code-dependent lane after test-only remediation',
            plannedChangedFiles: changedFiles
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, sourceFile), 'export const value = 1;\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(repoRoot, dbFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, dbFile), 'create table orders(id integer primary key);\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(repoRoot, infraFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, infraFile), 'Write-Output "deploy"\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, dependencyFile), JSON.stringify({ dependencies: { leftpad: '1.0.0' } }, null, 2) + '\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(repoRoot, testFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, testFile), 'it("keeps the baseline path covered", () => {});\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle preserves every supported code-dependent lane after test-only remediation',
            changedFiles
        );
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

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.equal((preflight.required_reviews as Record<string, boolean>).db, true);
        assert.equal((preflight.required_reviews as Record<string, boolean>).dependency, true);
        assert.equal((preflight.required_reviews as Record<string, boolean>).infra, true);
        const upstreamReviews: Array<[string, string]> = [
            ['code', 'REVIEW PASSED'],
            ['db', 'DB REVIEW PASSED'],
            ['dependency', 'DEPENDENCY REVIEW PASSED'],
            ['infra', 'INFRA REVIEW PASSED'],
            ['refactor', 'REFACTOR REVIEW PASSED'],
            ['security', 'SECURITY REVIEW PASSED']
        ];
        for (const [reviewType, verdict] of upstreamReviews) {
            seedReusableReviewEvidence(
                repoRoot,
                taskId,
                reviewType,
                verdict,
                preflightPath,
                path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`),
                `agent:${reviewType}-reviewer`
            );
        }

        fs.writeFileSync(
            path.join(repoRoot, testFile),
            'it("keeps the baseline path covered", () => { assert.equal(1, 1); });\n',
            'utf8'
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles,
            impactAnalysis: [
                `Reviewer finding: test reviewer reported missing assertion coverage in ${testFile}.`,
                `Intended fix: edit ${testFile} only to add the missing assertion for the failed test review.`,
                `Affected files/contracts: ${testFile} is the only affected file; source, database, infra, and dependency files remain unchanged.`,
                'API/runtime/artifact/test impact: no API or runtime behavior change; only test coverage changes.',
                'Possible side effects: stale upstream code, db, security, refactor, infra, or dependency evidence must not be relaunched when lane-domain fingerprints match.',
                'Required targeted checks: focused review-cycle classification and reuse assertions cover all supported code-dependent lane preservation.',
                'Scope or review-type changes: review-type impact stays in test; every supported non-test lane remains a reuse candidate.',
                'Related blockers/follow-up: no separate follow-up is needed because the remediation delta is limited to the failed test-review file.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const classification = remediationArtifact.remediation_fix_classification as Record<string, unknown>;
        const evidence = classification.evidence as Record<string, unknown>;
        const reviewReuse = remediationArtifact.review_reuse as Record<string, unknown>;
        const expectedPreservedReviews = ['code', 'db', 'dependency', 'infra', 'refactor', 'security'];
        assert.equal(classification.category, 'test_coverage_only');
        assert.equal(classification.scope_category, 'previous_scope_only');
        assert.deepEqual(classification.invalidated_review_types, ['test']);
        assert.deepEqual(
            [...((classification.preserved_review_types as string[]) || [])].sort(),
            expectedPreservedReviews
        );
        assert.deepEqual(evidence.semantic_changed_files, [testFile]);
        assert.equal(evidence.semantic_scope_source, 'impact_analysis_files');
        assert.deepEqual(
            [...((reviewReuse.reused_review_types as string[]) || [])].sort(),
            expectedPreservedReviews
        );
        assert.deepEqual(reviewReuse.launch_required_review_types, ['test']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle ignores unchanged product-file mentions in failed test remediation impact text', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-908-negated-runtime-test-remediation';
        const sourceFile = 'src/api/orders.ts';
        const performanceFile = 'perf/review-routing.ts';
        const testFile = 'tests/node/gates/next-step/next-step-quality-checklist-routing.test.ts';
        const changedFiles = [sourceFile, performanceFile, testFile];
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'negated-runtime-test-remediation');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle after failed test review with unchanged product files',
            plannedChangedFiles: changedFiles
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.mkdirSync(path.dirname(path.join(repoRoot, sourceFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, sourceFile), 'export const orderStatus = "draft";\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(repoRoot, performanceFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, performanceFile), 'export const routingBudgetMs = 25;\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(repoRoot, testFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, testFile), 'it("keeps quality checklist routing covered", () => {});\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle after failed test review with unchanged product files',
            changedFiles
        );
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

        const upstreamReviews: Array<[string, string]> = [
            ['api', 'API REVIEW PASSED'],
            ['code', 'REVIEW PASSED'],
            ['performance', 'PERFORMANCE REVIEW PASSED'],
            ['refactor', 'REFACTOR REVIEW PASSED'],
            ['security', 'SECURITY REVIEW PASSED']
        ];
        for (const [reviewType, verdict] of upstreamReviews) {
            seedReusableReviewEvidence(
                repoRoot,
                taskId,
                reviewType,
                verdict,
                preflightPath,
                path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`),
                `agent:${reviewType}-reviewer`
            );
        }

        fs.writeFileSync(
            path.join(repoRoot, testFile),
            'it("keeps quality checklist routing covered", () => { assert.equal(1, 1); });\n',
            'utf8'
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles,
            impactAnalysis: [
                `Reviewer finding: test reviewer reported missing assertion coverage in ${testFile}.`,
                `Intended fix: edit ${testFile} only to add the missing assertion for the failed test review.`,
                `Affected files/contracts: ${testFile} is the only affected file; ${sourceFile} remains unchanged and ${performanceFile} remains unchanged.`,
                'API/runtime/artifact/test impact: no API or runtime behavior change; runtime and artifacts stay unchanged, and only test coverage changes.',
                'Possible side effects: stale upstream api, code, performance, security, or refactor evidence must not be relaunched when lane-domain fingerprints match.',
                'Required targeted checks: focused review-cycle classification and reuse assertions cover negated runtime impact wording.',
                'Scope or review-type changes: review-type impact stays in test; every unchanged non-test lane remains a reuse candidate.',
                'Related blockers/follow-up: no separate follow-up is needed because the remediation delta is limited to the failed test-review file.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const classification = remediationArtifact.remediation_fix_classification as Record<string, unknown>;
        const evidence = classification.evidence as Record<string, unknown>;
        const reviewReuse = remediationArtifact.review_reuse as Record<string, unknown>;
        const expectedPreservedReviews = ['api', 'code', 'performance', 'refactor', 'security'];
        assert.equal(classification.category, 'test_coverage_only');
        assert.equal(classification.scope_category, 'previous_scope_only');
        assert.deepEqual(classification.invalidated_review_types, ['test']);
        assert.deepEqual(
            [...((classification.preserved_review_types as string[]) || [])].sort(),
            expectedPreservedReviews
        );
        assert.deepEqual(evidence.semantic_changed_files, [testFile]);
        assert.equal(evidence.semantic_scope_source, 'impact_analysis_files');
        assert.equal(evidence.test_refactor_trigger_reason, null);
        assert.deepEqual(
            [...((reviewReuse.reused_review_types as string[]) || [])].sort(),
            expectedPreservedReviews
        );
        assert.deepEqual(reviewReuse.launch_required_review_types, ['test']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle invalidates test-scoped refactor when existing test remediation exceeds the configured churn threshold', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-910-large-test-remediation-refactor';
        const sourceFile = 'src/app.ts';
        const testFile = 'tests/app.test.ts';
        const changedFiles = [sourceFile, testFile];
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'large-test-remediation-refactor');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle after large test-only remediation',
            plannedChangedFiles: changedFiles
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, sourceFile), 'export const value = 1;\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(repoRoot, testFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, testFile), 'it("works", () => {});\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle after large test-only remediation',
            changedFiles
        );
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

        for (const [reviewType, verdict] of [
            ['code', 'REVIEW PASSED'],
            ['refactor', 'REFACTOR REVIEW PASSED'],
            ['security', 'SECURITY REVIEW PASSED']
        ] as Array<[string, string]>) {
            seedReusableReviewEvidence(
                repoRoot,
                taskId,
                reviewType,
                verdict,
                preflightPath,
                path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`),
                `agent:${reviewType}-reviewer`
            );
        }

        fs.writeFileSync(
            path.join(repoRoot, testFile),
            Array.from({ length: 25 }, (_, index) => `it("covers path ${index}", () => { assert.equal(${index}, ${index}); });`).join('\n') + '\n',
            'utf8'
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles,
            impactAnalysis: [
                `Reviewer finding: test reviewer reported broad missing assertion coverage in ${testFile}.`,
                `Intended fix: edit ${testFile} only to add the missing assertions for the failed test review.`,
                `Affected files/contracts: ${testFile} is the only affected file; ${sourceFile} remains unchanged.`,
                'API/runtime/artifact/test impact: no API or runtime behavior change; only test coverage changes.',
                'Possible side effects: large test-domain churn should receive test-scoped refactor review without relaunching unchanged source lanes.',
                'Required targeted checks: focused review-cycle classification and reuse assertions cover threshold-triggered test refactor.',
                'Scope or review-type changes: review-type impact includes refactor and test; code and security remain reuse candidates.',
                'Related blockers/follow-up: no separate follow-up is needed because the remediation delta is limited to the failed test-review file.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const classification = remediationArtifact.remediation_fix_classification as Record<string, unknown>;
        const evidence = classification.evidence as Record<string, unknown>;
        const reviewReuse = remediationArtifact.review_reuse as Record<string, unknown>;
        assert.equal(classification.category, 'test_coverage_only');
        assert.deepEqual(classification.invalidated_review_types, ['refactor', 'test']);
        assert.deepEqual(
            [...((classification.preserved_review_types as string[]) || [])].sort(),
            ['code', 'security']
        );
        assert.equal(evidence.test_refactor_trigger_reason, 'test_domain_changed_lines_threshold');
        assert.equal(evidence.test_refactor_changed_lines_threshold, 20);
        assert.ok(Number(evidence.test_refactor_changed_lines_total) > 20);
        assert.deepEqual(
            [...((reviewReuse.reused_review_types as string[]) || [])].sort(),
            ['code', 'security']
        );
        assert.deepEqual(
            [...((reviewReuse.launch_required_review_types as string[]) || [])].sort(),
            ['refactor']
        );
        assert.deepEqual(
            [...((reviewReuse.pending_review_types as string[]) || [])].sort(),
            ['test']
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle ignores historical protected scope when remediation delta is test-only', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-906-protected-scope-test-only-remediation';
        const sourceFile = 'src/cli/commands/workflow/workflow-command-set.ts';
        const testFile = 'tests/node/reports/ui-dashboard-assets.test.ts';
        const changedFiles = [sourceFile, testFile];
        seedRemediationRepoBase(repoRoot);
        markAsSourceCheckout(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(
            repoRoot,
            'protected-scope-test-only-remediation'
        );

        fs.mkdirSync(path.dirname(path.join(repoRoot, sourceFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, sourceFile), 'export const previousRule = true;\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(repoRoot, testFile)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, testFile), 'it("renders previous UI state", () => {});\n', 'utf8');
        writeProtectedControlPlaneManifest(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot, 'Codex');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart failed test review after test-only remediation with protected historical scope',
            orchestratorWork: true,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(),
            plannedChangedFiles: changedFiles
        });
        assert.equal(taskModeResult.exitCode, 0, taskModeResult.outputLines.join('\n'));
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, sourceFile), 'export const previousRule = false;\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, testFile), 'it("renders the updated UI state", () => {});\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart failed test review after test-only remediation with protected historical scope',
            changedFiles
        );
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

        const upstreamReviews: Array<[string, string]> = [
            ['code', 'REVIEW PASSED'],
            ['refactor', 'REFACTOR REVIEW PASSED'],
            ['security', 'SECURITY REVIEW PASSED']
        ];
        for (const [reviewType, verdict] of upstreamReviews) {
            seedReusableReviewEvidence(
                repoRoot,
                taskId,
                reviewType,
                verdict,
                preflightPath,
                path.join(getReviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`),
                `agent:${reviewType}-reviewer`
            );
        }

        fs.writeFileSync(
            path.join(repoRoot, testFile),
            'it("renders the updated UI state", () => { assert.equal(1, 1); });\n',
            'utf8'
        );
        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles,
            impactAnalysis: [
                `Reviewer finding: test reviewer reported missing assertion coverage in ${testFile}.`,
                `Intended fix: edit ${testFile} only to add the missing assertion for the failed test review.`,
                `Affected files/contracts: ${testFile} is the only affected file; product contracts stay unchanged.`,
                `API/runtime/artifact/test impact: only test impact is expected from ${testFile}; runtime and artifacts stay unchanged.`,
                'Possible side effects: historical protected preflight scope must not force fresh upstream reviewers when the remediation delta is test-only.',
                'Required targeted checks: focused review-cycle classification and reuse assertions cover the protected historical scope path.',
                'Scope or review-type changes: review-type impact stays in test; code, security, and refactor remain reuse candidates.',
                'Related blockers/follow-up: no separate follow-up is needed because the remediation delta is limited to the failed test-review file.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const triggers = refreshedPreflight.triggers as Record<string, unknown>;
        assert.equal(triggers.protected_control_plane_changed, true);
        assert.deepEqual(triggers.changed_protected_files, [sourceFile]);

        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const classification = remediationArtifact.remediation_fix_classification as Record<string, unknown>;
        const evidence = classification.evidence as Record<string, unknown>;
        const reviewReuse = remediationArtifact.review_reuse as Record<string, unknown>;
        const expectedPreservedReviews = ['code', 'refactor', 'security'];
        assert.equal(classification.category, 'test_coverage_only');
        assert.equal(classification.scope_category, 'previous_scope_only');
        assert.doesNotMatch(String(classification.reason), /protected-control-plane changes/);
        assert.deepEqual(classification.invalidated_review_types, ['test']);
        assert.deepEqual(
            [...((classification.preserved_review_types as string[]) || [])].sort(),
            expectedPreservedReviews
        );
        assert.deepEqual(evidence.semantic_changed_files, [testFile]);
        assert.equal(evidence.semantic_scope_source, 'impact_analysis_files');
        assert.deepEqual(
            [...((reviewReuse.reused_review_types as string[]) || [])].sort(),
            expectedPreservedReviews
        );
        assert.deepEqual(reviewReuse.launch_required_review_types, ['test']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle emits semantic remediation classifications before reuse decisions', { concurrency: false }, async () => {
        const cases: Array<{
            suffix: string;
            changedFile?: string;
            impactAnalysis: string;
            expectedCategory: string;
            expectedReuseCandidate: boolean;
            expectedInvalidatedReviewTypes: string[];
            expectedPreservedReviewTypes: string[];
        }> = [
            {
                suffix: 'test-hooks',
                impactAnalysis: [
                    'Reviewer finding: failed review blocker requires isolating the _testHooks helper in src/app.ts.',
                    'Intended fix: constrain _testHooks exposure in src/app.ts without changing production behavior.',
                    'Affected files/contracts: src/app.ts is the affected file; public contracts stay unchanged.',
                    'API/runtime/artifact/test impact: test hook isolation only; no public contract or security impact is intended.',
                    'Possible side effects: review reuse must fail closed if unrelated behavior changes appear.',
                    'Required targeted checks: compile gate and review-cycle classification assertions cover the fix.',
                    'Scope or review-type changes: code review may be invalidated, but security and refactor remain candidates.',
                    'Related blockers/follow-up: no separate follow-up is needed for this isolated hook fix.'
                ].join(' '),
                expectedCategory: 'test_hook_isolation',
                expectedReuseCandidate: true,
                expectedInvalidatedReviewTypes: ['code'],
                expectedPreservedReviewTypes: ['refactor', 'security']
            },
            {
                suffix: 'protected-test-hooks',
                changedFile: 'garda-agent-orchestrator/src/cli/app.ts',
                impactAnalysis: [
                    'Reviewer finding: failed review blocker requires isolating the _testHooks helper in garda-agent-orchestrator/src/cli/app.ts.',
                    'Intended fix: constrain _testHooks exposure in the protected CLI control-plane file without changing production behavior.',
                    'Affected files/contracts: garda-agent-orchestrator/src/cli/app.ts is the affected file; public contracts stay unchanged.',
                    'API/runtime/artifact/test impact: test hook isolation only is intended, but protected-control-plane scope must still fail closed.',
                    'Possible side effects: stale security or refactor evidence could miss a protected control-plane regression.',
                    'Required targeted checks: compile gate and review-cycle classification assertions cover the fix.',
                    'Scope or review-type changes: protected control-plane scope invalidates all required review evidence before reuse.',
                    'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
                ].join(' '),
                expectedCategory: 'test_hook_isolation',
                expectedReuseCandidate: false,
                expectedInvalidatedReviewTypes: ['code', 'refactor', 'security'],
                expectedPreservedReviewTypes: []
            },
            {
                suffix: 'api-surface',
                impactAnalysis: [
                    'Reviewer finding: failed review blocker changes the public API surface in src/app.ts.',
                    'Intended fix: update the exported API contract in src/app.ts and refresh review evidence.',
                    'Affected files/contracts: src/app.ts is the affected file and its public API contract changes.',
                    'API/runtime/artifact/test impact: public API surface changes require fail-closed review handling.',
                    'Possible side effects: downstream callers may rely on the previous exported contract.',
                    'Required targeted checks: compile gate and review-cycle classification assertions cover the fix.',
                    'Scope or review-type changes: all affected review types must be reconsidered before reuse.',
                    'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
                ].join(' '),
                expectedCategory: 'api_surface',
                expectedReuseCandidate: false,
                expectedInvalidatedReviewTypes: ['code', 'refactor', 'security'],
                expectedPreservedReviewTypes: []
            },
            {
                suffix: 'security',
                impactAnalysis: [
                    'Reviewer finding: failed review blocker touches credential redaction in src/app.ts.',
                    'Intended fix: update security-sensitive token handling in src/app.ts.',
                    'Affected files/contracts: src/app.ts is the affected file and security-sensitive handling changes.',
                    'API/runtime/artifact/test impact: secret redaction evidence must be refreshed.',
                    'Possible side effects: leaked credentials would be a security regression.',
                    'Required targeted checks: compile gate and review-cycle classification assertions cover the fix.',
                    'Scope or review-type changes: security review must be fresh before any reuse decision.',
                    'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
                ].join(' '),
                expectedCategory: 'security_sensitive',
                expectedReuseCandidate: false,
                expectedInvalidatedReviewTypes: ['code', 'refactor', 'security'],
                expectedPreservedReviewTypes: []
            },
            {
                suffix: 'runtime-behavior',
                impactAnalysis: [
                    'Reviewer finding: failed review blocker changes observable runtime behavior in src/app.ts.',
                    'Intended fix: update the execution path in src/app.ts and require fresh review evidence.',
                    'Affected files/contracts: src/app.ts is the affected file and runtime behavior changes.',
                    'API/runtime/artifact/test impact: behavior change at runtime requires fail-closed review handling.',
                    'Possible side effects: existing callers may observe different runtime behavior.',
                    'Required targeted checks: compile gate and review-cycle classification assertions cover the fix.',
                    'Scope or review-type changes: all affected review types must be reconsidered before reuse.',
                    'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
                ].join(' '),
                expectedCategory: 'runtime_behavior',
                expectedReuseCandidate: false,
                expectedInvalidatedReviewTypes: ['code', 'refactor', 'security'],
                expectedPreservedReviewTypes: []
            },
            {
                suffix: 'structure-only',
                impactAnalysis: [
                    'Reviewer finding: failed review blocker requires refactor structure cleanup in src/app.ts.',
                    'Intended fix: extract internal helper structure in src/app.ts without changing behavior.',
                    'Affected files/contracts: src/app.ts is the affected file; public contracts stay unchanged.',
                    'Artifact/test impact: refactor structure only; no public contract or privileged handling impact is intended.',
                    'Possible side effects: structural decomposition should preserve existing outputs.',
                    'Required targeted checks: compile gate and review-cycle classification assertions cover the fix.',
                    'Scope or review-type changes: refactor review may be invalidated, but unrelated reviews remain candidates.',
                    'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
                ].join(' '),
                expectedCategory: 'refactor_structure',
                expectedReuseCandidate: true,
                expectedInvalidatedReviewTypes: ['refactor'],
                expectedPreservedReviewTypes: ['code', 'security']
            },
            {
                suffix: 'ambiguous',
                impactAnalysis: [
                    'Reviewer finding: failed review blocker mixes public API surface and refactor structure in src/app.ts.',
                    'Intended fix: update the public API surface while also changing internal decomposition.',
                    'Affected files/contracts: src/app.ts is the affected file and multiple contracts may shift.',
                    'API/runtime/artifact/test impact: public API surface and refactor structure evidence both matter.',
                    'Possible side effects: mixed semantic scope makes reuse unsafe.',
                    'Required targeted checks: compile gate and review-cycle classification assertions cover the fix.',
                    'Scope or review-type changes: fail closed because multiple review classes are implicated.',
                    'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
                ].join(' '),
                expectedCategory: 'unknown',
                expectedReuseCandidate: false,
                expectedInvalidatedReviewTypes: ['code', 'refactor', 'security'],
                expectedPreservedReviewTypes: []
            }
        ];

        for (const scenario of cases) {
            const repoRoot = createTempRepo();
            const taskId = `T-903b-remediation-classification-${scenario.suffix}`;
            const changedFile = scenario.changedFile || 'src/app.ts';
            seedRemediationRepoBase(repoRoot);
            writeReviewCapabilitiesConfig(repoRoot);
            writeProfilesConfig(repoRoot);
            const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, scenario.suffix);
            initializeGitRepo(repoRoot);
            seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
            seedInitAnswers(repoRoot, 'Codex');
            if (scenario.changedFile) {
                markAsSourceCheckout(repoRoot);
            }

            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: `Restart review cycle classifies ${scenario.suffix} remediation`,
                orchestratorWork: !!scenario.changedFile,
                operatorConfirmed: scenario.changedFile ? 'yes' : undefined,
                operatorConfirmedAtUtc: scenario.changedFile ? new Date().toISOString() : undefined,
                plannedChangedFiles: [changedFile]
            });
            loadTaskEntryRulePack(repoRoot, taskId);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);

            fs.mkdirSync(path.dirname(path.join(repoRoot, changedFile)), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, changedFile), 'export const value = 1;\n', 'utf8');
            const preflightPath = runExplicitPreflight(
                repoRoot,
                taskId,
                `Restart review cycle classifies ${scenario.suffix} remediation`,
                [changedFile]
            );
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

            fs.writeFileSync(path.join(repoRoot, changedFile), 'export const value = 2;\n', 'utf8');
            const restartResult = await runRestartReviewCycleCommand({
                repoRoot,
                taskId,
                preflightPath,
                commandsPath,
                outputFiltersPath,
                impactAnalysis: scenario.impactAnalysis,
                emitMetrics: false
            });
            assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

            const remediationArtifact = JSON.parse(fs.readFileSync(
                path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
                'utf8'
            )) as Record<string, unknown>;
            const classification = remediationArtifact.remediation_fix_classification as Record<string, unknown>;
            assert.equal(classification.category, scenario.expectedCategory);
            assert.equal(classification.scope_category, 'previous_scope_only');
            assert.equal(classification.non_test_review_reuse_candidate, scenario.expectedReuseCandidate);
            assert.deepEqual(classification.invalidated_review_types, scenario.expectedInvalidatedReviewTypes);
            assert.deepEqual(classification.preserved_review_types, scenario.expectedPreservedReviewTypes);
            assert.ok((classification.affected_file_groups as Record<string, unknown>).source);

            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('restart-review-cycle preserves previous source scope when explicit refresh lists only test remediation', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-explicit-subset';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-explicit-subset');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle preserves prior source scope when explicit remediation scope is narrow',
            plannedChangedFiles: ['src/app.ts', 'tests/app.test.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle preserves prior source scope when explicit remediation scope is narrow',
            ['src/app.ts']
        );
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

        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['tests/app.test.ts'],
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /DetectionSource: explicit_changed_files/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts', 'tests/app.test.ts']);
        assert.equal((refreshedPreflight.required_reviews as Record<string, boolean>).code, true);
        assert.equal((refreshedPreflight.required_reviews as Record<string, boolean>).test, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle normalizes Windows separators in explicit remediation scope', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-windows-separators';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-windows-separators');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle normalizes explicit Windows separator paths',
            plannedChangedFiles: ['src/app.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle normalizes explicit Windows separator paths',
            ['src/app.ts']
        );
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

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src\\app.ts'],
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /DetectionSource: explicit_changed_files/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts']);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).expanded_non_test_files,
            []
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle allows __tests__ files as test-only remediation expansion', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-dunder-tests';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-dunder-tests');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle treats __tests__ as test remediation scope',
            plannedChangedFiles: ['src/app.ts', 'src/__tests__/app-helper.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle treats __tests__ as test remediation scope',
            ['src/app.ts']
        );
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

        fs.mkdirSync(path.join(repoRoot, 'src', '__tests__'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', '__tests__', 'app-helper.ts'), 'export const ok = true;\n', 'utf8');

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts'],
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/__tests__/app-helper.ts', 'src/app.ts']);
        assert.equal((refreshedPreflight.required_reviews as Record<string, boolean>).test, true);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).allowed_test_only_expansion_files,
            ['src/__tests__/app-helper.ts']
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle uses classifier test regexes for non-JavaScript test expansion', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-classifier-test-regex';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-classifier-test-regex');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle uses classifier test regexes for remediation scope',
            plannedChangedFiles: ['src/app.ts', 'src/app.test.py']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle uses classifier test regexes for remediation scope',
            ['src/app.ts']
        );
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

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.test.py'), 'def test_app():\n    assert True\n', 'utf8');

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts'],
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.test.py', 'src/app.ts']);
        assert.equal((refreshedPreflight.required_reviews as Record<string, boolean>).test, true);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).allowed_test_only_expansion_files,
            ['src/app.test.py']
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle excludes dirty workspace baseline tests from explicit refresh expansion', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-baseline-test-exclusion';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-baseline-test-exclusion');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'baseline.test.ts'), 'it("unrelated", () => {});\n', 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle does not absorb dirty baseline test files',
            plannedChangedFiles: ['src/app.ts']
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle does not absorb dirty baseline test files',
            ['src/app.ts']
        );
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

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts'],
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /DetectionSource: explicit_changed_files/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts']);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).allowed_test_only_expansion_files,
            []
        );
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).expanded_files,
            ['tests/baseline.test.ts']
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle accepts an explicit ignored changelog remediation target named by the blocker', { concurrency: false }, async () => {
        const taskId = 'T-940-ignored-changelog-accepted';
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-accepted');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Added the failed-review release note.\n');
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        writeFailedIgnoredChangelogReviewRequest(repoRoot, taskId);
        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: [IGNORED_CHANGELOG_PATH],
            impactAnalysis: buildIgnoredChangelogImpactAnalysis(),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, [
            IGNORED_CHANGELOG_PATH,
            'src/app.ts'
        ]);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const ignoredTargets = remediationArtifact.ignored_remediation_targets as Record<string, unknown>;
        assert.equal(ignoredTargets.status, 'OK');
        assert.deepEqual(
            (ignoredTargets.targets as Array<Record<string, unknown>>).map((target) => target.path),
            [IGNORED_CHANGELOG_PATH]
        );
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).expanded_non_test_files,
            []
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle accepts a path-first ignored changelog blocker finding', { concurrency: false }, async () => {
        const taskId = 'T-940-ignored-changelog-path-first';
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-path-first');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Added the path-first failed-review release note.\n');
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        writeFailedIgnoredChangelogPathFirstReviewRequest(repoRoot, taskId);
        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: [IGNORED_CHANGELOG_PATH],
            impactAnalysis: buildIgnoredChangelogImpactAnalysis(),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.deepEqual(
            (remediationArtifact.ignored_remediation_targets as Record<string, unknown>).violations,
            []
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle accepts a root ignored changelog target named by a path-first blocker', { concurrency: false }, async () => {
        const taskId = 'T-940-root-ignored-changelog-path-first';
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(
            taskId,
            'root-ignored-changelog-path-first',
            ROOT_IGNORED_CHANGELOG_PATH
        );

        writeRepoFile(repoRoot, ROOT_IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Added the root ignored release note.\n');
        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        writeFailedIgnoredChangelogPathFirstReviewRequest(repoRoot, taskId, ROOT_IGNORED_CHANGELOG_PATH);
        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 1;\n');
        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: [ROOT_IGNORED_CHANGELOG_PATH],
            impactAnalysis: buildIgnoredChangelogImpactAnalysis(ROOT_IGNORED_CHANGELOG_PATH),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.ok((refreshedPreflight.changed_files as string[]).includes(ROOT_IGNORED_CHANGELOG_PATH));
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const targets = (remediationArtifact.ignored_remediation_targets as Record<string, unknown>)
            .targets as Array<Record<string, unknown>>;
        assert.deepEqual(targets.map((target) => target.path), [ROOT_IGNORED_CHANGELOG_PATH]);
        assert.equal(targets[0].sha256, fileSha256(path.join(repoRoot, ROOT_IGNORED_CHANGELOG_PATH)));
        assert.deepEqual(targets[0].approved_by, ['review_finding']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle accepts an ignored changelog remediation target approved by task plan', { concurrency: false }, async () => {
        const taskId = 'T-940-ignored-changelog-task-plan';
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(
            taskId,
            'ignored-changelog-task-plan',
            IGNORED_CHANGELOG_PATH,
            ['src/app.ts', IGNORED_CHANGELOG_PATH]
        );

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        writeFailedSourceOnlyReviewRequest(repoRoot, taskId);
        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 1;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Added the task-plan approved release note.\n');
        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: [IGNORED_CHANGELOG_PATH],
            impactAnalysis: buildIgnoredChangelogImpactAnalysis(),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.ok((refreshedPreflight.changed_files as string[]).includes(IGNORED_CHANGELOG_PATH));
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const targets = (remediationArtifact.ignored_remediation_targets as Record<string, unknown>)
            .targets as Array<Record<string, unknown>>;
        assert.deepEqual(targets.map((target) => target.path), [IGNORED_CHANGELOG_PATH]);
        assert.deepEqual(targets[0].approved_by, ['task_plan']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle rejects an explicit ignored file that is not approved by blocker evidence', { concurrency: false }, async () => {
        const taskId = 'T-940-ignored-changelog-unapproved';
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-unapproved');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Unapproved ignored release note.\n');
        const restartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', IGNORED_CHANGELOG_PATH],
            impactAnalysis: [
                'Reviewer finding: failed review requires a same-task remediation pass for src/app.ts.',
                'Intended fix: update only src/app.ts and preserve the original source boundary.',
                'Affected files and contracts: src/app.ts is the affected file and public contracts stay unchanged.',
                'API/runtime/artifact/test impact: runtime evidence and compile proof are refreshed for src/app.ts.',
                'Possible side effects: unrelated docs or artifacts must not be absorbed by review-cycle recovery.',
                'Required targeted checks: compile gate and review-cycle scope assertions cover the source fix.',
                'Scope or review-type changes: ignored artifacts are outside this failed-review remediation scope.',
                'Related blocker or follow-up decision: any release note work must be a separate follow-up.'
            ].join(' '),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        const output = restartResult.outputLines.join('\n');
        assert.match(output, /ignored remediation target .* is not approved/);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.equal(remediationArtifact.status, 'BLOCKED');
        assert.equal(remediationArtifact.reason, 'ignored_remediation_target_invalid');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle rejects ignored-only changed-file self-approval through impact analysis', { concurrency: false }, async () => {
        const taskId = 'T-940-ignored-changelog-impact-only';
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-impact-only');

        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Impact-only ignored release note.\n');
        const restartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: [IGNORED_CHANGELOG_PATH],
            impactAnalysis: buildIgnoredChangelogImpactAnalysis(),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(restartResult.outputLines.join('\n'), /ignored remediation target .* is not approved/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle ignores impact-analysis-only ignored path mentions outside changed scope', { concurrency: false }, async () => {
        const taskId = 'T-940-ignored-changelog-impact-mention-unchanged';
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-impact-mention-unchanged');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts'],
            impactAnalysis: [
                'Reviewer finding: failed review requires a same-task remediation pass for src/app.ts.',
                'Intended fix: update only src/app.ts and preserve the original source boundary.',
                'Affected files and contracts: src/app.ts is the affected file and public contracts stay unchanged.',
                'API/runtime/artifact/test impact: runtime evidence and compile proof are refreshed for src/app.ts.',
                `Possible side effects: do not update ${IGNORED_CHANGELOG_PATH}; release notes stay outside this remediation.`,
                'Required targeted checks: compile gate and review-cycle scope assertions cover the source fix.',
                'Scope or review-type changes: ignored artifacts are outside this failed-review remediation scope.',
                'Related blocker or follow-up decision: any release note work must be a separate follow-up.'
            ].join(' '),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle ignores generated review markdown when approving ignored remediation targets', { concurrency: false }, async () => {
        const taskId = 'T-940-ignored-changelog-generated-context-only';
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-generated-context-only');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Context-only ignored release note.\n');
        fs.writeFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.md`),
            [
                '# Generated Review Context',
                '',
                `This generated handoff mentions ${IGNORED_CHANGELOG_PATH}, but it is not the failed review output.`
            ].join('\n'),
            'utf8'
        );

        const restartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', IGNORED_CHANGELOG_PATH],
            impactAnalysis: [
                'Reviewer finding: failed review requires a same-task remediation pass for src/app.ts.',
                'Intended fix: update only src/app.ts and preserve the original source boundary.',
                'Affected files and contracts: src/app.ts is the affected file and public contracts stay unchanged.',
                'API/runtime/artifact/test impact: runtime evidence and compile proof are refreshed for src/app.ts.',
                'Possible side effects: generated review context must not approve ignored remediation targets.',
                'Required targeted checks: restart-review-cycle rejects context-only ignored-file mentions.',
                'Scope or review-type changes: ignored artifacts are outside this failed-review remediation scope.',
                'Related blocker or follow-up decision: any release note work must be a separate follow-up.'
            ].join(' '),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(restartResult.outputLines.join('\n'), /ignored remediation target .* is not approved/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle rejects ignored paths mentioned only as failed-review diagnostics', { concurrency: false }, async () => {
        const taskId = 'T-940-ignored-changelog-diagnostic-only';
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-diagnostic-only');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Diagnostic-only ignored release note.\n');
        writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'CODE REVIEW FAILED', [
            '# Code Review',
            '',
            `Diagnostic reproduction: the resolver accepted ${IGNORED_CHANGELOG_PATH} when it appeared in unrelated context text.`,
            '',
            '## Findings by Severity',
            'High: restrict ignored remediation approval to actionable failed-review requests and guarded evidence.',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'CODE REVIEW FAILED'
        ]);

        const restartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', IGNORED_CHANGELOG_PATH],
            impactAnalysis: [
                'Reviewer finding: failed review requires a same-task remediation pass for src/app.ts.',
                'Intended fix: update only src/app.ts and preserve the original source boundary.',
                'Affected files and contracts: src/app.ts is the affected file and public contracts stay unchanged.',
                'API/runtime/artifact/test impact: runtime evidence and compile proof are refreshed for src/app.ts.',
                'Possible side effects: diagnostic examples in failed reviews must not approve ignored paths.',
                'Required targeted checks: restart-review-cycle rejects diagnostic-only ignored-file mentions.',
                'Scope or review-type changes: ignored artifacts are outside this failed-review remediation scope.',
                'Related blocker or follow-up decision: any release note work must be a separate follow-up.'
            ].join(' '),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(restartResult.outputLines.join('\n'), /ignored remediation target .* is not approved/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle rejects ignored paths mentioned only in failed-review examples', { concurrency: false }, async () => {
        const taskId = 'T-940-ignored-changelog-example-only';
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-example-only');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Example-only ignored release note.\n');
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        writeFailedIgnoredChangelogExampleOnlyReviewRequest(repoRoot, taskId);
        const restartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', IGNORED_CHANGELOG_PATH],
            impactAnalysis: [
                'Reviewer finding: failed review requires a same-task remediation pass for src/app.ts.',
                'Intended fix: update only src/app.ts and preserve the original source boundary.',
                'Affected files and contracts: src/app.ts is the affected file and public contracts stay unchanged.',
                'API/runtime/artifact/test impact: runtime evidence and compile proof are refreshed for src/app.ts.',
                'Possible side effects: example wording in failed reviews must not approve ignored paths.',
                'Required targeted checks: restart-review-cycle rejects example-only ignored-file mentions.',
                'Scope or review-type changes: ignored artifacts are outside this failed-review remediation scope.',
                'Related blocker or follow-up decision: any release note work must be a separate follow-up.'
            ].join(' '),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(restartResult.outputLines.join('\n'), /ignored remediation target .* is not approved/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle rejects negated failed-review ignored path mentions', { concurrency: false }, async () => {
        const taskId = 'T-940-ignored-changelog-negated-review';
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-negated-review');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Negated ignored release note.\n');
        writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'CODE REVIEW FAILED', [
            '# Code Review',
            '',
            `Do not update ${IGNORED_CHANGELOG_PATH}; remove this ignored release-note change from the remediation scope.`,
            '',
            '## Findings by Severity',
            'High: keep ignored release-note artifacts outside this failed-review remediation.',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'CODE REVIEW FAILED'
        ]);

        const restartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', IGNORED_CHANGELOG_PATH],
            impactAnalysis: [
                'Reviewer finding: failed review requires a same-task remediation pass for src/app.ts.',
                'Intended fix: update only src/app.ts and preserve the original source boundary.',
                'Affected files and contracts: src/app.ts is the affected file and public contracts stay unchanged.',
                'API/runtime/artifact/test impact: runtime evidence and compile proof are refreshed for src/app.ts.',
                'Possible side effects: negated failed-review text must not approve ignored paths.',
                'Required targeted checks: restart-review-cycle rejects negated ignored-file mentions.',
                'Scope or review-type changes: ignored artifacts are outside this failed-review remediation scope.',
                'Related blocker or follow-up decision: any release note work must be a separate follow-up.'
            ].join(' '),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(restartResult.outputLines.join('\n'), /ignored remediation target .* is not approved/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle accepts current guarded hash evidence for an ignored remediation target', { concurrency: false }, async () => {
        const taskId = 'T-940-ignored-changelog-current-guard';
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-current-guard');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        writeFailedSourceOnlyReviewRequest(repoRoot, taskId);
        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 1;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Updated with guarded hash evidence.\n');
        const currentSha256 = fileSha256(path.join(repoRoot, ...IGNORED_CHANGELOG_PATH.split('/')));
        const impactAnalysisPath = path.join(getReviewsRoot(repoRoot), `${taskId}-impact-analysis.json`);
        fs.writeFileSync(impactAnalysisPath, JSON.stringify({
            'reviewer finding': 'failed review requires source remediation; guarded ignored-file evidence supplies release-note scope',
            'intended fix': `carry the ignored changelog remediation target ${IGNORED_CHANGELOG_PATH} only through guarded current hash evidence`,
            'affected files and contracts': `${IGNORED_CHANGELOG_PATH} is the affected artifact; runtime contracts stay unchanged`,
            'api/runtime/artifact/test impact': `artifact impact is limited to ${IGNORED_CHANGELOG_PATH} with compile evidence refreshed`,
            'possible side effects': 'review reuse must fail closed if guarded ignored-file evidence is stale or hashless',
            'required targeted checks': 'restart-review-cycle must accept a matching guarded ignored-file hash',
            'scope or review-type changes': 'the ignored changelog is in scope only with current guarded hash evidence',
            'related blocker or follow-up decision': 'no follow-up is needed for current guarded evidence',
            ignored_remediation_targets: [
                {
                    path: IGNORED_CHANGELOG_PATH,
                    sha256: currentSha256,
                    reason: 'current guarded evidence approves ignored remediation'
                }
            ]
        }, null, 2), 'utf8');

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: [IGNORED_CHANGELOG_PATH],
            impactAnalysisPath,
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.ok((refreshedPreflight.changed_files as string[]).includes(IGNORED_CHANGELOG_PATH));
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        const targets = (remediationArtifact.ignored_remediation_targets as Record<string, unknown>)
            .targets as Array<Record<string, unknown>>;
        assert.deepEqual(targets.map((target) => target.path), [IGNORED_CHANGELOG_PATH]);
        assert.equal(targets[0].sha256, currentSha256);
        assert.deepEqual(targets[0].approved_by, ['guarded_remediation_evidence']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle rejects stale guarded hash evidence for an ignored remediation target', { concurrency: false }, async () => {
        const taskId = 'T-940-ignored-changelog-stale-hash';
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-stale-hash');
        const oldSha256 = fileSha256(path.join(repoRoot, ...IGNORED_CHANGELOG_PATH.split('/')));
        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Updated after hash capture.\n');
        const impactAnalysisPath = path.join(getReviewsRoot(repoRoot), `${taskId}-impact-analysis.json`);
        fs.writeFileSync(impactAnalysisPath, JSON.stringify({
            'reviewer finding': `failed review requires release-note remediation in ${IGNORED_CHANGELOG_PATH}`,
            'intended fix': `update the ignored changelog remediation target ${IGNORED_CHANGELOG_PATH}`,
            'affected files and contracts': `${IGNORED_CHANGELOG_PATH} and src/app.ts are the affected files; runtime contracts stay unchanged`,
            'api/runtime/artifact/test impact': `artifact impact is limited to ${IGNORED_CHANGELOG_PATH} with compile evidence refreshed`,
            'possible side effects': 'review reuse must fail closed if guarded ignored-file evidence is stale',
            'required targeted checks': 'restart-review-cycle must validate the ignored file hash before preflight refresh',
            'scope or review-type changes': 'the ignored changelog is in scope only with current guarded hash evidence',
            'related blocker or follow-up decision': 'no follow-up is needed for current guarded evidence',
            ignored_remediation_targets: [
                {
                    path: IGNORED_CHANGELOG_PATH,
                    sha256: oldSha256,
                    reason: 'failed review requested changelog remediation'
                }
            ]
        }, null, 2), 'utf8');

        const restartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', IGNORED_CHANGELOG_PATH],
            impactAnalysisPath,
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(restartResult.outputLines.join('\n'), /ignored remediation target hash mismatch/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle rejects hashless guarded evidence for an ignored remediation target', { concurrency: false }, async () => {
        const taskId = 'T-940-ignored-changelog-hashless-guard';
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-hashless-guard');
        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Updated without guarded hash.\n');
        const impactAnalysisPath = path.join(getReviewsRoot(repoRoot), `${taskId}-impact-analysis.json`);
        fs.writeFileSync(impactAnalysisPath, JSON.stringify({
            'reviewer finding': `failed review requires release-note remediation in ${IGNORED_CHANGELOG_PATH}`,
            'intended fix': `update the ignored changelog remediation target ${IGNORED_CHANGELOG_PATH}`,
            'affected files and contracts': `${IGNORED_CHANGELOG_PATH} and src/app.ts are the affected files; runtime contracts stay unchanged`,
            'api/runtime/artifact/test impact': `artifact impact is limited to ${IGNORED_CHANGELOG_PATH} with compile evidence refreshed`,
            'possible side effects': 'review reuse must fail closed if guarded ignored-file evidence is missing a hash',
            'required targeted checks': 'restart-review-cycle must require a current hash for guarded ignored-file evidence',
            'scope or review-type changes': 'the ignored changelog is in scope only with current guarded hash evidence',
            'related blocker or follow-up decision': 'no follow-up is needed for current guarded evidence',
            ignored_remediation_targets: [
                {
                    path: IGNORED_CHANGELOG_PATH,
                    reason: 'hashless guarded evidence must not approve ignored remediation'
                }
            ]
        }, null, 2), 'utf8');

        const restartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', IGNORED_CHANGELOG_PATH],
            impactAnalysisPath,
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(restartResult.outputLines.join('\n'), /guarded evidence must include current sha256/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle refreshes mixed tracked and explicit ignored remediation scope', { concurrency: false }, async () => {
        const taskId = 'T-940-ignored-changelog-mixed';
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'ignored-changelog-mixed');

        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 3;\n');
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Documented the source remediation.\n');
        writeFailedIgnoredChangelogReviewRequest(repoRoot, taskId);
        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            changedFiles: ['src/app.ts', IGNORED_CHANGELOG_PATH],
            impactAnalysis: [
                `Reviewer finding: failed review requires source remediation in src/app.ts and release-note remediation in ${IGNORED_CHANGELOG_PATH}.`,
                `Intended fix: update src/app.ts and the explicit ignored changelog ${IGNORED_CHANGELOG_PATH}.`,
                `Affected files/contracts: src/app.ts and ${IGNORED_CHANGELOG_PATH} are affected while public contracts stay unchanged.`,
                'API/runtime/artifact/test impact: runtime evidence comes from src/app.ts and artifact evidence comes from the ignored changelog.',
                'Possible side effects: review reuse must fail closed if source behavior or ignored artifact evidence drifts.',
                'Required targeted checks: compile gate and review-cycle scope assertions cover the mixed remediation.',
                'Scope or review-type changes: refreshed preflight must include both tracked and explicit ignored files.',
                'Related blockers/follow-up: both changes resolve the same failed-review blocker.'
            ].join(' '),
            emitMetrics: false
        });

        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, [
            IGNORED_CHANGELOG_PATH,
            'src/app.ts'
        ]);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.deepEqual(
            (remediationArtifact.ignored_remediation_targets as Record<string, unknown>).violations,
            []
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('next-step includes explicit ignored changelog remediation in failed-review restart command', { concurrency: false }, async () => {
        const taskId = 'T-940-next-step-ignored-changelog';
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'next-step-ignored-changelog');
        void commandsPath;
        void outputFiltersPath;
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Added reviewer-requested note.\n');
        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        writeFailedIgnoredChangelogPathFirstReviewRequest(repoRoot, taskId);
        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 1;\n');

        const nextStep = resolveNextStep({ taskId, repoRoot });
        const commandText = nextStep.commands.map((command) => command.command).join('\n');
        assert.match(commandText, /restart-review-cycle/);
        assert.match(commandText, new RegExp(`--changed-file "${IGNORED_CHANGELOG_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('next-step does not include example-only ignored changelog mentions in failed-review restart command', { concurrency: false }, async () => {
        const taskId = 'T-940-next-step-example-only-ignored-changelog';
        const {
            repoRoot,
            preflightPath,
            commandsPath,
            outputFiltersPath
        } = await prepareIgnoredChangelogFixture(taskId, 'next-step-example-only-ignored-changelog');
        void commandsPath;
        void outputFiltersPath;
        writeRepoFile(repoRoot, IGNORED_CHANGELOG_PATH, '# Changelog\n\n- Example-only reviewer note.\n');
        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 2;\n');
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        writeFailedIgnoredChangelogExampleOnlyReviewRequest(repoRoot, taskId);
        writeRepoFile(repoRoot, 'src/app.ts', 'export const value = 1;\n');

        const nextStep = resolveNextStep({ taskId, repoRoot });
        const commandText = nextStep.commands.map((command) => command.command).join('\n');
        assert.match(commandText, /restart-review-cycle/);
        assert.doesNotMatch(
            commandText,
            new RegExp(`--changed-file "${IGNORED_CHANGELOG_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});

import {
    EXIT_GATE_FAILURE,
    assert,
    createTempRepo,
    describe,
    findLastTimelineEventIndex,
    fs,
    getReviewsRoot,
    initializeGitRepo,
    it,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    markAsSourceCheckout,
    path,
    readTaskTimelineEvents,
    runCompileGateCommand,
    runEnterTaskMode,
    runExplicitPreflight,
    runHandshakeForTask,
    runRestartReviewCycleCommand,
    runShellSmokeForTask,
    seedInitAnswers,
    seedRemediationRepoBase,
    seedReusableReviewEvidence,
    seedTaskQueue,
    writeProfilesConfig,
    writeReviewCapabilitiesConfig,
    writeSimpleCompileCommandsFile
} from './gates-review-cycle-fixtures';

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
        assert.equal(handshakeIndexes.length, 1);
        assert.equal(shellSmokeIndexes.length, 1);
        assert.ok(firstCompileIndex >= 0);
        assert.ok(firstCompileIndex > lastHandshakeIndex);
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
            changedFiles: ['src/app.ts'],
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
});

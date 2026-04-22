import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    EXIT_GATE_FAILURE,
    EXIT_GENERAL_FAILURE
} from '../../../../src/cli/exit-codes';
import {
    buildGateHelpText,
    buildTaskIdSyntaxRemediationMessage
} from '../../../../src/cli/commands/gate-command-help';
import { getAllShimmedGateNames } from '../../../../src/compat/shim-registry';
import * as gateReviewHandlers from '../../../../src/cli/commands/gate-review-handlers';
import {
    runCompileGateCommand,
    runDocImpactGateCommand,
    runHumanCommitCommand,
    runLogTaskEventCommand,
    runRequiredReviewsCheckCommand,
    splitCommandLine,
    executeCommand,
    executeCommandAsync
} from '../../../../src/cli/commands/gates';
import {
    runCliMainWithHandling
} from '../../../../src/cli/main';
import { runCompletionGate } from '../../../../src/gates/completion';
import {
    applyReviewerRoutingMetadata
} from '../../../../src/gate-runtime/review-context';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { writeOptionalSkillSelectionArtifact } from '../../../../src/runtime/optional-skill-selection';
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
    ageFixturePath
} from './gate-test-helpers';

const TASK_ID_REMEDIATION_GATE_NAMES = Object.freeze([
    'enter-task-mode',
    'load-rule-pack',
    'record-no-op',
    'handshake-diagnostics',
    'shell-smoke-preflight',
    'command-timeout-diagnostics',
    'classify-change',
    'restart-coherent-cycle',
    'restart-review-cycle',
    'compile-gate',
    'activate-optional-skill',
    'required-reviews-check',
    'doc-impact-gate',
    'full-suite-validation',
    'record-review-result',
    'record-review-routing',
    'record-review-receipt',
    'completion-gate',
    'log-task-event',
    'task-events-summary',
    'task-audit-summary'
]);

function stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function getSourceCheckoutNestedCwd(): string {
    return path.join(path.resolve('.'), 'src', 'cli');
}

async function recordReviewRoutingViaCli(options: {
    taskId: string;
    reviewType: string;
    repoRoot: string;
    reviewerExecutionMode: 'delegated_subagent' | 'same_agent_fallback';
    reviewerIdentity: string;
    reviewerFallbackReason?: string;
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
    it('splits quoted command lines', () => {
        assert.deepEqual(
            splitCommandLine('node -e "console.log(\'ok\')"'),
            ['node', '-e', "console.log('ok')"]
        );
    });

    it('preserves backslashes in quoted Windows executable paths', () => {
        assert.deepEqual(
            splitCommandLine('"C:\\Program Files\\nodejs\\npm.cmd" --version'),
            ['C:\\Program Files\\nodejs\\npm.cmd', '--version']
        );
    });

    it('prints gate subcommand help without triggering required-argument validation', async () => {
        const sourceCheckoutNestedCwd = getSourceCheckoutNestedCwd();
        const helpCases: Array<{ argv: string[]; expectedSnippets: string[] }> = [
            {
                argv: ['gate', 'enter-task-mode', '--help'],
                expectedSnippets: ['gate enter-task-mode', '--task-id "<task-id>"', '--routed-to "<provider-bridge-or-entrypoint>"']
            },
            {
                argv: ['gate', 'build-review-context', '--help'],
                expectedSnippets: ['gate build-review-context', '--review-type "<code|db|security|refactor|api|test|performance|infra|dependency>"', '--preflight-path']
            },
            {
                argv: ['gate', 'activate-optional-skill', '--help'],
                expectedSnippets: ['gate activate-optional-skill', '--task-id "<task-id>"', '--skill-id "<selected-skill-id>"']
            },
            {
                argv: ['gate', 'completion-gate', '--help'],
                expectedSnippets: ['gate completion-gate', '--task-id "<task-id>"', '--preflight-path']
            },
            {
                argv: ['gate', 'full-suite-validation', '--help'],
                expectedSnippets: ['gate full-suite-validation', '--task-id "<task-id>"', '--preflight-path']
            }
        ];

        for (const helpCase of helpCases) {
            const result = await runCliWithCapturedOutput(helpCase.argv, { cwd: sourceCheckoutNestedCwd });
            assert.equal(result.exitCode, 0, helpCase.argv.join(' '));
            assert.equal(result.errors.length, 0, helpCase.argv.join(' '));
            const combinedOutput = result.logs.join('\n');
            for (const snippet of helpCase.expectedSnippets) {
                assert.ok(combinedOutput.includes(snippet), `${helpCase.argv.join(' ')} must include '${snippet}'`);
            }
        }
    });

    it('prints help successfully for every public gate subcommand', async () => {
        const sourceCheckoutNestedCwd = getSourceCheckoutNestedCwd();
        for (const gateName of getAllShimmedGateNames()) {
            const result = await runCliWithCapturedOutput(['gate', gateName, '--help'], { cwd: sourceCheckoutNestedCwd });
            assert.equal(result.exitCode, 0, gateName);
            assert.equal(result.errors.length, 0, gateName);
            const combinedOutput = result.logs.join('\n');
            assert.ok(combinedOutput.includes(`gate ${gateName}`), gateName);
            assert.ok(combinedOutput.includes('Usage'), gateName);
            assert.ok(!combinedOutput.includes('TaskId must not be empty'), gateName);
            assert.ok(!combinedOutput.includes('ReviewType must not be empty'), gateName);
        }
    });

    it('prints canonical --task-id remediation for common task-start flag mistakes', async () => {
        const sourceCheckoutNestedCwd = getSourceCheckoutNestedCwd();
        const flagResult = await runCliWithCapturedOutput(['gate', 'enter-task-mode', '--task', 'T-008'], { cwd: sourceCheckoutNestedCwd });
        assert.notEqual(flagResult.exitCode, 0);
        const flagErrorOutput = flagResult.errors.join('\n');
        assert.ok(flagErrorOutput.includes('GARDA_CLI_FAILED'));
        assert.ok(flagErrorOutput.includes("uses '--task-id', not '--task'"));
        assert.ok(flagErrorOutput.includes('Suggested command: node bin/garda.js gate enter-task-mode --task-id "T-008"'));

        const equalsFlagResult = await runCliWithCapturedOutput(['gate', 'enter-task-mode', '--task=T-008'], { cwd: sourceCheckoutNestedCwd });
        assert.notEqual(equalsFlagResult.exitCode, 0);
        const equalsFlagErrorOutput = equalsFlagResult.errors.join('\n');
        assert.ok(equalsFlagErrorOutput.includes('GARDA_CLI_FAILED'));
        assert.ok(equalsFlagErrorOutput.includes("uses '--task-id', not '--task'"));
        assert.ok(equalsFlagErrorOutput.includes('Suggested command: node bin/garda.js gate enter-task-mode --task-id "T-008"'));

        const positionalResult = await runCliWithCapturedOutput(['gate', 'load-rule-pack', 'T-008'], { cwd: sourceCheckoutNestedCwd });
        assert.notEqual(positionalResult.exitCode, 0);
        const positionalErrorOutput = positionalResult.errors.join('\n');
        assert.ok(positionalErrorOutput.includes('GARDA_CLI_FAILED'));
        assert.ok(positionalErrorOutput.includes('requires \'--task-id "<task-id>"\', not a positional task id'));
        assert.ok(positionalErrorOutput.includes('Suggested command: node bin/garda.js gate load-rule-pack --task-id "T-008"'));

        const booleanPrefixedResult = await runCliWithCapturedOutput([
            'gate',
            'task-events-summary',
            '--as-json',
            'T-008'
        ], { cwd: sourceCheckoutNestedCwd });
        assert.notEqual(booleanPrefixedResult.exitCode, 0);
        const booleanPrefixedErrorOutput = booleanPrefixedResult.errors.join('\n');
        assert.ok(booleanPrefixedErrorOutput.includes('GARDA_CLI_FAILED'));
        assert.ok(booleanPrefixedErrorOutput.includes('requires \'--task-id "<task-id>"\', not a positional task id'));
        assert.ok(booleanPrefixedErrorOutput.includes('Suggested command: node bin/garda.js gate task-events-summary --task-id "T-008"'));

        const emitMetricsResult = await runCliWithCapturedOutput([
            'gate',
            'enter-task-mode',
            '--emit-metrics',
            'T-008'
        ], { cwd: sourceCheckoutNestedCwd });
        assert.notEqual(emitMetricsResult.exitCode, 0);
        const emitMetricsErrorOutput = emitMetricsResult.errors.join('\n');
        assert.ok(emitMetricsErrorOutput.includes('GARDA_CLI_FAILED'));
        assert.ok(emitMetricsErrorOutput.includes('requires \'--task-id "<task-id>"\', not a positional task id'));
        assert.ok(emitMetricsErrorOutput.includes('Suggested command: node bin/garda.js gate enter-task-mode --task-id "T-008"'));
    });

    it('prints canonical --task-id remediation for every gate that requires task-id syntax', async () => {
        const sourceCheckoutNestedCwd = getSourceCheckoutNestedCwd();
        for (const gateName of TASK_ID_REMEDIATION_GATE_NAMES) {
            const result = await runCliWithCapturedOutput(['gate', gateName, '--task=T-008'], { cwd: sourceCheckoutNestedCwd });
            assert.notEqual(result.exitCode, 0, gateName);
            const errorOutput = result.errors.join('\n');
            assert.ok(errorOutput.includes('GARDA_CLI_FAILED'), gateName);
            assert.ok(errorOutput.includes("uses '--task-id', not '--task'"), gateName);
            assert.ok(errorOutput.includes(`Canonical task-id syntax for '${gateName}'`), gateName);
            assert.ok(errorOutput.includes(`Suggested command: node bin/garda.js gate ${gateName} --task-id "T-008"`), gateName);
            const suggestedLine = errorOutput
                .split('\n')
                .find((line) => line.startsWith('Suggested command:')) ?? '';
            assert.ok(!suggestedLine.includes('<task-id>'), gateName);
        }
    });

    it('keeps source-checkout help and remediation snippets canonical from nested cwd values', async () => {
        const nestedSourceCwd = path.join(path.resolve('.'), 'src', 'cli');

        const helpResult = await runCliWithCapturedOutput(
            ['gate', 'enter-task-mode', '--help'],
            { cwd: nestedSourceCwd }
        );
        assert.equal(helpResult.exitCode, 0);
        const helpOutput = helpResult.logs.join('\n');
        assert.ok(helpOutput.includes('node bin/garda.js gate enter-task-mode --task-id "<task-id>"'));
        assert.ok(!helpOutput.includes('node garda-agent-orchestrator/bin/garda.js gate enter-task-mode'));

        const remediationResult = await runCliWithCapturedOutput(
            ['gate', 'enter-task-mode', '--task', 'T-008'],
            { cwd: nestedSourceCwd }
        );
        assert.notEqual(remediationResult.exitCode, 0);
        const remediationOutput = remediationResult.errors.join('\n');
        assert.ok(remediationOutput.includes('Suggested command: node bin/garda.js gate enter-task-mode --task-id "T-008"'));
        assert.ok(!remediationOutput.includes('Suggested command: node garda-agent-orchestrator/bin/garda.js'));
    });

    it('uses deployed-workspace CLI prefixes for help and remediation outside a source checkout', () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-help-bundle-'));
        const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        const nestedCwd = path.join(workspaceRoot, 'packages', 'feature');

        fs.mkdirSync(path.join(bundleRoot, 'bin'), { recursive: true });
        fs.mkdirSync(nestedCwd, { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n', 'utf8');
        fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');
        fs.writeFileSync(path.join(bundleRoot, 'bin', 'garda.js'), '// test fixture\n', 'utf8');

        try {
            const helpOutput = stripAnsi(buildGateHelpText('enter-task-mode', nestedCwd));
            assert.ok(helpOutput.includes('node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>"'));
            assert.ok(!helpOutput.includes('node bin/garda.js gate enter-task-mode --task-id "<task-id>"'));

            const remediationOutput = stripAnsi(buildTaskIdSyntaxRemediationMessage('enter-task-mode', ['--task=T-008'], nestedCwd) || '');
            assert.ok(remediationOutput);
            assert.ok(remediationOutput.includes('Suggested command: node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "T-008"'));
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('renders help paths with the configured bundle name instead of hardcoding the default bundle', { concurrency: false }, async () => {
        const previousBundleName = process.env.GARDA_BUNDLE_NAME;
        process.env.GARDA_BUNDLE_NAME = 'custom-garda-bundle';
        try {
            const helpOutput = stripAnsi(buildGateHelpText('load-rule-pack', path.resolve('.')));
            assert.ok(helpOutput.includes('custom-garda-bundle/live/docs/agent-rules/00-core.md'));
            assert.ok(helpOutput.includes('custom-garda-bundle/runtime/reviews/<task-id>-preflight.json'));
            assert.ok(!helpOutput.includes('garda-agent-orchestrator/live/docs/agent-rules/00-core.md'));
        } finally {
            if (previousBundleName == null) {
                delete process.env.GARDA_BUNDLE_NAME;
            } else {
                process.env.GARDA_BUNDLE_NAME = previousBundleName;
            }
        }
    });

    it('does not treat --help as a standalone help request when it is a string option value', async () => {
        const sourceCheckoutNestedCwd = getSourceCheckoutNestedCwd();
        const result = await runCliWithCapturedOutput([
            'gate',
            'validate-config',
            '--config-path',
            '--help'
        ], { cwd: sourceCheckoutNestedCwd });

        assert.notEqual(result.exitCode, 0);
        assert.equal(result.logs.length, 0);
        const errorOutput = result.errors.join('\n');
        assert.ok(errorOutput.includes('GARDA_CLI_FAILED'));
        assert.ok(!errorOutput.includes('Gate: validate-config'));
        assert.ok(errorOutput.includes('Unknown option: --config-path') || errorOutput.includes('ConfigPath'));
    });

    it('treats trailing --help after --task-id as gate help for malformed task-start invocations', async () => {
        const sourceCheckoutNestedCwd = getSourceCheckoutNestedCwd();
        const enterTaskModeResult = await runCliWithCapturedOutput([
            'gate',
            'enter-task-mode',
            '--task-id',
            '--help'
        ], { cwd: sourceCheckoutNestedCwd });
        assert.equal(enterTaskModeResult.exitCode, 0);
        assert.equal(enterTaskModeResult.errors.length, 0);
        const enterTaskModeOutput = enterTaskModeResult.logs.join('\n');
        assert.ok(enterTaskModeOutput.includes('gate enter-task-mode'));
        assert.ok(enterTaskModeOutput.includes('Usage'));
        assert.ok(!enterTaskModeOutput.includes('legacy_fallback'));

        const loadRulePackResult = await runCliWithCapturedOutput([
            'gate',
            'load-rule-pack',
            '--task-id',
            '--help'
        ], { cwd: sourceCheckoutNestedCwd });
        assert.equal(loadRulePackResult.exitCode, 0);
        assert.equal(loadRulePackResult.errors.length, 0);
        const loadRulePackOutput = loadRulePackResult.logs.join('\n');
        assert.ok(loadRulePackOutput.includes('gate load-rule-pack'));
        assert.ok(loadRulePackOutput.includes('Usage'));
        assert.ok(!loadRulePackOutput.includes('RULE_PACK_LOAD_FAILED'));
    });

    it('keeps POST_PREFLIGHT help generic instead of hardcoding one downstream rule-pack shape', async () => {
        const result = await runCliWithCapturedOutput(['gate', 'load-rule-pack', '--help'], { cwd: getSourceCheckoutNestedCwd() });
        assert.equal(result.exitCode, 0);
        const combinedOutput = result.logs.join('\n');
        assert.ok(combinedOutput.includes('<task-specific-downstream-rule-file>'));
        assert.ok(combinedOutput.includes('<additional-task-specific-rule-file>'));
        assert.ok(!combinedOutput.includes('50-structure-and-docs.md'));
        assert.ok(!combinedOutput.includes('70-security.md'));
    });

    it('does not emit task-id remediation for gates that do not accept --task-id', async () => {
        const result = await runCliWithCapturedOutput(['gate', 'build-review-context', 'T-008'], { cwd: getSourceCheckoutNestedCwd() });
        assert.notEqual(result.exitCode, 0);
        const errorOutput = result.errors.join('\n');
        assert.ok(errorOutput.includes('GARDA_CLI_FAILED'));
        assert.ok(errorOutput.includes('Unexpected positional argument: T-008'));
        assert.ok(!errorOutput.includes('Canonical task-id syntax'));
        assert.ok(!errorOutput.includes('Suggested command:'));
    });

    it('lists every public gate in root gate help output', async () => {
        const result = await runCliWithCapturedOutput(['gate', '--help'], { cwd: getSourceCheckoutNestedCwd() });
        assert.equal(result.exitCode, 0);
        assert.equal(result.errors.length, 0);
        const combinedOutput = result.logs.join('\n');
        assert.ok(combinedOutput.includes('record-no-op'));
        assert.ok(combinedOutput.includes('task-audit-summary'));
    });

    it('runs compile gate and writes evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(taskModeResult.outputLines[0], 'TASK_MODE_ENTERED');
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_PASSED');
        assert.equal(evidence.status, 'PASSED');
        assert.equal(evidence.event_source, 'compile-gate');
        assert.ok(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'IMPLEMENTATION_STARTED'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when strict optional-skill selection evidence is missing for the current task cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands.md');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');
        fs.mkdirSync(path.join(getOrchestratorRoot(repoRoot), 'live', 'config'), { recursive: true });
        fs.writeFileSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'garda.config.json'),
            JSON.stringify({ version: 1, configs: { 'optional-skill-selection-policy': 'optional-skill-selection-policy.json' } }, null, 2),
            'utf8'
        );
        fs.writeFileSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'strict' }, null, 2),
            'utf8'
        );

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            emitMetrics: false
        });

        assert.notEqual(result.exitCode, 0);
        assert.ok(result.outputLines.join('\n').includes('Optional skill selection artifact is missing for current task cycle'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when strict optional-skill selection evidence no longer matches the current TASK.md title', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill-stale-task-text';
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
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['docs/landing.md'],
            required_reviews: {
                code: false,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        const commandsPath = path.join(repoRoot, 'commands-stale-task-text.md');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');
        seedNodeBackendOptionalSkillFixture(repoRoot, 'strict');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Implement request validation for a Node.js API endpoint'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
            taskText: 'Implement request validation for a Node.js API endpoint',
            changedPaths: ['docs/landing.md'],
            preflightPath
        });
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Implement request validation for a Node.js API endpoint',
                'Refresh landing-page copy for the marketing site'
            ),
            'utf8'
        );

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            emitMetrics: false
        });

        assert.notEqual(result.exitCode, 0);
        assert.ok(result.outputLines.join('\n').includes('current task summary hash'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when the current task row disappears from TASK.md after optional-skill evidence was materialized', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-optional-skill-missing-task-row';
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
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['docs/landing.md'],
            required_reviews: {
                code: false,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        const commandsPath = path.join(repoRoot, 'commands-missing-task-row.md');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');
        seedNodeBackendOptionalSkillFixture(repoRoot, 'strict');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Implement request validation for a Node.js API endpoint'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
            taskText: 'Implement request validation for a Node.js API endpoint',
            changedPaths: ['docs/landing.md'],
            preflightPath
        });
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        fs.writeFileSync(
            taskPath,
            [
                '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                '| T-999 | TODO | P2 | docs | Placeholder task | unassigned | 2026-03-28 | default | fixture |'
            ].join('\n'),
            'utf8'
        );

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            emitMetrics: false
        });

        assert.notEqual(result.exitCode, 0);
        assert.ok(result.outputLines.join('\n').includes('current task summary hash'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

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

    it('applies budget tiers to compile gate telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-budget';
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
        const commandsPath = path.join(repoRoot, 'commands-budget.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'budget ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Budget telemetry check'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(taskModeResult.outputLines[0], 'TASK_MODE_ENTERED');
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(evidence.status, 'PASSED');
        assert.equal(evidence.selected_output_profile, 'compile_success_console');
        assert.equal(evidence.selected_budget_tier, 'tight');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when task mode entry evidence is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901a';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some(line => line.includes('Task-mode entry evidence missing')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('explains planned explicit preflight refresh steps when compile gate detects scope drift in a clean workspace', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901scope-drift-guidance';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        initializeGitRepo(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Clarify planned explicit preflight drift recovery'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(repoRoot, taskId, 'Clarify planned explicit preflight drift recovery', ['src/app.ts']);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        fs.writeFileSync(appPath, 'const a = 10;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-scope-drift.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Preflight scope drift detected.')));
        assert.ok(result.outputLines.some((line) => line.includes('planned --changed-file inputs in a clean workspace')));
        assert.ok(result.outputLines.some((line) => line.includes('load-rule-pack --stage POST_PREFLIGHT')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('recovers from planned explicit preflight scope drift after rerunning classify-change and POST_PREFLIGHT rule-pack', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901scope-drift-recovery';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        initializeGitRepo(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Recover planned explicit preflight drift after real diff exists'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(repoRoot, taskId, 'Recover planned explicit preflight drift after real diff exists', ['src/app.ts']);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        fs.writeFileSync(appPath, 'const a = 10;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-scope-drift-recovery.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const firstCompile = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(firstCompile.exitCode, EXIT_GATE_FAILURE);
        assert.ok(firstCompile.outputLines.some((line) => line.includes('Preflight scope drift detected.')));

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Recover planned explicit preflight drift after real diff exists',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, refreshedPreflightPath).exitCode, 0);

        const secondCompile = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(secondCompile.exitCode, 0);
        assert.equal(secondCompile.outputLines[0], 'COMPILE_GATE_PASSED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('records sequence evidence on the successful sequential POST_PREFLIGHT and compile path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-sequence-evidence';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-sequence.md');
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
            taskSummary: 'Emit sequence evidence for successful sequential compile flow'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Emit sequence evidence for successful sequential compile flow',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const rulePackArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-rule-pack.json`), 'utf8')
        );
        const compileArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`), 'utf8')
        );

        assert.equal(typeof rulePackArtifact.stages.post_preflight.preflight_event_sequence, 'number');
        assert.equal(typeof compileArtifact.post_preflight_sequence.latest_preflight_sequence, 'number');
        assert.equal(typeof compileArtifact.post_preflight_sequence.latest_post_preflight_rule_pack_sequence, 'number');
        assert.ok(
            compileArtifact.post_preflight_sequence.latest_post_preflight_rule_pack_sequence
            > compileArtifact.post_preflight_sequence.latest_preflight_sequence
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses binding-equivalent POST_PREFLIGHT rule-pack evidence after an identical preflight refresh', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-binding-equivalent';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-binding-equivalent.md');
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
            taskSummary: 'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence',
            ['src/app.ts']
        );
        assert.equal(refreshedPreflightPath, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);
        assert.equal(compileResult.outputLines[0], 'COMPILE_GATE_PASSED');

        const compileArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`), 'utf8')
        ) as Record<string, unknown>;
        const postPreflightSequence = compileArtifact.post_preflight_sequence as Record<string, unknown>;
        const rulePackEvidence = compileArtifact.rule_pack as Record<string, unknown>;
        assert.equal(postPreflightSequence.binding_equivalent_to_current_preflight, true);
        assert.equal(rulePackEvidence.binding_equivalent_to_current_preflight, true);

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_PASSED');

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Equivalent preflight refresh keeps the same downstream rule-pack.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath: refreshedPreflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses binding-equivalent POST_PREFLIGHT rule-pack evidence from a custom artifact path after an identical preflight refresh', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-binding-equivalent-custom-path';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-binding-equivalent-custom-path.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        const customRulePackPath = path.join(repoRoot, 'custom-artifacts', `${taskId}-rule-pack.json`);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow equivalent preflight refresh to reuse custom POST_PREFLIGHT rule-pack evidence'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse custom POST_PREFLIGHT rule-pack evidence',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, customRulePackPath).exitCode, 0);

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse custom POST_PREFLIGHT rule-pack evidence',
            ['src/app.ts']
        );
        assert.equal(refreshedPreflightPath, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            rulePackPath: customRulePackPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);
        assert.equal(compileResult.outputLines[0], 'COMPILE_GATE_PASSED');

        const compileArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`), 'utf8')
        ) as Record<string, unknown>;
        const postPreflightSequence = compileArtifact.post_preflight_sequence as Record<string, unknown>;
        const rulePackEvidence = compileArtifact.rule_pack as Record<string, unknown>;
        assert.equal(postPreflightSequence.binding_equivalent_to_current_preflight, true);
        assert.equal(rulePackEvidence.binding_equivalent_to_current_preflight, true);
        assert.equal(rulePackEvidence.evidence_path, customRulePackPath.replace(/\\/g, '/'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses binding-equivalent POST_PREFLIGHT rule-pack evidence with a custom task-mode path after an identical preflight refresh', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-binding-equivalent-custom-task-mode';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-binding-equivalent-custom-task-mode.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence with a custom task-mode path',
            artifactPath: customTaskModePath
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence with a custom task-mode path',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath).exitCode, 0);

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence with a custom task-mode path',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        assert.equal(refreshedPreflightPath, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath: refreshedPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);
        assert.equal(compileResult.outputLines[0], 'COMPILE_GATE_PASSED');

        const compileArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`), 'utf8')
        ) as Record<string, unknown>;
        const postPreflightSequence = compileArtifact.post_preflight_sequence as Record<string, unknown>;
        const rulePackEvidence = compileArtifact.rule_pack as Record<string, unknown>;
        assert.equal(postPreflightSequence.binding_equivalent_to_current_preflight, true);
        assert.equal(rulePackEvidence.binding_equivalent_to_current_preflight, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate with explicit unsafe parallelism guidance for a custom task-mode path when a newer preflight supersedes POST_PREFLIGHT rule-pack evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-overlap-custom-task-mode';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle with a custom task-mode path',
            artifactPath: customTaskModePath
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle with a custom task-mode path',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath).exitCode, 0);

        fs.writeFileSync(appPath, 'const a = 10;\nconst b = 2;\nconsole.log(a - b);\n', 'utf8');

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle with a custom task-mode path',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        assert.equal(refreshedPreflightPath, preflightPath);

        const commandsPath = path.join(repoRoot, 'commands-post-preflight-overlap-custom-task-mode.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath: refreshedPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Unsafe same-task overlap detected')));
        assert.ok(result.outputLines.some((line) => line.includes('Do not parallelize classify-change, load-rule-pack --stage POST_PREFLIGHT, and compile-gate')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when explicit task-mode path differs from the timeline-recorded TASK_MODE_ENTERED artifact path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-task-mode-artifact-path-mismatch';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const alternateTaskModePath = path.join(repoRoot, 'copied-artifacts', `${taskId}-task-mode.json`);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject copied task-mode artifacts that differ from the timeline-recorded path'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject copied task-mode artifacts that differ from the timeline-recorded path',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const canonicalTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        fs.mkdirSync(path.dirname(alternateTaskModePath), { recursive: true });
        fs.copyFileSync(canonicalTaskModePath, alternateTaskModePath);

        const commandsPath = path.join(repoRoot, 'commands-task-mode-artifact-path-mismatch.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath: alternateTaskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Task-mode entry evidence artifact path mismatch')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when task-mode entry evidence omits pinned runtime identity metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-task-mode-identity-missing-at-compile';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject compile gate when task-mode identity metadata is missing',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject compile gate when task-mode identity metadata is missing',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const tamperedTaskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        delete tamperedTaskMode.canonical_source_of_truth;
        delete tamperedTaskMode.execution_provider_source;
        delete tamperedTaskMode.runtime_identity_status;
        fs.writeFileSync(taskModePath, JSON.stringify(tamperedTaskMode, null, 2) + '\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-task-mode-identity-missing-at-compile.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('missing canonical_source_of_truth')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when explicit POST_PREFLIGHT rule-pack path differs from the timeline-recorded artifact path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-rule-pack-artifact-path-mismatch';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const alternateRulePackPath = path.join(repoRoot, 'copied-artifacts', `${taskId}-rule-pack.json`);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject copied POST_PREFLIGHT rule-pack artifacts that differ from the timeline-recorded path'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject copied POST_PREFLIGHT rule-pack artifacts that differ from the timeline-recorded path',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const canonicalRulePackPath = path.join(getReviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
        fs.mkdirSync(path.dirname(alternateRulePackPath), { recursive: true });
        fs.copyFileSync(canonicalRulePackPath, alternateRulePackPath);

        const commandsPath = path.join(repoRoot, 'commands-post-preflight-rule-pack-artifact-path-mismatch.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            rulePackPath: alternateRulePackPath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Rule-pack evidence artifact path mismatch')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate with explicit unsafe parallelism guidance when a newer preflight supersedes POST_PREFLIGHT rule-pack evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-overlap';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        fs.writeFileSync(appPath, 'const a = 10;\nconst b = 2;\nconsole.log(a - b);\n', 'utf8');

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle',
            ['src/app.ts']
        );
        assert.equal(refreshedPreflightPath, preflightPath);

        const commandsPath = path.join(repoRoot, 'commands-post-preflight-overlap.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Unsafe same-task overlap detected')));
        assert.ok(result.outputLines.some((line) => line.includes('Do not parallelize classify-change, load-rule-pack --stage POST_PREFLIGHT, and compile-gate')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when the latest handshake supersedes shell smoke evidence for the current task cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-handshake-shell-smoke-overlap';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-handshake-shell-smoke-overlap.md');
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
            taskSummary: 'Reject stale shell smoke evidence before compile'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale shell smoke evidence before compile',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Unsafe same-task overlap detected')));
        assert.ok(result.outputLines.some((line) => line.includes('shell-smoke-preflight -> classify-change -> load-rule-pack --stage POST_PREFLIGHT -> compile-gate')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('passes doc-impact gate and writes artifact', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-902';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);

        const result = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Internal cleanup only, no public behavior change.',
            emitMetrics: false
        });

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-doc-impact.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'DOC_IMPACT_GATE_PASSED');
        assert.equal(artifact.status, 'PASSED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('passes required reviews gate with compile evidence and review artifact', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands.md');
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
            taskSummary: 'Update app flow'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
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

        const evidencePath = path.join(reviewsRoot, `${taskId}-review-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'REVIEW_GATE_PASSED');
        assert.equal(evidence.status, 'PASSED');
        assert.equal(evidence.event_source, 'required-reviews-check');
        assert.ok(readTaskTimelineEvents(repoRoot, taskId).some((event) => (
            event.event_type === 'STATUS_CHANGED'
            && event.details
            && typeof event.details === 'object'
            && (event.details as Record<string, unknown>).new_status === 'IN_REVIEW'
        )));
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), /\|\s*T-903\s*\|\s*🟧 IN_REVIEW\s*\|/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('defaults required review verdicts from preflight when CLI verdict flags are omitted', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-defaulted-verdicts';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
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
        const commandsPath = path.join(repoRoot, 'commands-defaulted-verdicts.md');
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
            taskSummary: 'Default required review verdicts from preflight'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');
        writeCleanReviewArtifact(repoRoot, taskId, 'test', 'TEST REVIEW PASSED');

        const result = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-review-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'REVIEW_GATE_PASSED');
        assert.equal(evidence.verdicts.code, 'REVIEW PASSED');
        assert.equal(evidence.verdicts.test, 'TEST REVIEW PASSED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails required reviews gate when a preflight-defaulted required review artifact is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-defaulted-verdicts-missing-artifact';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
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
        const commandsPath = path.join(repoRoot, 'commands-defaulted-verdicts-missing-artifact.md');
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
            taskSummary: 'Keep defaulted required reviews strict when artifacts are missing'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

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
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-review-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.equal(evidence.verdicts.test, 'TEST REVIEW PASSED');
        assert.ok(result.outputLines.some((line) => line.includes("Review artifact not found for claimed 'TEST REVIEW PASSED'")));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails required reviews gate when review artifact is missing mandatory findings sections', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-invalid-sections';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-invalid-sections.md');
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
            taskSummary: 'Reject schema-invalid review artifacts earlier'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        writeReceiptBackedReviewArtifact(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            [
                '# Review',
                '',
                'Validated `src/app.ts` and related wiring with enough implementation detail to look realistic, but this fixture intentionally uses the wrong section names so review-gate must reject it before completion-gate ever runs.',
                '',
                'REVIEW PASSED',
                '',
                '## Findings',
                'none',
                '',
                '## Residual',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ]
        );

        const result = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes("missing required section '## Findings by Severity'")));
        assert.ok(result.outputLines.some((line) => line.includes("missing required section '## Residual Risks'")));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails required reviews gate when review artifact is trivial even with valid receipt/context', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-trivial-review';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-trivial-review.md');
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
            taskSummary: 'Reject trivial synthetic review artifacts earlier'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        writeReceiptBackedReviewArtifact(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            [
                '# Review',
                '',
                'REVIEW PASSED',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ]
        );

        const result = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('trivial or obviously synthetic')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
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

    it('logs terminal task events with review-temp cleanup and command audit', () => {
        for (const eventType of ['TASK_DONE', 'TASK_BLOCKED'] as const) {
            const repoRoot = createTempRepo();
            const taskId = `T-904-${eventType.toLowerCase()}`;
            const reviewsRoot = getReviewsRoot(repoRoot);
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const reviewTempRoot = path.join(repoRoot, '.review-temp');
            const stagedReviewOutputPath = path.join(reviewTempRoot, `${taskId}-code-output.md`);
            const foreignReviewOutputPath = path.join(reviewTempRoot, 'T-foreign-code-output.md');
            fs.mkdirSync(reviewTempRoot, { recursive: true });
            fs.writeFileSync(stagedReviewOutputPath, 'temporary reviewer output\n', 'utf8');
            fs.writeFileSync(foreignReviewOutputPath, 'leave unrelated reviewer output alone\n', 'utf8');
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
            assert.equal(payload.terminal_review_temp_cleanup.deleted_paths.length, 1);
            assert.equal(fs.existsSync(compileOutputPath), false);
            assert.equal(fs.existsSync(stagedReviewOutputPath), false);
            assert.equal(fs.existsSync(foreignReviewOutputPath), true);

            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('runs human commit through git with commit guard override', async () => {
        const repoRoot = createTempRepo();
    
        runGit(repoRoot, ['init']);
        runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
        runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
        runGit(repoRoot, ['add', '.']);

        const exitCode = await runHumanCommitCommand(['-m', 'test: initial commit'], { cwd: repoRoot });
        const logResult = childProcess.spawnSync('git', ['log', '--oneline', '-1'], {
            cwd: repoRoot,
            windowsHide: true,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });

        assert.equal(exitCode, 0);
        assert.match(logResult.stdout, /test: initial commit/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing updates review-context routing metadata and emits delegated telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
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
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

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
            review_type: 'code',
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

    it('record-review-result materializes delegated reviewer output into canonical artifact and receipt when controller routing telemetry already exists', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated `src/app.ts` and the delegated review ingestion path with concrete routing, receipt, and artifact persistence details so this reviewer output is realistic and non-trivial.',
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
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'Delegated review routed by controller.', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:code-reviewer',
            delegation_used: true
        });

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
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        assert.equal(fs.existsSync(reviewOutputPath), false);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        const rawReviewContent = fs.readFileSync(rawReviewOutputPath, 'utf8');
        assert.ok(artifactContent.includes('## Verdict\nREVIEW PASSED'));
        assert.ok(rawReviewContent.includes('## Verdict\nREVIEW PASSED'));
        assert.equal(artifactContent.trimEnd(), rawReviewContent.trimEnd());

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');

        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(receipt.reviewer_identity, 'agent:code-reviewer');
        assert.equal(receipt.trust_level, 'LOCAL_ASSERTED');
        assert.equal(receipt.reviewer_provenance?.attestation_type, 'controller_event_integrity');
        assert.equal(receipt.reviewer_provenance?.controller_event_type, 'REVIEWER_DELEGATION_ROUTED');
        assert.equal(receipt.review_output_path, rawReviewOutputPath.replace(/\\/g, '/'));
        assert.equal(receipt.review_materialization_fidelity, 'exact');
        assert.equal(typeof receipt.review_output_sha256, 'string');
        assert.ok(receipt.review_output_sha256.length > 0);
        assert.equal(typeof receipt.review_artifact_sha256, 'string');
        assert.ok(receipt.review_artifact_sha256.length > 0);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.filter((event) => event.event_type === 'REVIEW_RECORDED').length, 1);
        const routedEvent = events.find((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED') as Record<string, unknown> | undefined;
        const routedIntegrity = routedEvent?.integrity as Record<string, unknown> | undefined;
        assert.equal(receipt.reviewer_provenance?.task_sequence, routedIntegrity?.task_sequence);
        assert.equal(receipt.reviewer_provenance?.event_sha256, routedIntegrity?.event_sha256);
        assert.equal(receipt.reviewer_provenance?.prev_event_sha256 ?? null, routedIntegrity?.prev_event_sha256 ?? null);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewOutputMode: path')));
        assert.ok(capturedLogs.some((line) => line.includes('VerdictToken: REVIEW PASSED')));
        assert.ok(capturedLogs.some((line) => line.includes('ReviewMaterializationFidelity: exact')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result accepts legacy review-context identity when task-mode runtime identity is backfilled safely', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-legacy-backfill';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(taskModePath, JSON.stringify({
            timestamp_utc: '2026-04-16T09:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Record a review against a legacy provider-bridge review-context after upgrade',
            provider: 'Codex',
            routed_to: '.antigravity/agents/orchestrator.md'
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'TASK_MODE_ENTERED', 'PASS', 'Legacy provider-bridge task-mode entry before runtime identity split.', {
            artifact_path: taskModePath.replace(/\\/g, '/'),
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Record a review against a legacy provider-bridge review-context after upgrade',
            provider: 'Codex',
            routed_to: '.antigravity/agents/orchestrator.md'
        });
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');

        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, taskModePath).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');

        const preflightPath = writePreflight(repoRoot, taskId, {
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
            }
        });
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', taskModePath).exitCode, 0);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation resumed after upgrade on a legacy provider-bridge task-mode artifact.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const crypto = require('node:crypto');
        const preflightText = fs.readFileSync(preflightPath, 'utf8');
        const preflightSha256 = crypto.createHash('sha256').update(preflightText).digest('hex');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: preflightSha256,
            reviewer_routing: {
                source_of_truth: 'Codex',
                actual_execution_mode: null,
                reviewer_session_id: null,
                fallback_reason: null
            }
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated `src/cli/commands/gate-review-handlers.ts`, `src/gates/review-context-routing.ts`, and the legacy provider-bridge resume path, confirming that legacy review-context routing metadata can still be materialized after runtime identity is safely backfilled from a provider bridge while receipt, routing telemetry, and canonical artifact writes remain bound to the active preflight and task-mode evidence.',
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

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
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
                '--review-output-path', reviewOutputPath,
                '--review-context-path', reviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.source_of_truth, 'Codex');
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');
        assert.equal(receipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(receipt.reviewer_identity, 'agent:code-reviewer');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result accepts stdin reviewer output only through the same audited raw-artifact path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-stdin';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const stdinReviewOutput = [
            '# Review',
            '',
            'Validated direct stdin ingestion while keeping `src/cli/commands/gate-review-handlers.ts` and `garda-agent-orchestrator/runtime/reviews/*-review-output.md` on the same audited raw-artifact path, with concrete receipt and routing persistence details. Reviewed the raw artifact rewrite, verdict extraction, context binding, and receipt emission flow so this fixture remains realistic and non-trivial.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');

        const mutableGateReviewHandlers = gateReviewHandlers as typeof gateReviewHandlers & {
            readReviewOutputFromStdin: typeof gateReviewHandlers.readReviewOutputFromStdin;
        };
        const originalReadReviewOutputFromStdin = mutableGateReviewHandlers.readReviewOutputFromStdin;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleLog = console.log;
        const capturedLogs: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.log = (...args: unknown[]) => {
            capturedLogs.push(args.map((value) => String(value)).join(' '));
        };
        mutableGateReviewHandlers.readReviewOutputFromStdin = async () => stdinReviewOutput;
        try {
            process.chdir(repoRoot);
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
                '--review-output-stdin',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            mutableGateReviewHandlers.readReviewOutputFromStdin = originalReadReviewOutputFromStdin;
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        assert.equal(fs.readFileSync(rawReviewOutputPath, 'utf8'), stdinReviewOutput);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewOutputMode: stdin')));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewOutputPath: ${rawReviewOutputPath.replace(/\\/g, '/')}`)));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects dual review-output sources to avoid a weaker ingestion path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-dual-input';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, '# Review\n\n## Verdict\nREVIEW PASSED\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
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
                '--review-output-path', reviewOutputPath,
                '--review-output-stdin',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result materializes failed reviewer output with active findings when lifecycle sections are present', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-failed';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated that failed reviewer verdicts are still materialized as canonical evidence for the release gate.',
            '',
            '## Findings by Severity',
            '- High: `src/app.ts:1` reviewer intentionally failed this artifact to exercise the failed-verdict ingestion path.',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            '- REVIEW FAILED'
        ].join('\n'), 'utf8');

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
            process.chdir(repoRoot);
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
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.ok(fs.readFileSync(artifactPath, 'utf8').includes('## Verdict\n- REVIEW FAILED'));
        assert.ok(fs.readFileSync(artifactPath, 'utf8').includes('High: `src/app.ts:1` reviewer intentionally failed this artifact'));
        assert.ok(capturedLogs.some((line) => line.includes('VerdictToken: REVIEW FAILED')));

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');

        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(receipt.reviewer_identity, 'agent:code-reviewer');

        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.filter((event) => event.event_type === 'REVIEW_RECORDED').length, 1);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result keeps failed reviewer output materializable when residual risks remain explicit', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-failed-risks';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated that failed reviewer verdicts with explicit unresolved risk detail still materialize as canonical evidence while the task remains blocked from completion.',
            '',
            '## Findings by Severity',
            '- High: `src/app.ts:1` the reviewer found a blocking issue and intentionally kept the review in a failed state.',
            '',
            '## Residual Risks',
            '- Integration rerun is still pending for `tests/node/cli/commands/gates.test.ts`, so follow-up work remains open until the blocker is fixed.',
            '',
            '## Verdict',
            'REVIEW FAILED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
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
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.ok(fs.readFileSync(artifactPath, 'utf8').includes('Integration rerun is still pending'));

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects reviewer output without a recognized verdict token before materialization', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-no-verdict';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'This artifact intentionally omits the canonical verdict token.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            '- APPROVED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        assert.ok(fs.readFileSync(rawReviewOutputPath, 'utf8').includes('- APPROVED'));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects trivial passed reviewer output before routing or receipt materialization', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-trivial-pass';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Short pass.',
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
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        assert.ok(capturedErrors.some((line) => line.includes('trivial or obviously synthetic')));
        assert.ok(capturedErrors.some((line) => line.includes('Minimal compliant PASS review template')));
        assert.ok(capturedErrors.some((line) => line.includes('## Findings by Severity')));
        assert.ok(capturedErrors.some((line) => line.includes('## Residual Risks')));
        assert.ok(capturedErrors.some((line) => line.includes('## Verdict')));
        assert.ok(capturedErrors.some((line) => line.includes('REVIEW PASSED')));
        assert.ok(capturedErrors.some((line) => line.includes('Deferred Findings')));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result keeps trivial pass review blocked when lossless normalization would otherwise add deferred follow-up', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-trivial-pass-findings';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# R',
            '',
            'x',
            '',
            '## Findings by Severity',
            '- High: x',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');

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
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        assert.ok(capturedErrors.some((line) => line.includes('trivial or obviously synthetic')));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result materializes passed reviewer output with active findings and residual risks losslessly', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-pass-findings';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated the materialization guard against a pass artifact that still reports active follow-up while preserving the reviewer evidence losslessly.',
            '',
            '## Findings by Severity',
            '- High: `src/app.ts:1` this reviewer intentionally kept an unresolved blocker while claiming a pass verdict.',
            '',
            '## Residual Risks',
            '- Confirm the follow-up stays visible to operators after pass-review normalization.',
            '',
            '## Verdict',
            'REVIEW PASSED',
            '',
            '## Additional Reviewer Notes',
            'The unresolved blocker stays intentionally visible in the raw review output for audit provenance.'
        ].join('\n'), 'utf8');

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
            process.chdir(repoRoot);
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
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        assert.equal(fs.existsSync(reviewOutputPath), false);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        const rawReviewContent = fs.readFileSync(rawReviewOutputPath, 'utf8');
        assert.ok(rawReviewContent.includes('still reports active follow-up while preserving the reviewer evidence losslessly.'));
        assert.ok(rawReviewContent.includes('## Findings by Severity'));
        assert.ok(rawReviewContent.includes('## Residual Risks\n- Confirm the follow-up stays visible to operators after pass-review normalization.'));
        assert.ok(rawReviewContent.includes('## Additional Reviewer Notes'));
        assert.ok(artifactContent.includes('## Findings by Severity\nnone'));
        assert.ok(artifactContent.includes('## Preserved Raw Reviewer Output'));
        assert.ok(artifactContent.includes('> ## Additional Reviewer Notes'));
        assert.ok(artifactContent.includes('> The unresolved blocker stays intentionally visible in the raw review output for audit provenance.'));
        assert.ok(artifactContent.includes('## Deferred Findings'));
        assert.ok(artifactContent.includes('- [high] `src/app.ts:1` this reviewer intentionally kept an unresolved blocker while claiming a pass verdict.'));
        assert.ok(artifactContent.includes('- [follow-up] Confirm the follow-up stays visible to operators after pass-review normalization.'));
        assert.ok(artifactContent.includes('Justification: Preserved from raw reviewer output during PASS review normalization.'));
        assert.ok(artifactContent.includes('## Residual Risks\nnone'));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.review_output_path, rawReviewOutputPath.replace(/\\/g, '/'));
        assert.equal(receipt.review_materialization_fidelity, 'normalized_lossless');
        assert.equal(typeof receipt.review_output_sha256, 'string');
        assert.ok(receipt.review_output_sha256.length > 0);
        assert.notEqual(receipt.review_artifact_sha256, receipt.review_output_sha256);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.filter((event) => event.event_type === 'REVIEW_RECORDED').length, 1);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewMaterializationFidelity: normalized_lossless')));
        assert.ok(capturedLogs.some((line) => line.includes('VerdictToken: REVIEW PASSED')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result materializes no-findings pass review losslessly when deferred findings lack justification', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-pass-no-findings-recovery';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated the no-findings pass-review materialization path with concrete scope notes and enough detail to stay above the trivial-review threshold while still keeping the artifact intentionally malformed for recovery guidance.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Deferred Findings',
            '- [low] follow up on reviewer wording in `src/cli/commands/gate-review-handlers.ts:1`',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');

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
            process.chdir(repoRoot);
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
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        assert.equal(fs.existsSync(reviewOutputPath), false);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        const rawReviewContent = fs.readFileSync(rawReviewOutputPath, 'utf8');
        assert.ok(rawReviewContent.includes('## Deferred Findings'));
        assert.ok(rawReviewContent.includes('- [low] follow up on reviewer wording'));
        assert.ok(!rawReviewContent.includes('Justification:'));
        assert.ok(artifactContent.includes('## Preserved Raw Reviewer Output'));
        assert.ok(artifactContent.includes('> ## Deferred Findings'));
        assert.ok(artifactContent.includes('> - [low] follow up on reviewer wording in `src/cli/commands/gate-review-handlers.ts:1`'));
        assert.ok(artifactContent.includes('## Findings by Severity\nnone'));
        assert.ok(artifactContent.includes('## Deferred Findings'));
        assert.ok(artifactContent.includes('- [low] follow up on reviewer wording in `src/cli/commands/gate-review-handlers.ts:1`'));
        assert.ok(artifactContent.includes('Justification: Preserved from raw reviewer output during PASS review normalization.'));
        assert.ok(artifactContent.includes('## Residual Risks\nnone'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.review_output_path, rawReviewOutputPath.replace(/\\/g, '/'));
        assert.equal(receipt.review_materialization_fidelity, 'normalized_lossless');
        assert.equal(typeof receipt.review_output_sha256, 'string');
        assert.ok(receipt.review_output_sha256.length > 0);
        assert.notEqual(receipt.review_artifact_sha256, receipt.review_output_sha256);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.filter((event) => event.event_type === 'REVIEW_RECORDED').length, 1);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewMaterializationFidelity: normalized_lossless')));
        assert.ok(capturedLogs.some((line) => line.includes('VerdictToken: REVIEW PASSED')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects failed reviewer output that omits required lifecycle sections', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-failed-missing-section';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated that a failed verdict still needs the canonical lifecycle sections before it can become auditable evidence.',
            '',
            '## Findings by Severity',
            '- High: `src/app.ts:1` this failed review is intentionally missing residual-risk lifecycle evidence.',
            '',
            '## Verdict',
            'REVIEW FAILED'
        ].join('\n'), 'utf8');

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
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        assert.ok(capturedErrors.some((line) => line.includes("missing required section '## Residual Risks'")));
        assert.ok(!capturedErrors.some((line) => line.includes('Minimal compliant PASS review template')));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects deprecated same_agent_fallback receipt evidence through the public CLI path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-fallback';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'single_agent_only',
                expected_execution_mode: 'same_agent_fallback'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated deprecated fallback-mode rejection through `src/cli/commands/gate-review-handlers.ts`, confirming that same-agent fallback no longer writes the canonical artifact, routing metadata, or receipt for the current mandatory review contract.',
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
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'Fallback review routed by controller.', {
            review_type: 'code',
            reviewer_execution_mode: 'same_agent_fallback',
            reviewer_session_id: `self:${taskId}`,
            reviewer_fallback_reason: 'provider bridge does not expose subagent routing',
            delegation_used: false
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', `self:${taskId}`,
                '--reviewer-fallback-reason', 'provider bridge does not expose subagent routing'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        assert.equal(reviewContext.reviewer_routing.fallback_reason, null);
        assert.ok(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'));
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects delegated reviewer receipts when controller routing telemetry is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-missing-route';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated that delegated review materialization must bind to controller-routed telemetry rather than self-minting it during receipt persistence.',
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

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            console.error = (...args: unknown[]) => {
                capturedErrors.push(args.map((value) => String(value)).join(' '));
            };
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(reviewOutputPath), true);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        assert.ok(capturedErrors.length > 0);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rolls back artifact and routing metadata when review-recorded telemetry cannot be persisted', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-routing-lock';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated rollback semantics when routing telemetry cannot be appended.',
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
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'Delegated review routed by controller before materialization.', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:code-reviewer',
            delegation_used: true
        });

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
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-code-review-output.md`)), true);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const timelinePath = path.join(taskEventsRoot, `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), true);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects non-canonical preflight paths before materialization', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-preflight';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId);
        const customPreflightPath = path.join(repoRoot, 'custom-preflight.json');
        fs.writeFileSync(customPreflightPath, JSON.stringify({
            task_id: taskId,
            required_reviews: { code: true }
        }, null, 2) + '\n', 'utf8');

        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, '# Review\n\n## Verdict\nREVIEW PASSED\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', customPreflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result preserves artifact materialization but fails cleanly when receipt path is locked', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-lock';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated the receipt-lock failure path with realistic delegated reviewer output, including `src/cli/commands/gate-review-handlers.ts` and the canonical review receipt persistence path so the fixture stays non-trivial while exercising the lock failure. The review text intentionally covers artifact materialization, routing, and locked receipt emission behavior in one cohesive scenario.',
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

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            const lockPath = `${receiptPath}.lock`;
            fs.mkdirSync(lockPath, { recursive: true });
            fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
                pid: process.pid,
                hostname: os.hostname(),
                created_at_utc: new Date().toISOString()
            }, null, 2) + '\n', 'utf8');

            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(reviewOutputPath), true);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects unsupported reviewer execution modes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904x';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904x',
            '## Summary',
            'Verified `src/app.ts` delegated routing wiring with realistic detail.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
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
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_magic',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects delegated mode without pre-recorded routing evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y',
            '## Summary',
            'Verified `src/app.ts` delegated routing wiring with realistic detail.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
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
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
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
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects stale routing telemetry replayed from a prior cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-stale-routing-replay';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const priorPreflightPath = writePreflight(repoRoot, taskId, {
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
            }
        }, `${taskId}-prior-preflight.json`);
        prepareCurrentReviewPhase(repoRoot, taskId, priorPreflightPath);

        const orchestratorRoot = getOrchestratorRoot(repoRoot);
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'Historical review phase started.', {
            review_type: 'code'
        });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'Historical code review routed.', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:test-reviewer',
            delegation_used: true
        });

        const preflightPath = writePreflight(repoRoot, taskId, {
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
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'Current review phase started.', {
            review_type: 'code'
        });

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y-stale-routing-replay',
            '## Summary',
            'Verified stale routing replay handling with realistic detail.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'delegated_subagent',
            reviewerSessionId: 'agent:test-reviewer',
            fallbackReason: null
        });

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCodeReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        const matchingRoutingIndices = events
            .map((event, index) => ({ event, index }))
            .filter(({ event }) => (
                event.event_type === 'REVIEWER_DELEGATION_ROUTED'
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
                && String((event.details as Record<string, unknown> | undefined)?.reviewer_session_id || '') === 'agent:test-reviewer'
            ))
            .map(({ index }) => index);
        assert.ok(latestCodeReviewPhaseIndex >= 0);
        assert.ok(matchingRoutingIndices.some((index) => index < latestCodeReviewPhaseIndex));
        assert.equal(matchingRoutingIndices.some((index) => index > latestCodeReviewPhaseIndex), false);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
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
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt accepts earlier matching same-cycle routing telemetry when reviewer identity still matches the review context', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-superseded-routing';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);

        const orchestratorRoot = getOrchestratorRoot(repoRoot);
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'Earlier same-cycle code review routed.', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:test-reviewer',
            delegation_used: true
        });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'Later same-cycle code review rerouted to a different reviewer.', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:new-reviewer',
            delegation_used: true
        });

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y-superseded-routing',
            '## Summary',
            'Verified that superseded same-cycle routing telemetry cannot be replayed by tampering the review-context back to an older reviewer identity.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'delegated_subagent',
            reviewerSessionId: 'agent:test-reviewer',
            fallbackReason: null
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
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
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), true);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects same-agent fallback without a required fallback reason', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-receipt-fallback-reason';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y-receipt-fallback-reason',
            '## Summary',
            'Verified fallback receipt policy enforcement with realistic detail.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'same_agent_fallback',
            reviewerSessionId: `self:${taskId}`,
            fallbackReason: null
        });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'fallback routed without reason', {
            review_type: 'code',
            reviewer_execution_mode: 'same_agent_fallback',
            reviewer_session_id: `self:${taskId}`,
            delegation_used: false
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', `self:${taskId}`
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), false);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects fallback reasons that diverge from pre-recorded routing metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-receipt-fallback-mismatch';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y-receipt-fallback-mismatch',
            '## Summary',
            'Verified receipt fallback binding enforcement with realistic detail.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'same_agent_fallback',
            reviewerSessionId: `self:${taskId}`,
            fallbackReason: 'provider limitation'
        });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'fallback routed with canonical reason', {
            review_type: 'code',
            reviewer_execution_mode: 'same_agent_fallback',
            reviewer_session_id: `self:${taskId}`,
            reviewer_fallback_reason: 'provider limitation',
            delegation_used: false
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', `self:${taskId}`,
                '--reviewer-fallback-reason', 'tampered fallback'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), false);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt accepts delegated_subagent for providers that previously used single-agent fallback', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-receipt-single-agent';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Qwen');

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y-receipt-single-agent',
            '## Summary',
            'Verified delegated receipt acceptance for a provider that previously used same-agent fallback, with realistic detail.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Qwen')
        }, null, 2) + '\n', 'utf8');
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'delegated_subagent',
            reviewerSessionId: 'agent:test-reviewer',
            fallbackReason: null
        });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'delegated routing recorded for single-agent fixture', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:test-reviewer',
            delegation_used: true
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
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
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), true);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt accepts delegated_subagent when direct Codex runtime remains delegation-required', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-receipt-policy-tamper';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y-receipt-policy-tamper',
            '',
            'Validated `src/cli/commands/gate-review-handlers.ts` and the receipt-side routing enforcement path with enough implementation detail to prove that direct Codex sessions now keep delegated reviewer provenance instead of downgrading to same-agent fallback.',
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
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'delegated_subagent',
            reviewerSessionId: `agent:${taskId}-reviewer`,
            fallbackReason: null
        });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'tampered fallback routed for receipt fixture', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: `agent:${taskId}-reviewer`,
            reviewer_fallback_reason: null,
            delegation_used: true
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', `agent:${taskId}-reviewer`
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const receipt = JSON.parse(fs.readFileSync(artifactPath.replace(/\.md$/, '-receipt.json'), 'utf8'));
        assert.equal(receipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(receipt.reviewer_identity, `agent:${taskId}-reviewer`);
        assert.equal(receipt.reviewer_fallback_reason, null);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), true);

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
            review_type: 'code',
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
            review_type: 'code',
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

    it('record-review-result rejects tampered fallback policy fields when active runtime provider forbids fallback', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-result-policy-tamper';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                fallback_allowed: true,
                fallback_reason_required: true
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated `src/cli/commands/gate-review-handlers.ts`, `src/gates/reviewer-routing.ts`, and the current routing/receipt enforcement path to confirm that tampered review-context policy fields cannot force same-agent fallback on a delegation-required provider. The fixture is intentionally implementation-aware, references concrete files, and documents the guardrail behavior in enough detail to stay well above the trivial-review filter.',
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

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
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
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects same_agent_fallback with an agent-scoped reviewer identity', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-result-agent-identity';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated fallback identity authenticity in the public result-ingest path with concrete implementation detail and realistic wording.',
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

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', 'agent:test-reviewer',
                '--reviewer-fallback-reason', 'provider limitation'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code.md`)), false);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), false);

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
            review_type: 'code',
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

    it('records delegated routing and receipt through the public CLI path for providers that previously allowed fallback', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904z';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904z',
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
            review_type: 'code',
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
                '--reviewer-identity', `agent:${taskId}-reviewer`
            ]);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', `agent:${taskId}-reviewer`
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const receipt = JSON.parse(fs.readFileSync(artifactPath.replace(/\.md$/, '-receipt.json'), 'utf8'));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(receipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(receipt.reviewer_identity, `agent:${taskId}-reviewer`);
        assert.equal(receipt.reviewer_fallback_reason, null);
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, `agent:${taskId}-reviewer`);
        assert.equal(reviewContext.reviewer_routing.fallback_reason, null);
        assert.ok(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'));
        assert.ok(events.some((event) => event.event_type === 'REVIEW_RECORDED'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt fails when the receipt artifact path is already locked', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904z-lock';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904z-lock',
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
            review_type: 'code',
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
                '--reviewer-identity', `agent:${taskId}-reviewer`
            ]);

            const lockPath = `${receiptPath}.lock`;
            fs.mkdirSync(lockPath, { recursive: true });
            fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
                pid: process.pid,
                hostname: os.hostname(),
                created_at_utc: new Date().toISOString()
            }, null, 2) + '\n', 'utf8');

            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', `agent:${taskId}-reviewer`
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.ok(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'));
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects late receipt recording after completion already passed', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904z-late-receipt';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904z-late-receipt',
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
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                actual_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:test-reviewer'
            })
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'delegated', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:test-reviewer',
            delegation_used: true
        });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'COMPLETION_GATE_PASSED', 'PASS', 'Completion gate passed.', {});

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
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
        assert.equal(fs.existsSync(receiptPath), false);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rejects delegated_subagent for single-agent providers', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904za';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Qwen', {
                capability_level: 'single_agent_only',
                expected_execution_mode: 'same_agent_fallback',
                fallback_allowed: true,
                fallback_reason_required: true
            })
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
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const hasRoutingEvent = fs.existsSync(timelinePath)
            ? readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED')
            : false;
        assert.equal(hasRoutingEvent, false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('passes required review and completion flow for delegated test review evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        fs.mkdirSync(path.join(repoRoot, '.antigravity', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md'), '# antigravity bridge\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: false,
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
        const commandsPath = path.join(repoRoot, 'commands.md');
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
            taskSummary: 'Validate delegated test review flow',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');
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
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'Review phase started.', {
            review_type: 'test'
        });
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-test.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Test Review',
            '',
            'Verified changes in `src/app.ts`. This review artifact content has been extended with more words to ensure it strictly passes the newly introduced triviality check, which demands at least thirty words if there are no meaningful findings or risks.',
            '',
            'TEST REVIEW PASSED',
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
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'test',
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                execution_provider_source: 'provider_bridge',
                routed_to: '.antigravity/agents/orchestrator.md',
                provider_bridge: '.antigravity/agents/orchestrator.md'
            })
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'SKILL_SELECTED', 'INFO', 'selected', { skill_id: 'testing-strategy' });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', {
            reference_path: '/live/skills/testing-strategy/SKILL.md'
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'test',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'test',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            testReviewVerdict: 'TEST REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_PASSED');
        assert.ok(reviewResult.outputLines.includes('TrustStatus: LOCAL_ASSERTED'));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Test fixture exercises delegated test review only.',
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
        assert.equal(completionResult.review_artifacts?.test?.receipt?.trust_level, 'LOCAL_ASSERTED');
        assert.ok(completionResult.review_trust_summary?.visible_summary_line?.includes('LOCAL_ASSERTED'));
        assert.ok(completionResult.review_trust_summary?.policy_summary_line?.includes('asserted local review may finish this'));

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
            blockedErrorOutput.includes('code: no REVIEW_RECORDED evidence after the latest COMPILE_GATE_PASSED'),
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
            blockedErrorOutput.includes('no REVIEW_RECORDED evidence after the latest COMPILE_GATE_PASSED'),
            blockedErrorOutput
        );
        assert.equal(fs.existsSync(blockedTestReviewContextPath), false);
        assert.equal(fs.existsSync(blockedTestReviewContextArtifactPath), false);
        assert.equal(fs.existsSync(blockedTestScopedDiffPath), false);
        assert.equal(fs.existsSync(testReviewArtifactPath), false);
        assert.equal(fs.existsSync(testReviewReceiptPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result blocks downstream test review materialization until upstream code review passes current cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-record-test-review-blocked';
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
        const commandsPath = path.join(repoRoot, 'commands-record-review-blocked.md');
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
            taskSummary: 'Block downstream test review materialization until upstream code review passes current cycle',
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
        const testReviewContextPath = path.join(reviewsRoot, `${taskId}-manual-test-context.json`);
        const testReviewOutputPath = path.join(reviewsRoot, `${taskId}-test-review-output.md`);
        const testReviewArtifactPath = path.join(reviewsRoot, `${taskId}-test.md`);
        const testReviewReceiptPath = testReviewArtifactPath.replace(/\.md$/, '-receipt.json');
        fs.writeFileSync(testReviewContextPath, JSON.stringify({
            review_type: 'test',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(testReviewOutputPath, [
            '# Review',
            '',
            'Validated the downstream test-review materialization path against current-cycle review sequencing evidence, including `src/gates/review-dependencies.ts` and the `T-904b-record-test-review-blocked-test-review-context.json` binding that should stay blocked until code review passes. The review body also calls out current-cycle receipt binding and dependency ordering so it is substantive even with no active findings.',
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

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const blockedErrors: string[] = [];
        process.exitCode = 0;
        let blockedExitCode = 0;
        try {
            process.chdir(repoRoot);
            console.error = (...args: unknown[]) => {
                blockedErrors.push(args.map((value) => String(value)).join(' '));
            };
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
            blockedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const blockedErrorOutput = blockedErrors.join('\n');
        assert.ok(blockedExitCode !== 0, `Expected non-zero exit code, got ${blockedExitCode}`);
        assert.ok(
            blockedErrorOutput.includes("ReviewType 'test' is blocked until upstream reviews pass for the current cycle: code."),
            blockedErrorOutput
        );
        assert.ok(
            blockedErrorOutput.includes('code: no REVIEW_RECORDED evidence after the latest COMPILE_GATE_PASSED'),
            blockedErrorOutput
        );
        assert.equal(fs.existsSync(testReviewArtifactPath), false);
        assert.equal(fs.existsSync(testReviewReceiptPath), false);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
        )), false);

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

    it('required-reviews-check and completion prefer canonical review-context artifacts over stale legacy default files', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-canonical-review-context-preferred';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
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
            }
        });
        const commandsPath = path.join(repoRoot, 'commands-canonical-review-context-preferred.md');
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
            taskSummary: 'Prefer canonical review-context artifacts over stale legacy default files',
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
        const canonicalContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const legacyContextPath = path.join(reviewsRoot, `${taskId}-code-context.json`);
        const reviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        let buildExitCode = 0;
        let recordExitCode = 0;
        try {
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', canonicalContextPath
            ]);
            buildExitCode = Number(process.exitCode ?? 0);

            fs.writeFileSync(reviewOutputPath, [
                '# Review',
                '',
                'Validated `src/cli/commands/gates-artifacts.ts`, `src/gates/completion.ts`, and `src/gates/required-reviews-check.ts`, confirming that review gates now resolve the canonical review-context artifact deterministically and ignore stale legacy default siblings.',
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
                '--review-output-path', reviewOutputPath,
                '--review-context-path', canonicalContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            recordExitCode = Number(process.exitCode ?? 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(buildExitCode, 0);
        assert.equal(recordExitCode, 0);

        const canonicalContext = JSON.parse(fs.readFileSync(canonicalContextPath, 'utf8')) as Record<string, unknown>;
        const staleLegacyContext = {
            ...canonicalContext,
            preflight_sha256: 'stale-legacy-hash',
            reviewer_routing: {
                source_of_truth: 'Codex',
                actual_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:stale-legacy-reviewer'
            }
        };
        fs.writeFileSync(legacyContextPath, JSON.stringify(staleLegacyContext, null, 2) + '\n', 'utf8');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
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
            rationale: 'Canonical review-context path selection is an internal gate-contract change.',
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

    it('build-review-context, record-review-result, required-reviews-check, and completion honor an explicit custom task-mode artifact path end-to-end', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-custom-task-mode-end-to-end';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.antigravity', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md'), '# antigravity bridge\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
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
            }
        });
        const outputFiltersPath = path.resolve('live/config/output-filters.json');

        runEnterTaskMode({
            repoRoot,
            taskId,
            artifactPath: customTaskModePath,
            taskSummary: 'Honor an explicit custom task-mode artifact path across review and closeout gates',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation started for custom task-mode path regression fixture.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const defaultTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const driftedDefaultTaskMode = JSON.parse(fs.readFileSync(customTaskModePath, 'utf8')) as Record<string, unknown>;
        driftedDefaultTaskMode.provider = 'Codex';
        driftedDefaultTaskMode.routed_to = 'AGENTS.md';
        driftedDefaultTaskMode.canonical_source_of_truth = 'Codex';
        driftedDefaultTaskMode.execution_provider = 'Codex';
        driftedDefaultTaskMode.execution_provider_source = 'task_mode.provider';
        driftedDefaultTaskMode.runtime_identity_status = 'resolved';
        fs.mkdirSync(path.dirname(defaultTaskModePath), { recursive: true });
        fs.writeFileSync(defaultTaskModePath, JSON.stringify(driftedDefaultTaskMode, null, 2) + '\n', 'utf8');

        const reviewsRoot = getReviewsRoot(repoRoot);
        const customCodeReviewContextPath = path.join(reviewsRoot, 'custom-task-mode-code-review-context.json');
        const codeReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        let codeReviewBuildExitCode = 0;
        let codeReviewRecordExitCode = 0;
        try {
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
                '--output-path', customCodeReviewContextPath
            ]);
            codeReviewBuildExitCode = Number(process.exitCode ?? 0);

            const builtReviewContext = JSON.parse(fs.readFileSync(customCodeReviewContextPath, 'utf8')) as Record<string, unknown>;
            const reviewerRouting = builtReviewContext.reviewer_routing as Record<string, unknown>;
            assert.equal(reviewerRouting.canonical_source_of_truth, 'Codex');
            assert.equal(reviewerRouting.execution_provider, 'Antigravity');
            assert.equal(reviewerRouting.source_of_truth, 'Antigravity');

            fs.writeFileSync(codeReviewOutputPath, [
                '# Review',
                '',
                'Validated `src/gates/build-review-context.ts`, `src/cli/commands/gate-review-handlers.ts`, `src/cli/commands/gate-flows/review-flow.ts`, and `src/gates/completion.ts`, confirming that the explicit custom task-mode artifact path remains authoritative through review materialization, review-gate verification, and completion-gate closeout even when a conflicting default task-mode artifact exists.',
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
                '--task-mode-path', customTaskModePath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
                '--review-output-path', codeReviewOutputPath,
                '--review-context-path', customCodeReviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            codeReviewRecordExitCode = Number(process.exitCode ?? 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(codeReviewBuildExitCode, 0);
        assert.equal(codeReviewRecordExitCode, 0);

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            taskModePath: customTaskModePath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, reviewResult.outputLines.join('\n'));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Custom task-mode path regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId,
            taskModePath: customTaskModePath
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('build-review-context and record-review-result honor explicit custom task-mode paths for downstream test-review dependency checks', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-custom-task-mode-downstream-test';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.antigravity', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md'), '# antigravity bridge\n', 'utf8');
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

        runEnterTaskMode({
            repoRoot,
            taskId,
            artifactPath: customTaskModePath,
            taskSummary: 'Honor an explicit custom task-mode path when unblocking downstream test review',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation started for downstream custom task-mode dependency regression fixture.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const defaultTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const driftedDefaultTaskMode = JSON.parse(fs.readFileSync(customTaskModePath, 'utf8')) as Record<string, unknown>;
        driftedDefaultTaskMode.provider = 'Codex';
        driftedDefaultTaskMode.routed_to = 'AGENTS.md';
        driftedDefaultTaskMode.canonical_source_of_truth = 'Codex';
        driftedDefaultTaskMode.execution_provider = 'Codex';
        driftedDefaultTaskMode.execution_provider_source = 'task_mode.provider';
        driftedDefaultTaskMode.runtime_identity_status = 'resolved';
        fs.mkdirSync(path.dirname(defaultTaskModePath), { recursive: true });
        fs.writeFileSync(defaultTaskModePath, JSON.stringify(driftedDefaultTaskMode, null, 2) + '\n', 'utf8');

        const reviewsRoot = getReviewsRoot(repoRoot);
        const customCodeReviewContextPath = path.join(reviewsRoot, 'custom-task-mode-downstream-code-context.json');
        const customTestReviewContextPath = path.join(reviewsRoot, 'custom-task-mode-downstream-test-context.json');
        const codeReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
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
                '--task-mode-path', customTaskModePath,
                '--output-path', customCodeReviewContextPath
            ]);
            codeReviewBuildExitCode = Number(process.exitCode ?? 0);

            fs.writeFileSync(codeReviewOutputPath, [
                '# Review',
                '',
                'Validated `src/gates/review-dependencies.ts`, `src/cli/commands/gate-build-handlers.ts`, and `src/cli/commands/gate-review-handlers.ts`, confirming that upstream code-review evidence remains bound to the explicit custom task-mode artifact path even when a drifted default task-mode artifact exists.',
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
                '--task-mode-path', customTaskModePath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
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
                '--task-mode-path', customTaskModePath,
                '--output-path', customTestReviewContextPath
            ]);
            testReviewBuildExitCode = Number(process.exitCode ?? 0);

            const builtTestReviewContext = JSON.parse(fs.readFileSync(customTestReviewContextPath, 'utf8')) as Record<string, unknown>;
            const reviewerRouting = builtTestReviewContext.reviewer_routing as Record<string, unknown>;
            assert.equal(reviewerRouting.execution_provider, 'Antigravity');
            assert.equal(reviewerRouting.canonical_source_of_truth, 'Codex');

            fs.writeFileSync(testReviewOutputPath, [
                '# Review',
                '',
                'Validated `src/gates/review-dependencies.ts`, `src/cli/commands/gate-build-handlers.ts`, and `src/cli/commands/gate-review-handlers.ts`, confirming that downstream test-review dependency checks now stay bound to the explicit custom task-mode artifact path instead of falling back to a drifted default task-mode artifact.',
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
                '--review-context-path', customTestReviewContextPath,
                '--task-mode-path', customTaskModePath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'test',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
                '--review-output-path', testReviewOutputPath,
                '--review-context-path', customTestReviewContextPath,
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

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing and record-review-receipt honor an explicit custom task-mode artifact path when the default artifact drifts', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-custom-task-mode-routing-receipt';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.antigravity', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md'), '# antigravity bridge\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
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
            }
        });
        const outputFiltersPath = path.resolve('live/config/output-filters.json');

        runEnterTaskMode({
            repoRoot,
            taskId,
            artifactPath: customTaskModePath,
            taskSummary: 'Honor explicit custom task-mode evidence across split routing and receipt recording',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation started for split routing and receipt custom task-mode path regression fixture.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const defaultTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        fs.mkdirSync(path.dirname(defaultTaskModePath), { recursive: true });
        fs.writeFileSync(defaultTaskModePath, JSON.stringify({
            timestamp_utc: '2026-04-17T12:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Drifted default task-mode artifact for split routing/receipt regression coverage',
            provider: 'Qwen',
            routed_to: 'QWEN.md',
            canonical_source_of_truth: 'Qwen',
            execution_provider: 'Qwen',
            execution_provider_source: 'task_mode',
            runtime_identity_status: 'resolved'
        }, null, 2) + '\n', 'utf8');

        const reviewsRoot = getReviewsRoot(repoRoot);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        let buildExitCode = 0;
        let routingExitCode = 0;
        let receiptExitCode = 0;
        try {
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
                '--output-path', reviewContextPath
            ]);
            buildExitCode = Number(process.exitCode ?? 0);

            const builtReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
            const reviewerRouting = builtReviewContext.reviewer_routing as Record<string, unknown>;
            assert.equal(reviewerRouting.canonical_source_of_truth, 'Codex');
            assert.equal(reviewerRouting.execution_provider, 'Antigravity');
            assert.equal(reviewerRouting.source_of_truth, 'Antigravity');

            fs.writeFileSync(artifactPath, [
                '# Review',
                '',
                'Validated `src/cli/commands/gate-review-handlers.ts`, `src/gates/reviewer-routing.ts`, and the split routing/receipt lifecycle, confirming that the explicit custom task-mode artifact path remains authoritative even when a conflicting default task-mode artifact exists.',
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
                '--review-context-path', reviewContextPath,
                '--task-mode-path', customTaskModePath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            routingExitCode = Number(process.exitCode ?? 0);

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-context-path', reviewContextPath,
                '--task-mode-path', customTaskModePath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            receiptExitCode = Number(process.exitCode ?? 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(buildExitCode, 0);
        assert.equal(routingExitCode, 0);
        assert.equal(receiptExitCode, 0);

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = reviewContext.reviewer_routing as Record<string, unknown>;
        const receipt = JSON.parse(fs.readFileSync(artifactPath.replace(/\.md$/, '-receipt.json'), 'utf8')) as Record<string, unknown>;
        const events = readTaskTimelineEvents(repoRoot, taskId);

        assert.equal(reviewerRouting.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewerRouting.reviewer_session_id, 'agent:code-reviewer');
        assert.equal(receipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(receipt.reviewer_identity, 'agent:code-reviewer');
        assert.ok(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'));
        assert.ok(events.some((event) => event.event_type === 'REVIEW_RECORDED'));

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            taskModePath: customTaskModePath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, reviewResult.outputLines.join('\n'));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Custom task-mode path split routing/receipt regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId,
            taskModePath: customTaskModePath
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects stripped split runtime identity for explicit custom task-mode paths', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-custom-task-mode-receipt-identity-guard';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.antigravity', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md'), '# antigravity bridge\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
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
            }
        });

        runEnterTaskMode({
            repoRoot,
            taskId,
            artifactPath: customTaskModePath,
            taskSummary: 'Reject stripped split runtime identity on the public receipt path',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation started for stripped split runtime identity receipt guard regression fixture.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        let buildExitCode = 0;
        let routingExitCode = 0;
        let receiptExitCode = 0;
        try {
            console.error = (...args: unknown[]) => {
                capturedErrors.push(args.map((arg) => String(arg)).join(' '));
            };
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
                '--output-path', reviewContextPath
            ]);
            buildExitCode = Number(process.exitCode ?? 0);

            fs.writeFileSync(artifactPath, [
                '# Review',
                '',
                'Validated `src/cli/commands/gate-review-handlers.ts` and the stripped split runtime identity fixture while keeping the artifact realistic and non-trivial.',
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
                '--review-context-path', reviewContextPath,
                '--task-mode-path', customTaskModePath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            routingExitCode = Number(process.exitCode ?? 0);

            const strippedContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
            const reviewerRouting = strippedContext.reviewer_routing as Record<string, unknown>;
            delete reviewerRouting.canonical_source_of_truth;
            delete reviewerRouting.execution_provider;
            delete reviewerRouting.execution_provider_source;
            delete reviewerRouting.identity_status;
            strippedContext.reviewer_routing = reviewerRouting;
            fs.writeFileSync(reviewContextPath, JSON.stringify(strippedContext, null, 2) + '\n', 'utf8');

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-context-path', reviewContextPath,
                '--task-mode-path', customTaskModePath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            receiptExitCode = Number(process.exitCode ?? 0);
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(buildExitCode, 0);
        assert.equal(routingExitCode, 0);
        assert.notEqual(receiptExitCode, 0);
        assert.ok(capturedErrors.some((line) => (
            line.includes('missing canonical_source_of_truth')
            || line.includes('missing execution_provider')
            || line.includes('missing identity_status')
        )));
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('required-reviews-check rejects pre-recorded review artifacts when task-mode identity metadata is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-task-mode-identity-missing-at-review';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
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
            }
        });
        const outputFiltersPath = path.resolve('live/config/output-filters.json');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject required-reviews-check when pinned task-mode identity metadata is missing',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`),
            'agent:code-reviewer'
        );

        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const tamperedTaskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        delete tamperedTaskMode.canonical_source_of_truth;
        delete tamperedTaskMode.execution_provider_source;
        delete tamperedTaskMode.runtime_identity_status;
        fs.writeFileSync(taskModePath, JSON.stringify(tamperedTaskMode, null, 2) + '\n', 'utf8');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewResult.outputLines.some((line) => line.includes('missing canonical_source_of_truth')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('required-reviews-check fails when workspace canonical ownership drifts after task-mode identity was pinned', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-review-runtime-identity-drift';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
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
            }
        });
        const outputFiltersPath = path.resolve('live/config/output-filters.json');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fail required-reviews-check when workspace canonical SourceOfTruth drifts after task-mode entry',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`),
            'agent:code-reviewer'
        );

        seedInitAnswers(repoRoot, 'Qwen');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewResult.outputLines.some((line) => line.includes('contradicts task-mode canonical_source_of_truth')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('required-reviews-check rejects rerun after the review gate already passed without mutating the timeline', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-rerun-review-gate';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Required reviews gate passed.', {});

        const beforeEvents = readTaskTimelineEvents(repoRoot, taskId).length;
        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });
        const afterEvents = readTaskTimelineEvents(repoRoot, taskId);

        assert.equal(reviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewResult.outputLines.some((line) => line.includes("Do not rerun 'required-reviews-check' in place")));
        assert.equal(afterEvents.length, beforeEvents);
        assert.equal(afterEvents.filter((event) => event.event_type === 'REVIEW_GATE_FAILED').length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('required-reviews-check allows a fresh review cycle after a newer compile pass', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-rerun-review-gate-recovered';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-rerun.md');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow review-gate rerun after a new compile cycle'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Prior review gate passed.', {});

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });

        assert.equal(reviewResult.exitCode, 0);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_PASSED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });


    it('passes required review and completion flow for delegated evidence on providers that previously allowed fallback', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904c';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId, {
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
            }
        });
        const commandsPath = path.join(repoRoot, 'commands.md');
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
            taskSummary: 'Validate delegated review flow on a provider that previously allowed fallback',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');
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
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'Review phase started.', {
            review_type: 'code'
        });
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review',
            '',
            'Validated the Antigravity delegated reviewer path across `src/cli/main.ts`, `src/gates/required-reviews-check.ts`, and `src/gates/completion.ts`, confirming that providers which previously allowed fallback now materialize delegated reviewer routing, receipts, and completion evidence through the standard mandatory flow.',
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
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                execution_provider_source: 'provider_bridge',
                routed_to: '.antigravity/agents/orchestrator.md',
                reviewer_subagent_launch_status: 'launchable',
                reviewer_subagent_launch_route: '.antigravity/agents/orchestrator.md'
            })
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'SKILL_SELECTED', 'INFO', 'selected', { skill_id: 'code-review' });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', {
            reference_path: '/live/skills/code-review/SKILL.md'
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
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
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
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
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_PASSED');

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Test fixture exercises conditional-provider fallback review flow only.',
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

describe('executeCommand timeout protection (T-061)', () => {
    it('runs a simple command successfully with default timeout', () => {
        const result = executeCommand(`node -e "console.log('hello')"`, {
            cwd: process.cwd()
        });
        assert.equal(result.exitCode, 0);
        assert.ok(result.outputLines.some(line => line.includes('hello')));
        assert.equal(result.timedOut, false);
    });

    it('reports timedOut when command exceeds specified timeout', () => {
        const result = executeCommand(
            `node -e "const s=Date.now();while(Date.now()-s<10000){}"`,
            { cwd: process.cwd(), timeoutMs: 500 }
        );
        assert.equal(result.timedOut, true);
        assert.equal(result.exitCode, EXIT_GENERAL_FAILURE);
        assert.ok(result.outputLines.some(line => /timed out/i.test(line)));
    });

    it('throws ENOENT for missing executable', () => {
        assert.throws(
            () => executeCommand('__nonexistent_executable_12345__', { cwd: process.cwd() }),
            /not found in PATH/
        );
    });

    it('blocks direct .node-build sync consumers when the node-foundation producer output is stale', () => {
        const fixture = createDependentValidationFixture();
        try {
            writeNodeFoundationManifest(fixture.manifestPath);
            ageFixturePath(fixture.manifestPath, 10_000);
            fs.writeFileSync(fixture.sourcePath, 'export const feature = false;\n', 'utf8');

            assert.throws(
                () => executeCommand(`node --test "${fixture.consumerPath}"`, { cwd: fixture.repoRoot }),
                /Dependent validation chain 'node_foundation_build_to_compiled_tests'.*npm run build:node-foundation.*Do not run the producer and consumer in parallel/i
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('blocks direct .node-build async consumers while the node-foundation producer lock is active', async () => {
        const fixture = createDependentValidationFixture();
        try {
            ageFixturePath(fixture.sourcePath, 10_000);
            writeNodeFoundationManifest(fixture.manifestPath);
            fs.mkdirSync(fixture.lockPath, { recursive: true });
            fs.writeFileSync(path.join(fixture.lockPath, 'owner.json'), JSON.stringify({
                pid: process.pid,
                hostname: os.hostname(),
                startedAtUtc: new Date().toISOString()
            }, null, 2) + '\n', 'utf8');

            const error = await captureExpectedAsyncError(() => executeCommandAsync(
                `node --test "${fixture.consumerPath}"`,
                { cwd: fixture.repoRoot, timeoutMs: 10_000 }
            ).then(() => undefined));
            assert.match(
                error.message,
                /Dependent validation chain 'node_foundation_build_to_compiled_tests'.*producer lock.*npm test/i
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('blocks direct .node-build consumers from nested cwd values that point back to the repo artifact root', () => {
        const fixture = createDependentValidationFixture();
        try {
            const nestedConsumerPath = path.relative(fixture.nestedCwd, fixture.consumerPath);
            assert.throws(
                () => executeCommand(`node --test "${nestedConsumerPath}"`, { cwd: fixture.nestedCwd }),
                /Dependent validation chain 'node_foundation_build_to_compiled_tests'/i
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('prefers the resolved PATH batch executable over a cwd shadow for sync execution on Windows', () => {
        if (process.platform !== 'win32') return;
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-batch-shadow-'));
        try {
            fs.writeFileSync(path.join(repoRoot, 'npm.cmd'), '@echo off\r\necho HIJACKED_SYNC\r\n', 'utf8');
            const result = executeCommand('npm --version', { cwd: repoRoot });
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => /^\d+\.\d+\.\d+/.test(line)), 'expected real npm version output');
            assert.ok(!result.outputLines.some((line) => line.includes('HIJACKED_SYNC')));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('prefers the resolved PATH batch executable over a cwd shadow for async execution on Windows', async () => {
        if (process.platform !== 'win32') return;
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-batch-shadow-'));
        try {
            fs.writeFileSync(path.join(repoRoot, 'npm.cmd'), '@echo off\r\necho HIJACKED_ASYNC\r\n', 'utf8');
            const result = await executeCommandAsync('npm --version', { cwd: repoRoot, timeoutMs: 10_000 });
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => /^\d+\.\d+\.\d+/.test(line)), 'expected real npm version output');
            assert.ok(!result.outputLines.some((line) => line.includes('HIJACKED_ASYNC')));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('forwards quoted batch arguments through executeCommand on Windows', () => {
        if (process.platform !== 'win32') return;
        const fixture = createWindowsBatchNodeFixture('process.stdout.write(process.argv[2] || "")', { forwardArgs: true });
        try {
            const result = executeCommand(`"${fixture.batchPath}" "safe literal"`, { cwd: process.cwd() });
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => line.includes('safe literal')));
        } finally {
            fixture.cleanup();
        }
    });

    it('forwards quoted batch arguments through executeCommandAsync on Windows', async () => {
        if (process.platform !== 'win32') return;
        const fixture = createWindowsBatchNodeFixture('process.stdout.write(process.argv[2] || "")', { forwardArgs: true });
        try {
            const result = await executeCommandAsync(`"${fixture.batchPath}" "safe literal"`, {
                cwd: process.cwd(),
                timeoutMs: 10_000
            });
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => line.includes('safe literal')));
        } finally {
            fixture.cleanup();
        }
    });

    it('reports timedOut for batch execution through executeCommandAsync on Windows', async () => {
        if (process.platform !== 'win32') return;
        const fixture = createWindowsBatchNodeFixture('setTimeout(() => {}, 60000)');
        try {
            const result = await executeCommandAsync(`"${fixture.batchPath}"`, {
                cwd: process.cwd(),
                timeoutMs: 500
            });
            assert.equal(result.timedOut, true);
            assert.equal(result.exitCode, EXIT_GENERAL_FAILURE);
            assert.ok(result.outputLines.some((line) => /timed out/i.test(line)));
        } finally {
            fixture.cleanup();
        }
    });

    it('reports timedOut for batch execution through executeCommand on Windows', () => {
        if (process.platform !== 'win32') return;
        const fixture = createWindowsBatchNodeFixture('setTimeout(() => {}, 60000)');
        try {
            const result = executeCommand(`"${fixture.batchPath}"`, {
                cwd: process.cwd(),
                timeoutMs: 500
            });
            assert.equal(result.timedOut, true);
            assert.equal(result.exitCode, EXIT_GENERAL_FAILURE);
            assert.ok(result.outputLines.some((line) => /timed out/i.test(line)));
        } finally {
            fixture.cleanup();
        }
    });
});
